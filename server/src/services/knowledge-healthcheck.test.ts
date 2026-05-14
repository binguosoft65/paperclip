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
