# LLM-Wiki Phase 3c — Daily Healthcheck + Metrics + Alarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按 task 顺序实现本计划。所有步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 落地 PRD §7.5 + §13.3 Routine 3 的最小 MVP —— 每日跑 healthcheck 计算 6 个核心健康指标 → 写入 `knowledge_metrics` 缓存 → 阈值超出时生成 alarm Issue。沿用 Phase 3b 的 service + in-process scheduler 模式，单 session 内可完成的 task 拆分。

**Architecture:** 服务端 `knowledgeHealthcheckService(db, issueService)` 暴露 `runHealthcheck(companyId)`：内部依次跑 6 个 metric computer → batch insert `knowledge_metrics` → 与上一次同 metric 的 status 对比 → 恶化（healthy → warning/critical 或 warning → critical）时调 `issueService.create` 生成 alarm Issue。触发方式：HTTP `POST /api/knowledge/healthcheck/run` 手动 + 进程内 setInterval 每日（opt-in via `PAPERCLIP_KNOWLEDGE_HEALTHCHECK_ENABLED=1` env，沿用 Phase 3b reviewer-scheduler 模式）。

**Tech Stack:** TypeScript / Drizzle ORM / Express 5 / Vitest（mock-only 单测，无真实 DB）/ 复用 `issueService.create`。

**Phase 3a / 沉默检测 留口（本 MVP 不实现）：**
- **6 条自动行为**（升规则 / 衰减 / 合并 / 冲突 / 时效巡检 / 模式涌现）→ Phase 3a 独立 plan
- **沉默检测**（24h 无 draft / 7d 无审查通过 / embedding 队列堆积）→ v0.2 追加
- **Routine 1/2 失败重试 3 次告警** → Routine 1 不存在；Routine 2 是 Phase 3b in-process scheduler，进程崩了通过 Paperclip 重启监控覆盖
- **Dashboard read API**（`/knowledge/dashboard` 页面读 metrics）→ Phase 4 UI scope
- **`knowledge_metrics` 90 天清理** → 留 trigger 给以后单独的 Routine

**前置状态（已落地，不需改）：**
- `knowledge_metrics` 表 schema 在 migration `0084_motionless_tempest.sql` 中（id / company_id / metric_name / metric_value / status / computed_at / details）
- Drizzle export：`packages/db/src/schema/knowledge_metrics.ts` 已声明 6 个 metric_name 字符串值供应用层校验
- `companyMetricIdx` 索引 `(company_id, metric_name, computed_at DESC)` 已建（最新值查询高效）
- 业务表已就绪：`knowledge_nodes` / `knowledge_edges` / `knowledge_drafts` / `knowledge_node_events`
- Phase 3b 的 `knowledge-reviewer-scheduler.ts` 作为 in-process 调度参考实现
- Phase 3b 的 `POST /api/knowledge/reviewer/run` 作为路由风格参考
- `issueService.create(companyId, {...})` 已可创建 alarm Issue

---

## File Structure

**Create:**
- `server/src/services/knowledge-healthcheck.ts` — `knowledgeHealthcheckService` 工厂
- `server/src/services/knowledge-healthcheck.test.ts` — mock-only 单元测试
- `server/src/services/knowledge-healthcheck-scheduler.ts` — `startHealthcheckScheduler()` / `stopHealthcheckScheduler()`
- `docs/plans/2026-05-14-llm-wiki-phase-3c-smoke.md` — 手动 smoke 清单

**Modify:**
- `packages/shared/src/validators/knowledge.ts` — 添加 `KNOWLEDGE_METRIC_NAMES`、`KNOWLEDGE_METRIC_STATUSES`、`healthcheckRunQuerySchema`
- `packages/shared/src/validators/knowledge.test.ts` — 新 schema 用例
- `server/src/services/index.ts` — re-export `createKnowledgeHealthcheckService`
- `server/src/routes/knowledge.ts` — 添加 `POST /api/knowledge/healthcheck/run`
- `server/src/__tests__/knowledge-routes.test.ts` — 新 1 个 route 用例
- `server/src/app.ts` — wire healthcheck service + 启动 scheduler（env gated）

