# LLM-Wiki Phase 3b — Reviewer Agent + Routine 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `knowledge_drafts` 增加 Reviewer Agent 初筛：调用 LLM 给每条 pending draft 打 `pre_verdict` ∈ {recommend_approve / recommend_reject / needs_human} + reasoning + detected_conflicts；并通过周期任务 hourly 跑一次，把人工审查工作量放大 5-10 倍。

**Architecture:** 服务端 `reviewerAgentService(db, retriever, llm)` 暴露 `screenDraft(draftId)` 与 `screenPendingDrafts(companyId)`。LLM prompt 输入 draft 内容 + 检索器返回的 Top-3 相似已存节点（用于冲突检测）；LLM 输出严格 JSON。落库直接更新 `knowledge_drafts.pre_verdict / pre_verdict_reasoning / pre_verdict_at / detected_conflicts`。触发方式：HTTP `POST /api/knowledge/reviewer/run`（手动+routine 用）+ 进程内 setInterval 定时器（opt-in，env 控制）。UI `/knowledge/drafts/pending` 卡片显示 verdict 徽章 + reasoning 折叠 + 「一键应用 recommend_approve」批量按钮。

**Tech Stack:** TypeScript / Drizzle ORM / Express 5 / Vitest（mock-only）/ React 19 / shadcn/ui / DashScope OpenAI 兼容模式（qwen-plus chat）。

**Phase 3a / 3c 留口（不实现）：**
- `pre_verdict` 字段供 Phase 3c 健康指标 `审查 backlog 时长` 读取
- `detected_conflicts` 数组供 Phase 3a 演化引擎「合并/冲突」行为消费
- 未来真正的 Reviewer Agent（agents.role='reviewer'）由 Routine 2 + Agent 派工实现，本 plan 用 server-side 服务+ in-process 定时器替代

**前置状态（已落地，不需改）：**
- `knowledge_drafts` schema 已有 `pre_verdict / pre_verdict_reasoning / pre_verdict_at / detected_conflicts` 4 字段（migration 0084）
- `knowledge_drafts_unscreened_idx` 索引：`WHERE status='pending' AND pre_verdict IS NULL`
- `listKnowledgeDraftsQuerySchema` 已含 `pre_verdict` 过滤
- `KnowledgeDraft` UI 类型已含 4 个字段
- `knowledgeRetrieverService(db, llm).search()` 用于查相似节点
- `llmWikiService(db).completeChat()` 用于 LLM 调用

---

## File Structure

**Create:**
- `server/src/services/knowledge-reviewer.ts` — reviewerAgentService 工厂
- `server/src/services/knowledge-reviewer.test.ts` — 单元测试（mocked LLM + retriever + db）
- `server/src/services/knowledge-reviewer-scheduler.ts` — startReviewerScheduler() / stopReviewerScheduler() in-process 定时
- `docs/superpowers/plans/2026-05-13-llm-wiki-phase-3b-smoke.md` — 手动 smoke 清单

**Modify:**
- `packages/shared/src/validators/knowledge.ts` — 添加 `reviewerRunQuerySchema`、`batchApplyVerdictSchema`、`KNOWLEDGE_PRE_VERDICT_VALUES`
- `server/src/services/index.ts` — re-export reviewerAgentService
- `server/src/routes/knowledge.ts` — 添加 `POST /api/knowledge/reviewer/run` + `POST /api/knowledge/drafts/batch-apply-verdict`
- `server/src/__tests__/knowledge-routes.test.ts` — 新 2 个 route 用例
- `server/src/app.ts` — wire reviewer 服务 + 启动 scheduler（env gated）
- `ui/src/api/knowledge.ts` — 添加 `reviewerRun`、`batchApplyVerdict` 客户端方法
- `ui/src/pages/KnowledgeDrafts.tsx` — pre_verdict 徽章 + reasoning 折叠 + 一键应用批量按钮 + 顶部「触发 Reviewer」按钮

---

## Task 1: shared validators

**Files:**
- Modify: `packages/shared/src/validators/knowledge.ts`

- [ ] **Step 1: 写失败的测试（如不存在则在文件末尾追加）**

修改 `packages/shared/src/validators/knowledge.test.ts`（若文件不存在则新建并复制现有 imports）。在合适位置加：

```ts
import {
  KNOWLEDGE_PRE_VERDICT_VALUES,
  reviewerRunQuerySchema,
  batchApplyVerdictSchema,
} from "../validators/knowledge.js";

describe("reviewerRunQuerySchema", () => {
  it("accepts default (no limit)", () => {
    expect(reviewerRunQuerySchema.parse({}).limit).toBe(50);
  });
  it("clamps limit ≤ 200", () => {
    expect(() => reviewerRunQuerySchema.parse({ limit: 999 })).toThrow();
  });
});

describe("batchApplyVerdictSchema", () => {
  it("accepts recommend_approve action with draft_ids", () => {
    const parsed = batchApplyVerdictSchema.parse({
      verdict: "recommend_approve",
      draft_ids: ["id1", "id2"],
    });
    expect(parsed.draft_ids.length).toBe(2);
  });
  it("rejects empty draft_ids", () => {
    expect(() => batchApplyVerdictSchema.parse({
      verdict: "recommend_approve",
      draft_ids: [],
    })).toThrow();
  });
});

describe("KNOWLEDGE_PRE_VERDICT_VALUES", () => {
  it("has 3 values", () => {
    expect(KNOWLEDGE_PRE_VERDICT_VALUES).toEqual([
      "recommend_approve",
      "recommend_reject",
      "needs_human",
    ]);
  });
});
```

