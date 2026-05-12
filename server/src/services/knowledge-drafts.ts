import { and, eq, inArray, sql, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { businessDomains, knowledgeDrafts } from "@paperclipai/db";
import type { CreateKnowledgeDraft, ListKnowledgeDraftsQuery } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

/**
 * 调用方身份：Phase 1a 只关心 user / agent 两种主体 + isAdmin 标志。
 * Agent 路径（Path A/B/C）在 Phase 1b 才接入；此处接口先预留 sourceAgentId 字段。
 */
export type KnowledgeDraftActor =
  | { type: "user"; userId: string; isAdmin: boolean }
  | { type: "agent"; agentId: string; runId?: string | null };

export interface CreateKnowledgeDraftInput {
  companyId: string;
  actor: KnowledgeDraftActor;
  payload: CreateKnowledgeDraft;
}

/**
 * Draft 服务 —— LLM-Wiki Phase 1a 核心下游层。
 *
 * 职责：
 * - create：三路写入入口（Phase 1a 仅 manual）；校验业务域归属本公司；写入 pending
 * - getById：读单条（带公司多租户过滤）
 * - list：审查队列分页（状态/来源/pre_verdict/domain 过滤；游标分页）
 * - approve / reject / requestRevision / batchApprove：见 Task 4
 */
export function knowledgeDraftService(db: Db) {
  // ============================================================
  // 私有：业务域 name → id 查找，确保该 domain 属于当前 company
  // ============================================================
  async function resolveBusinessDomainId(companyId: string, name: string): Promise<string> {
    const rows = await db
      .select({ id: businessDomains.id })
      .from(businessDomains)
      .where(and(eq(businessDomains.companyId, companyId), eq(businessDomains.name, name)))
      .limit(1);
    if (rows.length === 0) {
      throw unprocessable(`business_domain '${name}' not found for company`);
    }
    return rows[0]!.id;
  }

  return {
    /** 创建 draft；Phase 1a 仅支持 source=manual，skip_review 仅 admin 可用 */
    async create(input: CreateKnowledgeDraftInput) {
      const { companyId, actor, payload } = input;

      // skip_review 权限校验（仅 admin user）
      if (payload.skip_review === true) {
        if (actor.type !== "user" || !actor.isAdmin) {
          throw forbidden("skip_review requires admin privileges");
        }
      }

      const businessDomainId = await resolveBusinessDomainId(
        companyId,
        payload.business_domain_name,
      );

      // 组装 INSERT
      const insertRow = {
        targetNodeId: payload.target_node_id ?? null,
        proposedTitle: payload.title,
        proposedContent: payload.content,
        proposedType: payload.type,
        proposedLevel: payload.level,
        proposedBusinessDomainId: businessDomainId,
        proposedMetadata: payload.metadata ?? {},
        proposedVolatility: payload.volatility ?? null,
        proposedValidUntil: payload.valid_until ?? null,
        source: payload.source,
        sourceAgentId: actor.type === "agent" ? actor.agentId : null,
        sourceRunId:
          actor.type === "agent" ? actor.runId ?? null : payload.source_run_id ?? null,
        sourceIssueId: payload.source_issue_id ?? null,
        sourceUserId: actor.type === "user" ? actor.userId : null,
        confidence: payload.confidence ?? 0.5,
        status: "pending" as const,
        companyId,
      };

      const inserted = await db
        .insert(knowledgeDrafts)
        .values(insertRow)
        .returning({
          id: knowledgeDrafts.id,
          status: knowledgeDrafts.status,
          preVerdict: knowledgeDrafts.preVerdict,
        });

      if (inserted.length === 0) {
        throw new Error("knowledge_drafts insert returned no row");
      }
      return inserted[0]!;
    },

    /** 按 ID 读 draft；非本公司返回 null（由调用方决定 403/404） */
    async getById(companyId: string, id: string) {
      const rows = await db
        .select()
        .from(knowledgeDrafts)
        .where(and(eq(knowledgeDrafts.id, id), eq(knowledgeDrafts.companyId, companyId)))
        .limit(1);
      return rows[0] ?? null;
    },

    /** 审查队列分页 */
    async list(companyId: string, query: ListKnowledgeDraftsQuery) {
      const filters = [eq(knowledgeDrafts.companyId, companyId)];

      const statusList = (query.status ?? "pending").split(",").map((s) => s.trim()).filter(Boolean);
      if (statusList.length > 0) {
        filters.push(inArray(knowledgeDrafts.status, statusList));
      }
      if (query.source) {
        const sources = query.source.split(",").map((s) => s.trim()).filter(Boolean);
        if (sources.length > 0) filters.push(inArray(knowledgeDrafts.source, sources));
      }
      if (query.pre_verdict) {
        const verdicts = query.pre_verdict.split(",").map((s) => s.trim()).filter(Boolean);
        if (verdicts.length > 0) filters.push(inArray(knowledgeDrafts.preVerdict, verdicts));
      }
      // 业务域过滤：先解析 name → ids 再 inArray
      if (query.domain) {
        const names = query.domain.split(",").map((s) => s.trim()).filter(Boolean);
        if (names.length > 0) {
          const domainRows = await db
            .select({ id: businessDomains.id })
            .from(businessDomains)
            .where(
              and(eq(businessDomains.companyId, companyId), inArray(businessDomains.name, names)),
            );
          const ids = domainRows.map((r) => r.id);
          if (ids.length === 0) {
            return { items: [], nextCursor: null };
          }
          filters.push(inArray(knowledgeDrafts.proposedBusinessDomainId, ids));
        }
      }
      // 游标：base64({createdAt, id})；为简单起见 Phase 1a 用 createdAt < cursor
      let cursorFilter = sql`true`;
      if (query.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(query.cursor, "base64").toString("utf-8")) as {
            createdAt: string;
          };
          cursorFilter = sql`${knowledgeDrafts.createdAt} < ${decoded.createdAt}`;
        } catch {
          throw unprocessable("invalid cursor");
        }
      }

      const rows = await db
        .select()
        .from(knowledgeDrafts)
        .where(and(...filters, cursorFilter))
        .orderBy(desc(knowledgeDrafts.createdAt))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const nextCursor =
        hasMore && items.length > 0
          ? Buffer.from(JSON.stringify({ createdAt: items[items.length - 1]!.createdAt })).toString(
              "base64",
            )
          : null;
      return { items, nextCursor };
    },

    /**
     * 标 draft 为 approved（仅状态改动；物化到 nodes 由 route handler 调
     * knowledgeNodeWriterService.materialize 完成）。返回更新后的 draft 行。
     */
    async markApproved(input: {
      companyId: string;
      id: string;
      reviewerUserId: string;
      notes?: string;
    }) {
      const existing = await this.getById(input.companyId, input.id);
      if (!existing) throw notFound("draft not found");
      if (existing.status !== "pending") {
        throw conflict(`draft cannot be approved from status='${existing.status}'`);
      }
      const updated = await db
        .update(knowledgeDrafts)
        .set({
          status: "approved",
          reviewedBy: input.reviewerUserId,
          reviewNotes: input.notes ?? null,
          reviewedAt: new Date(),
        })
        .where(
          and(eq(knowledgeDrafts.id, input.id), eq(knowledgeDrafts.companyId, input.companyId)),
        )
        .returning();
      if (updated.length === 0) throw notFound("draft not found");
      return updated[0]!;
    },

    /** 驳回 draft */
    async reject(input: {
      companyId: string;
      id: string;
      reviewerUserId: string;
      notes?: string;
    }) {
      const existing = await this.getById(input.companyId, input.id);
      if (!existing) throw notFound("draft not found");
      if (existing.status !== "pending") {
        throw conflict(`draft cannot be rejected from status='${existing.status}'`);
      }
      const updated = await db
        .update(knowledgeDrafts)
        .set({
          status: "rejected",
          reviewedBy: input.reviewerUserId,
          reviewNotes: input.notes ?? null,
          reviewedAt: new Date(),
        })
        .where(
          and(eq(knowledgeDrafts.id, input.id), eq(knowledgeDrafts.companyId, input.companyId)),
        )
        .returning();
      if (updated.length === 0) throw notFound("draft not found");
      return updated[0]!;
    },

    /**
     * 要求修改。Phase 1a 仅改状态，不自动开 Issue（待 Phase 1b 集成
     * issueService 后再补，避免循环依赖）。返回 issueId=null 占位。
     */
    async requestRevision(input: {
      companyId: string;
      id: string;
      reviewerUserId: string;
      notes: string;
    }) {
      const existing = await this.getById(input.companyId, input.id);
      if (!existing) throw notFound("draft not found");
      if (existing.status !== "pending") {
        throw conflict(`draft cannot request-revision from status='${existing.status}'`);
      }
      await db
        .update(knowledgeDrafts)
        .set({
          status: "revision_requested",
          reviewedBy: input.reviewerUserId,
          reviewNotes: input.notes,
          reviewedAt: new Date(),
        })
        .where(
          and(eq(knowledgeDrafts.id, input.id), eq(knowledgeDrafts.companyId, input.companyId)),
        );
      return { draftId: input.id, issueId: null as string | null };
    },

    /**
     * 批量批准：把所有 pending 的 id 标 approved 并返回 approved_count + failed[]。
     * 物化由 route handler 串行调 nodeWriter（避免 fan-out 把 OpenAI quota 打爆）。
     */
    async batchMarkApproved(input: {
      companyId: string;
      ids: string[];
      reviewerUserId: string;
      notes?: string;
    }) {
      const approved: string[] = [];
      const failed: Array<{ id: string; reason: string }> = [];
      for (const id of input.ids) {
        try {
          await this.markApproved({
            companyId: input.companyId,
            id,
            reviewerUserId: input.reviewerUserId,
            notes: input.notes,
          });
          approved.push(id);
        } catch (err) {
          failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return { approvedIds: approved, failed };
    },
  };
}

export type KnowledgeDraftService = ReturnType<typeof knowledgeDraftService>;
