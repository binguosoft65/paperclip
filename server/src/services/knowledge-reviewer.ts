import { and, eq, isNull, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { knowledgeDrafts } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { KnowledgeRetrieverService } from "./knowledge-retriever.js";

/**
 * Reviewer Agent 初筛服务（Phase 3b）—— PRD §6.4 梯度审查。
 *
 * 工作流（screenDraft）：
 *   1. 读 draft（带公司多租户）
 *   2. 用 retriever 查 Top-K 相似既有节点（K=3，仅 similarity > 0.5 的入参 LLM）
 *   3. LLM prompt：让 LLM 输出 JSON {verdict, reasoning, conflicts}
 *   4. 解析 + 兜底（unknown verdict → needs_human、解析失败 → needs_human、reasoning ≤ 200 字截断）
 *   5. 写回 draft：preVerdict / preVerdictReasoning / preVerdictAt / detectedConflicts
 *
 * 失败不抛：单条 screen 失败时落 needs_human + 错误理由，永远写库。
 */

export interface ReviewerLlmClient {
  completeChat(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string>;
}

/** 相似节点进入 LLM 参考的最低相似度门槛 */
const SIMILARITY_FLOOR_FOR_CONFLICT_CHECK = 0.5;
/** 每次检索的相似节点最大数量 */
const TOP_K_NEIGHBORS = 3;
/** reasoning 最大字符数（超过则截断） */
const REASONING_MAX_CHARS = 200;

/**
 * Reviewer Agent 的系统提示词，让 LLM 输出结构化初筛结论。
 * 导出以便路由层或测试引用。
 */
export const REVIEWER_SYSTEM_PROMPT = `你是 Paperclip LLM-Wiki 的 Reviewer Agent，负责对待审查的知识 draft 做初筛。

输入：一条 draft + 数据库里相似的既有节点列表（可能为空）。

输出：一段严格 JSON，schema：
{
  "verdict": "recommend_approve" | "recommend_reject" | "needs_human",
  "reasoning": "≤200字的简短理由（中文）",
  "conflicts": ["node-uuid-1", ...]  // 与 draft 直接矛盾的相似节点 id；无则空数组
}

判定标准：
- recommend_approve：内容具体、信息量充足、与既有节点不重复、confidence ≥ 0.7
- recommend_reject：内容空洞 / 文本片段 / 与既有节点高度重复无新增信息 / 显然非知识（如调试日志）
- needs_human：以上两类不明显、检测到 conflicts、或 confidence 在 0.3-0.7 之间
- conflicts：仅当相似节点观点与 draft 直接矛盾时返回其 id；语义相近但不矛盾不算

只输出 JSON，不要 markdown 围栏，不要解释。`.trim();

export function reviewerAgentService(
  db: Db,
  retriever: KnowledgeRetrieverService,
  llm: ReviewerLlmClient,
) {
  /**
   * 私有：将初筛结论写回 knowledge_drafts 表，并返回标准化结构。
   */
  async function writeBack(
    input: { companyId: string; draftId: string },
    verdict: "recommend_approve" | "recommend_reject" | "needs_human",
    reasoning: string,
    conflicts: string[],
  ) {
    await db
      .update(knowledgeDrafts)
      .set({
        preVerdict: verdict,
        preVerdictReasoning: reasoning,
        preVerdictAt: new Date(),
        detectedConflicts: conflicts,
      })
      .where(
        and(
          eq(knowledgeDrafts.id, input.draftId),
          eq(knowledgeDrafts.companyId, input.companyId),
        ),
      );
    return { pre_verdict: verdict, reasoning, conflicts };
  }

  return {
    /**
     * 给单条 draft 打 pre_verdict。
     * 失败时落 needs_human + 错误理由，永远写库（不向上抛）。
     * 若 draft 不存在则抛 404（调用方可中断批量循环）。
     */
    async screenDraft(input: { companyId: string; draftId: string }): Promise<{
      pre_verdict: "recommend_approve" | "recommend_reject" | "needs_human";
      reasoning: string;
      conflicts: string[];
    }> {
      // 1. 读 draft（多租户隔离，company_id 不匹配即 404）
      const rows = await db
        .select()
        .from(knowledgeDrafts)
        .where(
          and(
            eq(knowledgeDrafts.id, input.draftId),
            eq(knowledgeDrafts.companyId, input.companyId),
          ),
        )
        .limit(1);
      const draft = rows[0];
      if (!draft) throw notFound("draft not found");

      // 2. 查相似既有节点（用 draft 标题 + 内容拼成 query）
      let neighbors: Array<{ id: string; title: string; snippet: string }> = [];
      try {
        const query = `${draft.proposedTitle}\n\n${draft.proposedContent}`.trim();
        const result = await retriever.search({
          companyId: input.companyId,
          query,
          limit: TOP_K_NEIGHBORS,
        });
        // 仅保留相似度超过门槛的节点，避免把低质量匹配送入 LLM 干扰判断
        neighbors = result.results
          .filter((r) => r.similarity >= SIMILARITY_FLOOR_FOR_CONFLICT_CHECK)
          .map((r) => ({ id: r.id, title: r.title, snippet: r.snippet }));
      } catch (err) {
        // retriever 故障不应阻断初筛流程，记日志继续（邻居为空）
        logger.warn({ err, draftId: input.draftId }, "reviewer: retriever 调用失败，继续无邻居节点");
      }

      // 3. 构造传给 LLM 的 user message（JSON 格式，利于模型稳定解析）
      const userMessage = JSON.stringify(
        {
          draft: {
            id: draft.id,
            title: draft.proposedTitle,
            content: draft.proposedContent,
            type: draft.proposedType,
            level: draft.proposedLevel,
            confidence: draft.confidence,
            source: draft.source,
          },
          neighbors,
        },
        null,
        2,
      );

      // 4. 调 LLM 获取初筛 JSON
      let raw = "";
      try {
        raw = await llm.completeChat([
          { role: "system", content: REVIEWER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ]);
      } catch (err) {
        logger.warn({ err, draftId: input.draftId }, "reviewer: LLM 调用失败");
        return writeBack(input, "needs_human", "LLM 调用失败，请人审", []);
      }

      // 5. 解析 LLM 输出 + 兜底逻辑
      let parsed: { verdict?: string; reasoning?: string; conflicts?: unknown[] };
      try {
        // 容错：去掉 LLM 可能输出的 markdown 代码围栏
        const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        parsed = JSON.parse(cleaned) as typeof parsed;
      } catch {
        // 解析失败 → needs_human，理由说明无法解析
        return writeBack(input, "needs_human", "Reviewer 输出无法解析为 JSON，请人审", []);
      }

      // verdict 枚举校验：未知值兜底为 needs_human
      const validVerdicts = ["recommend_approve", "recommend_reject", "needs_human"] as const;
      const verdict = (validVerdicts as readonly string[]).includes(parsed.verdict ?? "")
        ? (parsed.verdict as (typeof validVerdicts)[number])
        : "needs_human";

      // reasoning 截断到 ≤ REASONING_MAX_CHARS 字符（DB 层也有 CHECK 约束）
      const reasoning = (parsed.reasoning ?? "").slice(0, REASONING_MAX_CHARS);

      // conflicts 过滤非字符串元素，上限 20 条防止异常大数组
      const conflicts = Array.isArray(parsed.conflicts)
        ? parsed.conflicts.filter((c): c is string => typeof c === "string").slice(0, 20)
        : [];

      return writeBack(input, verdict, reasoning, conflicts);
    },

    /**
     * 拉所有 status=pending 且 pre_verdict IS NULL 的 draft，
     * 按 created_at 升序逐条 screen。
     * 受 limit 限制避免一次跑爆 LLM quota，返回 {processed, errors}。
     */
    async screenPendingDrafts(input: { companyId: string; limit?: number }): Promise<{
      processed: number;
      errors: Array<{ draftId: string; reason: string }>;
    }> {
      const limit = input.limit ?? 50;

      // 查找待初筛的 draft ID 列表（只取 id，避免拉全量字段）
      const rows = await db
        .select({ id: knowledgeDrafts.id })
        .from(knowledgeDrafts)
        .where(
          and(
            eq(knowledgeDrafts.companyId, input.companyId),
            eq(knowledgeDrafts.status, "pending"),
            isNull(knowledgeDrafts.preVerdict),
          ),
        )
        .orderBy(asc(knowledgeDrafts.createdAt))
        .limit(limit);

      const errors: Array<{ draftId: string; reason: string }> = [];
      let processed = 0;

      // 逐条 screen，单条失败不中断整批
      for (const row of rows) {
        try {
          await this.screenDraft({ companyId: input.companyId, draftId: row.id });
          processed += 1;
        } catch (err) {
          errors.push({
            draftId: row.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { processed, errors };
    },
  };
}

export type ReviewerAgentService = ReturnType<typeof reviewerAgentService>;