---

## 6 个指标定义 + 阈值（应用层枚举，跟 schema 注释一致）

| metric_name | 健康区间（PRD §7.5） | healthy | warning | critical | 数据源 |
|---|---|---|---|---|---|
| `weekly_new_drafts` | > 0 | ≥ 1 | — | = 0 | `knowledge_drafts` `created_at > now()-7d` |
| `review_backlog_hours_p50` | < 24h | ≤ 24 | (24, 48] | > 48 | `knowledge_drafts` `status=pending`，`now() - created_at` 中位 |
| `helped_ratio` | > 0.5 | ≥ 0.5 | [0.3, 0.5) | < 0.3 | `knowledge_node_events` `event_type=feedback`，过去 30 天 `value=helped` 占比 |
| `avg_edges_per_node` | > 1.5 边/节点 | ≥ 1.5 | [1.0, 1.5) | < 1.0 | `COUNT(knowledge_edges)/COUNT(knowledge_nodes)` per company |
| `unresolved_conflicts` | < 10 | ≤ 9 | [10, 20] | > 20 | `knowledge_node_events` `event_type=conflict_detected` 未关闭计数（具体 schema 见 Task 2.5） |
| `stale_unchecked_fast` | < 5 | ≤ 4 | [5, 10] | > 10 | `knowledge_nodes` `volatility=fast AND (verified_at IS NULL OR verified_at < now()-90d)` |

阈值常量在 `knowledge-healthcheck.ts` 顶部 `METRIC_THRESHOLDS` 对象，方便未来调整不动 service 主逻辑。

---

## Task 1: shared validators + metric enums

**Files:**
- Modify: `packages/shared/src/validators/knowledge.ts`
- Modify: `packages/shared/src/validators/knowledge.test.ts`

- [ ] **Step 1：写失败的测试**

修改 `packages/shared/src/validators/knowledge.test.ts`，在合适位置加：

```ts
import {
  KNOWLEDGE_METRIC_NAMES,
  KNOWLEDGE_METRIC_STATUSES,
  healthcheckRunQuerySchema,
} from "../validators/knowledge.js";

describe("KNOWLEDGE_METRIC_NAMES", () => {
  it("contains exactly 6 PRD-defined metric names", () => {
    expect(KNOWLEDGE_METRIC_NAMES).toEqual([
      "weekly_new_drafts",
      "review_backlog_hours_p50",
      "helped_ratio",
      "avg_edges_per_node",
      "unresolved_conflicts",
      "stale_unchecked_fast",
    ]);
  });
});

describe("KNOWLEDGE_METRIC_STATUSES", () => {
  it("matches DB CHECK constraint", () => {
    expect(KNOWLEDGE_METRIC_STATUSES).toEqual(["healthy", "warning", "critical"]);
  });
});

describe("healthcheckRunQuerySchema", () => {
  it("accepts empty payload (defaults: all metrics, current company)", () => {
    const parsed = healthcheckRunQuerySchema.parse({});
    expect(parsed.metrics).toEqual(KNOWLEDGE_METRIC_NAMES);
  });
  it("filters to subset when metrics provided", () => {
    const parsed = healthcheckRunQuerySchema.parse({
      metrics: ["weekly_new_drafts", "helped_ratio"],
    });
    expect(parsed.metrics).toEqual(["weekly_new_drafts", "helped_ratio"]);
  });
  it("rejects unknown metric name", () => {
    expect(() =>
      healthcheckRunQuerySchema.parse({ metrics: ["bogus_metric"] }),
    ).toThrow();
  });
});
```

跑 `pnpm --filter @paperclipai/shared test` 应失败（symbols 还不存在）。

- [ ] **Step 2：实现**

在 `packages/shared/src/validators/knowledge.ts` 末尾追加（紧贴 Phase 3b 的 `KNOWLEDGE_PRE_VERDICT_VALUES` 之后，保持顺序一致）：

