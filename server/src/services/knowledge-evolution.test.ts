import { describe, it, expect, vi } from "vitest";
import {
  knowledgeEvolutionService,
  BEHAVIOR_LIMITS,
} from "./knowledge-evolution.js";

/**
 * Mock db with sequential execute() return values.
 * Mirrors Phase 3c knowledge-healthcheck.test.ts fakeDb helper.
 */
function fakeDb(...executeResults: unknown[][]) {
  const db = { execute: vi.fn() };
  for (const r of executeResults) db.execute.mockResolvedValueOnce(r);
  return db as never;
}

// Unused dependencies — decayScan touches neither LLM nor retriever nor
// issueSvc. Subsequent Task 3-6 commits will exercise these mocks.
const fakeLlm = { embed: vi.fn(), completeChat: vi.fn() } as never;
const fakeRetriever = { search: vi.fn() } as never;

// ──────────────────────────────────────────────────────────────────
// decayScan (PRD §FR6 row 2: status=active AND idle > 180d → archived)
// ──────────────────────────────────────────────────────────────────

describe("decayScan", () => {
  it("archives all active nodes idle ≥ 180 days and reports nodesModified", async () => {
    const db = fakeDb([
      { node_id: "n-1" },
      { node_id: "n-2" },
      { node_id: "n-3" },
    ]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, null);
    const r = await svc.__test__.decayScan("co-1");
    expect(r.behavior).toBe("decay_scan");
    expect(r.candidatesFound).toBe(3);
    expect(r.nodesModified).toBe(3);
    expect(r.issuesCreated).toBe(0);
    expect(r.draftsCreated).toBe(0);
    expect(r.edgesCreated).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.details).toEqual({ idle_days_threshold: 180 });
  });

  it("returns 0 nodesModified when no nodes match", async () => {
    const db = fakeDb([]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, null);
    const r = await svc.__test__.decayScan("co-1");
    expect(r.candidatesFound).toBe(0);
    expect(r.nodesModified).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("issues exactly one db.execute call (single CTE, not split SELECT+UPDATE+INSERT)", async () => {
    const db = fakeDb([{ node_id: "n-1" }]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, null);
    await svc.__test__.decayScan("co-1");
    expect((db as never as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls).toHaveLength(1);
  });

  it("uses idle_days threshold from BEHAVIOR_LIMITS (180)", () => {
    expect(BEHAVIOR_LIMITS.decay_scan.idleDays).toBe(180);
  });

  it("does NOT touch llm, retriever, or issueSvc", async () => {
    const db = fakeDb([{ node_id: "n-1" }]);
    const llm = { embed: vi.fn(), completeChat: vi.fn() } as never;
    const retriever = { search: vi.fn() } as never;
    const issueSvc = { create: vi.fn() } as never;
    const svc = knowledgeEvolutionService(db, llm, retriever, issueSvc);
    await svc.__test__.decayScan("co-1");
    expect((llm as never as { embed: { mock: { calls: unknown[] } } }).embed.mock.calls).toHaveLength(0);
    expect((llm as never as { completeChat: { mock: { calls: unknown[] } } }).completeChat.mock.calls).toHaveLength(0);
    expect((retriever as never as { search: { mock: { calls: unknown[] } } }).search.mock.calls).toHaveLength(0);
    expect((issueSvc as never as { create: { mock: { calls: unknown[] } } }).create.mock.calls).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// BEHAVIOR_LIMITS shape — guards against accidental key drift
// ──────────────────────────────────────────────────────────────────

describe("BEHAVIOR_LIMITS", () => {
  it("defines all 6 behaviors that KNOWLEDGE_EVOLUTION_BEHAVIORS enumerates", () => {
    const keys = Object.keys(BEHAVIOR_LIMITS).sort();
    expect(keys).toEqual([
      "conflict_detect",
      "decay_scan",
      "freshness_audit",
      "merge_candidate_detect",
      "pattern_emergence",
      "promotion_check",
    ]);
  });

  it("uses 7-day cooldown for proposal-creating behaviors (v0.2 dedup strategy)", () => {
    expect(BEHAVIOR_LIMITS.promotion_check.cooldownDays).toBe(7);
    expect(BEHAVIOR_LIMITS.merge_candidate_detect.cooldownDays).toBe(7);
    expect(BEHAVIOR_LIMITS.freshness_audit.cooldownDays).toBe(7);
  });

  it("uses 30-day cooldown for pattern_emergence (failed extractions don't retry weekly)", () => {
    expect(BEHAVIOR_LIMITS.pattern_emergence.cooldownDays).toBe(30);
  });

  it("decay_scan has no cooldown (no proposal Issues)", () => {
    const ds = BEHAVIOR_LIMITS.decay_scan as { cooldownDays?: number };
    expect(ds.cooldownDays).toBeUndefined();
  });
});
