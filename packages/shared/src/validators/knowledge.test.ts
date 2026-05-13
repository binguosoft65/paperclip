import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE_PRE_VERDICT_VALUES,
  reviewerRunQuerySchema,
  batchApplyVerdictSchema,
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
