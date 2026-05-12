import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  KNOWLEDGE_NODE_TYPES,
  KNOWLEDGE_LEVELS,
  KNOWLEDGE_VOLATILITIES,
} from "@paperclipai/shared";
import { knowledgeDraftService, type KnowledgeDraftActor } from "./knowledge-drafts.js";

/**
 * Drafter 触发种类。决定走哪个 prompt 模板。
 * - task_complete：Path A 任务收尾自评（issue 状态 → done）
 * - issue_reopened / approval_rejected / run_cancelled：Path B 3 个失败信号
 */
export type KnowledgeDrafterTriggerKind =
  | "task_complete"
  | "issue_reopened"
  | "approval_rejected"
  | "run_cancelled";

export interface KnowledgeDrafterTrigger {
  kind: KnowledgeDrafterTriggerKind;
  companyId: string;
  issueId?: string | null;
  runId?: string | null;
  approvalId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  /** 因 kind 不同携带不同字段；drafter 内部按 kind 渲染 prompt */
  context: Record<string, unknown>;
}

export interface KnowledgeDrafterResult {
  /** 成功落库的 draft ID 列表（按返回顺序） */
  draftIds: string[];
  /** 任意阶段失败的简短原因；成功路径为 undefined */
  error?: string;
}

/** Drafter 注入的 LLM 客户端接口（生产注入 llmWikiService） */
export interface DrafterChatClient {
  completeChat(opts: {
    system: string;
    user: string;
    jsonMode?: boolean;
    model?: string;
    temperature?: number;
  }): Promise<string>;
}

