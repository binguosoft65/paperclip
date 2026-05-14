# LLM-Wiki Phase 2a + 2b — 检索 + heartbeat-context 集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 PRD §6 FR5 的"两路检索"+ §6 FR9 的"反馈四值"，再把 retriever 接入 `GET /api/issues/:id/heartbeat-context` 让 Agent checkout Issue 时自动收到 Top-5 知识节点（PRD §15 Phase 2 a/b 子集，砍掉 Agent tool 形式即 2c）。

**Architecture:** 新建 `knowledgeRetrieverService(db, llm)`：用 `llmWikiService.embed()` 把 query 向量化，跑两路 SQL — 语义（`embedding <=> $vec` cosine）+ 经验（`used_for && $tags`），客户端合并按 `similarity*0.5 + exp_score*0.3 + freshness*0.2` 排序取 Top N。freshness 实时算（不存）。反馈 service 单独：写 `knowledge_node_events` + 更新 `knowledge_nodes` 缓存字段。heartbeat-context endpoint 直接 inject `knowledgeNodes: [...]` 字段；retriever 失败 fail-open（仍返回上下文，知识缺失）。

**Tech Stack:** 复用 Phase 1a 的 `llmWikiService.embed()`、Drizzle ORM 的 `sql\`\`` 模板做向量查询、Vitest mock 单测。沿用 `assertCompanyAccess` / 现有 service factory 风格。

---

## Context（执行者须读）

### 现状（已确认）

- **Phase 0 schema**：`knowledge_nodes` 含 `embedding vector(1536)`、HNSW 索引（m=16, ef_construction=200，`vector_cosine_ops`）、`used_for text[]` + GIN 索引、`status text NOT NULL`、`level text`、`business_domain_id uuid FK`、`trigger_count int`、`last_triggered timestamptz`、`volatility text`、`verified_at` / `valid_until / source_url`
- **Phase 0 业务域**：`business_domains` 表（company_id + name 唯一），每 company 自动 seed `general`
- **Phase 1a**：`knowledgeNodes` / `knowledgeEdges` / `knowledgeNodeEvents` schema export 自 `@paperclipai/db`；`llmWikiService(db).embed(text)` 返回 1536 维向量
- **真实数据**：SmokeTest 公司有 6 个 active node（全部 embedding 非空）、9+ 个 events
- **Heartbeat-context endpoint**：`GET /api/issues/:id/heartbeat-context` 已在 `server/src/routes/issues.ts:1489`；返回 `{issue, ancestors, project, goal, commentCursor, wakeComment, attachments, continuationSummary, currentExecutionWorkspace}` JSON

### 关键参数（PRD §6 5.2 / §4.4）

**语义路径**：
```
similarity = 1 - (n.embedding <=> $query_embedding)   -- cosine 距离
WHERE similarity > 0.75
ORDER BY n.embedding <=> $query_embedding             -- HNSW 走升序距离
LIMIT 10
```

**经验路径**：
```
exp_score = trigger_count * (1.0 / GREATEST(1, days_since(last_triggered)))
WHERE used_for && $tags
ORDER BY exp_score DESC
LIMIT 5
```

**Freshness 公式**（PRD §4.4）：
```python
if valid_until and valid_until < now:        return 0.0
if valid_until and valid_until - now <= 30d: return 0.3
age_days = (now - verified_at).days  if verified_at else (now - created_at).days
half_life = { stable: ∞, slow: 365, fast: 90 }[volatility]
return exp(-age_days / half_life)  if half_life else 1.0
```

**Freshness 标签**：`>= 0.7 fresh` / `>= 0.3 stale_warning` / `< 0.3 outdated`

**合并**：`final_score = similarity*0.5 + exp_score_norm*0.3 + freshness*0.2`。经验分需归一化（max-min 或除以 max）—— 简化做 `min(exp_score / 10, 1.0)` 给上限（10 是经验：trigger_count 10 已经很高）。

### 默认级别过滤（PRD §6 5.2）

```sql
(n.level = 'company' OR (n.level = 'project' AND n.project_id = $current_project))
-- personal level 默认排除（PRD 留给 personal/private 流；Phase 2a 不开放）
```

### 业务域过滤（FR10）

```sql
JOIN business_domains d ON d.id = n.business_domain_id
WHERE (d.name = ANY($domains) OR d.name = 'general')   -- general 永远兜底
```

如果 `$domains` 为空（用户不传），则不加这个 WHERE — 所有 active domain 都允许。

### 反馈四值副作用（PRD §6 FR9）

| feedback | DB 写入 |
|---|---|
| `helped` | UPDATE nodes set trigger_count += 1, last_triggered=now; INSERT event(type='triggered', feedback='helped') |
| `outdated` | UPDATE nodes set metadata = jsonb_set(metadata, '{forced_outdated_at}', now_iso); INSERT event(type='feedback', feedback='outdated') |
| `wrong` | INSERT event(type='feedback', feedback='wrong') —— Phase 3 演化引擎读 event 起冲突队列 |
| `irrelevant` | INSERT event(type='feedback', feedback='irrelevant') —— Phase 3 演化引擎汇总 used_for 权重 |

**简化决策（vs PRD 字面）**：`outdated` 不在本 phase 自动开 Issue；`wrong` 不在本 phase 进冲突队列。这俩留给 Phase 3 演化引擎读 events 表做。Phase 2a 只做"记录"，不做"反应"。

### 范围边界（明确不做的）

- ❌ Agent tool `search_knowledge_base`（Phase 2c）
- ❌ MCP search 工具（Phase 6）
- ❌ Web UI 搜索框（Phase 4）
- ❌ Reviewer Agent 用检索做近邻参考（Phase 3）
- ❌ `outdated` 反馈自动开验证 Issue（Phase 3）
- ❌ `wrong` 反馈进冲突队列（Phase 3）
- ❌ Personal 节点检索（Phase 4 + 权限模型完善之后）
- ❌ outdated 节点显式 include 查史（`include_outdated=true` 参数支持，但 freshness 计算 / 标签即可）
- ❌ `?include_outdated=true` 的反向查询（Phase 4 详情页）

### File Structure（一表锁定）

| 文件 | 责任 | 状态 |
|---|---|---|
| `packages/shared/src/validators/knowledge.ts` | 加 search query schema + feedback body schema | 修改 |
| `packages/shared/src/validators/index.ts` | re-export | 修改 |
| `packages/shared/src/index.ts` | re-export | 修改 |
| `server/src/services/knowledge-freshness.ts` | `computeFreshness(node, now)` 纯函数 + `freshnessLabel(score)` | **新建** |
| `server/src/services/knowledge-freshness.test.ts` | freshness 单测（边界 / 半衰期 / 强制 outdated） | **新建** |
| `server/src/services/knowledge-retriever.ts` | `knowledgeRetrieverService(db, llm)`：`search(input)` | **新建** |
| `server/src/services/knowledge-retriever.test.ts` | retriever 单测（mock embed + mock Drizzle 返回行） | **新建** |
| `server/src/services/knowledge-feedback.ts` | `knowledgeFeedbackService(db)`：`record(input)` 四值分支 | **新建** |
| `server/src/services/knowledge-feedback.test.ts` | feedback 单测（mock Drizzle update/insert） | **新建** |
| `server/src/services/index.ts` | export 三个新 service | 修改 |
| `server/src/routes/knowledge.ts` | 加 `GET /search` + `POST /nodes/:id/feedback` | 修改 |
| `server/src/__tests__/knowledge-routes.test.ts` | 加 search / feedback 路由 supertest | 修改 |
| `server/src/app.ts` | 构造 retriever + feedback service，传给 issueRoutes & knowledgeRoutes | 修改 |
| `server/src/routes/issues.ts` | heartbeat-context 注入 `knowledgeNodes` Top-5（仅当 retriever 注入时） | 修改 |
| `docs/plans/2026-05-13-llm-wiki-phase-2a-2b-smoke.md` | 手动 smoke checklist | **新建** |

