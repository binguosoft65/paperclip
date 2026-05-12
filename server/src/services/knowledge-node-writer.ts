import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  knowledgeDrafts,
  knowledgeNodes,
  knowledgeEdges,
  knowledgeNodeRevisions,
  knowledgeNodeEvents,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { parseWikilinks } from "./knowledge-wikilinks.js";

/**
 * NodeWriter 把"已 approved"的 draft 在事务里物化成节点 + 边 + 历史快照 + 事件。
 *
 * 调用约定：
 * - 由 route handler 在 draftService.markApproved 之后调用
 * - 失败不会回滚 draft 状态（draft 保持 approved，但 node 未生成）；这种"半完成"
 *   状态通过 GET /drafts 查询时若 status=approved 且无对应 event 即可识别。
 *   Phase 3 演化引擎可以补一个 retry routine
 *
 * 依赖 embed：通过构造函数注入，便于测试 mock。生产代码注入
 * llmWikiService(db).embed。
 */
export interface EmbedClient {
  embed(text: string): Promise<number[]>;
}

export function knowledgeNodeWriterService(db: Db, client: EmbedClient) {
  return {
    /**
     * 把 draft 物化为节点。返回新建/更新的 node id。
     *
     * 事务内串行：
     *   1. 读 draft（必须 approved + 同公司）
     *   2. 算 embedding（在事务外算更稳，但 Phase 1a 简化先放在事务前）
     *   3. 若是 update：读旧 node → 写 revision 快照
     *   4. INSERT / UPDATE node
     *   5. 删旧 auto_generated edges
     *   6. 解析 [[uuid]] → 校验都属本公司 → INSERT references edges
     *   7. INSERT node_events 一条
     */
    async materialize(input: { companyId: string; draftId: string; reviewerUserId: string }) {
      // 1. 读 draft（事务外读，节省事务时长）
      const draftRows = await db
        .select()
        .from(knowledgeDrafts)
        .where(
          and(
            eq(knowledgeDrafts.id, input.draftId),
            eq(knowledgeDrafts.companyId, input.companyId),
          ),
        )
        .limit(1);
      const draft = draftRows[0];
      if (!draft) throw notFound("draft not found");
      if (draft.status !== "approved") {
        throw conflict(`draft must be approved before materialize (got status='${draft.status}')`);
      }

      // 2. 算 embedding（基于 title + content，提高检索匹配度）
      const embedInput = `${draft.proposedTitle}\n\n${draft.proposedContent}`.trim();
      const embedding = await client.embed(embedInput);

      // 3-7. 事务内写入
      return db.transaction(async (tx) => {
        let nodeId: string;
        const isUpdate = draft.targetNodeId !== null && draft.targetNodeId !== undefined;

        if (isUpdate) {
          const existingRows = await tx
            .select()
            .from(knowledgeNodes)
            .where(
              and(
                eq(knowledgeNodes.id, draft.targetNodeId!),
                eq(knowledgeNodes.companyId, input.companyId),
              ),
            )
            .limit(1);
          const existing = existingRows[0];
          if (!existing) throw notFound("target node not found");

          // 写修改前快照
          await tx.insert(knowledgeNodeRevisions).values({
            nodeId: existing.id,
            title: existing.title,
            content: existing.content,
            type: existing.type,
            level: existing.level,
            metadata: existing.metadata,
            changesetSummary: null,
            editorAgentId: draft.sourceAgentId,
            editorUserId: input.reviewerUserId,
            draftId: draft.id,
          });

          // UPDATE node
          const updated = await tx
            .update(knowledgeNodes)
            .set({
              title: draft.proposedTitle,
              content: draft.proposedContent,
              type: draft.proposedType,
              level: draft.proposedLevel,
              businessDomainId: draft.proposedBusinessDomainId,
              metadata: draft.proposedMetadata,
              volatility: draft.proposedVolatility ?? existing.volatility,
              validUntil: draft.proposedValidUntil ?? existing.validUntil,
              confidence: draft.confidence,
              embedding,
              updatedAt: new Date(),
            })
            .where(eq(knowledgeNodes.id, existing.id))
            .returning({ id: knowledgeNodes.id });
          nodeId = updated[0]!.id;
        } else {
          // INSERT 新 node
          const inserted = await tx
            .insert(knowledgeNodes)
            .values({
              title: draft.proposedTitle,
              content: draft.proposedContent,
              type: draft.proposedType,
              level: draft.proposedLevel,
              businessDomainId: draft.proposedBusinessDomainId,
              metadata: draft.proposedMetadata,
              volatility: draft.proposedVolatility ?? "slow",
              validUntil: draft.proposedValidUntil,
              confidence: draft.confidence,
              embedding,
              companyId: input.companyId,
              createdByAgent: draft.sourceAgentId,
              createdByUser: draft.sourceUserId,
            })
            .returning({ id: knowledgeNodes.id });
          if (inserted.length === 0) throw new Error("knowledge_nodes insert returned no row");
          nodeId = inserted[0]!.id;
        }

        // 删旧 auto_generated edges（仅 update 路径下有；新建路径下查询为空，no-op）
        await tx
          .delete(knowledgeEdges)
          .where(
            and(eq(knowledgeEdges.fromNodeId, nodeId), eq(knowledgeEdges.autoGenerated, true)),
          );

        // 解析 wikilinks 并校验目标节点存在 + 同公司
        const linkedIds = parseWikilinks(draft.proposedContent).filter((id) => id !== nodeId);
        if (linkedIds.length > 0) {
          const validRows = await tx
            .select({ id: knowledgeNodes.id })
            .from(knowledgeNodes)
            .where(
              and(
                eq(knowledgeNodes.companyId, input.companyId),
                inArray(knowledgeNodes.id, linkedIds),
              ),
            );
          const validIds = new Set(validRows.map((r) => r.id));
          const edgeRows = linkedIds
            .filter((id) => validIds.has(id))
            .map((toId) => ({
              fromNodeId: nodeId,
              toNodeId: toId,
              edgeType: "references" as const,
              autoGenerated: true,
              createdByAgent: draft.sourceAgentId,
              createdByUser: input.reviewerUserId,
            }));
          if (edgeRows.length > 0) {
            await tx.insert(knowledgeEdges).values(edgeRows);
          }
        }

        // 写事件
        await tx.insert(knowledgeNodeEvents).values({
          nodeId,
          eventType: isUpdate ? "updated" : "created",
          agentId: draft.sourceAgentId,
          runId: draft.sourceRunId,
          issueId: draft.sourceIssueId,
          userId: input.reviewerUserId,
          metadata: { draftId: draft.id },
        });

        return { nodeId, isUpdate };
      });
    },
  };
}

export type KnowledgeNodeWriterService = ReturnType<typeof knowledgeNodeWriterService>;