- [ ] **Step 2: 运行测试，预期失败**

```bash
cd D:/aiprojects/paperclip && pnpm --filter @paperclipai/shared exec vitest run src/validators/knowledge.test.ts
```

预期：`KNOWLEDGE_PRE_VERDICT_VALUES is not exported` / `reviewerRunQuerySchema is not exported` 等。

- [ ] **Step 3: 最小实现（追加到 `packages/shared/src/validators/knowledge.ts` 末尾）**

```ts
// ──────────────────────────────────────────────────────────────────
// Phase 3b: Reviewer Agent 初筛
// ──────────────────────────────────────────────────────────────────

/**
 * Reviewer Agent 三档初筛结果。
 * - recommend_approve：质量高、与既有节点无冲突 → 人审可一键过
 * - recommend_reject：信息量低 / 与既有节点重复 / 无价值 → 人审可一键驳
 * - needs_human：confidence 中等、检测到 conflicts、或新主题需人判断
 */
export const KNOWLEDGE_PRE_VERDICT_VALUES = [
  "recommend_approve",
  "recommend_reject",
  "needs_human",
] as const;
export type KnowledgePreVerdict = (typeof KNOWLEDGE_PRE_VERDICT_VALUES)[number];

/**
 * Reviewer 批量初筛入参。limit 用于单次最大处理 draft 数，避免长事务+OpenAI quota 突刺。
 * companyId 在 query 层强校验；此处只校验 limit。
 */
export const reviewerRunQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReviewerRunQuery = z.infer<typeof reviewerRunQuerySchema>;

/**
 * 一键批量应用初筛建议：对 verdict=recommend_approve 的 draft 一键 approve；
 * 对 verdict=recommend_reject 的 draft 一键 reject。
 * draft_ids 由 UI 收集（用户勾选/全选当前 Tab 内的对应 verdict）。
 */
export const batchApplyVerdictSchema = z.object({
  verdict: z.enum(["recommend_approve", "recommend_reject"]),
  draft_ids: z.array(z.string().uuid()).min(1).max(100),
  review_notes: z.string().max(500).optional(),
});
export type BatchApplyVerdict = z.infer<typeof batchApplyVerdictSchema>;
```

- [ ] **Step 4: 在 `packages/shared/src/index.ts` 确认 re-export（应已 export 整个 validators/knowledge 文件，无需改）**

```bash
grep -n "knowledge" D:/aiprojects/paperclip/packages/shared/src/index.ts | head -5
```

如果输出中没有从 `./validators/knowledge.js` re-export 的行，补一行；否则跳过。

- [ ] **Step 5: 跑测试，预期通过**

```bash
cd D:/aiprojects/paperclip && pnpm --filter @paperclipai/shared exec vitest run src/validators/knowledge.test.ts
```

预期：新增 3 个测试全部 PASS，且 shared 包内其他测试不受影响。

- [ ] **Step 6: 提交**

```bash
cd D:/aiprojects/paperclip && git add packages/shared/src/validators/knowledge.ts packages/shared/src/validators/knowledge.test.ts && git commit -m "feat(llm-wiki): reviewerRun + batchApplyVerdict schemas (Phase 3b Task 1)"
```

---

## Task 2: reviewerAgentService — screenDraft（单条初筛）

**Files:**
- Create: `server/src/services/knowledge-reviewer.ts`
- Create: `server/src/services/knowledge-reviewer.test.ts`

- [ ] **Step 1: 写失败的测试**

新建 `server/src/services/knowledge-reviewer.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { reviewerAgentService, REVIEWER_SYSTEM_PROMPT } from "./knowledge-reviewer.js";

// Drizzle 在测试中 mock 成手写 fluent builder
function fakeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([
      {
        id: "draft-1",
        companyId: "co-1",
        proposedTitle: "Avoid global mutable singletons",
        proposedContent: "Singletons make tests flaky; prefer factory.",
        proposedType: "lesson",
        proposedLevel: "company",
        confidence: 0.85,
        source: "agent_self_review",
        status: "pending",
        preVerdict: null,
      },
    ]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: "draft-1" }]),
  } as any;
}

const fakeRetriever = {
  search: vi.fn().mockResolvedValue({
    results: [],
    search_type: "semantic",
    took_ms: 1,
  }),
};

const fakeLlm = {
  completeChat: vi.fn().mockResolvedValue(JSON.stringify({
    verdict: "recommend_approve",
    reasoning: "Clear lesson with concrete advice, no conflicts.",
    conflicts: [],
  })),
};

describe("reviewerAgentService.screenDraft", () => {
  it("writes pre_verdict=recommend_approve when LLM returns clean approve", async () => {
    const db = fakeDb();
    const svc = reviewerAgentService(db, fakeRetriever as any, fakeLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.pre_verdict).toBe("recommend_approve");
    expect(result.reasoning).toContain("Clear lesson");
    expect(result.conflicts).toEqual([]);

    // 校验落库
    const updateArgs = db.set.mock.calls[0]?.[0];
    expect(updateArgs.preVerdict).toBe("recommend_approve");
    expect(updateArgs.preVerdictReasoning).toContain("Clear lesson");
  });

  it("falls back to needs_human when LLM JSON cannot parse", async () => {
    const db = fakeDb();
    const brokenLlm = { completeChat: vi.fn().mockResolvedValue("not json") };
    const svc = reviewerAgentService(db, fakeRetriever as any, brokenLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.pre_verdict).toBe("needs_human");
    expect(result.reasoning).toMatch(/parse|invalid/i);
  });

  it("clamps reasoning to ≤ 200 chars", async () => {
    const db = fakeDb();
    const longLlm = {
      completeChat: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: "recommend_approve",
        reasoning: "x".repeat(500),
        conflicts: [],
      })),
    };
    const svc = reviewerAgentService(db, fakeRetriever as any, longLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.reasoning.length).toBeLessThanOrEqual(200);
  });

  it("rejects unknown verdict from LLM as needs_human", async () => {
    const db = fakeDb();
    const weirdLlm = {
      completeChat: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: "MAYBE",
        reasoning: "ambiguous",
        conflicts: [],
      })),
    };
    const svc = reviewerAgentService(db, fakeRetriever as any, weirdLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.pre_verdict).toBe("needs_human");
  });

  it("throws 404 when draft not found", async () => {
    const db = fakeDb();
    db.limit.mockResolvedValueOnce([]);
    const svc = reviewerAgentService(db, fakeRetriever as any, fakeLlm as any);
    await expect(
      svc.screenDraft({ companyId: "co-1", draftId: "missing" }),
    ).rejects.toThrow(/not found/i);
  });

  it("passes retriever Top-K similar nodes into LLM prompt", async () => {
    const db = fakeDb();
    const retriever2 = {
      search: vi.fn().mockResolvedValue({
        results: [
          { id: "node-A", title: "Singletons are evil", snippet: "..." },
        ],
        search_type: "semantic",
        took_ms: 5,
      }),
    };
    const recordingLlm = {
      completeChat: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: "needs_human",
        reasoning: "duplicates existing node",
        conflicts: ["node-A"],
      })),
    };
    const svc = reviewerAgentService(db, retriever2 as any, recordingLlm as any);
    await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    // 验证 LLM 收到包含 "node-A" 的 prompt
    const prompt = recordingLlm.completeChat.mock.calls[0]?.[0];
    expect(JSON.stringify(prompt)).toContain("node-A");
  });
});
```