---

## Task 0: Shared validators（search query + feedback body）

**Files:**
- Modify: `D:\aiprojects\paperclip\packages\shared\src\validators\knowledge.ts`
- Modify: `D:\aiprojects\paperclip\packages\shared\src\validators\index.ts`
- Modify: `D:\aiprojects\paperclip\packages\shared\src\index.ts`

### Step 1: 加 schemas 到 knowledge.ts

打开 `packages/shared/src/validators/knowledge.ts`。在文件末尾（`listKnowledgeDraftsQuerySchema` 之后）追加：

```typescript
/** GET /api/knowledge/search 查询参数 */
export const knowledgeSearchQuerySchema = z
  .object({
    q: z.string().min(1).max(2000),
    type: z.string().optional(),              // csv: lesson,rule,...
    domain: z.string().optional(),            // csv: software,content
    used_for: z.string().optional(),          // csv: bug-fix,architecture
    project_id: z.string().uuid().optional(),
    include_outdated: z.coerce.boolean().optional().default(false),
    limit: z.coerce.number().int().min(1).max(50).optional().default(5),
  })
  .strict();

export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

/** POST /api/knowledge/nodes/:id/feedback body */
export const knowledgeFeedbackSchema = z
  .object({
    feedback: z.enum(["helped", "outdated", "wrong", "irrelevant"]),
    run_id: z.string().uuid().nullable().optional(),
    issue_id: z.string().uuid().nullable().optional(),
    comment: z.string().max(2000).optional(),
  })
  .strict();

export type KnowledgeFeedback = z.infer<typeof knowledgeFeedbackSchema>;

export const KNOWLEDGE_FEEDBACK_VALUES = ["helped", "outdated", "wrong", "irrelevant"] as const;
```

### Step 2: 同步 validators/index.ts

在 `packages/shared/src/validators/index.ts` 原 knowledge 导出块加：

```typescript
  knowledgeSearchQuerySchema,
  knowledgeFeedbackSchema,
  KNOWLEDGE_FEEDBACK_VALUES,
  type KnowledgeSearchQuery,
  type KnowledgeFeedback,
```

放在 `listKnowledgeDraftsQuerySchema` 旁边即可。

### Step 3: 同步 src/index.ts

在 `packages/shared/src/index.ts` 找到 Phase 1a 加的 knowledge 块，把 `knowledgeSearchQuerySchema`/`knowledgeFeedbackSchema`/`KNOWLEDGE_FEEDBACK_VALUES` 放进 value-export，`KnowledgeSearchQuery`/`KnowledgeFeedback` 放进 type-export。

### Step 4: 构建 shared

Run: `pnpm --filter @paperclipai/shared build`
Expected: 无 TS 错。

### Step 5: Commit

```bash
git add packages/shared/src/validators/knowledge.ts packages/shared/src/validators/index.ts packages/shared/src/index.ts
git commit -m "feat(llm-wiki): add Zod validators for search + feedback API (Phase 2a)"
```

---

## Task 1: Freshness 纯函数 + 单测

**Files:**
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-freshness.ts`
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-freshness.test.ts`

### Step 1: 写失败测试

写入 `server/src/services/knowledge-freshness.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { computeFreshness, freshnessLabel } from "./knowledge-freshness.js";

const day = 24 * 60 * 60 * 1000;

function dateAgo(days: number) {
  return new Date(Date.now() - days * day);
}

describe("computeFreshness", () => {
  it("stable + 无 verified_at → 1.0", () => {
    expect(
      computeFreshness({ volatility: "stable", verifiedAt: null, validUntil: null, createdAt: dateAgo(100) }),
    ).toBe(1.0);
  });

  it("valid_until 已过 → 0.0", () => {
    expect(
      computeFreshness({
        volatility: "fast",
        verifiedAt: dateAgo(10),
        validUntil: dateAgo(1),
        createdAt: dateAgo(20),
      }),
    ).toBe(0.0);
  });

  it("valid_until 30 天内 → 0.3", () => {
    const fifteenDaysAhead = new Date(Date.now() + 15 * day);
    expect(
      computeFreshness({
        volatility: "slow",
        verifiedAt: dateAgo(10),
        validUntil: fifteenDaysAhead,
        createdAt: dateAgo(20),
      }),
    ).toBe(0.3);
  });

  it("fast volatility + 0 天龄 → ~1.0（exp(0)=1）", () => {
    const v = computeFreshness({
      volatility: "fast",
      verifiedAt: new Date(),
      validUntil: null,
      createdAt: new Date(),
    });
    expect(v).toBeGreaterThan(0.99);
  });

  it("fast volatility + 90 天龄 → ~0.368（exp(-1)）", () => {
    const v = computeFreshness({
      volatility: "fast",
      verifiedAt: dateAgo(90),
      validUntil: null,
      createdAt: dateAgo(90),
    });
    expect(v).toBeGreaterThan(0.35);
    expect(v).toBeLessThan(0.40);
  });

  it("slow volatility + 365 天龄 → ~0.368", () => {
    const v = computeFreshness({
      volatility: "slow",
      verifiedAt: dateAgo(365),
      validUntil: null,
      createdAt: dateAgo(365),
    });
    expect(v).toBeGreaterThan(0.35);
    expect(v).toBeLessThan(0.40);
  });

  it("verified_at 缺 fallback createdAt", () => {
    const v = computeFreshness({
      volatility: "fast",
      verifiedAt: null,
      validUntil: null,
      createdAt: dateAgo(30),
    });
    // exp(-30/90) ≈ 0.716
    expect(v).toBeGreaterThan(0.7);
    expect(v).toBeLessThan(0.73);
  });

  it("metadata.forced_outdated_at 强制 ≤ 0.3", () => {
    const v = computeFreshness({
      volatility: "stable",
      verifiedAt: new Date(),
      validUntil: null,
      createdAt: new Date(),
      metadata: { forced_outdated_at: new Date().toISOString() },
    });
    expect(v).toBeLessThanOrEqual(0.3);
  });
});

describe("freshnessLabel", () => {
  it("≥ 0.7 → fresh", () => {
    expect(freshnessLabel(0.7)).toBe("fresh");
    expect(freshnessLabel(0.85)).toBe("fresh");
    expect(freshnessLabel(1.0)).toBe("fresh");
  });

  it("0.3 - 0.7 → stale_warning", () => {
    expect(freshnessLabel(0.3)).toBe("stale_warning");
    expect(freshnessLabel(0.5)).toBe("stale_warning");
    expect(freshnessLabel(0.69)).toBe("stale_warning");
  });

  it("< 0.3 → outdated", () => {
    expect(freshnessLabel(0.0)).toBe("outdated");
    expect(freshnessLabel(0.29)).toBe("outdated");
  });
});
```

