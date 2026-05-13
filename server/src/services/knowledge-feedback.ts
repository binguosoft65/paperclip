import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { knowledgeNodes, knowledgeNodeEvents } from "@paperclipai/db";
import { notFound } from "../errors.js";

/**
 * Knowledge feedback 服务（Phase 2a）—— PRD §6 FR9 反馈四值。
 *
 * 四种反馈的副作用：
 *   - helped:      trigger_count += 1, last_triggered = now;
 *                  event(type='triggered', feedback='helped')
 *   - outdated:    metadata.forced_outdated_at = now_iso;
 *                  event(type='feedback', feedback='outdated')
 *                  （freshness 实时算时会读 metadata.forced_outdated_at 强制降到 ≤ 0.3）
 *   - wrong:       仅 event(type='feedback', feedback='wrong')
 *                  （演化引擎读 events 起冲突队列 — Phase 3）
 *   - irrelevant:  仅 event(type='feedback', feedback='irrelevant')
 *                  （演化引擎读 events 调 used_for 权重 — Phase 3）
 *
 * 不在 Phase 2a 做：
 *   - 自动开"请验证"Issue（outdated）→ Phase 3 routine
 *   - 自动加 conflicts_with 边（wrong）→ Phase 3 routine
 *   - irrelevant 实时降权 → 演化引擎统计层处理
 */

export interface KnowledgeFeedbackInput {
  companyId: string;
  nodeId: string;
  feedback: "helped" | "outdated" | "wrong" | "irrelevant";
  runId?: string | null;
  issueId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  comment?: string | null;
}

export function knowledgeFeedbackService(db: Db) {
  return {
    async record(input: KnowledgeFeedbackInput): Promise<{ nodeId: string; eventId: string }> {
      // 1. 找节点，跨公司即 404
      const rows = await db
        .select()
        .from(knowledgeNodes)
        .where(and(eq(knowledgeNodes.id, input.nodeId), eq(knowledgeNodes.companyId, input.companyId)))
        .limit(1);
      const node = rows[0];
      if (!node || node.companyId !== input.companyId) throw notFound("node not found");

      const now = new Date();
      const eventMetadata: Record<string, unknown> = {};
      if (input.comment) eventMetadata.comment = input.comment;

      // 2. 根据反馈类型决定 update / event
      if (input.feedback === "helped") {
        await db
          .update(knowledgeNodes)
          .set({
            triggerCount: (node.triggerCount ?? 0) + 1,
            lastTriggered: now,
          })
          .where(eq(knowledgeNodes.id, input.nodeId))
          .returning({ id: knowledgeNodes.id });
      } else if (input.feedback === "outdated") {
        const newMeta = {
          ...(node.metadata as Record<string, unknown> | null ?? {}),
          forced_outdated_at: now.toISOString(),
        };
        await db
          .update(knowledgeNodes)
          .set({ metadata: newMeta })
          .where(eq(knowledgeNodes.id, input.nodeId))
          .returning({ id: knowledgeNodes.id });
      }
      // wrong / irrelevant 不改节点字段，只写事件

      // 3. 写 event
      const eventType = input.feedback === "helped" ? "triggered" : "feedback";
      const inserted = await db
        .insert(knowledgeNodeEvents)
        .values({
          nodeId: input.nodeId,
          eventType,
          feedback: input.feedback,
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
          issueId: input.issueId ?? null,
          userId: input.userId ?? null,
          metadata: eventMetadata,
        })
        .returning({ id: knowledgeNodeEvents.id });

      return { nodeId: input.nodeId, eventId: inserted[0]!.id };
    },
  };
}

export type KnowledgeFeedbackService = ReturnType<typeof knowledgeFeedbackService>;