```ts
/**
 * Phase 3c 健康指标枚举。
 * 6 个指标与 PRD §7.5 一一对应。新增指标时同步：
 * - server/src/services/knowledge-healthcheck.ts 的 METRIC_THRESHOLDS / computer 注册
 * - knowledge_metrics schema 注释（packages/db/src/schema/knowledge_metrics.ts §14-25 行）
 */
export const KNOWLEDGE_METRIC_NAMES = [
  "weekly_new_drafts",
  "review_backlog_hours_p50",
  "helped_ratio",
  "avg_edges_per_node",
  "unresolved_conflicts",
  "stale_unchecked_fast",
] as const;

export type KnowledgeMetricName = (typeof KNOWLEDGE_METRIC_NAMES)[number];

/** knowledge_metrics.status CHECK 约束的应用层镜像 */
export const KNOWLEDGE_METRIC_STATUSES = [
  "healthy",
  "warning",
  "critical",
] as const;

export type KnowledgeMetricStatus = (typeof KNOWLEDGE_METRIC_STATUSES)[number];

/** POST /api/knowledge/healthcheck/run 请求体 */
export const healthcheckRunQuerySchema = z
  .object({
    metrics: z
      .array(z.enum(KNOWLEDGE_METRIC_NAMES))
      .min(1)
      .optional()
      .default([...KNOWLEDGE_METRIC_NAMES]),
  })
  .strict();

export type HealthcheckRunQuery = z.infer<typeof healthcheckRunQuerySchema>;
```

- [ ] **Step 3：verify** `pnpm --filter @paperclipai/shared test` 通过。

---

## Task 2: knowledgeHealthcheckService — 6 metric computers

**Files:**
- Create: `server/src/services/knowledge-healthcheck.ts`
- Create: `server/src/services/knowledge-healthcheck.test.ts`

**设计原则**：

1. 工厂函数 `createKnowledgeHealthcheckService({ db, issueService })`。
2. 暴露 6 个内部 computer + 1 个公开 `runHealthcheck(companyId, opts?)`（Task 3）。
3. 每个 computer 签名一致：`compute<MetricName>(companyId): Promise<{ value: number; status: KnowledgeMetricStatus; details: Record<string, unknown> }>`。
4. computer 内部只读 DB，不写。
5. 阈值常量 `METRIC_THRESHOLDS` 顶部声明，未来调整不动 service 逻辑。

- [ ] **Step 1：写失败的测试**

新建 `server/src/services/knowledge-healthcheck.test.ts`，对每个 computer 写至少 3 个边界用例（健康 / 警告 / 严重）。例如：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKnowledgeHealthcheckService } from "./knowledge-healthcheck.js";

const stubDb = (overrides: Partial<Record<string, unknown>> = {}) => ({
  // 简单的 query stub，按需返回 fixture
  execute: vi.fn(),
  select: vi.fn(),
  ...overrides,
});

describe("computeWeeklyNewDrafts", () => {
  it("returns healthy when >= 1 draft in last 7 days", async () => {
    const db = stubDb({
      execute: vi.fn().mockResolvedValueOnce([{ count: 5 }]),
    });
    const svc = createKnowledgeHealthcheckService({ db: db as any, issueService: {} as any });
    const result = await svc.__test__.computeWeeklyNewDrafts("company-1");
    expect(result.value).toBe(5);
    expect(result.status).toBe("healthy");
  });
  it("returns critical when 0 drafts in last 7 days", async () => {
    const db = stubDb({
      execute: vi.fn().mockResolvedValueOnce([{ count: 0 }]),
    });
    const svc = createKnowledgeHealthcheckService({ db: db as any, issueService: {} as any });
    const result = await svc.__test__.computeWeeklyNewDrafts("company-1");
    expect(result.value).toBe(0);
    expect(result.status).toBe("critical");
  });
});

// ... 其余 5 个 computer 各 3 用例 ...
```

- [ ] **Step 2：实现 6 个 computer**

在 `server/src/services/knowledge-healthcheck.ts` 实现。每个 computer 用 Drizzle `sql\`...\``（参考 Phase 2a `knowledgeRetrieverService` 风格）。具体 SQL 见 **Appendix A**。

