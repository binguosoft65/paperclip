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
