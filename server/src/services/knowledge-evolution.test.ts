import { describe, it, expect, vi } from "vitest";
import {
  knowledgeEvolutionService,
  BEHAVIOR_LIMITS,
  unionFindClusters,
  PATTERN_EMERGENCE_SYSTEM_PROMPT,
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

// ──────────────────────────────────────────────────────────────────
// promotionCheck (PRD §FR6 row 1: lesson + trigger_count≥3 +
//                                  prevention_score≥0.7 → propose
//                                  upgrade to rule via Issue)
// ──────────────────────────────────────────────────────────────────

/**
 * fakeIssueSvc returns canned id values from `.create.mockResolvedValueOnce`
 * sequence. Test code seeds the mocks before calling the behavior.
 */
function fakeIssueSvc() {
  return { create: vi.fn() } as never;
}

describe("promotionCheck", () => {
  it("creates one Issue per candidate + records dedup metadata", async () => {
    // 1st execute: candidate SELECT returns 2 rows.
    // Then per candidate: 1 execute for recordProposalSuccess CTE.
    const db = fakeDb(
      [
        { id: "n-1", title: "Avoid singletons", type: "lesson", trigger_count: 5, prevention_score: 0.85 },
        { id: "n-2", title: "Always validate input", type: "lesson", trigger_count: 4, prevention_score: 0.75 },
      ],
      [], // recordProposalSuccess for n-1 (no return rows needed)
      [], // recordProposalSuccess for n-2
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-1" });
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-2" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.promotionCheck("co-1");

    expect(r.behavior).toBe("promotion_check");
    expect(r.candidatesFound).toBe(2);
    expect(r.issuesCreated).toBe(2);
    expect(r.nodesModified).toBe(2);
    expect(r.errors).toEqual([]);
    expect(r.details).toMatchObject({
      trigger_count_min: 3,
      prevention_score_min: 0.7,
      cooldown_days: 7,
    });

    // issueSvc.create called with v0.2-correct signature: positional companyId
    const createCalls = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls;
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0][0]).toBe("co-1");
    const data1 = createCalls[0][1] as { title: string; description: string; status: string; priority: string };
    expect(data1.title).toMatch(/^\[Evolution:promotion\] 建议升级为 rule:/);
    expect(data1.title).toContain("Avoid singletons");
    expect(data1.status).toBe("todo");
    expect(data1.priority).toBe("medium");
    // No `labels` and no `metadata` in data object (v0.2 schema-truth)
    expect((data1 as never as { labels?: unknown }).labels).toBeUndefined();
    expect((data1 as never as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it("returns 0 issues when no candidates match (empty SELECT)", async () => {
    const db = fakeDb([]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, fakeIssueSvc());
    const r = await svc.__test__.promotionCheck("co-1");
    expect(r.candidatesFound).toBe(0);
    expect(r.issuesCreated).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("degrades gracefully when issueSvc is null (logs warning, counts error)", async () => {
    const db = fakeDb([
      { id: "n-1", title: "x", type: "lesson", trigger_count: 5, prevention_score: 0.9 },
    ]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, null);
    const r = await svc.__test__.promotionCheck("co-1");
    expect(r.candidatesFound).toBe(1);
    expect(r.issuesCreated).toBe(0);
    expect(r.errors).toEqual([
      { subject: "n-1", reason: "issue_create_failed_or_unavailable" },
    ]);
    // No metadata UPDATE was attempted (only 1 execute call: the SELECT)
    expect((db as never as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls).toHaveLength(1);
  });

  it("counts errors when issueSvc.create throws but continues with next candidate", async () => {
    const db = fakeDb(
      [
        { id: "n-1", title: "x", type: "lesson", trigger_count: 5, prevention_score: 0.9 },
        { id: "n-2", title: "y", type: "lesson", trigger_count: 4, prevention_score: 0.8 },
      ],
      [], // recordProposalSuccess for n-2 only
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockRejectedValueOnce: (v: unknown) => unknown } }).create.mockRejectedValueOnce(new Error("DB down"));
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-2" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.promotionCheck("co-1");

    expect(r.candidatesFound).toBe(2);
    expect(r.issuesCreated).toBe(1); // n-2 succeeded
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toEqual({
      subject: "n-1",
      reason: "issue_create_failed_or_unavailable",
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// freshnessAudit (PRD §FR6 row 5: valid_until≤7d / fast≥90d /
//                                 slow≥365d → propose verify via Issue)
// ──────────────────────────────────────────────────────────────────

describe("freshnessAudit", () => {
  it("creates Issues + counts reasons across all 3 UNION branches", async () => {
    const db = fakeDb(
      [
        {
          id: "n-1",
          title: "API key expiring",
          reason: "expiring_validity",
          valid_until: "2026-05-20T00:00:00Z",
          verified_at: null,
          volatility: "stable",
        },
        {
          id: "n-2",
          title: "Douyin policy",
          reason: "fast_stale",
          valid_until: null,
          verified_at: "2026-02-01T00:00:00Z",
          volatility: "fast",
        },
        {
          id: "n-3",
          title: "Architecture pattern",
          reason: "slow_stale",
          valid_until: null,
          verified_at: "2025-04-01T00:00:00Z",
          volatility: "slow",
        },
      ],
      [],
      [],
      [],
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create
      .mockResolvedValueOnce({ id: "iss-a" })
      .mockResolvedValueOnce({ id: "iss-b" })
      .mockResolvedValueOnce({ id: "iss-c" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.freshnessAudit("co-1");

    expect(r.behavior).toBe("freshness_audit");
    expect(r.candidatesFound).toBe(3);
    expect(r.issuesCreated).toBe(3);
    expect(r.errors).toEqual([]);
    expect(r.details.reason_counts).toEqual({
      expiring_validity: 1,
      fast_stale: 1,
      slow_stale: 1,
    });

    // All Issues use the [Evolution:freshness] prefix
    const calls = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls;
    for (const call of calls) {
      const data = call[1] as { title: string };
      expect(data.title).toMatch(/^\[Evolution:freshness\] 请验证:/);
    }
  });

  it("returns 0 candidates when no nodes meet any of the 3 conditions", async () => {
    const db = fakeDb([]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, fakeIssueSvc());
    const r = await svc.__test__.freshnessAudit("co-1");
    expect(r.candidatesFound).toBe(0);
    expect(r.issuesCreated).toBe(0);
    expect(r.details.reason_counts).toEqual({
      expiring_validity: 0,
      fast_stale: 0,
      slow_stale: 0,
    });
  });

  it("does NOT touch verified_at on success (only the human reviewer flips that)", async () => {
    const db = fakeDb(
      [
        {
          id: "n-1",
          title: "x",
          reason: "fast_stale",
          valid_until: null,
          verified_at: null,
          volatility: "fast",
        },
      ],
      [], // recordProposalSuccess only does metadata UPDATE + event INSERT, not verified_at
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-x" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.freshnessAudit("co-1");

    expect(r.issuesCreated).toBe(1);
    // Only 2 execute calls: SELECT + recordProposalSuccess CTE
    expect((db as never as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls).toHaveLength(2);
    // The 2nd call should NOT mention verified_at in its SQL
    const secondCallSql = JSON.stringify((db as never as { execute: { mock: { calls: unknown[][] } } }).execute.mock.calls[1]);
    expect(secondCallSql).not.toContain("verified_at");
  });

  it("uses [Evolution:freshness] title prefix (no labels per v0.2 schema-truth)", async () => {
    const db = fakeDb(
      [
        {
          id: "n-1",
          title: "Sample",
          reason: "expiring_validity",
          valid_until: "2026-05-20T00:00:00Z",
          verified_at: null,
          volatility: "stable",
        },
      ],
      [],
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-1" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    await svc.__test__.freshnessAudit("co-1");

    const call = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls[0];
    expect(call[0]).toBe("co-1");
    const data = call[1] as { title: string };
    expect(data.title.startsWith("[Evolution:freshness]")).toBe(true);
    expect((data as never as { labels?: unknown }).labels).toBeUndefined();
    expect((data as never as { metadata?: unknown }).metadata).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// mergeCandidateDetect (PRD §FR6 row 3: pgvector cosine ≥ 0.9 →
//                                       propose merge via Issue, top 10)
// ──────────────────────────────────────────────────────────────────

describe("mergeCandidateDetect", () => {
  it("creates one Issue per pair + records dedup metadata on BOTH nodes", async () => {
    // SELECT returns 2 pairs; per successful pair: 1 execute for UPDATE+events CTE.
    const db = fakeDb(
      [
        {
          id_a: "n-1",
          id_b: "n-2",
          title_a: "Avoid singletons",
          title_b: "Singletons are anti-pattern",
          type_a: "lesson",
          type_b: "lesson",
          cosine: 0.95,
        },
        {
          id_a: "n-3",
          id_b: "n-4",
          title_a: "Use factory",
          title_b: "Factory pattern over global state",
          type_a: "lesson",
          type_b: "rule",
          cosine: 0.91,
        },
      ],
      [], // recordMergeProposalSuccess for pair-1
      [], // recordMergeProposalSuccess for pair-2
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create
      .mockResolvedValueOnce({ id: "iss-m1" })
      .mockResolvedValueOnce({ id: "iss-m2" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.mergeCandidateDetect("co-1");

    expect(r.behavior).toBe("merge_candidate_detect");
    expect(r.candidatesFound).toBe(2);
    expect(r.issuesCreated).toBe(2);
    // 2 nodes touched per pair × 2 pairs = 4 nodesModified.
    expect(r.nodesModified).toBe(4);
    expect(r.errors).toEqual([]);
    expect(r.details).toMatchObject({
      cosine_threshold: 0.9,
      top_pairs_limit: 10,
      cooldown_days: 7,
    });

    // v0.2 signature: positional companyId; no labels/metadata in data.
    const calls = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("co-1");
    const data1 = calls[0][1] as { title: string; description: string };
    expect(data1.title).toMatch(/^\[Evolution:merge\] 建议合并 /);
    expect(data1.title).toContain("Avoid singletons");
    expect(data1.title).toContain("Singletons are anti-pattern");
    // Body contains pair_key, cosine, both ids
    expect(data1.description).toContain("Pair key: n-1:n-2");
    expect(data1.description).toContain("0.950");
    expect(data1.description).toContain("n-1");
    expect(data1.description).toContain("n-2");
    expect((data1 as never as { labels?: unknown }).labels).toBeUndefined();
    expect((data1 as never as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it("returns 0 issues when no candidate pairs match (empty SELECT)", async () => {
    const db = fakeDb([]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, fakeIssueSvc());
    const r = await svc.__test__.mergeCandidateDetect("co-1");
    expect(r.candidatesFound).toBe(0);
    expect(r.issuesCreated).toBe(0);
    expect(r.nodesModified).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("degrades gracefully when issueSvc is null (logs, counts errors with pair_key)", async () => {
    const db = fakeDb([
      {
        id_a: "n-a",
        id_b: "n-b",
        title_a: "x",
        title_b: "y",
        type_a: "lesson",
        type_b: "lesson",
        cosine: 0.92,
      },
    ]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, null);
    const r = await svc.__test__.mergeCandidateDetect("co-1");
    expect(r.candidatesFound).toBe(1);
    expect(r.issuesCreated).toBe(0);
    expect(r.nodesModified).toBe(0);
    expect(r.errors).toEqual([
      { subject: "n-a:n-b", reason: "issue_create_failed_or_unavailable" },
    ]);
    // Only 1 execute call: the candidate SELECT. No metadata UPDATE attempted.
    expect((db as never as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls).toHaveLength(1);
  });

  it("uses sorted pair_key (id_a < id_b enforced by JOIN, surfaced to caller)", async () => {
    // Note: in production the SQL enforces a.id < b.id; here we mock the
    // result honoring that order so the helper sees a sorted pair_key.
    const db = fakeDb(
      [
        {
          id_a: "aaaa1111-...",
          id_b: "bbbb2222-...",
          title_a: "x",
          title_b: "y",
          type_a: "lesson",
          type_b: "lesson",
          cosine: 0.95,
        },
      ],
      [],
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-1" });
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    await svc.__test__.mergeCandidateDetect("co-1");
    const data = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls[0][1] as { description: string };
    expect(data.description).toContain("Pair key: aaaa1111-...:bbbb2222-...");
  });

  it("limits per-pair to top 10 by cosine (enforced in SQL — verify LIMIT value reflects BEHAVIOR_LIMITS)", () => {
    expect(BEHAVIOR_LIMITS.merge_candidate_detect.topPairs).toBe(10);
    expect(BEHAVIOR_LIMITS.merge_candidate_detect.cosineThreshold).toBe(0.9);
  });

  it("coerces numeric-as-string cosine from postgres.js driver", async () => {
    const db = fakeDb(
      [
        {
          id_a: "n-1",
          id_b: "n-2",
          title_a: "x",
          title_b: "y",
          type_a: "lesson",
          type_b: "lesson",
          cosine: "0.92", // postgres.js may return numeric as string
        },
      ],
      [],
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-1" });
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    await svc.__test__.mergeCandidateDetect("co-1");
    const data = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls[0][1] as { description: string };
    // toFixed(3) applied to Number(cosine) — should produce "0.920" not crash
    expect(data.description).toContain("0.920");
  });

  it("counts errors with pair_key (not node id) when post-issue UPDATE fails", async () => {
    // SELECT returns 1 pair, issueSvc succeeds, then the UPDATE+events CTE throws.
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id_a: "n-1",
            id_b: "n-2",
            title_a: "x",
            title_b: "y",
            type_a: "lesson",
            type_b: "lesson",
            cosine: 0.95,
          },
        ])
        .mockRejectedValueOnce(new Error("metadata UPDATE blew up")),
    } as never;
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-1" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.mergeCandidateDetect("co-1");

    expect(r.candidatesFound).toBe(1);
    // Issue creation succeeded, but post-issue UPDATE failed → counted as error,
    // issuesCreated stays 0 (we only increment after the CTE succeeds).
    expect(r.issuesCreated).toBe(0);
    expect(r.errors).toEqual([
      { subject: "n-1:n-2", reason: "metadata UPDATE blew up" },
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────
// conflictDetect (PRD §FR6 row 4 + Decision C: materialize Phase 3b
//   detected_conflicts → conflicts_with edges + Issues + clear array)
// ──────────────────────────────────────────────────────────────────

describe("conflictDetect", () => {
  it("creates conflicts_with edge + Issue per pair when draft has target_node_id (then clears array)", async () => {
    // 1 SELECT (2 pairs) + 2 edge upserts (each returning 1 row = new) + 1 array-clear UPDATE.
    const db = fakeDb(
      [
        {
          draft_id: "d-1",
          target_node_id: "n-target",
          proposed_title: "Use HNSW",
          conflict_node_id: "n-c1",
          conflict_node_title: "Use IVFFlat",
        },
        {
          draft_id: "d-1",
          target_node_id: "n-target",
          proposed_title: "Use HNSW",
          conflict_node_id: "n-c2",
          conflict_node_title: "Avoid vector indexes",
        },
      ],
      [{ id: "e-1" }], // edge upsert 1 — new
      [{ id: "e-2" }], // edge upsert 2 — new
      [], // array clear UPDATE (no return)
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create
      .mockResolvedValueOnce({ id: "iss-c1" })
      .mockResolvedValueOnce({ id: "iss-c2" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.conflictDetect("co-1");

    expect(r.behavior).toBe("conflict_detect");
    expect(r.candidatesFound).toBe(2);
    expect(r.edgesCreated).toBe(2);
    expect(r.issuesCreated).toBe(2);
    expect(r.nodesModified).toBe(0); // no node mutation
    expect(r.errors).toEqual([]);
    expect(r.details).toMatchObject({
      max_drafts_per_tick: 50,
      processed_drafts: 1, // both pairs from same draft d-1
    });

    // Issue title prefix [Evolution:conflict] + uses conflict_node_title
    const calls = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls;
    const data1 = calls[0][1] as { title: string; description: string };
    expect(data1.title).toMatch(/^\[Evolution:conflict\] 冲突:/);
    expect(data1.title).toContain("Use HNSW");
    expect(data1.title).toContain("Use IVFFlat");
    expect(data1.description).toContain("Draft id: d-1");
    expect(data1.description).toContain("已在 knowledge_edges 表落 conflicts_with 边");
  });

  it("brand-new draft (target_node_id null) → 0 edges, 1 Issue per conflict", async () => {
    const db = fakeDb(
      [
        {
          draft_id: "d-1",
          target_node_id: null,
          proposed_title: "New idea",
          conflict_node_id: "n-c1",
          conflict_node_title: "Existing idea",
        },
        {
          draft_id: "d-1",
          target_node_id: null,
          proposed_title: "New idea",
          conflict_node_id: "n-c2",
          conflict_node_title: "Other existing",
        },
      ],
      // No edge upserts (target_node_id null short-circuits the edge block)
      [], // array clear UPDATE
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create
      .mockResolvedValueOnce({ id: "iss-1" })
      .mockResolvedValueOnce({ id: "iss-2" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.conflictDetect("co-1");

    expect(r.candidatesFound).toBe(2);
    expect(r.edgesCreated).toBe(0);
    expect(r.issuesCreated).toBe(2);

    const data = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls[0][1] as { description: string };
    expect(data.description).toContain("Draft 尚未物化为节点");
  });

  it("edge already exists (ON CONFLICT returns empty) → skips Issue creation", async () => {
    const db = fakeDb(
      [
        {
          draft_id: "d-1",
          target_node_id: "n-target",
          proposed_title: "x",
          conflict_node_id: "n-c1",
          conflict_node_title: "y",
        },
      ],
      [], // edge upsert RETURNING empty = edge already existed
      [], // array clear UPDATE
    );
    const issueSvc = fakeIssueSvc();
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    const r = await svc.__test__.conflictDetect("co-1");

    expect(r.candidatesFound).toBe(1);
    expect(r.edgesCreated).toBe(0);
    expect(r.issuesCreated).toBe(0);
    expect(r.details.processed_drafts).toBe(1); // draft is still in clear set
    // No Issue create call attempted (deduped via edge existence)
    expect((issueSvc as never as { create: { mock: { calls: unknown[] } } }).create.mock.calls).toHaveLength(0);
  });

  it("empty SELECT → no candidates, no array clear UPDATE", async () => {
    const db = fakeDb([]);
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, fakeIssueSvc());
    const r = await svc.__test__.conflictDetect("co-1");
    expect(r.candidatesFound).toBe(0);
    expect(r.edgesCreated).toBe(0);
    expect(r.issuesCreated).toBe(0);
    expect(r.details.processed_drafts).toBe(0);
    // Only the SELECT execute happened — no array-clear UPDATE attempted
    expect((db as never as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls).toHaveLength(1);
  });

  it("conflict node deleted (LEFT JOIN returns NULL title) → uses fallback display", async () => {
    const db = fakeDb(
      [
        {
          draft_id: "d-1",
          target_node_id: null,
          proposed_title: "New idea",
          conflict_node_id: "deleted-node-uuid",
          conflict_node_title: null,
        },
      ],
      [],
    );
    const issueSvc = fakeIssueSvc();
    (issueSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "iss-1" });

    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, issueSvc);
    await svc.__test__.conflictDetect("co-1");

    const data = (issueSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls[0][1] as { title: string; description: string };
    expect(data.title).toContain("(节点 deleted-node-uuid)");
    expect(data.description).toContain("(节点 deleted-node-uuid)");
  });

  it("issueSvc null on a target_node_id-set draft → edge IS created, Issue counted as error", async () => {
    const db = fakeDb(
      [
        {
          draft_id: "d-1",
          target_node_id: "n-target",
          proposed_title: "x",
          conflict_node_id: "n-c1",
          conflict_node_title: "y",
        },
      ],
      [{ id: "e-1" }], // edge upsert succeeds even though issueSvc is null
      [], // array clear
    );
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, null);
    const r = await svc.__test__.conflictDetect("co-1");

    expect(r.candidatesFound).toBe(1);
    expect(r.edgesCreated).toBe(1); // edge still landed (independent of Issue)
    expect(r.issuesCreated).toBe(0);
    expect(r.errors).toEqual([
      { subject: "d-1:n-c1", reason: "issue_create_failed_or_unavailable" },
    ]);
  });

  it("edge upsert throws → counted as error, draft still in clear set", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          {
            draft_id: "d-1",
            target_node_id: "n-target",
            proposed_title: "x",
            conflict_node_id: "n-c1",
            conflict_node_title: "y",
          },
        ])
        .mockRejectedValueOnce(new Error("FK violation"))
        .mockResolvedValueOnce([]), // array clear still runs
    } as never;
    const svc = knowledgeEvolutionService(db, fakeLlm, fakeRetriever, fakeIssueSvc());
    const r = await svc.__test__.conflictDetect("co-1");

    expect(r.candidatesFound).toBe(1);
    expect(r.edgesCreated).toBe(0);
    expect(r.issuesCreated).toBe(0);
    expect(r.errors).toEqual([
      { subject: "d-1:n-c1", reason: "FK violation" },
    ]);
    expect(r.details.processed_drafts).toBe(1); // d-1 still tracked for array clear
  });
});

// ──────────────────────────────────────────────────────────────────
// unionFindClusters (Task 6 helper, exported for direct testing)
// ──────────────────────────────────────────────────────────────────

describe("unionFindClusters", () => {
  it("returns empty when no ids and no edges", () => {
    expect(unionFindClusters([], [])).toEqual([]);
  });

  it("returns each isolated id as its own cluster (no edges)", () => {
    const r = unionFindClusters(["a", "b", "c"], []);
    expect(r).toHaveLength(3);
    expect(r.flat().sort()).toEqual(["a", "b", "c"]);
  });

  it("merges a 3-chain A-B-C via transitive edges (A-B + B-C, no A-C)", () => {
    const r = unionFindClusters(
      ["a", "b", "c"],
      [
        { a: "a", b: "b" },
        { a: "b", b: "c" },
      ],
    );
    expect(r).toHaveLength(1);
    expect(r[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps two disjoint components separate", () => {
    const r = unionFindClusters(
      ["a", "b", "c", "d"],
      [
        { a: "a", b: "b" },
        { a: "c", b: "d" },
      ],
    );
    expect(r).toHaveLength(2);
    const sorted = r.map((c) => c.sort()).sort((x, y) => x[0].localeCompare(y[0]));
    expect(sorted[0]).toEqual(["a", "b"]);
    expect(sorted[1]).toEqual(["c", "d"]);
  });

  it("idempotent on duplicate edges", () => {
    const r = unionFindClusters(
      ["a", "b"],
      [
        { a: "a", b: "b" },
        { a: "a", b: "b" },
        { a: "b", b: "a" },
      ],
    );
    expect(r).toHaveLength(1);
    expect(r[0].sort()).toEqual(["a", "b"]);
  });

  it("ignores edges referencing unknown ids (safety)", () => {
    const r = unionFindClusters(
      ["a", "b"],
      [
        { a: "a", b: "b" },
        { a: "a", b: "ghost" }, // ghost not in allIds
      ],
    );
    expect(r).toHaveLength(1);
    expect(r[0].sort()).toEqual(["a", "b"]);
  });
});

// ──────────────────────────────────────────────────────────────────
// PATTERN_EMERGENCE_SYSTEM_PROMPT (Task 6) — guard against drift
// ──────────────────────────────────────────────────────────────────

describe("PATTERN_EMERGENCE_SYSTEM_PROMPT", () => {
  it("exports the v0.1 plan-defined system prompt", () => {
    expect(PATTERN_EMERGENCE_SYSTEM_PROMPT).toContain("Curator");
    expect(PATTERN_EMERGENCE_SYSTEM_PROMPT).toContain("pattern_name");
    expect(PATTERN_EMERGENCE_SYSTEM_PROMPT).toContain("no_pattern");
    expect(PATTERN_EMERGENCE_SYSTEM_PROMPT).toContain("source_lesson_ids");
    expect(PATTERN_EMERGENCE_SYSTEM_PROMPT).toContain("只输出 JSON");
  });
});

// ──────────────────────────────────────────────────────────────────
// patternEmergence (PRD §FR6 row 6) — most complex behavior
// ──────────────────────────────────────────────────────────────────

function fakeDraftSvc() {
  return { create: vi.fn() } as never;
}

describe("patternEmergence", () => {
  const groupRow = {
    used_for: "bug-fix",
    business_domain_id: "bd-1",
    business_domain_name: "software",
    lesson_count: 6,
  };
  const lessonRows = [
    { id: "L1", title: "Use parseURL not regex", content: "URL parsing with regex breaks on edge cases." },
    { id: "L2", title: "Validate inputs", content: "Always validate untrusted input at the boundary." },
    { id: "L3", title: "Avoid global state", content: "Singletons make tests flaky." },
    { id: "L4", title: "Prefer factories", content: "Factory pattern over global state." },
    { id: "L5", title: "Boundary checks", content: "Validate at the system boundary, not inside." },
    { id: "L6", title: "Outlier topic", content: "Completely unrelated topic." }, // not in cluster
  ];
  // Edges connecting L1-L5 in a chain; L6 is isolated.
  const clusterEdges = [
    { id_a: "L1", id_b: "L2", cosine: 0.8 },
    { id_a: "L2", id_b: "L3", cosine: 0.75 },
    { id_a: "L3", id_b: "L4", cosine: 0.78 },
    { id_a: "L4", id_b: "L5", cosine: 0.72 },
  ];

  it("happy path: 1 group, 1 cluster of 5, LLM returns valid pattern → 1 draft created", async () => {
    const db = fakeDb([groupRow], lessonRows, clusterEdges);
    const llm = { embed: vi.fn(), completeChat: vi.fn().mockResolvedValueOnce(JSON.stringify({
      pattern_name: "validate-at-boundary",
      pattern_summary: "在系统边界验证输入,而不是在内部各处重复验证。",
      pattern_conditions: ["接受外部输入时", "API 请求处理"],
      source_lesson_ids: ["L1", "L2", "L3", "L4", "L5"],
    })) } as never;
    const draftSvc = fakeDraftSvc();
    (draftSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "draft-1" });

    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, draftSvc);
    const r = await svc.__test__.patternEmergence("co-1");

    expect(r.behavior).toBe("pattern_emergence");
    expect(r.candidatesFound).toBe(1);
    expect(r.draftsCreated).toBe(1);
    expect(r.nodesModified).toBe(0); // no cooldown set
    expect(r.errors).toEqual([]);
    expect(r.details.clusters_processed).toBe(1);
    expect(r.details.llm_calls).toBe(1);

    // Draft created with v0.1 contract
    const callArg = (draftSvc as never as { create: { mock: { calls: unknown[][] } } }).create.mock.calls[0][0] as {
      companyId: string;
      actor: { type: string };
      payload: {
        title: string;
        content: string;
        type: string;
        level: string;
        business_domain_name: string;
        metadata: { is_pattern: boolean; derived_from_lessons: string[]; used_for: string };
        confidence: number;
        source: string;
      };
    };
    expect(callArg.companyId).toBe("co-1");
    expect(callArg.actor.type).toBe("system");
    expect(callArg.payload.type).toBe("concept");
    expect(callArg.payload.level).toBe("company");
    expect(callArg.payload.business_domain_name).toBe("software");
    expect(callArg.payload.metadata.is_pattern).toBe(true);
    expect(callArg.payload.metadata.derived_from_lessons).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    expect(callArg.payload.metadata.used_for).toBe("bug-fix");
    expect(callArg.payload.source).toBe("agent_self_review");
    expect(callArg.payload.content).toContain("触发条件:");
  });

  it("empty groups → no LLM calls, no drafts", async () => {
    const db = fakeDb([]);
    const llm = { embed: vi.fn(), completeChat: vi.fn() } as never;
    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, fakeDraftSvc());
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.candidatesFound).toBe(0);
    expect(r.draftsCreated).toBe(0);
    expect((llm as never as { completeChat: { mock: { calls: unknown[] } } }).completeChat.mock.calls).toHaveLength(0);
  });

  it("group post-filter lessons < minClusterSize → skip without LLM call", async () => {
    // Race: group SELECT saw 5 lessons, but step 2a returns only 3
    // (e.g. concurrent status change / cooldown).
    const db = fakeDb([groupRow], lessonRows.slice(0, 3));
    const llm = { embed: vi.fn(), completeChat: vi.fn() } as never;
    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, fakeDraftSvc());
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.candidatesFound).toBe(1);
    expect(r.draftsCreated).toBe(0);
    expect((llm as never as { completeChat: { mock: { calls: unknown[] } } }).completeChat.mock.calls).toHaveLength(0);
  });

  it("LLM returns no_pattern → cooldown set on all cluster lessons, 0 drafts", async () => {
    // SELECT group, SELECT lessons, SELECT edges, [LLM call], [cooldown UPDATE]
    const db = fakeDb([groupRow], lessonRows, clusterEdges, []); // 4th call = cooldown UPDATE
    const llm = { embed: vi.fn(), completeChat: vi.fn().mockResolvedValueOnce(JSON.stringify({
      no_pattern: true,
      reason: "Lessons cover different sub-topics; abstracting would lose specificity.",
    })) } as never;

    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, fakeDraftSvc());
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.draftsCreated).toBe(0);
    expect(r.nodesModified).toBe(5); // 5 cluster lessons cooldown'd
    expect(r.errors).toEqual([]);
    expect(r.details.cooldowns_set).toBe(5);
  });

  it("LLM returns malformed JSON → cooldown set + error logged", async () => {
    const db = fakeDb([groupRow], lessonRows, clusterEdges, []); // cooldown UPDATE
    const llm = { embed: vi.fn(), completeChat: vi.fn().mockResolvedValueOnce("not valid json at all") } as never;

    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, fakeDraftSvc());
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.draftsCreated).toBe(0);
    expect(r.nodesModified).toBe(5);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toBe("llm_output_not_json");
  });

  it("LLM returns Branch-A but missing required field → cooldown + error", async () => {
    const db = fakeDb([groupRow], lessonRows, clusterEdges, []); // cooldown UPDATE
    const llm = { embed: vi.fn(), completeChat: vi.fn().mockResolvedValueOnce(JSON.stringify({
      pattern_name: "foo",
      // missing pattern_summary + pattern_conditions + source_lesson_ids
    })) } as never;

    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, fakeDraftSvc());
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.draftsCreated).toBe(0);
    expect(r.nodesModified).toBe(5);
    expect(r.errors[0].reason).toBe("llm_output_malformed");
  });

  it("LLM call throws → error counted, NO cooldown set (don't punish lessons for transient LLM error)", async () => {
    const db = fakeDb([groupRow], lessonRows, clusterEdges);
    const llm = { embed: vi.fn(), completeChat: vi.fn().mockRejectedValueOnce(new Error("LLM provider timeout")) } as never;
    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, fakeDraftSvc());
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.draftsCreated).toBe(0);
    expect(r.nodesModified).toBe(0); // no cooldown
    expect(r.errors[0].reason).toContain("llm_failed");
  });

  it("draftSvc null → pattern extracted but counted as error (no draft created)", async () => {
    const db = fakeDb([groupRow], lessonRows, clusterEdges);
    const llm = { embed: vi.fn(), completeChat: vi.fn().mockResolvedValueOnce(JSON.stringify({
      pattern_name: "x",
      pattern_summary: "y",
      pattern_conditions: ["a"],
      source_lesson_ids: ["L1", "L2", "L3", "L4", "L5"],
    })) } as never;

    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, null);
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.draftsCreated).toBe(0);
    expect(r.errors[0].reason).toBe("draftSvc unavailable");
  });

  it("LLM output with markdown code fence is stripped before JSON.parse", async () => {
    const db = fakeDb([groupRow], lessonRows, clusterEdges);
    const llm = { embed: vi.fn(), completeChat: vi.fn().mockResolvedValueOnce("```json\n" + JSON.stringify({
      pattern_name: "x",
      pattern_summary: "y",
      pattern_conditions: [],
      source_lesson_ids: ["L1"],
    }) + "\n```") } as never;
    const draftSvc = fakeDraftSvc();
    (draftSvc as never as { create: { mockResolvedValueOnce: (v: unknown) => unknown } }).create.mockResolvedValueOnce({ id: "draft-1" });

    const svc = knowledgeEvolutionService(db, llm, fakeRetriever, null, draftSvc);
    const r = await svc.__test__.patternEmergence("co-1");
    expect(r.draftsCreated).toBe(1);
  });
});