```ts
import { sql } from "drizzle-orm";
import type { Database } from "@paperclipai/db";
import type { IssueService } from "./issue-service.js";   // 实际路径以 services/index.ts 为准
import {
  KNOWLEDGE_METRIC_NAMES,
  type KnowledgeMetricName,
  type KnowledgeMetricStatus,
} from "@paperclipai/shared";

const METRIC_THRESHOLDS = {
  weekly_new_drafts: { healthyMin: 1, warningRange: null, criticalMax: 0 },
  review_backlog_hours_p50: { healthyMax: 24, warningRange: [24, 48], criticalMin: 48 },
  helped_ratio: { healthyMin: 0.5, warningRange: [0.3, 0.5], criticalMax: 0.3 },
  avg_edges_per_node: { healthyMin: 1.5, warningRange: [1.0, 1.5], criticalMax: 1.0 },
  unresolved_conflicts: { healthyMax: 9, warningRange: [10, 20], criticalMin: 20 },
  stale_unchecked_fast: { healthyMax: 4, warningRange: [5, 10], criticalMin: 10 },
} as const;

interface ComputerResult {
  value: number;
  status: KnowledgeMetricStatus;
  details: Record<string, unknown>;
}

interface HealthcheckDeps {
  db: Database;
  issueService: IssueService;
}

export function createKnowledgeHealthcheckService(deps: HealthcheckDeps) {
  const { db, issueService } = deps;

  async function computeWeeklyNewDrafts(companyId: string): Promise<ComputerResult> {
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM knowledge_drafts
      WHERE company_id = ${companyId}
        AND created_at > NOW() - INTERVAL '7 days'
    `);
    const value = (rows[0] as { count: number }).count;
    const status: KnowledgeMetricStatus = value >= 1 ? "healthy" : "critical";
    return { value, status, details: { window_days: 7 } };
  }

  // ... 其他 5 个 computer，参考 Appendix A ...

  return {
    async runHealthcheck(/* see Task 3 */) { /* ... */ },
    /** 仅 test 访问内部 computer */
    __test__: {
      computeWeeklyNewDrafts,
      computeReviewBacklog,
      computeHelpedRatio,
      computeAvgEdgesPerNode,
      computeUnresolvedConflicts,
      computeStaleUncheckedFast,
    },
  };
}