### Step 2: 跑测试 verify fail

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge-freshness
```

Expected: FAIL — "Cannot find module ./knowledge-freshness.js"

### Step 3: 实现

写入 `server/src/services/knowledge-freshness.ts`：

```typescript
/**
 * Knowledge node freshness 计算（PRD §4.4）—— 实时算，不存 DB。
 *
 * 公式：
 *   if valid_until 已过       → 0.0
 *   if valid_until 30 天内    → 0.3
 *   else                       → exp(-age_days / half_life)
 *     half_life: stable=∞ / slow=365 / fast=90
 *     age_days = days_since(verified_at || created_at)
 *
 * 强制降权：metadata.forced_outdated_at 存在时强制 freshness ≤ 0.3。
 * 这个字段由反馈 service 在收到 'outdated' 反馈时写入。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_EXPIRY_DAYS = 30;

const HALF_LIFE_DAYS: Record<string, number | null> = {
  stable: null,    // 不衰减
  slow: 365,
  fast: 90,
};

export interface FreshnessInput {
  volatility: string | null | undefined;
  verifiedAt: Date | string | null | undefined;
  validUntil: Date | string | null | undefined;
  createdAt: Date | string;
  metadata?: Record<string, unknown> | null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function computeFreshness(input: FreshnessInput, now: Date = new Date()): number {
  const validUntil = toDate(input.validUntil);
  if (validUntil) {
    const diffMs = validUntil.getTime() - now.getTime();
    if (diffMs < 0) return 0.0;
    if (diffMs <= SOON_EXPIRY_DAYS * DAY_MS) return 0.3;
  }

  const volatility = (input.volatility ?? "slow").toLowerCase();
  const halfLife = HALF_LIFE_DAYS[volatility] ?? HALF_LIFE_DAYS.slow!;

  let score: number;
  if (halfLife === null) {
    // stable: 不衰减
    score = 1.0;
  } else {
    const ref = toDate(input.verifiedAt) ?? toDate(input.createdAt) ?? now;
    const ageMs = Math.max(0, now.getTime() - ref.getTime());
    const ageDays = ageMs / DAY_MS;
    score = Math.exp(-ageDays / halfLife);
  }

  // 反馈强制 outdated
  const forced = input.metadata?.forced_outdated_at;
  if (forced && typeof forced === "string" && !Number.isNaN(new Date(forced).getTime())) {
    score = Math.min(score, 0.3);
  }

  // clamp [0, 1]
  return Math.max(0, Math.min(1, score));
}

export type FreshnessLabel = "fresh" | "stale_warning" | "outdated";

export function freshnessLabel(score: number): FreshnessLabel {
  if (score >= 0.7) return "fresh";
  if (score >= 0.3) return "stale_warning";
  return "outdated";
}
```

### Step 4: 跑测试 verify pass

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge-freshness
```

Expected: 11 cases PASS。

### Step 5: Commit

```bash
git add server/src/services/knowledge-freshness.ts server/src/services/knowledge-freshness.test.ts
git commit -m "feat(llm-wiki): computeFreshness + freshnessLabel pure helpers (Phase 2a)"
```

---

## Task 2: knowledgeRetrieverService 核心

**Files:**
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-retriever.ts`
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-retriever.test.ts`
- Modify: `D:\aiprojects\paperclip\server\src\services\index.ts`

实现 retriever。`search()` 输入 `{companyId, query, projectId?, type?, domain?, used_for?, include_outdated?, limit?}` → 返回 Top N `SearchResult[]`。

内部：
1. embed(query) 拿 1536 维向量
2. 语义 SQL（用 Drizzle `sql` 模板）→ Top 10
3. 经验 SQL（仅当 `used_for` 非空）→ Top 5
4. 客户端合并 → 算每条 final_score → sort → take limit

### Step 1: 写失败测试

写入 `server/src/services/knowledge-retriever.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeRetrieverService } from "./knowledge-retriever.js";

const mockEmbed = vi.fn();
const llmStub = { embed: mockEmbed, completeChat: vi.fn() };

function makeDbWithQueries(semanticRows: unknown[], experienceRows: unknown[]) {
  // db.execute(sql) returns { rows } via postgres driver; mimic by chained calls
  const execute = vi.fn();
  execute.mockResolvedValueOnce(semanticRows);
  execute.mockResolvedValueOnce(experienceRows);
  return { execute } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("knowledgeRetrieverService.search", () => {
  it("query 空时拒绝（zod 已挡在上层；service 防御也校验）", async () => {
    const svc = knowledgeRetrieverService(makeDbWithQueries([], []), llmStub as any);
    await expect(svc.search({ companyId: "c-1", query: "" } as any)).rejects.toThrow(/query/);
  });

  it("没 used_for 时跳过经验路径（只跑 1 个 execute）", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const db = makeDbWithQueries(
      [
        {
          id: "n-1",
          title: "Test node",
          content: "Some content here",
          type: "lesson",
          level: "company",
          confidence: 0.9,
          verified: true,
          trigger_count: 3,
          last_triggered: null,
          volatility: "stable",
          verified_at: null,
          valid_until: null,
          metadata: {},
          created_at: new Date(),
          similarity: 0.92,
          domain_name: "general",
          domain_display_label: "通用",
          domain_color: "#666",
        },
      ],
      [],
    );
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "find me" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe("n-1");
    expect(res.results[0].similarity).toBe(0.92);
    expect(res.results[0].experience_score).toBe(0);
    expect(res.results[0].freshness_label).toBe("fresh");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("有 used_for 时跑 2 路 + 合并去重", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const semanticRow = {
      id: "n-shared",
      title: "Shared",
      content: "x",
      type: "rule",
      level: "company",
      confidence: 0.8,
      verified: true,
      trigger_count: 5,
      last_triggered: new Date(Date.now() - 1 * 86400_000),
      volatility: "slow",
      verified_at: new Date(),
      valid_until: null,
      metadata: {},
      created_at: new Date(),
      similarity: 0.82,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    };
    const experienceRow = { ...semanticRow, similarity: null, exp_raw: 2.5 };
    const onlyExperience = { ...semanticRow, id: "n-exp-only", similarity: null, exp_raw: 1.0 };

    const db = makeDbWithQueries([semanticRow], [experienceRow, onlyExperience]);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({
      companyId: "c-1",
      query: "find",
      used_for: ["bug-fix"],
    });

    // 合并后 n-shared 应有 similarity 和 experience_score 都非 0
    const shared = res.results.find((r) => r.id === "n-shared");
    expect(shared).toBeDefined();
    expect(shared!.similarity).toBe(0.82);
    expect(shared!.experience_score).toBeGreaterThan(0);

    const expOnly = res.results.find((r) => r.id === "n-exp-only");
    expect(expOnly).toBeDefined();
    expect(expOnly!.similarity).toBe(0);
  });

  it("limit 限制结果数", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const semanticRows = Array.from({ length: 10 }, (_, i) => ({
      id: `n-${i}`,
      title: `T${i}`,
      content: "c",
      type: "lesson",
      level: "company",
      confidence: 0.5,
      verified: false,
      trigger_count: i,
      last_triggered: null,
      volatility: "stable",
      verified_at: null,
      valid_until: null,
      metadata: {},
      created_at: new Date(),
      similarity: 0.9 - i * 0.05,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    }));
    const db = makeDbWithQueries(semanticRows, []);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "f", limit: 3 });
    expect(res.results).toHaveLength(3);
  });

  it("outdated 节点在默认（include_outdated=false）下被排除", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const fresh = {
      id: "n-fresh",
      title: "fresh",
      content: "x",
      type: "lesson",
      level: "company",
      confidence: 0.9,
      verified: true,
      trigger_count: 2,
      last_triggered: null,
      volatility: "stable",
      verified_at: new Date(),
      valid_until: null,
      metadata: {},
      created_at: new Date(),
      similarity: 0.9,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    };
    const expired = {
      ...fresh,
      id: "n-expired",
      valid_until: new Date(Date.now() - 86400_000),
    };
    const db = makeDbWithQueries([fresh, expired], []);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "x" });
    expect(res.results.map((r) => r.id)).toEqual(["n-fresh"]);
  });

  it("include_outdated=true 时保留", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const expired = {
      id: "n-expired",
      title: "expired",
      content: "x",
      type: "fact",
      level: "company",
      confidence: 0.9,
      verified: true,
      trigger_count: 1,
      last_triggered: null,
      volatility: "fast",
      verified_at: null,
      valid_until: new Date(Date.now() - 86400_000),
      metadata: {},
      created_at: new Date(),
      similarity: 0.85,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    };
    const db = makeDbWithQueries([expired], []);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "x", include_outdated: true });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].freshness_label).toBe("outdated");
  });
});
```

### Step 2: 跑测试 verify fail

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge-retriever
```

Expected: FAIL — 模块不存在。

### Step 3: 实现 retriever

写入 `server/src/services/knowledge-retriever.ts`：

```typescript
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { computeFreshness, freshnessLabel, type FreshnessLabel } from "./knowledge-freshness.js";

/**
 * Knowledge Retriever 服务（Phase 2a）—— PRD §6 FR5 两路检索。
 *
 * 输入自然语言 query，输出 Top N 结果按 final_score 排序。
 *
 * 工作流：
 *   1. embed(query) → 1536 维 query vector
 *   2. 语义路径 SQL：cosine 距离 < 0.25（similarity > 0.75）+ active + 多层过滤 → Top 10
 *   3. 经验路径 SQL（仅当传 used_for）：used_for && $tags + active + 同样过滤 → Top 5
 *   4. 合并去重 → 算每条 final_score = sim*0.5 + exp_norm*0.3 + freshness*0.2
 *   5. 按 final_score 降序，取 limit（默认 5）
 *
 * freshness 实时算，不存 DB（见 ./knowledge-freshness）。
 * outdated 节点（freshness < 0.3）默认排除，可用 include_outdated=true 显式保留。
 */

