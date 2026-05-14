import { describe, it, expect, vi } from "vitest";
import {
  knowledgeHealthcheckService,
  METRIC_THRESHOLDS,
  shouldCreateAlarm,
  formatAlarmBody,
} from "./knowledge-healthcheck.js";

/**
 * mock db with sequential execute() return values。
 * 用 mockResolvedValueOnce 而不是 mockResolvedValue,因为每个测试只调一次
 * execute,避免上一个测试的返回值串到下一个。
 */
function fakeDb(...executeResults: unknown[][]) {
  const db = {
    execute: vi.fn(),
  };
  for (const r of executeResults) {
    db.execute.mockResolvedValueOnce(r);
  }
  return db as never;
}

// ──────────────────────────────────────────────────────────────────
// computeWeeklyNewDrafts (PRD §7.5: > 0 healthy, = 0 critical)
// ──────────────────────────────────────────────────────────────────

describe("computeWeeklyNewDrafts", () => {
  it("returns healthy when ≥ 1 draft created in last 7 days", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 5 }]));
    const r = await svc.__test__.computeWeeklyNewDrafts("co-1");
    expect(r.value).toBe(5);
    expect(r.status).toBe("healthy");
    expect(r.details).toEqual({ window_days: 7 });
  });

  it("returns critical when 0 drafts in last 7 days", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 0 }]));
    const r = await svc.__test__.computeWeeklyNewDrafts("co-1");
    expect(r.value).toBe(0);
    expect(r.status).toBe("critical");
  });

  it("tolerates empty result rows defensively (value=0, critical)", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([]));
    const r = await svc.__test__.computeWeeklyNewDrafts("co-1");
    expect(r.value).toBe(0);
    expect(r.status).toBe("critical");
  });

  it("uses the configured healthyMin threshold", () => {
    expect(METRIC_THRESHOLDS.weekly_new_drafts.healthyMin).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// computeReviewBacklogHoursP50 (PRD §7.5: ≤24 healthy / (24,48] warning / >48 critical)
// ──────────────────────────────────────────────────────────────────

describe("computeReviewBacklogHoursP50", () => {
  it("returns healthy when p50 ≤ 24h", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ p50_hours: 12.5, pending_count: 5 }]),
    );
    const r = await svc.__test__.computeReviewBacklogHoursP50("co-1");
    expect(r.value).toBe(12.5);
    expect(r.status).toBe("healthy");
    expect(r.details).toEqual({ pending_count: 5 });
  });

  it("returns healthy at boundary value = 24h", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ p50_hours: 24, pending_count: 3 }]),
    );
    const r = await svc.__test__.computeReviewBacklogHoursP50("co-1");
    expect(r.status).toBe("healthy");
  });

  it("returns warning when 24 < p50 ≤ 48", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ p50_hours: 36, pending_count: 12 }]),
    );
    const r = await svc.__test__.computeReviewBacklogHoursP50("co-1");
    expect(r.status).toBe("warning");
  });

  it("returns warning at boundary value = 48h", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ p50_hours: 48, pending_count: 8 }]),
    );
    const r = await svc.__test__.computeReviewBacklogHoursP50("co-1");
    expect(r.status).toBe("warning");
  });

  it("returns critical when p50 > 48h", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ p50_hours: 72, pending_count: 20 }]),
    );
    const r = await svc.__test__.computeReviewBacklogHoursP50("co-1");
    expect(r.status).toBe("critical");
  });

  it("returns healthy with value=0 when no pending drafts (PG COALESCE)", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ p50_hours: 0, pending_count: 0 }]),
    );
    const r = await svc.__test__.computeReviewBacklogHoursP50("co-1");
    expect(r.value).toBe(0);
    expect(r.status).toBe("healthy");
  });

  it("coerces numeric/string from PG safely (numeric returned as string by some drivers)", async () => {
    // postgres.js 返回 numeric as string；node-pg 返回 number。两者都要 work。
    const svc = knowledgeHealthcheckService(
      fakeDb([{ p50_hours: "36.5", pending_count: 7 }]),
    );
    const r = await svc.__test__.computeReviewBacklogHoursP50("co-1");
    expect(r.value).toBe(36.5);
    expect(r.status).toBe("warning");
  });
});