export type KnowledgeHealthcheckService = ReturnType<typeof createKnowledgeHealthcheckService>;
```

- [ ] **Step 3：verify** `pnpm --filter @paperclipai/server test knowledge-healthcheck` 通过。

---

## Task 3: runHealthcheck — 统合 + knowledge_metrics 写入 + alarm Issue

**Files:** Modify: `server/src/services/knowledge-healthcheck.ts` + `.test.ts`

**业务逻辑**：

1. 对 `opts.metrics`（默认全部 6 个）依次调 computer。
2. Batch insert 一次 `knowledge_metrics`，记录 `value / status / computed_at / details`。
3. 对每个 metric 查上一次同 `(companyId, metric_name)` 的 status：
   - 上一次不存在 OR 上一次 = healthy，本次 = warning/critical → **创建 alarm Issue**
   - 上一次 = warning，本次 = critical → **创建 alarm Issue**（状态恶化）
   - 上一次 = warning/critical，本次同状态或更好 → **不创建**（避免重复）
4. Alarm Issue 含 metric name / value / threshold / details / drilldown link。具体格式见 **Appendix B**。

- [ ] **Step 1：写测试**

```ts
describe("runHealthcheck", () => {
  it("inserts 6 metric rows on first run", async () => {
    // stub db.execute / db.insert，验证 batch insert 调用一次，含 6 行
    // ...
  });
  it("creates alarm issue when status worsens healthy -> critical", async () => {
    // stub 上次 status = healthy；本次 computer 返回 critical
    // 期望 issueService.create 被调用一次，标题含 metric name
    // ...
  });
  it("does NOT create duplicate alarm when status stays warning", async () => {
    // 上次 = warning，本次 = warning → issueService.create 不调
    // ...
  });
  it("respects opts.metrics filter", async () => {
    // opts.metrics = ['weekly_new_drafts'] → 只 insert 1 行
    // ...
  });
  it("returns summary { metricsComputed, alarmsCreated }", async () => {
    // runHealthcheck 返回值校验
  });
});
```

- [ ] **Step 2：实现 runHealthcheck**

```ts
async function runHealthcheck(
  companyId: string,
  opts?: { metrics?: KnowledgeMetricName[] },
): Promise<{ metricsComputed: number; alarmsCreated: number }> {
  const requested = opts?.metrics ?? [...KNOWLEDGE_METRIC_NAMES];
  const computedAt = new Date();

  // 1. 跑 computer
  const computerMap = {
    weekly_new_drafts: computeWeeklyNewDrafts,
    review_backlog_hours_p50: computeReviewBacklog,
    helped_ratio: computeHelpedRatio,
    avg_edges_per_node: computeAvgEdgesPerNode,
    unresolved_conflicts: computeUnresolvedConflicts,
    stale_unchecked_fast: computeStaleUncheckedFast,
  } as const;

  const results = await Promise.all(
    requested.map(async (name) => ({
      name,
      ...(await computerMap[name](companyId)),
    })),
  );

  // 2. 一次 batch insert
  await db.insert(knowledgeMetrics).values(
    results.map((r) => ({
      companyId,
      metricName: r.name,
      metricValue: String(r.value),  // numeric → string
      status: r.status,
      computedAt,
      details: r.details,
    })),
  );

  // 3. 对每个 metric 查上一次 status + 决定是否开 alarm
  let alarmsCreated = 0;
  for (const r of results) {
    const last = await db.execute(sql`
      SELECT status FROM knowledge_metrics
      WHERE company_id = ${companyId}
        AND metric_name = ${r.name}
        AND computed_at < ${computedAt}
      ORDER BY computed_at DESC
      LIMIT 1
    `);
    const lastStatus = (last[0] as { status: KnowledgeMetricStatus } | undefined)?.status;

    const worsened =
      (!lastStatus || lastStatus === "healthy") && r.status !== "healthy" ||
      (lastStatus === "warning" && r.status === "critical");

    if (!worsened) continue;

    await issueService.create(companyId, {
      title: `[LLM-Wiki Health] ${r.name} = ${r.value} (${r.status})`,
      body: formatAlarmBody(r.name, r.value, r.status, r.details),
      labels: ["llm-wiki-health-alarm", r.name],
      // 不指定 assignee — 进 admin review queue
    });
    alarmsCreated++;
  }

  return { metricsComputed: results.length, alarmsCreated };
}
```

`formatAlarmBody()` 参考 Appendix B 模板。

- [ ] **Step 3：verify** 全部 test pass + 至少手测一次 runHealthcheck 不抛错。

---

## Task 4: REST POST /api/knowledge/healthcheck/run

**Files:**
- Modify: `server/src/routes/knowledge.ts`
- Modify: `server/src/__tests__/knowledge-routes.test.ts`

- [ ] **Step 1：测试**

```ts
describe("POST /api/knowledge/healthcheck/run", () => {
  it("requires company auth", async () => {
    const res = await request(app)
      .post("/api/knowledge/healthcheck/run")
      .send({});
    expect(res.status).toBe(401);
  });
  it("rejects unknown metric name (400)", async () => {
    // ...
  });
  it("returns { metricsComputed, alarmsCreated } on success", async () => {
    // mock service.runHealthcheck → 期望返回 { metricsComputed: 6, alarmsCreated: 0 }
    // 验证 service.runHealthcheck 被调一次，参数 = current company id
  });
});
```

- [ ] **Step 2：实现**

在 `server/src/routes/knowledge.ts` 加（紧贴 Phase 3b `POST /api/knowledge/reviewer/run` 之后）：

```ts
router.post(
  "/healthcheck/run",
  assertCompanyAccess,
  async (req, res) => {
    const parsed = healthcheckRunQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const result = await healthcheckService.runHealthcheck(
      req.companyId,
      { metrics: parsed.data.metrics },
    );
    res.json(result);
  },
);
```

- [ ] **Step 3：verify** `pnpm --filter @paperclipai/server test knowledge-routes` 通过。

---

## Task 5: in-process daily scheduler

**Files:**
- Create: `server/src/services/knowledge-healthcheck-scheduler.ts`
- Modify: `server/src/app.ts`

**设计**：

- 完全沿用 Phase 3b `knowledge-reviewer-scheduler.ts` 模式（`setInterval`，进程内，env gated）
- 每小时唤醒一次，检查当前小时 = `PAPERCLIP_KNOWLEDGE_HEALTHCHECK_HOUR`（默认 `8`）且当天未跑过，则跑所有 company
- 不用 cron 库，避免新增依赖
- 关闭时调 `stopHealthcheckScheduler()` 清 interval（防 graceful shutdown 泄漏）

- [ ] **Step 1：实现**

```ts
import type { KnowledgeHealthcheckService } from "./knowledge-healthcheck.js";
import type { Database } from "@paperclipai/db";