export interface RetrieverChatClient {
  embed(text: string): Promise<number[]>;
}

export interface KnowledgeSearchInput {
  companyId: string;
  query: string;
  projectId?: string | null;
  type?: string[] | null;
  domain?: string[] | null;
  used_for?: string[] | null;
  include_outdated?: boolean;
  limit?: number;
}

export interface SearchResultDomain {
  name: string;
  display_label: string;
  color: string;
}

export interface SearchResultItem {
  id: string;
  title: string;
  snippet: string;
  type: string;
  level: string;
  domain: SearchResultDomain;
  confidence: number;
  verified: boolean;
  trigger_count: number;
  similarity: number;
  experience_score: number;
  freshness_score: number;
  freshness_label: FreshnessLabel;
  final_score: number;
  verified_at: string | null;
  volatility: string | null;
}

export interface KnowledgeSearchResult {
  results: SearchResultItem[];
  search_type: "semantic" | "experience" | "semantic+experience";
  took_ms: number;
}

const SEMANTIC_SIMILARITY_FLOOR = 0.75;
const SEMANTIC_LIMIT = 10;
const EXPERIENCE_LIMIT = 5;
const SNIPPET_CHARS = 200;
const EXP_SCORE_NORMALIZATION = 10;   // experience_score / 10 上限 1.0