// ──────────────────────────────────────────────────────────────────
// computeStaleUncheckedFast (PRD §7.5: ≤4 healthy / [5,10] warning / >10 critical)
// ──────────────────────────────────────────────────────────────────

describe("computeStaleUncheckedFast", () => {
  it("returns healthy when count ≤ 4", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 2 }]));
    const r = await svc.__test__.computeStaleUncheckedFast("co-1");
    expect(r.value).toBe(2);
    expect(r.status).toBe("healthy");
    expect(r.details).toEqual({ window_days: 90 });
  });

  it("returns healthy at boundary count = 4", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 4 }]));
    const r = await svc.__test__.computeStaleUncheckedFast("co-1");
    expect(r.status).toBe("healthy");
  });

  it("returns warning at boundary count = 5", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 5 }]));
    const r = await svc.__test__.computeStaleUncheckedFast("co-1");
    expect(r.status).toBe("warning");
  });

  it("returns warning when count in [5, 10]", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 7 }]));
    const r = await svc.__test__.computeStaleUncheckedFast("co-1");
    expect(r.status).toBe("warning");
  });

  it("returns warning at boundary count = 10", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 10 }]));
    const r = await svc.__test__.computeStaleUncheckedFast("co-1");
    expect(r.status).toBe("warning");
  });

  it("returns critical when count > 10", async () => {
    const svc = knowledgeHealthcheckService(fakeDb([{ count: 15 }]));
    const r = await svc.__test__.computeStaleUncheckedFast("co-1");
    expect(r.status).toBe("critical");
  });
});

// ──────────────────────────────────────────────────────────────────
// computeHelpedRatio (PRD §7.5: ≥0.5 healthy / [0.3,0.5) warning / <0.3 critical)
// Maintainer decision 1A: total < 10 → healthy + low_sample flag
// ──────────────────────────────────────────────────────────────────

describe("computeHelpedRatio", () => {
  it("returns healthy + low_sample when total < 10 (decision 1A)", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 5, ratio: 0.2 }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    // Even ratio=0.2 (which would normally be critical) → healthy because low_sample
    expect(r.status).toBe("healthy");
    expect(r.value).toBe(0.2);
    expect(r.details.low_sample).toBe(true);
    expect(r.details.total_feedback).toBe(5);
    expect(r.details.low_sample_threshold).toBe(10);
  });

  it("returns healthy + low_sample when no feedback at all (total=0)", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 0, ratio: 0 }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    expect(r.status).toBe("healthy");
    expect(r.details.low_sample).toBe(true);
  });

  it("returns healthy when total ≥ 10 and ratio ≥ 0.5", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 20, ratio: 0.7 }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    expect(r.status).toBe("healthy");
    expect(r.value).toBe(0.7);
    expect(r.details.low_sample).toBeUndefined();
  });

  it("returns healthy at boundary ratio = 0.5", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 20, ratio: 0.5 }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    expect(r.status).toBe("healthy");
  });

  it("returns warning when ratio in [0.3, 0.5)", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 20, ratio: 0.4 }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    expect(r.status).toBe("warning");
  });

  it("returns warning at boundary ratio = 0.3", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 20, ratio: 0.3 }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    expect(r.status).toBe("warning");
  });

  it("returns critical when ratio < 0.3", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 30, ratio: 0.15 }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    expect(r.status).toBe("critical");
    expect(r.value).toBe(0.15);
  });

  it("coerces numeric-as-string ratio safely", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ total: 15, ratio: "0.6" }]),
    );
    const r = await svc.__test__.computeHelpedRatio("co-1");
    expect(r.value).toBe(0.6);
    expect(r.status).toBe("healthy");
  });
});