/** LLM 输出的单条 draft 的最小校验形状 */
const llmDraftSchema = z.object({
  type: z.enum(KNOWLEDGE_NODE_TYPES),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(8000),
  confidence: z.number().min(0).max(1).default(0.5),
  volatility: z.enum(KNOWLEDGE_VOLATILITIES).optional(),
  level: z.enum(KNOWLEDGE_LEVELS).optional(),
  used_for: z.array(z.string()).optional(),
  business_domain_name: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const llmEnvelopeSchema = z.object({
  drafts: z.array(z.unknown()),
});

/** 系统级 prompt 头，所有 kind 共用 */
const SYSTEM_PROMPT = `你是一个知识库 curator，专门把 Paperclip 平台 Agent 的工作产出提炼成可复用的知识条目。

**任务**：基于给定的触发场景与上下文，输出 0 到 N 条 knowledge draft（条目候选）。如果场景中没有值得沉淀的内容，直接输出空数组。

**质量要求**：
- 教训（lesson）要带"症状/根因/下次怎么做"
- 规则（rule）要明确"什么场景适用"
- 决策（decision）要有"备选方案 + 选择理由"
- 事实（fact）要客观可验证
- 内容用 Markdown；可在 content 里写 [[<uuid>]] 引用已有节点（如果上下文中有 ID）

**输出格式**（严格 JSON object，外层 envelope）：

\`\`\`json
{
  "drafts": [
    {
      "type": "lesson|rule|decision|fact|concept",
      "title": "<= 100 字简洁标题",
      "content": "Markdown 正文，<= 8000 字",
      "confidence": 0.5,
      "volatility": "stable|slow|fast",
      "used_for": ["bug-fix", "architecture", ...],
      "metadata": { ... }
    }
  ]
}
\`\`\`

如果场景里没值得记录的，输出 \`{"drafts": []}\`。不要解释、不要 chain of thought、直接输出 JSON。`;

/** kind → user prompt 模板。渲染时把 context 字段插值进去。 */
function renderUserPrompt(trigger: KnowledgeDrafterTrigger): string {
  const ctx = trigger.context as Record<string, unknown>;
  const safeJson = (v: unknown) => JSON.stringify(v, null, 2);
  switch (trigger.kind) {
    case "task_complete":
      return `场景：Agent 完成了一个任务（issue 标记为 done）。

Issue 信息：
${safeJson({ title: ctx.title, description: ctx.description, status: ctx.status })}

最近评论（最多 10 条）：
${safeJson(ctx.comments ?? [])}

Run 输出（如果有）：
${(ctx.runLogs as string | undefined)?.slice(0, 4000) ?? "(无)"}

问：本次任务中有什么值得沉淀到知识库的教训 / 规则 / 决策 / 事实？`;
    case "issue_reopened":
      return `场景：一个本已 done 的 issue 被重新打开了（从 ${ctx.previousStatus ?? "?"} → ${ctx.status ?? "?"}）。这通常意味着上次"完成"是错的。

Issue 信息：
${safeJson({ title: ctx.title, description: ctx.description })}

最近评论：
${safeJson(ctx.comments ?? [])}

问：reopen 暴露了什么应该记下的教训或规则？（避免下次"假完成"）`;
    case "approval_rejected":
      return `场景：一个 approval 被驳回。

Approval 上下文：
${safeJson(ctx)}

问：驳回理由揭示了什么需要沉淀的规则 / 教训 / 决策？`;
    case "run_cancelled":
      return `场景：Agent run 被取消或超时。

Run 上下文：
${safeJson(ctx)}

问：取消 / 超时 暴露了什么应该记下的教训或规则？（避免再次卡住）`;
  }
}

/** kind → source 字符串映射（写入 knowledge_drafts.source） */
function sourceForKind(kind: KnowledgeDrafterTriggerKind): "agent_self_review" | "failure_signal" {
  return kind === "task_complete" ? "agent_self_review" : "failure_signal";
}

/**
 * 知识 Drafter 服务（Phase 1b-1）。
 *
 * 触发方（issues route / approval service / heartbeat）以 fire-and-forget
 * 方式调用 run(trigger)；失败被 catch 后仅记录 warning，不影响主流程。
 *
 * 内部串行：
 *   1. 选 prompt 模板（kind）→ 渲染 context 进 user prompt
 *   2. 调 LLM completeChat({ jsonMode: true })
 *   3. 截 \`\`\`json 围栏 + JSON.parse；envelope schema 校验
 *   4. 对每个 element 用 llmDraftSchema 校验；非法的跳过
 *   5. 对每个有效 draft 调 knowledgeDraftService.create()
 *   6. 返回 draftIds + 可能的 error
 *
 * 任何 step 失败 → draftIds 空 + error 字符串。**不抛**，交给调用方 catch。
 */
export function knowledgeDrafterService(db: Db, llm: DrafterChatClient) {
  const drafts = knowledgeDraftService(db);

  return {
    async run(trigger: KnowledgeDrafterTrigger): Promise<KnowledgeDrafterResult> {
      let completion: string;
      try {
        completion = await llm.completeChat({
          system: SYSTEM_PROMPT,
          user: renderUserPrompt(trigger),
          jsonMode: true,
          temperature: 0.2,
        });
      } catch (err) {
        return { draftIds: [], error: err instanceof Error ? err.message : String(err) };
      }

      // 剥 ```json ... ``` 围栏（DashScope 等 endpoint 即使 jsonMode 也偶尔加）
      const stripped = completion.replace(/^```(?:json)?\s*\n?/i, "").replace(/```\s*$/, "").trim();

      let envelope: unknown;
      try {
        envelope = JSON.parse(stripped);
      } catch (err) {
        return { draftIds: [], error: `json parse failed: ${(err as Error).message}` };
      }

      const parsed = llmEnvelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        return { draftIds: [], error: `envelope schema mismatch: ${parsed.error.message}` };
      }

      // 准备 actor —— drafter 的写入身份。trigger.agentId / userId 二选一。
      // 当两者都缺时（理论不该发生），用 system user 兜底。
      const actor: KnowledgeDraftActor =
        trigger.userId != null
          ? { type: "user", userId: trigger.userId, isAdmin: false }
          : trigger.agentId != null
            ? { type: "agent", agentId: trigger.agentId, runId: trigger.runId ?? null }
            : { type: "user", userId: "system", isAdmin: false };

      const draftIds: string[] = [];
      for (const rawDraft of parsed.data.drafts) {
        const draftParsed = llmDraftSchema.safeParse(rawDraft);
        if (!draftParsed.success) continue; // 静默跳过非法条目

        const d = draftParsed.data;
        try {
          const created = await drafts.create({
            companyId: trigger.companyId,
            actor,
            payload: {
              title: d.title,
              content: d.content,
              type: d.type,
              level: d.level ?? "project",
              business_domain_name: d.business_domain_name ?? "general",
              metadata: d.metadata ?? {},
              volatility: d.volatility,
              confidence: d.confidence,
              source: sourceForKind(trigger.kind),
              source_issue_id: trigger.issueId ?? null,
              source_run_id: trigger.runId ?? null,
              skip_review: false,
              valid_until: null,
              target_node_id: null,
            },
          });
          draftIds.push(created.id);
        } catch {
          // 单条失败不阻塞其余（如业务域不存在等）；继续下一条
          continue;
        }
      }

      return { draftIds };
    },
  };
}

export type KnowledgeDrafterService = ReturnType<typeof knowledgeDrafterService>;