const HOUR_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;  // YYYY-MM-DD

export function startHealthcheckScheduler(deps: {
  db: Database;
  healthcheckService: KnowledgeHealthcheckService;
  targetHour?: number;
}) {
  const targetHour = deps.targetHour ?? 8;
  if (timer) return;

  const tick = async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== targetHour) return;
    if (lastRunDate === today) return;
    lastRunDate = today;

    // 跑所有 company
    const companies = await deps.db.execute(
      sql`SELECT id FROM companies WHERE archived_at IS NULL`,
    );
    for (const row of companies as Array<{ id: string }>) {
      try {
        await deps.healthcheckService.runHealthcheck(row.id);
      } catch (err) {
        console.error("[healthcheck-scheduler]", row.id, err);
        // 单 company 失败不影响其他 company
      }
    }
  };

  // 启动时立刻 tick 一次（避免错过 targetHour）+ 之后每 1h
  void tick();
  timer = setInterval(tick, HOUR_MS);
}

export function stopHealthcheckScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    lastRunDate = null;
  }
}
```

- [ ] **Step 2：wire in `server/src/app.ts`**

紧贴 Phase 3b `startReviewerScheduler` 之后：

```ts
if (process.env.PAPERCLIP_KNOWLEDGE_HEALTHCHECK_ENABLED === "1") {
  startHealthcheckScheduler({
    db,
    healthcheckService,
    targetHour: Number(process.env.PAPERCLIP_KNOWLEDGE_HEALTHCHECK_HOUR ?? 8),
  });
  logger.info("knowledge healthcheck scheduler started");
}
```

- [ ] **Step 3：verify** 手动测试（不写 unit test，scheduler 涉及定时器 mocking 太重）：
  - `PAPERCLIP_KNOWLEDGE_HEALTHCHECK_ENABLED=1 PAPERCLIP_KNOWLEDGE_HEALTHCHECK_HOUR=$(date +%H) pnpm dev`
  - 服务起来后查看 log 是否打 `knowledge healthcheck scheduler started`
  - 当前小时数等于 targetHour 时观察立刻有 healthcheck 跑（看 server log）

---

## Task 6: smoke checklist

**Files:** Create: `docs/plans/2026-05-14-llm-wiki-phase-3c-smoke.md`

参考 Phase 3b smoke checklist 风格。最小 smoke 内容：

```markdown
# LLM-Wiki Phase 3c — Healthcheck Smoke

## 前置
- PG（含 pgvector）+ Phase 0-3b 已部署
- 至少 1 个 company
- 可手动 POST 到 /api/knowledge/healthcheck/run（board 操作员身份）

## Smoke 1: 手动触发一次健康检查

```bash
curl -X POST http://localhost:3100/api/knowledge/healthcheck/run \
  -H "Content-Type: application/json" \
  -H "Cookie: ..." \
  -d '{}'
```

预期返回：`{ "metricsComputed": 6, "alarmsCreated": 0..6 }`

## Smoke 2: 验证 knowledge_metrics 写入

```sql
SELECT metric_name, metric_value, status, computed_at
FROM knowledge_metrics
WHERE company_id = '<your-company-id>'
ORDER BY computed_at DESC
LIMIT 6;
```