// ──────────────────────────────────────────────────────────────────
// computeAvgEdgesPerNode (PRD §7.5: ≥1.5 healthy / [1.0,1.5) warning / <1.0 critical)
// Maintainer decision 2C: weighted human=1.0 / auto=0.5
// ──────────────────────────────────────────────────────────────────

describe("computeAvgEdgesPerNode", () => {
  it("returns healthy + no_nodes when no nodes exist", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ node_count: 0, weighted: 0, auto_count: 0, human_count: 0, total: 0 }]),
    );
    const r = await svc.__test__.computeAvgEdgesPerNode("co-1");
    expect(r.value).toBe(0);
    expect(r.status).toBe("healthy");
    expect(r.details.no_nodes).toBe(true);
  });

  it("returns healthy when weighted avg ≥ 1.5 (e.g. 4 human + 0 auto over 2 nodes = 2.0)", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ node_count: 2, weighted: 4.0, auto_count: 0, human_count: 4, total: 4 }]),
    );
    const r = await svc.__test__.computeAvgEdgesPerNode("co-1");
    expect(r.value).toBe(2.0);
    expect(r.status).toBe("healthy");
    expect(r.details.weighting).toEqual({ human: 1.0, auto: 0.5 });
    expect(r.details.auto_edges).toBe(0);
    expect(r.details.human_edges).toBe(4);
  });

  it("returns healthy at boundary value = 1.5", async () => {
    const svc = knowledgeHealthcheckService(
      fakeDb([{ node_count: 2, weighted: 3.0, auto_count: 0, human_count: 3, total: 3 }]),
    );
    const r = await svc.__test__.computeAvgEdgesPerNode("co-1");
    expect(r.value).toBe(1.5);
    expect(r.status).toBe("healthy");
  });

  it("returns warning when weighted avg in [1.0, 1.5)", async () => {
    // 5 nodes / 4 human + 4 auto = weighted (4*1.0 + 4*0.5) / 5 = 6/5 = 1.2
    const svc = knowledgeHealthcheckService(
      fakeDb([{ node_count: 5, weighted: 6.0, auto_count: 4, human_count: 4, total: 8 }]),
    );
    const r = await svc.__test__.computeAvgEdgesPerNode("co-1");
    expect(r.value).toBe(1.2);
    expect(r.status).toBe("warning");
  });

  it("returns critical when weighted avg < 1.0 (e.g. all auto edges)", async () => {
    // 5 nodes / 0 human + 4 auto = weighted (0 + 4*0.5) / 5 = 2/5 = 0.4
    const svc = knowledgeHealthcheckService(
      fakeDb([{ node_count: 5, weighted: 2.0, auto_count: 4, human_count: 0, total: 4 }]),
    );
    const r = await svc.__test__.computeAvgEdgesPerNode("co-1");
    expect(r.value).toBe(0.4);
    expect(r.status).toBe("critical");
    expect(r.details.auto_edges).toBe(4);
    expect(r.details.human_edges).toBe(0);
  });

  it("treats auto edges as half-weighted (10 auto over 5 nodes = 1.0)", async () => {
    // 5 nodes / 0 human + 10 auto = weighted (0 + 10*0.5) / 5 = 5/5 = 1.0
    // 1.0 is exactly criticalMax, so status = critical (per `< healthyMin && < criticalMax`)
    // BUT criticalMax = 1.0 and check is `value < criticalMax`, so value=1.0 falls into warning branch
    const svc = knowledgeHealthcheckService(
      fakeDb([{ node_count: 5, weighted: 5.0, auto_count: 10, human_count: 0, total: 10 }]),
    );
    const r = await svc.__test__.computeAvgEdgesPerNode("co-1");
    expect(r.value).toBe(1.0);
    expect(r.status).toBe("warning"); // boundary: 1.0 is not < 1.0, so warning not critical
  });
});

// ──────────────────────────────────────────────────────────────────
// computeUnresolvedConflicts (decision 3A: source-unavailable fallback)
// Phase 3a 落地前一律返回 healthy + source_unavailable
// ──────────────────────────────────────────────────────────────────

