import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE_PRE_VERDICT_VALUES,
  reviewerRunQuerySchema,
  batchApplyVerdictSchema,
  KNOWLEDGE_METRIC_NAMES,
  KNOWLEDGE_METRIC_STATUSES,
  healthcheckRunQuerySchema,
} from "./knowledge.js";

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
      draft_ids: ["f47ac10b-58cc-4372-a567-0e02b2c3d479", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
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

// ──────────────────────────────────────────────────────────────────
// Phase 3c: Daily Healthcheck + Metrics + Alarm
// ──────────────────────────────────────────────────────────────────

describe("KNOWLEDGE_METRIC_NAMES", () => {
  it("contains exactly the 6 PRD §7.5 metric names in declared order", () => {
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
  it("mirrors DB CHECK constraint (3 values)", () => {
    expect(KNOWLEDGE_METRIC_STATUSES).toEqual([
      "healthy",
      "warning",
      "critical",
    ]);
  });
});

describe("healthcheckRunQuerySchema", () => {
  it("defaults to all 6 metrics when payload is empty", () => {
    const parsed = healthcheckRunQuerySchema.parse({});
    expect(parsed.metrics).toEqual(KNOWLEDGE_METRIC_NAMES);
  });
  it("preserves the requested subset when metrics provided", () => {
    const parsed = healthcheckRunQuerySchema.parse({
      metrics: ["weekly_new_drafts", "helped_ratio"],
    });
    expect(parsed.metrics).toEqual(["weekly_new_drafts", "helped_ratio"]);
  });
  it("rejects an unknown metric name", () => {
    expect(() =>
      healthcheckRunQuerySchema.parse({ metrics: ["bogus_metric"] }),
    ).toThrow();
  });
  it("rejects empty metrics array (min 1)", () => {
    expect(() =>
      healthcheckRunQuerySchema.parse({ metrics: [] }),
    ).toThrow();
  });
  it("rejects unknown top-level keys (strict)", () => {
    expect(() =>
      healthcheckRunQuerySchema.parse({
        metrics: ["weekly_new_drafts"],
        extra: "nope",
      }),
    ).toThrow();
  });
});