/** Drizzle 拼接 array literal 的字面量（避免 ARRAY[$1,$2] 绑定数组到 text[] 麻烦） */
function pgTextArray(values: string[]) {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

function pgVector(vec: number[]) {
  // pgvector 文本格式 [v1,v2,...]
  return sql`${`[${vec.join(",")}]`}::vector`;
}

export function knowledgeRetrieverService(db: Db, llm: RetrieverChatClient) {
  return {
    async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
      if (!input.query || input.query.trim().length === 0) {
        throw unprocessable("query parameter is required");
      }

      const startedAt = Date.now();
      const queryVec = await llm.embed(input.query);
      const queryVecSql = pgVector(queryVec);
      const companyId = input.companyId;
      const limit = input.limit ?? 5;

      // 公共 WHERE 子句构造
      const filters = [
        sql`n.company_id = ${companyId}`,
        sql`n.status = 'active'`,
        sql`(n.level = 'company' OR (n.level = 'project' AND n.project_id = ${input.projectId ?? null}))`,
      ];
      if (input.type && input.type.length > 0) {
        filters.push(sql`n.type = ANY(${pgTextArray(input.type)})`);
      }
      if (input.domain && input.domain.length > 0) {
        // 业务域 name 过滤；general 永远兜底命中
        filters.push(
          sql`(d.name = ANY(${pgTextArray([...input.domain, "general"])}))`,
        );
      }
      const whereCombined = sql.join(filters, sql` AND `);

      // ── 语义路径 ──
      const semanticSql = sql`
        SELECT
          n.id, n.title, n.content, n.type, n.level, n.confidence, n.verified,
          n.trigger_count, n.last_triggered, n.volatility, n.verified_at,
          n.valid_until, n.metadata, n.created_at,
          1 - (n.embedding <=> ${queryVecSql}) AS similarity,
          d.name AS domain_name,
          d.display_label AS domain_display_label,
          d.color AS domain_color
        FROM knowledge_nodes n
        JOIN business_domains d ON d.id = n.business_domain_id
        WHERE ${whereCombined}
          AND 1 - (n.embedding <=> ${queryVecSql}) > ${SEMANTIC_SIMILARITY_FLOOR}
        ORDER BY n.embedding <=> ${queryVecSql}
        LIMIT ${SEMANTIC_LIMIT}
      `;
      const semanticRowsRaw = (await db.execute(semanticSql)) as unknown as Array<Record<string, unknown>>;

      // ── 经验路径（条件性） ──
      let experienceRowsRaw: Array<Record<string, unknown>> = [];
      let hasExperience = false;
      if (input.used_for && input.used_for.length > 0) {
        hasExperience = true;
        const expWhere = sql.join(
          [
            ...filters,
            sql`n.used_for && ${pgTextArray(input.used_for)}`,
          ],
          sql` AND `,
        );
        const experienceSql = sql`
          SELECT
            n.id, n.title, n.content, n.type, n.level, n.confidence, n.verified,
            n.trigger_count, n.last_triggered, n.volatility, n.verified_at,
            n.valid_until, n.metadata, n.created_at,
            n.trigger_count * (1.0 / GREATEST(1, EXTRACT(DAY FROM (now() - COALESCE(n.last_triggered, n.created_at))))) AS exp_raw,
            d.name AS domain_name,
            d.display_label AS domain_display_label,
            d.color AS domain_color
          FROM knowledge_nodes n
          JOIN business_domains d ON d.id = n.business_domain_id
          WHERE ${expWhere}
          ORDER BY exp_raw DESC
          LIMIT ${EXPERIENCE_LIMIT}
        `;
        experienceRowsRaw = (await db.execute(experienceSql)) as unknown as Array<Record<string, unknown>>;
      }

      // ── 合并去重 ──
      type Row = Record<string, unknown>;
      const merged = new Map<string, { row: Row; similarity: number; experience: number }>();

      for (const row of semanticRowsRaw) {
        const id = row.id as string;
        const sim = typeof row.similarity === "number" ? row.similarity : Number(row.similarity ?? 0);
        merged.set(id, { row, similarity: sim, experience: 0 });
      }
      for (const row of experienceRowsRaw) {
        const id = row.id as string;
        const expRaw = typeof row.exp_raw === "number" ? row.exp_raw : Number(row.exp_raw ?? 0);
        const expNorm = Math.min(expRaw / EXP_SCORE_NORMALIZATION, 1.0);
        const existing = merged.get(id);
        if (existing) {
          existing.experience = expNorm;
        } else {
          merged.set(id, { row, similarity: 0, experience: expNorm });
        }
      }

      // ── 算 final_score + freshness ──
      const now = new Date();
      const includeOutdated = input.include_outdated === true;
      const items: SearchResultItem[] = [];
      for (const { row, similarity, experience } of merged.values()) {
        const freshness = computeFreshness(
          {
            volatility: (row.volatility as string | null) ?? null,
            verifiedAt: (row.verified_at as string | Date | null) ?? null,
            validUntil: (row.valid_until as string | Date | null) ?? null,
            createdAt: (row.created_at as string | Date) ?? new Date(),
            metadata: (row.metadata as Record<string, unknown> | null) ?? null,
          },
          now,
        );
        const label = freshnessLabel(freshness);
        if (!includeOutdated && label === "outdated") continue;

        const finalScore = similarity * 0.5 + experience * 0.3 + freshness * 0.2;
        const contentStr = String(row.content ?? "");

        items.push({
          id: String(row.id),
          title: String(row.title ?? ""),
          snippet: contentStr.length > SNIPPET_CHARS ? contentStr.slice(0, SNIPPET_CHARS) + "…" : contentStr,
          type: String(row.type ?? ""),
          level: String(row.level ?? ""),
          domain: {
            name: String(row.domain_name ?? ""),
            display_label: String(row.domain_display_label ?? ""),
            color: String(row.domain_color ?? "#6B7280"),
          },
          confidence: Number(row.confidence ?? 0),
          verified: Boolean(row.verified),
          trigger_count: Number(row.trigger_count ?? 0),
          similarity: Number(similarity.toFixed(4)),
          experience_score: Number(experience.toFixed(4)),
          freshness_score: Number(freshness.toFixed(4)),
          freshness_label: label,
          final_score: Number(finalScore.toFixed(4)),
          verified_at: row.verified_at instanceof Date ? row.verified_at.toISOString() : (row.verified_at as string | null) ?? null,
          volatility: (row.volatility as string | null) ?? null,
        });
      }

      items.sort((a, b) => b.final_score - a.final_score);
      const results = items.slice(0, limit);

      const searchType: KnowledgeSearchResult["search_type"] = hasExperience
        ? "semantic+experience"
        : "semantic";

      return {
        results,
        search_type: searchType,
        took_ms: Date.now() - startedAt,
      };
    },
  };
}

export type KnowledgeRetrieverService = ReturnType<typeof knowledgeRetrieverService>;
```

### Step 4: 跑测试

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge-retriever
```

Expected: 6 cases PASS。

### Step 5: 加 service barrel

在 `server/src/services/index.ts` 加：

```typescript
export {
  knowledgeRetrieverService,
  type KnowledgeRetrieverService,
  type KnowledgeSearchInput,
  type SearchResultItem,
  type KnowledgeSearchResult,
} from "./knowledge-retriever.js";
```

### Step 6: typecheck

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: 无新错。

### Step 7: Commit

```bash
git add server/src/services/knowledge-retriever.ts server/src/services/knowledge-retriever.test.ts server/src/services/knowledge-freshness.ts server/src/services/knowledge-freshness.test.ts server/src/services/index.ts
git commit -m "feat(llm-wiki): knowledgeRetrieverService — semantic + experience two-path search (Phase 2a)"
```

(Task 1 + 2 一起提交，因为 retriever 依赖 freshness。)

---

## Task 3: knowledgeFeedbackService

**Files:**
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-feedback.ts`
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-feedback.test.ts`
- Modify: `D:\aiprojects\paperclip\server\src\services\index.ts`

### Step 1: 写失败测试