describe("computeUnresolvedConflicts", () => {
  it("returns source-unavailable fallback (healthy / value=0) when Phase 3a not landed", async () => {
    // execute should NOT be called — computer is purely synthetic until Phase 3a lands
    const db = { execute: vi.fn() };
    const svc = knowledgeHealthcheckService(db as never);
    const r = await svc.__test__.computeUnresolvedConflicts("co-1");
    expect(r.value).toBe(0);
    expect(r.status).toBe("healthy");
    expect(r.details.source_unavailable).toBe(true);
    expect(r.details.reason).toMatch(/Phase 3a/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("documents the future-switch contract via will_switch_when", async () => {
    const svc = knowledgeHealthcheckService({ execute: vi.fn() } as never);
    const r = await svc.__test__.computeUnresolvedConflicts("co-1");
    expect(r.details.will_switch_when).toMatch(/Phase 3a/);
  });
});

// ──────────────────────────────────────────────────────────────────
// shouldCreateAlarm helper (Task 3 dedup logic)
// ──────────────────────────────────────────────────────────────────

describe("shouldCreateAlarm", () => {
  it("first run + critical → alarm", () => {
    expect(shouldCreateAlarm(undefined, "critical")).toBe(true);
  });
  it("first run + warning → alarm", () => {
    expect(shouldCreateAlarm(undefined, "warning")).toBe(true);
  });
  it("first run + healthy → no alarm", () => {
    expect(shouldCreateAlarm(undefined, "healthy")).toBe(false);
  });
  it("healthy → warning → alarm (degradation)", () => {
    expect(shouldCreateAlarm("healthy", "warning")).toBe(true);
  });
  it("healthy → critical → alarm (degradation)", () => {
    expect(shouldCreateAlarm("healthy", "critical")).toBe(true);
  });
  it("healthy → healthy → no alarm (stable)", () => {
    expect(shouldCreateAlarm("healthy", "healthy")).toBe(false);
  });
  it("warning → critical → alarm (further degradation)", () => {
    expect(shouldCreateAlarm("warning", "critical")).toBe(true);
  });
  it("warning → warning → no alarm (stable, dedup)", () => {
    expect(shouldCreateAlarm("warning", "warning")).toBe(false);
  });
  it("warning → healthy → no alarm (recovered)", () => {
    expect(shouldCreateAlarm("warning", "healthy")).toBe(false);
  });
  it("critical → critical → no alarm (stable, dedup)", () => {
    expect(shouldCreateAlarm("critical", "critical")).toBe(false);
  });
  it("critical → healthy → no alarm (recovered)", () => {
    expect(shouldCreateAlarm("critical", "healthy")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// formatAlarmBody helper
// ──────────────────────────────────────────────────────────────────

describe("formatAlarmBody", () => {
  const computedAt = new Date("2026-05-14T08:00:00Z");

  it("includes metric / value / status / threshold / computed_at", () => {
    const body = formatAlarmBody(
      "review_backlog_hours_p50",
      72.5,
      "critical",
      { pending_count: 42 },
      computedAt,
    );
    expect(body).toContain("`review_backlog_hours_p50`");
    expect(body).toContain("72.5");
    expect(body).toContain("**critical**");
    expect(body).toContain("≤ 24h healthy");
    expect(body).toContain("2026-05-14T08:00:00.000Z");
  });

  it("includes details as JSON code fence", () => {
    const body = formatAlarmBody(
      "helped_ratio",
      0.2,
      "critical",
      { total_feedback: 30, window_days: 30 },
      computedAt,
    );
    expect(body).toContain("```json");
    expect(body).toContain('"total_feedback": 30');
  });

  it("references the plan + dedup contract", () => {
    const body = formatAlarmBody(
      "weekly_new_drafts",
      0,
      "critical",
      {},
      computedAt,
    );
    expect(body).toContain("2026-05-14-llm-wiki-phase-3c-healthcheck.md");
    expect(body).toMatch(/Closing this issue does not suppress/i);
  });
});

// ──────────────────────────────────────────────────────────────────
// runHealthcheck (integration of computers + insert + alarm)
// ──────────────────────────────────────────────────────────────────

/**
 * Build a mock db that:
 * - returns sequential execute() results
 * - captures insert(table).values(rows) into `db.__insertedRows`
 */
function fakeDbForRun(executeResults: unknown[][]) {
  const insertedRows: unknown[][] = [];
  const valuesFn = vi.fn().mockImplementation((rows: unknown[]) => {
    insertedRows.push(rows);
    return Promise.resolve(undefined);
  });
  const db = {
    execute: vi.fn(),
    insert: vi.fn().mockReturnValue({ values: valuesFn }),
    __insertedRows: insertedRows,
    __valuesFn: valuesFn,
  };
  for (const r of executeResults) {
    db.execute.mockResolvedValueOnce(r);
  }
  return db as never;
}

function fakeIssueSvc() {
  return {
    create: vi.fn().mockResolvedValue({ id: "issue-uuid-stub" }),
  };
}

/** Compose execute results for runHealthcheck with full default 6 metrics:
 * - 6 computer execute() results in declared order
 * - 6 "last status" execute() results in same order
 * (computeUnresolvedConflicts does NOT call execute, so total = 5 computer + 6 last = 11)
 */
function defaultRunExecuteResults(opts: {
  computerOutputs?: Partial<{
    weekly_new_drafts: unknown[];
    review_backlog_hours_p50: unknown[];
    helped_ratio: unknown[];
    avg_edges_per_node: unknown[];
    stale_unchecked_fast: unknown[];
  }>;
  lastStatuses?: Partial<Record<string, "healthy" | "warning" | "critical">>;
} = {}) {
  const co = opts.computerOutputs ?? {};
  const last = opts.lastStatuses ?? {};
  return [
    co.weekly_new_drafts ?? [{ count: 5 }],
    co.review_backlog_hours_p50 ?? [{ p50_hours: 10, pending_count: 3 }],
    co.helped_ratio ?? [{ total: 20, ratio: 0.7 }],
    co.avg_edges_per_node ?? [{ node_count: 5, weighted: 8, auto_count: 0, human_count: 8, total: 8 }],
    // computeUnresolvedConflicts has no execute call
    co.stale_unchecked_fast ?? [{ count: 2 }],
    // "last status" queries — one per metric in declared order
    last.weekly_new_drafts ? [{ status: last.weekly_new_drafts }] : [],
    last.review_backlog_hours_p50 ? [{ status: last.review_backlog_hours_p50 }] : [],
    last.helped_ratio ? [{ status: last.helped_ratio }] : [],
    last.avg_edges_per_node ? [{ status: last.avg_edges_per_node }] : [],
    last.unresolved_conflicts ? [{ status: last.unresolved_conflicts }] : [],
    last.stale_unchecked_fast ? [{ status: last.stale_unchecked_fast }] : [],
  ];
}

describe("runHealthcheck", () => {
  it("computes all 6 metrics and batch-inserts to knowledge_metrics", async () => {
    const db = fakeDbForRun(defaultRunExecuteResults());
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeHealthcheckService(db, issueSvc);

    const result = await svc.runHealthcheck("co-1");

    expect(result.metricsComputed).toBe(6);
    // 1 insert call with 6 rows
    expect((db as any).__valuesFn).toHaveBeenCalledTimes(1);
    const inserted = (db as any).__insertedRows[0] as Array<{ metricName: string }>;
    expect(inserted).toHaveLength(6);
    expect(inserted.map((r) => r.metricName).sort()).toEqual([
      "avg_edges_per_node",
      "helped_ratio",
      "review_backlog_hours_p50",
      "stale_unchecked_fast",
      "unresolved_conflicts",
      "weekly_new_drafts",
    ]);
  });

  it("creates 0 alarms when all metrics are healthy (default fixtures)", async () => {
    const db = fakeDbForRun(defaultRunExecuteResults());
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeHealthcheckService(db, issueSvc);

    const result = await svc.runHealthcheck("co-1");

    expect(result.alarmsCreated).toBe(0);
    expect(issueSvc.create).not.toHaveBeenCalled();
  });

  it("creates an alarm when weekly_new_drafts drops to 0 (first run, no history)", async () => {
    const db = fakeDbForRun(
      defaultRunExecuteResults({
        computerOutputs: { weekly_new_drafts: [{ count: 0 }] }, // → critical
      }),
    );
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeHealthcheckService(db, issueSvc);

    const result = await svc.runHealthcheck("co-1");

    expect(result.alarmsCreated).toBe(1);
    expect(issueSvc.create).toHaveBeenCalledTimes(1);
    const [companyId, payload] = issueSvc.create.mock.calls[0];
    expect(companyId).toBe("co-1");
    expect(payload.title).toMatch(/\[LLM-Wiki Health\] weekly_new_drafts = 0 \(critical\)/);
    expect(payload.status).toBe("todo");
    expect(payload.priority).toBe("high"); // critical → high
    expect(payload.description).toContain("weekly_new_drafts");
  });

  it("uses priority=medium for warning, priority=high for critical", async () => {
    const db = fakeDbForRun(
      defaultRunExecuteResults({
        computerOutputs: {
          review_backlog_hours_p50: [{ p50_hours: 36, pending_count: 12 }], // → warning
        },
      }),
    );
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeHealthcheckService(db, issueSvc);

    await svc.runHealthcheck("co-1");

    const payload = issueSvc.create.mock.calls[0][1];
    expect(payload.priority).toBe("medium");
  });

  it("does NOT create alarm on warning → warning (stable, dedup)", async () => {
    const db = fakeDbForRun(
      defaultRunExecuteResults({
        computerOutputs: {
          review_backlog_hours_p50: [{ p50_hours: 36, pending_count: 12 }], // warning
        },
        lastStatuses: { review_backlog_hours_p50: "warning" },
      }),
    );
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeHealthcheckService(db, issueSvc);

    const result = await svc.runHealthcheck("co-1");

    expect(result.alarmsCreated).toBe(0);
    expect(issueSvc.create).not.toHaveBeenCalled();
  });

  it("creates alarm on warning → critical (further degradation)", async () => {
    const db = fakeDbForRun(
      defaultRunExecuteResults({
        computerOutputs: {
          review_backlog_hours_p50: [{ p50_hours: 72, pending_count: 30 }], // critical
        },
        lastStatuses: { review_backlog_hours_p50: "warning" },
      }),
    );
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeHealthcheckService(db, issueSvc);

    const result = await svc.runHealthcheck("co-1");

    expect(result.alarmsCreated).toBe(1);
  });

  it("respects opts.metrics filter (subset)", async () => {
    const db = fakeDbForRun([
      [{ count: 5 }], // weekly_new_drafts
      [{ count: 2 }], // stale_unchecked_fast
      // last status queries for the 2 requested
      [], // weekly_new_drafts last
      [], // stale_unchecked_fast last
    ]);
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeHealthcheckService(db, issueSvc);

    const result = await svc.runHealthcheck("co-1", {
      metrics: ["weekly_new_drafts", "stale_unchecked_fast"],
    });

    expect(result.metricsComputed).toBe(2);
    const inserted = (db as any).__insertedRows[0] as Array<{ metricName: string }>;
    expect(inserted).toHaveLength(2);
  });

  it("skips alarm creation when issueSvc is not provided (logs warn instead)", async () => {
    const db = fakeDbForRun(
      defaultRunExecuteResults({
        computerOutputs: { weekly_new_drafts: [{ count: 0 }] },
      }),
    );
    const svc = knowledgeHealthcheckService(db);

    const result = await svc.runHealthcheck("co-1");

    // metrics still computed + written, but no alarm created
    expect(result.metricsComputed).toBe(6);
    expect(result.alarmsCreated).toBe(0);
  });
});