- [ ] **Step 2: 跑测试，预期失败**

```bash
cd D:/aiprojects/paperclip/server && pnpm exec vitest run src/services/knowledge-reviewer.test.ts
```

预期：`Cannot find module './knowledge-reviewer.js'`。

- [ ] **Step 3: 实现服务**

新建 `server/src/services/knowledge-reviewer.ts`：

```ts
import { and, eq } from "drizzle-orm";
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
 * 失败不抛：单条 screen 失败时落库 pre_verdict=needs_human + reason，让人介入。
 * 这样 Routine 批量跑时不会因为某条 draft 卡死整个 batch。
 */

export interface ReviewerLlmClient {
  completeChat(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string>;
}

const SIMILARITY_FLOOR_FOR_CONFLICT_CHECK = 0.5;
const TOP_K_NEIGHBORS = 3;
const REASONING_MAX_CHARS = 200;

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

只输出 JSON，不要 markdown 围栏，不要解释。
`.trim();

export function reviewerAgentService(
  db: Db,
  retriever: KnowledgeRetrieverService,
  llm: ReviewerLlmClient,
) {
  return {
    /**
     * 给单条 draft 打 pre_verdict。失败时落 needs_human + 错误理由，永远写库。
     */
    async screenDraft(input: { companyId: string; draftId: string }): Promise<{
      pre_verdict: "recommend_approve" | "recommend_reject" | "needs_human";
      reasoning: string;
      conflicts: string[];
    }> {
      // 1. 读 draft（多租户隔离）
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

      // 2. 查相似既有节点（用 draft 标题+内容作为 query）
      let neighbors: Array<{ id: string; title: string; snippet: string }> = [];
      try {
        const query = `${draft.proposedTitle}\n\n${draft.proposedContent}`.trim();
        const result = await retriever.search({
          companyId: input.companyId,
          query,
          limit: TOP_K_NEIGHBORS,
        });
        neighbors = result.results
          .filter((r) => r.similarity >= SIMILARITY_FLOOR_FOR_CONFLICT_CHECK)
          .map((r) => ({ id: r.id, title: r.title, snippet: r.snippet }));
      } catch (err) {
        logger.warn({ err, draftId: input.draftId }, "reviewer: retriever failed, continuing without neighbors");
      }

      // 3. 构造 user message
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

      // 4. 调 LLM
      let raw = "";
      try {
        raw = await llm.completeChat([
          { role: "system", content: REVIEWER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ]);
      } catch (err) {
        logger.warn({ err, draftId: input.draftId }, "reviewer: LLM call failed");
        return await writeBack(input, "needs_human", "LLM 调用失败，请人审", []);
      }

      // 5. 解析 + 兜底
      let parsed: { verdict?: string; reasoning?: string; conflicts?: string[] };
      try {
        // 容错：去掉可能的 markdown 围栏
        const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        parsed = JSON.parse(cleaned);
      } catch {
        return await writeBack(input, "needs_human", "Reviewer 输出无法解析为 JSON，请人审", []);
      }

      const validVerdicts = ["recommend_approve", "recommend_reject", "needs_human"] as const;
      const verdict = (validVerdicts as readonly string[]).includes(parsed.verdict ?? "")
        ? (parsed.verdict as (typeof validVerdicts)[number])
        : "needs_human";
      const reasoning = (parsed.reasoning ?? "").slice(0, REASONING_MAX_CHARS);
      const conflicts = Array.isArray(parsed.conflicts)
        ? parsed.conflicts.filter((c): c is string => typeof c === "string").slice(0, 20)
        : [];

      return await writeBack(input, verdict, reasoning, conflicts);
    },

    /**
     * 拉所有 status=pending 且 pre_verdict IS NULL 的 draft，按 created_at 升序逐条 screen。
     * 受 limit 限制，避免一次跑爆 LLM quota。返回 {processed, errors}。
     */
    async screenPendingDrafts(input: { companyId: string; limit?: number }): Promise<{
      processed: number;
      errors: Array<{ draftId: string; reason: string }>;
    }> {
      const limit = input.limit ?? 50;
      const rows = await db
        .select({ id: knowledgeDrafts.id })
        .from(knowledgeDrafts)
        .where(
          and(
            eq(knowledgeDrafts.companyId, input.companyId),
            eq(knowledgeDrafts.status, "pending"),
            // pre_verdict IS NULL 用 raw SQL，Drizzle helper isNull 也行：
          ),
        )
        .limit(limit);
      // 注：上面的 query 没法直接表达 IS NULL；改成 raw SQL：
      // → 在最终实现时用 isNull(knowledgeDrafts.preVerdict)，import { isNull } from "drizzle-orm"
      // 此处保留示意，Step 3 实现里会修正。

      const errors: Array<{ draftId: string; reason: string }> = [];
      let processed = 0;
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

  // ────────────────────────────────────────────────────────
  // 私有：落库
  // ────────────────────────────────────────────────────────
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
}

export type ReviewerAgentService = ReturnType<typeof reviewerAgentService>;
```

**重要修正：上面 `screenPendingDrafts` 里的 `pre_verdict IS NULL` 用 drizzle 的 `isNull` 表达。**最终代码应写：

```ts
import { and, eq, isNull, asc } from "drizzle-orm";
// ...
.where(
  and(
    eq(knowledgeDrafts.companyId, input.companyId),
    eq(knowledgeDrafts.status, "pending"),
    isNull(knowledgeDrafts.preVerdict),
  ),
)
.orderBy(asc(knowledgeDrafts.createdAt))
.limit(limit);
```

- [ ] **Step 4: 跑测试，预期通过**

```bash
cd D:/aiprojects/paperclip/server && pnpm exec vitest run src/services/knowledge-reviewer.test.ts
```

预期：6 个测试全部 PASS。

- [ ] **Step 5: 在 services/index.ts 加 export**

修改 `server/src/services/index.ts`，找到现有 knowledge-* 的 re-export 行后追加：

```ts
export { reviewerAgentService, type ReviewerAgentService, REVIEWER_SYSTEM_PROMPT } from "./knowledge-reviewer.js";
```

- [ ] **Step 6: 提交**

```bash
cd D:/aiprojects/paperclip && git add server/src/services/knowledge-reviewer.ts server/src/services/knowledge-reviewer.test.ts server/src/services/index.ts && git commit -m "feat(llm-wiki): reviewerAgentService — screen drafts to pre_verdict (Phase 3b Task 2)"
```

---

## Task 3: REST routes — POST /reviewer/run + POST /drafts/batch-apply-verdict

**Files:**
- Modify: `server/src/routes/knowledge.ts`
- Modify: `server/src/__tests__/knowledge-routes.test.ts`

- [ ] **Step 1: 写失败的路由测试（追加到 routes 测试文件末尾）**

在 `server/src/__tests__/knowledge-routes.test.ts` 现有 describe block 内或文件末尾追加：

```ts
describe("POST /api/knowledge/reviewer/run", () => {
  it("returns processed count after screening", async () => {
    const { app, screenPendingDraftsMock } = buildTestApp();
    screenPendingDraftsMock.mockResolvedValue({ processed: 3, errors: [] });
    const res = await request(app)
      .post("/api/knowledge/reviewer/run?companyId=co-1")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(3);
    expect(res.body.data.errors).toEqual([]);
  });

  it("rejects when companyId missing", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/knowledge/reviewer/run");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/knowledge/drafts/batch-apply-verdict", () => {
  it("approves all listed drafts when verdict=recommend_approve", async () => {
    const { app, markApprovedMock, materializeMock } = buildTestApp();
    markApprovedMock.mockImplementation(async ({ id }) => ({}));
    materializeMock.mockImplementation(async ({ draftId }) => ({ nodeId: `node-${draftId}` }));
    const res = await request(app)
      .post("/api/knowledge/drafts/batch-apply-verdict?companyId=co-1")
      .send({
        verdict: "recommend_approve",
        draft_ids: ["d1", "d2"],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.approved_count).toBe(2);
  });

  it("rejects all listed drafts when verdict=recommend_reject", async () => {
    const { app, rejectMock } = buildTestApp();
    rejectMock.mockResolvedValue({});
    const res = await request(app)
      .post("/api/knowledge/drafts/batch-apply-verdict?companyId=co-1")
      .send({
        verdict: "recommend_reject",
        draft_ids: ["d1", "d2", "d3"],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.rejected_count).toBe(3);
  });
});
```

**注：** `buildTestApp` 已存在于该测试文件中；需要新增 `screenPendingDraftsMock` 到测试 harness 的服务 mock 集合。在现有 harness 里的 `const drafts = { ... }` 处追加：

```ts
const reviewer = {
  screenPendingDrafts: vi.fn().mockResolvedValue({ processed: 0, errors: [] }),
  screenDraft: vi.fn(),
};
// ... 在 mock 注入处：
vi.mocked(reviewerAgentService).mockReturnValue(reviewer as any);
// 在 buildTestApp 的 return 处：return { app, ..., screenPendingDraftsMock: reviewer.screenPendingDrafts };
```

- [ ] **Step 2: 跑测试，预期失败**

```bash
cd D:/aiprojects/paperclip/server && pnpm exec vitest run src/__tests__/knowledge-routes.test.ts
```

预期：`Cannot find module reviewerAgentService` 或 route 返回 404。

- [ ] **Step 3: 在 `server/src/routes/knowledge.ts` 顶部 import 增加：**

```ts
import {
  // ...现有 import
  knowledgeFeedbackSchema,
  knowledgeSearchQuerySchema,
  reviewerRunQuerySchema,
  batchApplyVerdictSchema,
} from "@paperclipai/shared";
import {
  knowledgeDraftService,
  knowledgeNodeWriterService,
  llmWikiService,
  knowledgeRetrieverService,
  knowledgeFeedbackService,
  reviewerAgentService,
} from "../services/index.js";
```

在工厂函数顶部（已有 retriever/feedback 构造的同一处）追加：

```ts
const reviewer = reviewerAgentService(db, retriever, llm);
```

在所有路由的最后（return router 前）追加两个 route handler：

```ts
  // ============================================================
  // POST /api/knowledge/reviewer/run
  // ============================================================
  router.post("/reviewer/run", async (req, res) => {
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    assertBoard(req); // 初筛触发仅人审用户（Phase 3b MVP）
    const parsed = reviewerRunQuerySchema.safeParse({
      limit: req.body?.limit ?? req.query.limit,
    });
    if (!parsed.success) {
      throw badRequest("invalid body", parsed.error.format());
    }
    const result = await reviewer.screenPendingDrafts({
      companyId,
      limit: parsed.data.limit,
    });
    res.json({ data: result });
  });

  // ============================================================
  // POST /api/knowledge/drafts/batch-apply-verdict
  // ============================================================
  router.post(
    "/drafts/batch-apply-verdict",
    validate(batchApplyVerdictSchema),
    async (req, res) => {
      const companyId = requireCompanyId(req);
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const actor = getActorInfo(req);
      const { verdict, draft_ids, review_notes } = req.body as {
        verdict: "recommend_approve" | "recommend_reject";
        draft_ids: string[];
        review_notes?: string;
      };

      if (verdict === "recommend_approve") {
        // 复用 batchMarkApproved + materialize
        const { approvedIds, failed } = await drafts.batchMarkApproved({
          companyId,
          ids: draft_ids,
          reviewerUserId: actor.actorId,
          notes: review_notes,
        });
        const materializeFailed: Array<{ id: string; reason: string }> = [];
        let approvedCount = 0;
        for (const id of approvedIds) {
          try {
            await nodeWriter.materialize({
              companyId,
              draftId: id,
              reviewerUserId: actor.actorId,
            });
            approvedCount += 1;
          } catch (err) {
            materializeFailed.push({
              id,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        res.json({
          data: {
            verdict,
            approved_count: approvedCount,
            failed: [...failed, ...materializeFailed],
          },
        });
        return;
      }

      // recommend_reject 分支：逐条 drafts.reject
      let rejectedCount = 0;
      const failed: Array<{ id: string; reason: string }> = [];
      for (const id of draft_ids) {
        try {
          await drafts.reject({
            companyId,
            id,
            reviewerUserId: actor.actorId,
            notes: review_notes,
          });
          rejectedCount += 1;
        } catch (err) {
          failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      res.json({ data: { verdict, rejected_count: rejectedCount, failed } });
    },
  );
```

- [ ] **Step 4: 跑测试，预期通过**

```bash
cd D:/aiprojects/paperclip/server && pnpm exec vitest run src/__tests__/knowledge-routes.test.ts
```

预期：2 个新 describe 共 4 个测试 PASS。原有所有 routes 测试也仍 PASS。

- [ ] **Step 5: 提交**

```bash
cd D:/aiprojects/paperclip && git add server/src/routes/knowledge.ts server/src/__tests__/knowledge-routes.test.ts && git commit -m "feat(llm-wiki): REST POST /reviewer/run + /drafts/batch-apply-verdict (Phase 3b Task 3)"
```

---

## Task 4: 进程内 hourly scheduler（opt-in）

**Files:**
- Create: `server/src/services/knowledge-reviewer-scheduler.ts`
- Create: `server/src/services/knowledge-reviewer-scheduler.test.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: 写失败的测试**

`server/src/services/knowledge-reviewer-scheduler.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startReviewerScheduler } from "./knowledge-reviewer-scheduler.js";

describe("reviewer scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not start when env flag is off", () => {
    delete process.env.KNOWLEDGE_REVIEWER_ENABLED;
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }]);
    const screen = vi.fn().mockResolvedValue({ processed: 0, errors: [] });
    const handle = startReviewerScheduler({
      listCompanies: list,
      reviewerForCompany: () => ({ screenPendingDrafts: screen } as any),
      intervalMs: 60_000,
    });
    expect(handle).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("starts when enabled and fires immediately + every intervalMs", async () => {
    process.env.KNOWLEDGE_REVIEWER_ENABLED = "true";
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }, { id: "co-2" }]);
    const screen = vi.fn().mockResolvedValue({ processed: 1, errors: [] });
    const handle = startReviewerScheduler({
      listCompanies: list,
      reviewerForCompany: () => ({ screenPendingDrafts: screen } as any),
      intervalMs: 60_000,
    });
    expect(handle).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); // 让首次立即触发的 microtask 跑完
    expect(screen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toHaveBeenCalledTimes(4); // 又触发一轮 2 公司
    handle?.stop();
  });

  it("swallows screen errors and keeps the loop alive", async () => {
    process.env.KNOWLEDGE_REVIEWER_ENABLED = "true";
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }]);
    const screen = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ processed: 5, errors: [] });
    const handle = startReviewerScheduler({
      listCompanies: list,
      reviewerForCompany: () => ({ screenPendingDrafts: screen } as any),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen).toHaveBeenCalledTimes(2);
    handle?.stop();
  });
});
```

- [ ] **Step 2: 跑测试，预期失败**

```bash
cd D:/aiprojects/paperclip/server && pnpm exec vitest run src/services/knowledge-reviewer-scheduler.test.ts
```

预期：`Cannot find module ...`

- [ ] **Step 3: 实现**

新建 `server/src/services/knowledge-reviewer-scheduler.ts`：

```ts
import { logger } from "../middleware/logger.js";
import type { ReviewerAgentService } from "./knowledge-reviewer.js";

/**
 * 进程内 Reviewer 调度器（Phase 3b MVP）。
 *
 * 启用：env `KNOWLEDGE_REVIEWER_ENABLED=true`
 * 周期：env `KNOWLEDGE_REVIEWER_INTERVAL_MINUTES`（默认 60min）
 *
 * 行为：启动时立即跑一次，然后每 interval 跑一次；对每个公司分别调
 * reviewer.screenPendingDrafts。失败被 catch 吞掉只 logger.warn，不打断 loop。
 *
 * 上线后被正式 Routine（Routine 2 hourly-draft-pre-review）替代时，
 * 通过 env 关闭 + 把 Routine 配置成调 `POST /api/knowledge/reviewer/run`。
 */

export interface ReviewerSchedulerDeps {
  listCompanies: () => Promise<Array<{ id: string }>>;
  reviewerForCompany: (companyId: string) => ReviewerAgentService;
  intervalMs?: number;
}

export interface ReviewerSchedulerHandle {
  stop: () => void;
}

export function startReviewerScheduler(
  deps: ReviewerSchedulerDeps,
): ReviewerSchedulerHandle | null {
  if (process.env.KNOWLEDGE_REVIEWER_ENABLED !== "true") {
    return null;
  }
  const intervalMs =
    deps.intervalMs ??
    Number(process.env.KNOWLEDGE_REVIEWER_INTERVAL_MINUTES ?? "60") * 60_000;

  let running = false;

  async function tick() {
    if (running) {
      logger.warn("reviewer scheduler: previous tick still running, skip");
      return;
    }
    running = true;
    try {
      const companies = await deps.listCompanies();
      for (const c of companies) {
        try {
          const r = await deps.reviewerForCompany(c.id).screenPendingDrafts({
            companyId: c.id,
          });
          logger.info(
            { companyId: c.id, processed: r.processed, errors: r.errors.length },
            "reviewer scheduler: company done",
          );
        } catch (err) {
          logger.warn({ err, companyId: c.id }, "reviewer scheduler: company failed");
        }
      }
    } catch (err) {
      logger.warn({ err }, "reviewer scheduler: list companies failed");
    } finally {
      running = false;
    }
  }

  // 立即跑一次（不 await，让 caller 立刻返回 handle）
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // 不让 timer 阻塞进程退出（生产 service 是常驻进程，这里只为了 dev/test 优雅退出）
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: 在 `server/src/app.ts` 接入**

找到现有 knowledge 服务构造区域（已有 `knowledgeRetrieverService`、`llmWikiClient` 等的位置），在 issueRoutes 装载后追加：

```ts
import { startReviewerScheduler } from "./services/knowledge-reviewer-scheduler.js";
import { reviewerAgentService } from "./services/index.js";
import { companies as companiesTable } from "@paperclipai/db";

// ... 在合适位置：
const reviewerSchedulerHandle = startReviewerScheduler({
  listCompanies: async () => {
    const rows = await db.select({ id: companiesTable.id }).from(companiesTable);
    return rows;
  },
  reviewerForCompany: (_companyId) => reviewerAgentService(db, knowledgeRetriever, llmWikiClient),
});

// app.on('close', ...) 或类似 graceful-shutdown 钩子里：
//   reviewerSchedulerHandle?.stop();
```

如果 app.ts 现有结构没有 graceful-shutdown 钩子，stop 可以挂在 process SIGTERM 监听上，或者直接不调用 stop（timer 已 unref，会随进程退出消失）。

- [ ] **Step 5: 跑测试**

```bash
cd D:/aiprojects/paperclip/server && pnpm exec vitest run src/services/knowledge-reviewer-scheduler.test.ts
```

预期：3 个测试 PASS。

跑 build 确认 app.ts 没坏：

```bash
cd D:/aiprojects/paperclip/server && pnpm exec tsc --noEmit
```

预期：无 type 错。

- [ ] **Step 6: 提交**

```bash
cd D:/aiprojects/paperclip && git add server/src/services/knowledge-reviewer-scheduler.ts server/src/services/knowledge-reviewer-scheduler.test.ts server/src/app.ts && git commit -m "feat(llm-wiki): in-process hourly reviewer scheduler (Phase 3b Task 4)"
```

---

## Task 5: UI — pre_verdict 徽章 + reasoning 折叠 + 顶部「触发 Reviewer」按钮

**Files:**
- Modify: `ui/src/api/knowledge.ts`
- Modify: `ui/src/pages/KnowledgeDrafts.tsx`

- [ ] **Step 1: 加 API 客户端方法（追加到 `ui/src/api/knowledge.ts` 的 knowledgeApi 末尾）**

```ts
  reviewerRun: (companyId: string, limit?: number) =>
    api.post<{ data: { processed: number; errors: Array<{ draftId: string; reason: string }> } }>(
      `/knowledge/reviewer/run?companyId=${companyId}`,
      limit !== undefined ? { limit } : {},
    ),

  batchApplyVerdict: (
    companyId: string,
    verdict: "recommend_approve" | "recommend_reject",
    draft_ids: string[],
    review_notes?: string,
  ) =>
    api.post<{
      data: {
        verdict: string;
        approved_count?: number;
        rejected_count?: number;
        failed: Array<{ id: string; reason: string }>;
      };
    }>(
      `/knowledge/drafts/batch-apply-verdict?companyId=${companyId}`,
      { verdict, draft_ids, ...(review_notes ? { review_notes } : {}) },
    ),
```

- [ ] **Step 2: 在 KnowledgeDrafts.tsx 加常量（在文件顶部 SOURCE_LABEL 等之后）**

```ts
const PRE_VERDICT_LABEL: Record<NonNullable<KnowledgeDraft["preVerdict"]>, string> = {
  recommend_approve: "建议通过",
  recommend_reject: "建议驳回",
  needs_human: "需人审",
};

const PRE_VERDICT_TONE: Record<NonNullable<KnowledgeDraft["preVerdict"]>, string> = {
  recommend_approve: "bg-emerald-500/15 text-emerald-500",
  recommend_reject: "bg-rose-500/15 text-rose-500",
  needs_human: "bg-amber-500/15 text-amber-500",
};
```

- [ ] **Step 3: 在 draft 卡片渲染处（找到现有卡片的 header / footer），插入 pre_verdict 徽章**

在 draft 卡片当前已有 source 徽章和 type 徽章的同一行（一般是 flex container），紧随其后插入：

```tsx
{draft.preVerdict && (
  <Badge variant="outline" className={cn("text-xs", PRE_VERDICT_TONE[draft.preVerdict])}>
    {PRE_VERDICT_LABEL[draft.preVerdict]}
  </Badge>
)}
```

在卡片内容下方（描述/操作按钮上方）插入 reasoning 折叠区：

```tsx
{draft.preVerdictReasoning && (
  <details className="text-xs text-muted-foreground mt-2">
    <summary className="cursor-pointer select-none">Reviewer 理由</summary>
    <p className="mt-1 whitespace-pre-wrap">{draft.preVerdictReasoning}</p>
    {draft.detectedConflicts.length > 0 && (
      <p className="mt-1 text-rose-500">
        检测到冲突节点：{draft.detectedConflicts.join(", ")}
      </p>
    )}
  </details>
)}
```

- [ ] **Step 4: 添加顶部「触发 Reviewer」按钮**

在 pending Tab 的 toolbar 区（Tabs 下方、列表上方）加：

```tsx
{statusFilter === "pending" && (
  <div className="flex gap-2 my-3">
    <Button
      size="sm"
      variant="outline"
      disabled={triggerMutation.isPending}
      onClick={() => triggerMutation.mutate()}
    >
      {triggerMutation.isPending ? "Reviewer 跑中…" : "触发 Reviewer 初筛"}
    </Button>
    <Button
      size="sm"
      variant="default"
      disabled={
        batchApplyMutation.isPending ||
        recommendApproveIds.length === 0
      }
      onClick={() =>
        batchApplyMutation.mutate({
          verdict: "recommend_approve",
          ids: recommendApproveIds,
        })
      }
    >
      一键通过所有 recommend_approve ({recommendApproveIds.length})
    </Button>
  </div>
)}
```

在组件函数体内（hooks 区）添加：

```tsx
const recommendApproveIds = (draftsQuery.data?.data ?? [])
  .filter((d) => d.preVerdict === "recommend_approve")
  .map((d) => d.id);

const triggerMutation = useMutation({
  mutationFn: () => knowledgeApi.reviewerRun(selectedCompanyId!),
  onSuccess: (res) => {
    pushToast({
      title: `已处理 ${res.data.processed} 条 draft`,
      description: res.data.errors.length > 0 ? `失败 ${res.data.errors.length} 条` : undefined,
    });
    queryClient.invalidateQueries({ queryKey: ["knowledge-drafts"] });
  },
  onError: (err) => pushToast({ title: "触发失败", description: (err as Error).message, variant: "destructive" }),
});

const batchApplyMutation = useMutation({
  mutationFn: ({ verdict, ids }: { verdict: "recommend_approve" | "recommend_reject"; ids: string[] }) =>
    knowledgeApi.batchApplyVerdict(selectedCompanyId!, verdict, ids),
  onSuccess: (res) => {
    pushToast({
      title: res.data.verdict === "recommend_approve"
        ? `已批准 ${res.data.approved_count} 条`
        : `已驳回 ${res.data.rejected_count} 条`,
    });
    queryClient.invalidateQueries({ queryKey: ["knowledge-drafts"] });
  },
});
```

- [ ] **Step 5: 跑 dev server 手验**

```bash
cd D:/aiprojects/paperclip && pnpm dev
```

打开 `http://127.0.0.1:3100/SMO/knowledge/drafts/pending`：
- 应看到顶部「触发 Reviewer 初筛」按钮
- 点按钮后等几秒（看 server log 有 reviewer 调用），刷新页面应看到 draft 卡片出现 verdict 徽章 + 折叠的 reasoning

如果 typecheck 失败，单独跑：

```bash
cd D:/aiprojects/paperclip/ui && pnpm exec tsc --noEmit
```

- [ ] **Step 6: 提交**

```bash
cd D:/aiprojects/paperclip && git add ui/src/api/knowledge.ts ui/src/pages/KnowledgeDrafts.tsx && git commit -m "feat(llm-wiki): UI pre_verdict badge + reasoning + bulk apply (Phase 3b Task 5)"
```

---

## Task 6: smoke 清单 doc

**Files:**
- Create: `docs/superpowers/plans/2026-05-13-llm-wiki-phase-3b-smoke.md`

- [ ] **Step 1: 写 smoke 清单**

```markdown
# LLM-Wiki Phase 3b — Reviewer Agent Smoke

需 server 在 3100、≥3 个 status=pending pre_verdict IS NULL 的 draft。

## 前置

```bash
export KNOWLEDGE_REVIEWER_ENABLED=true
export KNOWLEDGE_REVIEWER_INTERVAL_MINUTES=60
# OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_CHAT_MODEL 已配
pnpm dev
```

## Case 1 — 单次触发 + 落库

```bash
CID=<existing-company-uuid>
BEFORE=$(curl -sS "http://127.0.0.1:3100/api/knowledge/drafts?companyId=$CID&status=pending" \
  | jq '[.data[] | select(.preVerdict == null)] | length')
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/reviewer/run?companyId=$CID" \
  -H "Content-Type: application/json" -d '{"limit": 10}' | jq
AFTER=$(curl -sS "http://127.0.0.1:3100/api/knowledge/drafts?companyId=$CID&status=pending" \
  | jq '[.data[] | select(.preVerdict == null)] | length')
echo "未筛 before=$BEFORE after=$AFTER"
```

期望：`response.data.processed > 0`，`after < before`，被处理的 draft 行 preVerdict 三选一。

## Case 2 — 失败兜底（LLM 报错时）

临时把 OPENAI_API_KEY 设为无效，重启 server，再调 reviewer/run。期望：`processed > 0`，所有处理的 draft 的 preVerdict 都是 `needs_human`、reasoning 含「LLM 调用失败」或「无法解析」。

## Case 3 — 调度器自动跑

```bash
KNOWLEDGE_REVIEWER_ENABLED=true KNOWLEDGE_REVIEWER_INTERVAL_MINUTES=1 pnpm dev
```

等 1 分钟，查 server 日志含 `reviewer scheduler: company done`。再过 1 分钟再次触发。

## Case 4 — UI 徽章 + 一键批量

`http://127.0.0.1:3100/<COMPANY>/knowledge/drafts/pending` →
- 已 screened 的 draft 卡片右上角有徽章
- 折叠区显示 reasoning
- 「一键通过所有 recommend_approve」按钮文案含正确计数；点后所有对应 draft 状态变为 approved 且节点已物化

## Case 5 — 跨公司隔离

用 A 公司 token 调 `/reviewer/run?companyId=<B>` → 401/403（未通过 assertCompanyAccess）。

## 完成判定

| Case | 状态 |
|---|---|
| Case 1 单次触发 + 落库 | ✓ |
| Case 2 失败兜底 needs_human | ✓ |
| Case 3 调度器自动跑 | ✓ |
| Case 4 UI 徽章 + 批量 | ✓ |
| Case 5 跨公司隔离 | ✓ |

≥ 4/5 通过 → Phase 3b 完成；可进 Phase 3a（演化引擎）或 Phase 3c（健康自检）。
```

- [ ] **Step 2: 提交 + 完结**

```bash
cd D:/aiprojects/paperclip && git add docs/superpowers/plans/2026-05-13-llm-wiki-phase-3b-smoke.md && git commit -m "docs(llm-wiki): Phase 3b reviewer smoke checklist (Task 6)"
```

---

## Self-Review 结果

**Spec coverage（PRD §6.4 + §13.3 Routine 2）：**
- ✓ Reviewer Agent 初筛 pre_verdict 三档（Task 2）
- ✓ Reasoning ≤ 200 字（Task 2 reasoning 截断）
- ✓ detected_conflicts 数组（Task 2 + UI 渲染 Task 5）
- ✓ Routine 2 hourly 行为：用进程内 scheduler 替代正式 Routine（Task 4 + 文档里说明升级路径）
- ✓ 一键批量应用 recommend_approve / reject（Task 3 backend + Task 5 UI）
- ✓ 失败兜底永远写库 needs_human（Task 2 + smoke Case 2）
- ✓ 多租户隔离 assertCompanyAccess + assertBoard（Task 3）

**Placeholder scan：**
- 无 TBD / TODO / "implement later"
- Task 2 Step 3 里的 screenPendingDrafts 示例代码已标注「实现里用 isNull」（修正说明在该 Step 末尾，不算 placeholder）

**Type consistency：**
- preVerdict / preVerdictReasoning / preVerdictAt / detectedConflicts 在 schema / service / route / UI 类型 4 处都一致（drizzle 字段是 camelCase，对应 DB snake_case）
- ReviewerLlmClient.completeChat 签名在 Task 2 service 定义、Task 4 scheduler 依赖、route 处隐式使用都一致
- KNOWLEDGE_PRE_VERDICT_VALUES 在 Task 1 定义、Task 2 service / Task 5 UI 通过 type guard 使用

---

Plan complete and saved to `docs/superpowers/plans/2026-05-13-llm-wiki-phase-3b-reviewer-agent.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 每个 task 一个独立 subagent，task 间复核，快速迭代

**2. Inline Execution** — 在当前会话内顺序执行 task，每个 task 末尾停下让你 checkpoint

哪一种？