写入 `server/src/services/knowledge-feedback.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeFeedbackService } from "./knowledge-feedback.js";

function makeMockDb(opts: { nodeRow?: Record<string, unknown> | null }) {
  const selectQueue = [opts.nodeRow ? [opts.nodeRow] : []];
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(selectQueue.shift() ?? []),
      }),
    }),
  });
  const updateReturning = vi.fn().mockResolvedValue([{ id: opts.nodeRow?.id ?? "n-1" }]);
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: updateReturning }),
  });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-1" }]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  return {
    db: { select, update, insert } as any,
    spies: { select, update, updateSet, updateReturning, insert, insertValues, insertReturning },
  };
}

beforeEach(() => vi.clearAllMocks());

const baseNode = {
  id: "n-1",
  companyId: "c-1",
  status: "active",
  triggerCount: 3,
  metadata: {},
};

describe("knowledgeFeedbackService.record", () => {
  it("节点不存在抛 404", async () => {
    const { db } = makeMockDb({ nodeRow: null });
    const svc = knowledgeFeedbackService(db);
    await expect(
      svc.record({
        companyId: "c-1",
        nodeId: "missing",
        feedback: "helped",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("跨公司节点抛 404", async () => {
    const { db } = makeMockDb({ nodeRow: { ...baseNode, companyId: "other" } });
    const svc = knowledgeFeedbackService(db);
    await expect(
      svc.record({
        companyId: "c-1",
        nodeId: "n-1",
        feedback: "helped",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("helped → trigger_count += 1 + last_triggered + event(type='triggered')", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "helped",
      runId: "r-1",
      issueId: "i-1",
      userId: "u-1",
    });
    // update 被调（trigger_count）
    expect(spies.update).toHaveBeenCalled();
    const updatePayload = spies.updateSet.mock.calls[0][0];
    expect(updatePayload).toEqual(
      expect.objectContaining({ triggerCount: 4 }),
    );
    expect(updatePayload.lastTriggered).toBeInstanceOf(Date);

    // event 插入
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "n-1",
        eventType: "triggered",
        feedback: "helped",
        runId: "r-1",
        issueId: "i-1",
        userId: "u-1",
      }),
    );
  });

  it("outdated → metadata.forced_outdated_at 设置 + event(type='feedback', feedback='outdated')", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode, metadata: { foo: "bar" } } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "outdated",
    });
    const updatePayload = spies.updateSet.mock.calls[0][0];
    expect(updatePayload).toHaveProperty("metadata");
    const meta = updatePayload.metadata;
    expect(meta).toEqual(
      expect.objectContaining({
        foo: "bar",
        forced_outdated_at: expect.any(String),
      }),
    );
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "feedback", feedback: "outdated" }),
    );
  });

  it("wrong → 仅 event(type='feedback', feedback='wrong')，不 update 节点", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "wrong",
      comment: "conflicts with PG 17 docs",
    });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "feedback",
        feedback: "wrong",
        metadata: expect.objectContaining({ comment: "conflicts with PG 17 docs" }),
      }),
    );
  });

  it("irrelevant → 仅 event(type='feedback', feedback='irrelevant')，不 update 节点", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "irrelevant",
    });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "feedback", feedback: "irrelevant" }),
    );
  });
});
```

### Step 2: verify fail

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge-feedback
```

Expected: 模块不存在 FAIL。

### Step 3: 实现

写入 `server/src/services/knowledge-feedback.ts`：

```typescript
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
      if (!node) throw notFound("node not found");

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
```

### Step 4: verify pass

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge-feedback
```

Expected: 6 cases PASS。

### Step 5: 加 barrel

```typescript
export {
  knowledgeFeedbackService,
  type KnowledgeFeedbackService,
  type KnowledgeFeedbackInput,
} from "./knowledge-feedback.js";
```

### Step 6: Commit

```bash
git add server/src/services/knowledge-feedback.ts server/src/services/knowledge-feedback.test.ts server/src/services/index.ts
git commit -m "feat(llm-wiki): knowledgeFeedbackService — record 4-value feedback to nodes + events (Phase 2a)"
```

---

## Task 4: REST routes — GET /search + POST /nodes/:id/feedback

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\routes\knowledge.ts`
- Modify: `D:\aiprojects\paperclip\server\src\__tests__\knowledge-routes.test.ts`
- Modify: `D:\aiprojects\paperclip\server\src\app.ts`

### Step 1: 在 knowledge.ts 加 import + factory 接 retriever / feedback

打开 `D:\aiprojects\paperclip\server\src\routes\knowledge.ts`。

1a. 加 import（与现有的 services import 同区域）：

```typescript
import {
  knowledgeDraftService,
  knowledgeNodeWriterService,
  llmWikiService,
  knowledgeRetrieverService,
  knowledgeFeedbackService,
} from "../services/index.js";
import {
  knowledgeFeedbackSchema,
  knowledgeSearchQuerySchema,
} from "@paperclipai/shared";
```

1b. 在 factory body 加：

```typescript
  const retriever = knowledgeRetrieverService(db, llm);
  const feedback = knowledgeFeedbackService(db);
```

放在 `const drafts = ...` 旁边。

### Step 2: 加 routes（在 batch-approve 之后、`return router;` 之前）

```typescript
  // ============================================================
  // GET /api/knowledge/search
  // ============================================================
  router.get("/search", async (req, res) => {
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const parsed = knowledgeSearchQuerySchema.safeParse({
      q: req.query.q,
      type: req.query.type,
      domain: req.query.domain,
      used_for: req.query.used_for,
      project_id: req.query.project_id,
      include_outdated: req.query.include_outdated,
      limit: req.query.limit,
    });
    if (!parsed.success) {
      throw badRequest("invalid query", parsed.error.format());
    }
    const q = parsed.data;
    const result = await retriever.search({
      companyId,
      query: q.q,
      projectId: q.project_id ?? null,
      type: q.type ? q.type.split(",").map((s) => s.trim()).filter(Boolean) : null,
      domain: q.domain ? q.domain.split(",").map((s) => s.trim()).filter(Boolean) : null,
      used_for: q.used_for ? q.used_for.split(",").map((s) => s.trim()).filter(Boolean) : null,
      include_outdated: q.include_outdated,
      limit: q.limit,
    });
    res.json({ data: result, meta: { took_ms: result.took_ms } });
  });

  // ============================================================
  // POST /api/knowledge/nodes/:id/feedback
  // ============================================================
  router.post(
    "/nodes/:id/feedback",
    validate(knowledgeFeedbackSchema),
    async (req, res) => {
      const companyId = requireCompanyId(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      await feedback.record({
        companyId,
        nodeId: requireParamId(req),
        feedback: req.body.feedback,
        runId: req.body.run_id ?? actor.runId ?? null,
        issueId: req.body.issue_id ?? null,
        agentId: actor.actorType === "agent" ? actor.actorId : null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        comment: req.body.comment ?? null,
      });
      res.status(204).end();
    },
  );
```

### Step 3: 加 routes tests

打开 `D:\aiprojects\paperclip\server\src\__tests__\knowledge-routes.test.ts`。

3a. 在 `mockNodeWriter` 之后加：

```typescript
const mockRetriever = vi.hoisted(() => ({
  search: vi.fn(),
}));

const mockFeedback = vi.hoisted(() => ({
  record: vi.fn(),
}));
```

3b. 在 `vi.mock("../services/index.js", ...)` 加：

```typescript
vi.mock("../services/index.js", () => ({
  knowledgeDraftService: () => mockDraftService,
  knowledgeNodeWriterService: () => mockNodeWriter,
  llmWikiService: () => ({ embed: vi.fn() }),
  knowledgeRetrieverService: () => mockRetriever,
  knowledgeFeedbackService: () => mockFeedback,
}));
```

3c. 在文件末尾追加 2 个 describe block：

```typescript
describe.sequential("GET /api/knowledge/search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 返回 retriever 结果", async () => {
    mockRetriever.search.mockResolvedValueOnce({
      results: [
        {
          id: "n-1",
          title: "T",
          snippet: "S",
          type: "lesson",
          level: "company",
          domain: { name: "general", display_label: "通用", color: "#666" },
          confidence: 0.9,
          verified: true,
          trigger_count: 5,
          similarity: 0.88,
          experience_score: 0.0,
          freshness_score: 0.95,
          freshness_label: "fresh",
          final_score: 0.63,
          verified_at: null,
          volatility: "stable",
        },
      ],
      search_type: "semantic",
      took_ms: 120,
    });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).get("/api/knowledge/search?companyId=c-1&q=hello"),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.results[0].id).toBe("n-1");
    expect(mockRetriever.search).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "c-1", query: "hello" }),
    );
  });

  it("400 缺 q", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).get("/api/knowledge/search?companyId=c-1"),
    );
    expect(res.status).toBe(400);
  });

  it("csv 参数被拆为数组传给 retriever", async () => {
    mockRetriever.search.mockResolvedValueOnce({ results: [], search_type: "semantic", took_ms: 1 });
    const app = await createApp(boardActor);
    await requestApp(app, (base) =>
      request(base).get("/api/knowledge/search?companyId=c-1&q=x&domain=software,content&used_for=bug-fix"),
    );
    expect(mockRetriever.search).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: ["software", "content"],
        used_for: ["bug-fix"],
      }),
    );
  });
});