预期：6 行，每个 metric_name 一行，computed_at 几秒内。

## Smoke 3: 制造 critical 状况，验证 alarm Issue 生成

最容易制造的 critical：
- 删/不创建任何 drafts → `weekly_new_drafts = 0` → critical
- 或人工 insert 一行 `knowledge_drafts` `created_at = now()-30d, status=pending` → backlog 时长极高

跑 healthcheck 两次（第一次 baseline，第二次触发状态恶化）。

预期：第二次跑后查 issues 表，有标题含 `[LLM-Wiki Health]` 的 alarm Issue。

## Smoke 4: 验证不重复创建

立刻第三次跑 healthcheck，alarm 不重复创建（`alarmsCreated = 0`）。

## Smoke 5: scheduler 启动

```bash
PAPERCLIP_KNOWLEDGE_HEALTHCHECK_ENABLED=1 \
PAPERCLIP_KNOWLEDGE_HEALTHCHECK_HOUR=$(date +%H) \
pnpm dev
```

预期 server log：`knowledge healthcheck scheduler started`。等几秒（启动时 tick 一次）观察 healthcheck 跑。
```

- [ ] verify smoke checklist 文件存在且引用的 SQL/curl 命令完整。

---

## Acceptance Criteria（与 PRD §16.1 + §15 Phase 3 对照）

| PRD 要求 | Phase 3c 实现状态 |
|---|---|
| 6 项健康指标在 Dashboard 显示 | ⏸️ **Dashboard 在 Phase 4 范围**；3c 只负责计算 + 写表 |
| 任一异常时自动开 alarm Issue | ✅ Task 3 实现，dedup 已设计 |
| 沉默检测（24h 无 draft / 7d 无审查通过） | ❌ **不实现**，留口给 v0.2（见本 plan 顶部"留口"） |
| Routine 1/2 失败重试 3 次告警 | ❌ **不实现**，Routine 1 不存在；Routine 2 进程崩了走平台重启 |
| 6 条演化行为产生 Issue | ❌ **Phase 3a scope**，本 plan 不覆盖 |

**本 MVP 完成视为**：
- `pnpm --filter @paperclipai/shared test` + `pnpm --filter @paperclipai/server test` 全部通过
- Smoke 1-5 全部 ✅
- AGENTS.md §11 Definition of Done 第 1-5 项满足；第 6 项 Greptile 留给 PR review

---

## Appendix A: 6 个 metric 的 SQL 查询草稿

仅供 Task 2 实现时参考，具体 SQL 写法以 Drizzle `sql\`...\`` 模板 + 实际 schema 字段名为准。

### A.1 `weekly_new_drafts`
```sql
SELECT COUNT(*)::int AS count
FROM knowledge_drafts
WHERE company_id = $1
  AND created_at > NOW() - INTERVAL '7 days';
```

### A.2 `review_backlog_hours_p50`
```sql
SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600
  )::numeric AS p50_hours
FROM knowledge_drafts
WHERE company_id = $1 AND status = 'pending';
```

无 pending → p50 = 0 → healthy。

### A.3 `helped_ratio`
```sql
WITH feedback_30d AS (
  SELECT payload->>'value' AS feedback_value
  FROM knowledge_node_events
  WHERE company_id = $1
    AND event_type = 'feedback'
    AND created_at > NOW() - INTERVAL '30 days'
)
SELECT
  CASE WHEN COUNT(*) = 0 THEN NULL  -- 无反馈数据 → details.no_data=true, status=healthy
  ELSE
    SUM(CASE WHEN feedback_value = 'helped' THEN 1 ELSE 0 END)::numeric
    / COUNT(*)::numeric
  END AS ratio
FROM feedback_30d;
```

**特殊处理**：反馈数据少（< 10 条）时 status = healthy，details 含 `low_sample=true`。

### A.4 `avg_edges_per_node`
```sql
WITH n AS (SELECT COUNT(*)::numeric AS c FROM knowledge_nodes WHERE company_id = $1),
     e AS (SELECT COUNT(*)::numeric AS c FROM knowledge_edges WHERE company_id = $1)
SELECT CASE WHEN n.c = 0 THEN 0 ELSE e.c / n.c END AS avg_edges
FROM n, e;
```

