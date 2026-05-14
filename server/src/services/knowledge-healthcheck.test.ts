import { describe, it, expect, vi } from "vitest";
import {
  knowledgeHealthcheckService,
  METRIC_THRESHOLDS,
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