describe.sequential("POST /api/knowledge/nodes/:id/feedback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("204 + 调 feedback service", async () => {
    mockFeedback.record.mockResolvedValueOnce({ nodeId: "n-1", eventId: "e-1" });
    const app = await createApp(boardActor);
    const nodeId = "11111111-1111-1111-1111-111111111111";
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/knowledge/nodes/${nodeId}/feedback?companyId=c-1`)
        .send({ feedback: "helped" }),
    );
    expect(res.status).toBe(204);
    expect(mockFeedback.record).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId, companyId: "c-1", feedback: "helped" }),
    );
  });

  it("400 非法 feedback enum", async () => {
    const app = await createApp(boardActor);
    const nodeId = "11111111-1111-1111-1111-111111111111";
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/knowledge/nodes/${nodeId}/feedback?companyId=c-1`)
        .send({ feedback: "bogus" }),
    );
    expect(res.status).toBe(400);
  });
});
```

### Step 4: 跑测试

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge
```

Expected: 全过（含 5 个新 case + 36 个原有 = 41）。

### Step 5: typecheck

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: 无新错。

### Step 6: app.ts 不需要改（retriever / feedback 在 knowledge.ts 内部 instantiate，不用 opts 注入）

确认：当前 `knowledgeRoutes(db)` 的工厂签名不变，retriever / feedback 都用 db 构造，不需要外部传。**跳过 app.ts 改动。**

### Step 7: Commit

```bash
git add server/src/routes/knowledge.ts server/src/__tests__/knowledge-routes.test.ts
git commit -m "feat(llm-wiki): REST GET /knowledge/search + POST /knowledge/nodes/:id/feedback (Phase 2a)"
```

---

## Task 5: Heartbeat-context 注入 Top-5 知识节点

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\routes\issues.ts`
- Modify: `D:\aiprojects\paperclip\server\src\app.ts`

### Step 1: issueRoutes opts 加 knowledgeRetriever 字段

打开 `D:\aiprojects\paperclip\server\src\routes\issues.ts`。

1a. 找到 import section，加：

```typescript
import { type KnowledgeRetrieverService, type SearchResultItem } from "../services/knowledge-retriever.js";
```

1b. 找到 `issueRoutes` 工厂签名（约 line 725）的 opts 类型，加新字段：

```typescript
export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    ...其它字段...
    knowledgeDrafter?: KnowledgeDrafterService;
    knowledgeRetriever?: KnowledgeRetrieverService;
  } = {},
) {
  const router = Router();
  ...
  const drafter = opts.knowledgeDrafter;
  const retriever = opts.knowledgeRetriever;
```

### Step 2: heartbeat-context endpoint 加 knowledgeNodes

定位 `router.get("/issues/:id/heartbeat-context", ...)` 约 line 1489。

在 `Promise.all([...])` 后、`res.json({...})` 前，新增并行 retriever 调用 — fail-open，不阻塞主响应：

```typescript
    // Phase 2b: 注入 Top-5 知识节点。retriever 失败 fail-open（返回空数组）。
    let knowledgeNodes: SearchResultItem[] = [];
    if (retriever) {
      const query = `${issue.title}\n\n${issue.description ?? ""}`.trim();
      try {
        const result = await retriever.search({
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          query,
          limit: 5,
        });
        knowledgeNodes = result.results;
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id },
          "knowledge retriever failed in heartbeat-context",
        );
      }
    }
```

把这段插在现有 `await Promise.all([...])` 的赋值语句**之后**、`res.json({...})` 之前。

然后在 `res.json({...})` 对象里加一个字段：

```typescript
    res.json({
      issue: { ... },
      ancestors: ...,
      project: ...,
      goal: ...,
      commentCursor,
      wakeComment: ...,
      attachments: ...,
      continuationSummary: ...,
      currentExecutionWorkspace,
      knowledgeNodes,    // ← 新增字段
    });
```

### Step 3: app.ts 构造 retriever 并传给 issueRoutes

打开 `D:\aiprojects\paperclip\server\src\app.ts`。

3a. 在 import section 加：

```typescript
import { knowledgeRetrieverService } from "./services/index.js";
```

（如果已经从 `./services/index.js` 引入了 `knowledgeDrafterService` 等，就把 `knowledgeRetrieverService` 加到同一个 import 列表）

3b. 在构造 `knowledgeDrafter` 旁边构造 retriever：

```typescript
  const llmWikiClient = llmWikiService(db);
  const knowledgeDrafter = knowledgeDrafterService(db, llmWikiClient);
  const knowledgeRetriever = knowledgeRetrieverService(db, llmWikiClient);
  setKnowledgeDrafterForHeartbeat(knowledgeDrafter);
```

3c. issueRoutes 调用加上 retriever：

```typescript
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
    knowledgeDrafter,
    knowledgeRetriever,
  }));
```

### Step 4: typecheck

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: 无新错。

### Step 5: 跑 issues 测试确保无 regression

```bash
cd D:\aiprojects\paperclip\server && npx vitest run issues knowledge
```

Expected: pre-existing tests 全过；Windows IPv6 `connect EACCES` 的 supertest 失败属预期不修。

### Step 6: Commit

```bash
git add server/src/routes/issues.ts server/src/app.ts
git commit -m "feat(llm-wiki): inject Top-5 knowledge nodes into heartbeat-context (Phase 2b)"
```

---

## Task 6: Smoke checklist

**Files:**
- Create: `D:\aiprojects\paperclip\docs\superpowers\plans\2026-05-13-llm-wiki-phase-2a-2b-smoke.md`

### Step 1: 写 smoke 文档

写入 `docs/plans/2026-05-13-llm-wiki-phase-2a-2b-smoke.md`：

```markdown
# LLM-Wiki Phase 2a + 2b — Smoke Checklist

需 PG（含 pgvector）+ OpenAI/兼容 key + Phase 1a 数据（≥ 5 个 approved knowledge_nodes）。

## 前置

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_EMBEDDING_MODEL="text-embedding-v1"
pnpm dev
```

## 2a-Case 1: 语义检索 happy path

```bash
CID=<existing-company-uuid>
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=database%20deadlock&limit=3" | jq
```

期望：返回 `data.results` 数组，每条含 `id / title / snippet / similarity / freshness_label / final_score`，按 final_score 降序；`search_type=semantic`；`took_ms` 包含。

## 2a-Case 2: 经验路径

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=database&used_for=bug-fix" | jq '.data.search_type, .data.results | length'
```