无 nodes 时 = 0 → critical，但 details 含 `no_nodes=true` 提示别 panic。

### A.5 `unresolved_conflicts`

依赖 Phase 3a 演化引擎的 conflict 事件。**MVP 暂时这样**：

```sql
SELECT COUNT(*)::int AS count
FROM knowledge_node_events
WHERE company_id = $1
  AND event_type = 'conflict_detected'
  AND payload->>'resolved' IS DISTINCT FROM 'true';
```

如果 Phase 3a 未落地 / `conflict_detected` 事件类型不存在，counts 永远 = 0 → 永久 healthy。Task 2 实现时遇到 schema 不支持，**容错返回 `{ value: 0, status: 'healthy', details: { source_unavailable: true } }`** 而不是抛错。

### A.6 `stale_unchecked_fast`
```sql
SELECT COUNT(*)::int AS count
FROM knowledge_nodes
WHERE company_id = $1
  AND volatility = 'fast'
  AND (verified_at IS NULL OR verified_at < NOW() - INTERVAL '90 days');
```

---

## Appendix B: Alarm Issue 格式

**Title**:
```
[LLM-Wiki Health] {metric_name} = {value} ({status})
```

例：`[LLM-Wiki Health] review_backlog_hours_p50 = 72.5 (critical)`

**Body** (markdown)：
```markdown
## 健康指标告警

| 字段 | 值 |
|---|---|
| Metric | `{metric_name}` |
| Value | {value} |
| Status | **{status}** |
| Computed at | {computed_at} (ISO 8601) |
| Healthy threshold (PRD §7.5) | {threshold_description} |

## 详情

{details JSON 美化展示}

## 推荐 drilldown

- {根据 metric_name 给具体页面链接（Phase 4 上线后可点击）}
  - weekly_new_drafts → /knowledge/drafts （看是否真的写入路径阻塞）
  - review_backlog_hours_p50 → /knowledge/drafts?status=pending&sort=created_at
  - helped_ratio → /knowledge/dashboard?tab=feedback
  - avg_edges_per_node → /knowledge/graph
  - unresolved_conflicts → /knowledge/review?tab=conflicts
  - stale_unchecked_fast → /knowledge/search?filter=stale

## 自动生成

由 `daily-knowledge-healthcheck` Routine 自动生成（详见 `docs/plans/2026-05-14-llm-wiki-phase-3c-healthcheck.md`）。
关闭此 Issue 不抑制后续告警 —— dedup 逻辑基于 metric status 是否恶化，不基于 Issue 状态。
```

**Labels**:
- `llm-wiki-health-alarm`
- `{metric_name}`（具体 metric 名，方便按 metric 过滤）

**Priority** (如果 Paperclip issue model 支持):
- `critical` status → priority `high`
- `warning` status → priority `medium`

**Assignee**: 不指定，进 admin review queue。

---

## Appendix C: 此 plan 后续演进

**v0.2 待加内容**（Phase 3c 完成后追加）：
- 沉默检测：24h 无 draft / 7d 无审查通过 / embedding 失败堆积 → 3 个新 metric_name
- Routine 健康监控：检测 Phase 3b reviewer scheduler 是否真在跑
- knowledge_metrics 90 天清理逻辑
- Dashboard `/knowledge/dashboard` 读 metrics（Phase 4 范围，单独 plan）

**Phase 3a 依赖此 plan 的接口**：
- `knowledge_metrics` 表已有的 `details` jsonb 列足够 Phase 3a 演化引擎写入"6 条行为各自统计"，不必扩 schema
- `unresolved_conflicts` 在 Phase 3a 落地后自动从 `source_unavailable=true` 切到真实数据 —— Task 2 的容错设计就是为这个

**v1.0 真正"Curator Agent" 升级**：
- 当前 in-process scheduler 是占位，未来用 Paperclip 真正的 Routine + Agent 派工模型替换
- service 层不变，只换调用方（scheduler → routine handler）