期望：`search_type=semantic+experience`；如果有 used_for 包含 "bug-fix" 的节点，experience_score > 0。

## 2a-Case 3: type / domain 过滤

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=anything&type=rule&domain=general" | jq '.data.results[] | {type, domain: .domain.name}'
```

期望：全部 `type=rule`，`domain.name=general`。

## 2a-Case 4: include_outdated

如果有 valid_until 过期的节点：

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=x&include_outdated=true" | jq '.data.results[] | select(.freshness_label=="outdated")'
```

期望：能看到 freshness_label="outdated" 的节点；默认（无 include_outdated）则不返回。

## 2a-Case 5: 反馈 helped

```bash
NID=<existing-node-uuid>
BEFORE=$(curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=any&limit=10" | jq '.data.results[] | select(.id=="'$NID'") | .trigger_count')
curl -X POST "http://127.0.0.1:3100/api/knowledge/nodes/$NID/feedback?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"feedback":"helped"}'
AFTER=$(curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=any&limit=10" | jq '.data.results[] | select(.id=="'$NID'") | .trigger_count')
echo "before=$BEFORE after=$AFTER"
```

期望：after = before + 1。

## 2a-Case 6: 反馈 outdated → freshness 强制降

```bash
curl -X POST "http://127.0.0.1:3100/api/knowledge/nodes/$NID/feedback?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"feedback":"outdated"}'
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=any&include_outdated=true" | jq '.data.results[] | select(.id=="'$NID'") | .freshness_label'
```

期望：`stale_warning` 或 `outdated`（不可能再是 `fresh`）。

## 2b-Case 7: heartbeat-context 注入

```bash
ISSUE_ID=<existing-issue-uuid>
curl -s "http://127.0.0.1:3100/api/issues/$ISSUE_ID/heartbeat-context?companyId=$CID" | jq '.knowledgeNodes | length, .knowledgeNodes[0:2]'
```

期望：`knowledgeNodes` 是数组（≤ 5 条），每条含 SearchResultItem 字段。如果数据库节点很多，count 应 > 0；如果只少量节点且与 issue 主题无关（similarity < 0.75），count 可能为 0。

## 2b-Case 8: retriever 故障 fail-open

临时拔掉 OPENAI_API_KEY 重启 server，再调 heartbeat-context：

```bash
unset OPENAI_API_KEY
pnpm dev &
curl -s "http://127.0.0.1:3100/api/issues/$ISSUE_ID/heartbeat-context?companyId=$CID" | jq '.knowledgeNodes'
```

期望：`knowledgeNodes` 为 `[]`（fail-open），主响应仍 200，server 日志含 warn `knowledge retriever failed in heartbeat-context`。

## 完成判定

| Case | 状态 |
|---|---|
| 2a-Case 1 语义 | ✓ |
| 2a-Case 2 经验 | ✓ |
| 2a-Case 3 type/domain 过滤 | ✓ |
| 2a-Case 4 include_outdated | ✓ |
| 2a-Case 5 helped 反馈 trigger_count+1 | ✓ |
| 2a-Case 6 outdated 反馈 freshness 降 | ✓ |
| 2b-Case 7 heartbeat-context 注入 | ✓ |
| 2b-Case 8 fail-open | ✓ |

≥ 6/8 通过 → Phase 2a + 2b 完成，可进 Phase 2c（Agent tool plugin）或 Phase 3（演化 / Reviewer）。
```

### Step 2: Commit

```bash
git add docs/plans/2026-05-13-llm-wiki-phase-2a-2b-smoke.md
git commit -m "docs(llm-wiki): Phase 2a + 2b smoke checklist"
```

---

## End-to-end Verification

```bash
# 1. 单测全过
cd D:/aiprojects/paperclip/server && npx vitest run "knowledge"
# 预期：≥ 50 个 case 全过（Phase 1a 26 + 1b-1 7 + 1b-2 3 + 2a 23 = 59 大致量级）

# 2. typecheck 干净（modulo pre-existing aws-secrets-manager）
pnpm --filter @paperclipai/server typecheck

# 3. dev 起立
pnpm dev &
curl -sf http://127.0.0.1:3100/api/health   # 200 OK

# 4. 跑 Task 6 smoke checklist 8 个 case
```

≥ 4 / 4 + smoke 6/8 通过 → Phase 2a + 2b 完成。

---

## 顺序依赖

```
Task 0 (validators)
   ↓
Task 1 (freshness) → Task 2 (retriever)
   ↓                   ↓
   └───────────→ Task 3 (feedback)
                       ↓
                  Task 4 (routes + tests)
                       ↓
                  Task 5 (heartbeat-context 注入)
                       ↓
                  Task 6 (smoke)
```

Task 1 / 3 可并行（freshness 是 retriever 的 dep，feedback 与之独立），但串行更稳。

---

## 不在本次范围（明确划线）

- ❌ Agent tool `search_knowledge_base`（Phase 2c）
- ❌ MCP `search` 工具（Phase 6）
- ❌ Web UI 搜索页（Phase 4）
- ❌ Reviewer Agent 用 retriever 找近邻参考（Phase 3）
- ❌ `outdated` 反馈自动开"请验证"Issue（Phase 3 routine）
- ❌ `wrong` 反馈进冲突队列 + conflicts_with 边（Phase 3 演化引擎）
- ❌ `irrelevant` 反馈降权（Phase 3 used_for 统计层）
- ❌ Personal level 节点检索（PRD 留给后续）
- ❌ heartbeat-context 注入 used_for 推断（issue label / project metadata → tags）

---

## 风险与备注

1. **HNSW + Drizzle**：用 `sql\`\`` 模板拼向量查询；pgvector 兼容 Drizzle 当前版本的 raw SQL。**测试时 mock db.execute 直接返回 row 数组**（驱动差异：`postgres` 包返回数组、`pg` 包返回 `{rows: [...]}`；本仓库用 `postgres` 包，测试 mock 直接返 array 数组）
2. **embedding 调用成本**：每次 search 调一次 embed（DashScope text-embedding-v1 < ¥0.001/次）。heartbeat-context 高频触发可能成本累加；本期不加缓存（Phase 3 优化）
3. **fail-open 设计**：heartbeat-context 注入 retriever 失败时返回空数组、log warn，主 endpoint 仍 200。Agent 看到空 `knowledgeNodes` 字段不会崩
4. **schema 字段名**：`knowledge_nodes.trigger_count`（DB column）vs `triggerCount`（Drizzle TS 字段）—— 在 raw SQL 用下划线版本，在 Drizzle ORM 用 camelCase。Task 2 raw SQL 全 snake_case；Task 3 用 Drizzle ORM，全 camelCase
5. **包含 6 节点的真实数据**：跑 smoke 时若 similarity 都 < 0.75，结果为空 — 调高 query 相关性或先加几个相关节点
6. **请求 schema 严 strict()**：避免 unknown 字段绕过校验；前端传 csv 字符串符合现有 Phase 1a list endpoint 风格
