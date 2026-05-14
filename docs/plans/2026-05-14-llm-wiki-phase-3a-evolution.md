# LLM-Wiki Phase 3a — Evolution Engine + 6 Behaviors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PRD §FR6 演化 6 条 + §13.3 Routine 1 `weekly-knowledge-evolution` MVP. Every active company's `knowledge_*` tables run through 6 sequential evolution actions on a weekly cadence (or on demand via REST), producing proposal Issues + drafts that pass through the existing Phase 1b draft review queue and Phase 3b reviewer pre-screening before any node mutation lands. Phase 3 (Reviewer / Evolution / Healthcheck) is then complete; only Phase 4-7 remain on the PRD roadmap.

**Architecture:** Server-side `knowledgeEvolutionService(db, llm, retriever, issueService)` factory in the same style as Phase 3c `knowledgeHealthcheckService`. Single service exposes 6 methods — one per PRD §FR6 row — plus an outer `runEvolution(companyId, opts?)` aggregator that calls them in PRD §13.3 declaration order. State changes go through three paths: (i) direct UPDATE (decay archive), (ii) draft creation through existing `knowledgeDraftService.create()` so Phase 3b reviewer can screen and human review can approve, (iii) Issue creation through `issueService.create()` for human-action proposals. **No node mutation happens without human approval** — the engine only proposes; the existing draft/approval pipeline lands the changes.

**Tech Stack:** TypeScript / Drizzle ORM + raw `sql\`\`\`` for pgvector cosine / Express 5 / Vitest mock-only / no new npm deps. Reuses Phase 1a `knowledgeDraftService.create`, Phase 1a `llmWikiService.completeChat` + `.embed`, Phase 2a `knowledgeRetrieverService.search`, Phase 3b `reviewerAgentService` indirectly (drafts produced here will be pre-screened by Routine 2 on the next hourly tick), and Phase 3c style scheduler + REST patterns.

**Phase 3 relationship after this PR lands:**

| PRD §15 Phase 3 sub-phase | Owner | Status |
|---|---|---|
| 3a Evolution Engine + 6 behaviors + Curator Agent + Routine 1 | **this plan** | will be ✅ when implemented |
| 3b Reviewer Agent + Routine 2 | shipped in master | ✅ |
| 3c Daily Healthcheck + Routine 3 + 6 metrics + alarm Issue | shipped in feat/llm-wiki-phase-3c-healthcheck (PR #2) | ✅ |

After Phase 3a lands the full Phase 3 PRD acceptance criteria can be checked: "6 条行为分别正确产生 Issue (含模式涌现)".

**Prerequisites (already in master or pending PRs):**

- Phase 0 schema (migration `0084_motionless_tempest.sql`): `knowledge_nodes` / `knowledge_edges` / `knowledge_drafts` / `knowledge_node_events` / `business_domains` / `knowledge_metrics` / `knowledge_node_revisions` / pgvector
- Phase 1a `knowledgeDraftService.create()` + `knowledgeNodeWriterService.materialize()`
- Phase 1a `llmWikiService.embed()` + `llmWikiService.completeChat()`
- Phase 2a `knowledgeRetrieverService.search()`
- Phase 3b `knowledge_drafts.detected_conflicts` populated by Reviewer Agent (Phase 3a Task 5 directly depends on this column being a non-empty UUID[] for the draft to be a conflict candidate)

---

## v0.2 Amendment — schema-truth corrections (post-`partial-smoke` 2026-05-14)

After committing the v0.1 plan, a partial smoke against the live `paperclip-pg` MCP database surfaced four wrong schema assumptions. All v0.1 assumptions about how Phase 3a interacts with the `issues` table are revised here; SQL drafts and code skeletons below have been updated to match real schema.

| # | v0.1 wrong assumption | v0.2 truth + fix |
|---|---|---|
| 1 | `issueSvc.create({ companyId, title, ..., labels, metadata })` — single object arg with `labels` array and `metadata` jsonb | `issueSvc.create(companyId, { title, description, status, priority })` — `companyId` is **positional first arg**; data object has no `labels` and no `metadata` fields. Type confirmed via `IssueServiceLike = Pick<ReturnType<typeof issueService>, "create">` in `server/src/services/knowledge-healthcheck.ts` (Phase 3c already uses the correct signature). |
| 2 | `issues.metadata` jsonb column exists → dedup via `metadata.subject_node_id = <id>` | `issues` table has **no `metadata` column**. Dedup moves to `knowledge_nodes.metadata.last_<behavior>_proposal_at` ISO timestamp on the source node (or `knowledge_drafts.metadata` for draft-anchored proposals). Plus default 7-day cooldown matches the weekly tick. |
| 3 | `issues.labels` text[] column exists → write `labels: ['[Evolution]', '[Evolution:promotion]']` per Issue | `issues` table has **no `labels` array**. Labels go through join tables `issue_labels` × `labels` (lazy-create-on-use). MVP skips label seeding entirely and uses **title prefix** `[Evolution:<behavior>]` as the visual category. Later PR can backfill labels via the join tables if board UX needs them. |
| 4 | pgvector index is `ivfflat` | Actual index is **HNSW with `vector_cosine_ops`** (`knowledge_nodes_embedding_idx`, `m=16`, `ef_construction=200`). Functionally equivalent for `<=>` cosine distance queries; HNSW is more accurate + needs no training. Prose updated; no SQL change needed. |

These corrections do not invalidate the task ordering or the maintainer decisions A/B/C/D — they only adjust the **interface** Phase 3a code uses to write Issues and check dedup. Task 1 onwards now references `knowledge_nodes.metadata.last_<behavior>_proposal_at` instead of `issues.metadata.subject_node_id`.

---

## Maintainer Decisions

Recorded as named decisions so they are easy to reference in code (`// per Phase 3a decision A`) and in commit messages. Mirror Phase 3c's 1A/2C/3A style.

| ID | Decision | Effect |
|---|---|---|
| **A** | Curator Agent: **do NOT create** an agent entity in the agents table for Phase 3a | All Issues produced by evolution get `assignee=null` (unassigned). A future PR can introduce a Curator Agent and back-fill the assignee. The Phase 3a code path does not reference any specific agent ID — it just sets the Issue's labels/title/body and lets the existing board/triage flow handle it. |
| **B** | Pattern-emergence clustering: **cosine threshold graph + connected-components**, NOT HDBSCAN / DBSCAN | No new npm dependency. Pure SQL plus a small in-memory union-find. Threshold = 0.7 default (tunable per behavior config). Trade-off: less density-aware than HDBSCAN — but deterministic, debuggable, and free. PRD §6 algorithm 4 (HDBSCAN) is preserved in `// future` comment for v0.2 follow-up. |
| **C** | Conflict-detect (FR6 #4): **materialize Phase 3b `detected_conflicts` only**, no independent active-rule scan in v0.1 | Phase 3b reviewer already flags conflicts on draft creation. Phase 3a's `conflictDetect()` walks `knowledge_drafts` where `detected_conflicts` array is non-empty, creates `conflicts_with` edges + Issues, and clears the array. No extra LLM call. v0.2 follow-up can add an independent two-by-two active-rule scan. |
| **D** | Service structure: **single `knowledgeEvolutionService` factory exposes 6 methods**, NOT 6 separate service files | Matches Phase 3c `knowledgeHealthcheckService` exactly (factory + `__test__` namespace + outer `runEvolution`). Shared dependencies (LLM client / retriever / issueService) injected once. `server/src/services/index.ts` gets one re-export, not six. |
| (default) | LLM cost control: **per-behavior top-N limits** in `BEHAVIOR_LIMITS` constant | merge-candidate-detect: top 10 pairs / pattern-emergence: top 5 clusters per (used_for, business_domain) group / conflict-detect: no LLM (just materialization) / others: no LLM. Total worst-case LLM calls per weekly run per company: ~15. |
| (default) | Cooldown / dedup: **metadata-driven**, no new schema | `metadata.evolution_cooldown_until` ISO timestamp on nodes / drafts / merge-pair tuple keys. Pattern-emergence failures set cooldown=now+30d. Merge proposals checked against existing open `[Evolution]` Issues by title before creating a new one. |

---

## PRD References

- §FR6 全表 (line 432-457) — 6 行为定义
- §6.5 conflict 设计 (line 416-431)
- §6.6 pattern-emergence 详细算法草案 (line 443-455)
- §13.3 Routine 1 注册 (line 1027-1037)
- §4.3 6 种 edge types (line 198-204) — `derived_from` / `merged_from` / `conflicts_with` / `references` 在 Phase 3a 全部用到
- §4.4 时效性模型 (line 204+) — freshness-audit 触发条件
- §4.5 业务域 — pattern-emergence 二维分组键之一
- §15 Phase 3 验收 (line 1158-1164) — 整 Phase 3 完成判定

---

## Schema Verification (no migration required)

All fields PRD §FR6 references are already in master via `migration 0084`. Verified with `packages/db/src/schema/knowledge_*.ts`:

```typescript
// knowledge_nodes
{
  triggerCount: integer (FR6 #1 promotionCheck source)
  preventionScore: real (FR6 #1 promotionCheck source)
  lastTriggered: timestamp (FR6 #2 decayScan source)
  verifiedAt: timestamp (FR6 #5 freshnessAudit source)
  validUntil: timestamp (FR6 #5 freshnessAudit source)
  volatility: text (FR6 #5 freshnessAudit dispatch: fast/slow/stable)
  status: text (FR6 #2 decayScan target: active → archived)
  type: text (FR6 #1 promotionCheck target: lesson → rule; FR6 #6 target: concept)
  embedding: vector(1536) (FR6 #3 mergeCandidate + #6 pattern source)
  usedFor: text (FR6 #6 pattern grouping key)
  businessDomainId: uuid (FR6 #6 pattern grouping key)
  metadata: jsonb (cooldown markers, is_pattern flag, derived_from_lessons)
}

// knowledge_edges
{
  edgeType: text  // 'derived_from' (FR6 #1) / 'merged_from' (FR6 #3) /
                  // 'conflicts_with' (FR6 #4) / 'references' (FR6 #6)
  fromNodeId / toNodeId / autoGenerated / metadata
}

// knowledge_drafts
{
  detectedConflicts: uuid[]  // FR6 #4 source (populated by Phase 3b reviewer)
  status: text  // 'pending' is the only relevant state for conflict materialization
  targetNodeId: uuid  // null = brand-new node proposal; non-null = revision
}

// issues (Paperclip core) — confirmed via partial smoke 2026-05-14
{
  title / description / status / priority         // base fields used by Phase 3a
  companyId                                        // POSITIONAL 1st arg to issueSvc.create, not a data field
  // assigneeAgentId + assigneeUserId both null per decision A (no Curator Agent)
  // NOTE: issues table has NO `labels` array column and NO `metadata` jsonb column.
  //       Labels live in `issue_labels` × `labels` join tables (lazy-create-on-use).
  //       MVP skips label seeding entirely; title prefix `[Evolution:<behavior>]`
  //       serves as the visual category instead.
}
```

**No migration required for Phase 3a.** All cooldown / pattern markers go on **`knowledge_nodes.metadata`** (per-node jsonb), specifically `last_<behavior>_proposal_at` ISO timestamp set when Phase 3a creates a proposal Issue against that node. Issue dedup queries the source node's metadata, not the issues table. Title prefix `[Evolution:<behavior>]` provides the human-readable category without seeding any label entities.

---

## File Structure

**Create (4 files):**

- `server/src/services/knowledge-evolution.ts` — service factory + 6 methods + `runEvolution` aggregator + `BEHAVIOR_LIMITS` const + `EVOLUTION_BEHAVIORS` const tuple. Estimated ~600-800 LOC.
- `server/src/services/knowledge-evolution.test.ts` — Vitest mock-only. Estimated ~500-700 LOC across 6 behavior describe blocks + `runEvolution` aggregation + edge cases. Target 40+ test cases.
- `server/src/services/knowledge-evolution-scheduler.ts` — in-process weekly scheduler mirroring Phase 3c. Estimated ~80 LOC.
- `docs/plans/2026-05-14-llm-wiki-phase-3a-smoke.md` — 8-case smoke checklist (one per behavior + scheduler + cross-company). Estimated ~250 LOC.

**Modify (6 files):**

- `packages/shared/src/validators/knowledge.ts` — add `KNOWLEDGE_EVOLUTION_BEHAVIORS` const tuple, `evolutionRunQuerySchema`, type aliases.
- `packages/shared/src/validators/knowledge.test.ts` — 5-6 new Vitest cases for the new schema.
- `server/src/services/index.ts` — re-export `knowledgeEvolutionService`, `KnowledgeEvolutionService`, `BEHAVIOR_LIMITS as KNOWLEDGE_EVOLUTION_LIMITS`, `startEvolutionScheduler`, `EvolutionSchedulerDeps`, `EvolutionSchedulerHandle`.
- `server/src/routes/knowledge.ts` — instantiate evolution service + add `POST /api/knowledge/evolution/run` route handler. Mirror Phase 3c healthcheck route exactly (board-only, assertCompanyAccess, body validated by `evolutionRunQuerySchema`).
- `server/src/__tests__/knowledge-routes.test.ts` — add `mockEvolution = vi.hoisted(...)` + register in `vi.mock("../services/index.js", ...)` + 4 new route test cases (happy path with all 6 behaviors / subset filter / 400 missing companyId / 400 unknown behavior name).
- `server/src/app.ts` — import `startEvolutionScheduler` + `knowledgeEvolutionService` + wire alongside reviewer and healthcheck schedulers + add `evolutionSchedulerHandle?.stop()` to process.exit cleanup.

---

## Tasks

The 9 tasks below are designed to be implemented and reviewed independently. Tasks 1-2 establish the foundation; Tasks 3-6 implement the 6 behaviors in increasing complexity (so the simplest review and merge first); Tasks 7-8 add the run aggregator + automation surfaces; Task 9 is the verification artifact.

Each task targets a self-contained commit. Estimated session count: 4-6 (Tasks 1-2 in one session, Tasks 3+4 in one, Task 5 alone, Task 6 alone, Tasks 7+8+9 in one).

### Task 1: Shared validators + behavior name enum

**Files:**

- Modify: `packages/shared/src/validators/knowledge.ts`
- Modify: `packages/shared/src/validators/knowledge.test.ts`

**Subject:** Add the Phase 3a shared symbols any server route + UI dashboard will need.

- [ ] **Step 1: Failing tests first** — append to `knowledge.test.ts`:

  ```ts
  import {
    KNOWLEDGE_EVOLUTION_BEHAVIORS,
    evolutionRunQuerySchema,
  } from "./knowledge.js";

  describe("KNOWLEDGE_EVOLUTION_BEHAVIORS", () => {
    it("contains the 6 PRD §13.3 behaviors in declared order", () => {
      expect(KNOWLEDGE_EVOLUTION_BEHAVIORS).toEqual([
        "promotion_check",
        "decay_scan",
        "merge_candidate_detect",
        "conflict_detect",
        "freshness_audit",
        "pattern_emergence",
      ]);
    });
  });

  describe("evolutionRunQuerySchema", () => {
    it("defaults to all 6 behaviors when payload empty", () => {
      const parsed = evolutionRunQuerySchema.parse({});
      expect(parsed.behaviors).toEqual(KNOWLEDGE_EVOLUTION_BEHAVIORS);
    });
    it("preserves requested subset", () => {
      const parsed = evolutionRunQuerySchema.parse({
        behaviors: ["decay_scan", "freshness_audit"],
      });
      expect(parsed.behaviors).toEqual(["decay_scan", "freshness_audit"]);
    });
    it("rejects unknown behavior name", () => {
      expect(() =>
        evolutionRunQuerySchema.parse({ behaviors: ["bogus"] }),
      ).toThrow();
    });
    it("rejects empty array", () => {
      expect(() =>
        evolutionRunQuerySchema.parse({ behaviors: [] }),
      ).toThrow();
    });
    it("rejects unknown top-level keys (strict)", () => {
      expect(() =>
        evolutionRunQuerySchema.parse({
          behaviors: ["decay_scan"],
          extra: "nope",
        }),
      ).toThrow();
    });
  });
  ```

- [ ] **Step 2: Implement** in `knowledge.ts`:

  ```ts
  /**
   * Phase 3a 演化引擎 6 条行为枚举（PRD §13.3 Routine 1）。
   * 顺序与 PRD §FR6 表 + §13.3 Action 列表一致。runEvolution 默认按此顺序串行。
   */
  export const KNOWLEDGE_EVOLUTION_BEHAVIORS = [
    "promotion_check",
    "decay_scan",
    "merge_candidate_detect",
    "conflict_detect",
    "freshness_audit",
    "pattern_emergence",
  ] as const;

  export type KnowledgeEvolutionBehavior =
    (typeof KNOWLEDGE_EVOLUTION_BEHAVIORS)[number];

  /**
   * POST /api/knowledge/evolution/run 请求体。
   * `behaviors` 可选, 缺省跑全 6 个;给子集时只跑指定的几个(调试 / 分批跑)。
   */
  export const evolutionRunQuerySchema = z
    .object({
      behaviors: z
        .array(z.enum(KNOWLEDGE_EVOLUTION_BEHAVIORS))
        .min(1)
        .optional()
        .default([...KNOWLEDGE_EVOLUTION_BEHAVIORS]),
    })
    .strict();

  export type EvolutionRunQuery = z.infer<typeof evolutionRunQuerySchema>;
  ```

- [ ] **Step 3: Verify** — `node ./node_modules/vitest/dist/cli.js run packages/shared/src/validators/knowledge.test.ts` should report 17 tests (12 existing + 5 new).

**Acceptance:** typecheck + new tests pass; commit message mirrors Phase 3c Task 1.

---

### Task 2: knowledgeEvolutionService factory + decayScan (FR6 #2, simplest behavior)

**Files:**

- Create: `server/src/services/knowledge-evolution.ts`
- Create: `server/src/services/knowledge-evolution.test.ts`

**Subject:** Stand up the service factory and the simplest of the 6 behaviors. Future tasks add the remaining 5 by appending methods to the same factory.

`decayScan` is pure SQL with no LLM and no Issue creation — pick it first to validate the service shape before committing to the harder LLM-using behaviors.

- [ ] **Step 1: File skeleton** — copy the shape from `server/src/services/knowledge-healthcheck.ts`:

  ```ts
  import { sql } from "drizzle-orm";
  import type { Db } from "@paperclipai/db";
  import { knowledgeNodes, knowledgeNodeEvents } from "@paperclipai/db";
  import { logger } from "../middleware/logger.js";
  import type { LlmWikiService } from "./llm-wiki.js";
  import type { KnowledgeRetrieverService } from "./knowledge-retriever.js";
  import type { IssueServiceLike } from "./knowledge-healthcheck.js";

  /**
   * Phase 3a 演化引擎 (PRD §FR6 + §13.3 Routine 1 weekly-knowledge-evolution).
   *
   * 6 行为按 PRD §13.3 顺序串行: promotionCheck → decayScan →
   * mergeCandidateDetect → conflictDetect → freshnessAudit → patternEmergence.
   *
   * Maintainer decisions (recorded for reference; details in plan file
   * docs/plans/2026-05-14-llm-wiki-phase-3a-evolution.md):
   * - A: Curator Agent not created in v0.1; all proposal Issues use
   *      assignee=null and rely on existing board triage flow.
   * - B: pattern-emergence uses cosine threshold graph + connected-
   *      components (in-memory union-find), no external clustering deps.
   * - C: conflict-detect materializes Phase 3b detected_conflicts only;
   *      no independent active-rule scan in v0.1.
   * - D: single service factory exposing 6 methods (this file), not
   *      6 separate service files.
   *
   * No node mutation happens without human approval. Proposals go through
   * the existing draft / Issue review pipeline; decay-archive is the only
   * direct UPDATE and it merely flips status (no data loss; reversible).
   */

  /** Per-behavior top-N limits — controls LLM cost in weekly tick. */
  export const BEHAVIOR_LIMITS = {
    merge_candidate_detect: { topPairs: 10, cosineThreshold: 0.9 },
    pattern_emergence: {
      topClusters: 5,
      cosineThreshold: 0.7,
      minClusterSize: 5,
      cooldownDays: 30,
    },
    promotion_check: { triggerCountMin: 3, preventionScoreMin: 0.7 },
    decay_scan: { idleDays: 180 },
    freshness_audit: {
      validUntilWindowDays: 7,
      fastVerifyWindowDays: 90,
      slowVerifyWindowDays: 365,
    },
    // conflict_detect: no tunable limit; processes all drafts with
    // non-empty detected_conflicts.
  } as const;

  export interface BehaviorResult {
    behavior: string;
    candidatesFound: number;
    issuesCreated: number;
    draftsCreated: number;
    edgesCreated: number;
    nodesModified: number;
    /** non-fatal per-item errors */
    errors: Array<{ subject: string; reason: string }>;
    details: Record<string, unknown>;
  }

  export interface RunEvolutionResult {
    behaviorsRun: number;
    issuesCreated: number;
    draftsCreated: number;
    nodesModified: number;
    perBehavior: BehaviorResult[];
  }

  export function knowledgeEvolutionService(
    db: Db,
    llm: LlmWikiService,
    retriever: KnowledgeRetrieverService,
    issueSvc: IssueServiceLike | null,
  ) {
    // ──────────────────────────────────────────────────────────────
    // Behavior #2 — decayScan (PRD §FR6 row 2)
    // Trigger: status=active AND last_triggered IS NULL OR now-last_triggered > 180d
    // Effect: status=archived; write knowledge_node_events row with
    //         event_type='archived', metadata.reason='auto_decay'.
    // No Issue creation (decay is reversible and high-volume; surfacing
    // every archive as an Issue would spam).
    // ──────────────────────────────────────────────────────────────

    async function decayScan(companyId: string): Promise<BehaviorResult> {
      const t = BEHAVIOR_LIMITS.decay_scan;
      // Single UPDATE returning the count; cheap and atomic.
      const rows = (await db.execute(sql`
        WITH archived AS (
          UPDATE knowledge_nodes
          SET status = 'archived', updated_at = NOW()
          WHERE company_id = ${companyId}
            AND status = 'active'
            AND (last_triggered IS NULL
                 OR last_triggered < NOW() - INTERVAL '${sql.raw(String(t.idleDays))} days')
          RETURNING id
        )
        INSERT INTO knowledge_node_events (node_id, event_type, metadata, created_at)
        SELECT id, 'archived',
               jsonb_build_object('reason', 'auto_decay', 'idle_days', ${t.idleDays}),
               NOW()
        FROM archived
        RETURNING node_id
      `)) as Array<{ node_id: string }>;
      return {
        behavior: "decay_scan",
        candidatesFound: rows.length,
        issuesCreated: 0,
        draftsCreated: 0,
        edgesCreated: 0,
        nodesModified: rows.length,
        errors: [],
        details: { idle_days_threshold: t.idleDays },
      };
    }

    return {
      __test__: {
        decayScan,
      },
    };
  }

  export type KnowledgeEvolutionService = ReturnType<
    typeof knowledgeEvolutionService
  >;
  ```

- [ ] **Step 2: Failing tests** (`knowledge-evolution.test.ts`):

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { knowledgeEvolutionService, BEHAVIOR_LIMITS } from "./knowledge-evolution.js";

  function fakeDb(...executeResults: unknown[][]) {
    const db = { execute: vi.fn() };
    for (const r of executeResults) db.execute.mockResolvedValueOnce(r);
    return db as never;
  }

  const fakeLlm = { embed: vi.fn(), completeChat: vi.fn() };
  const fakeRetriever = { search: vi.fn() };

  describe("decayScan", () => {
    it("archives all active nodes idle > 180 days", async () => {
      const db = fakeDb([{ node_id: "n-1" }, { node_id: "n-2" }, { node_id: "n-3" }]);
      const svc = knowledgeEvolutionService(db, fakeLlm as never, fakeRetriever as never, null);
      const r = await svc.__test__.decayScan("co-1");
      expect(r.behavior).toBe("decay_scan");
      expect(r.nodesModified).toBe(3);
      expect(r.candidatesFound).toBe(3);
      expect(r.issuesCreated).toBe(0);
      expect(r.draftsCreated).toBe(0);
      expect(r.details).toEqual({ idle_days_threshold: 180 });
    });

    it("returns 0 when no nodes match", async () => {
      const db = fakeDb([]);
      const svc = knowledgeEvolutionService(db, fakeLlm as never, fakeRetriever as never, null);
      const r = await svc.__test__.decayScan("co-1");
      expect(r.nodesModified).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it("uses idle_days threshold from BEHAVIOR_LIMITS (180)", () => {
      expect(BEHAVIOR_LIMITS.decay_scan.idleDays).toBe(180);
    });
  });
  ```

- [ ] **Step 3: Verify** — Vitest passes 3 cases.

**Acceptance:** decay-scan tests pass; service factory shape locked in for Tasks 3-6 to extend.

---

### Task 3: promotionCheck + freshnessAudit (FR6 #1 + #5, two SQL+Issue behaviors)

**Files:**

- Modify: `server/src/services/knowledge-evolution.ts` (append 2 methods + Issue-creation helper)
- Modify: `server/src/services/knowledge-evolution.test.ts` (append 2 describe blocks)

**Subject:** The two "find rows matching SQL → create one Issue per candidate" behaviors. They share an Issue-creation helper that the remaining LLM-using behaviors (Tasks 4 + 6) will also reuse.

**Architecture for Issue creation:**

```ts
async function proposeViaIssue(
  companyId: string,
  titlePrefix: string,        // e.g. "[Evolution:promotion]"
  title: string,              // human-readable subject ("建议升级为 rule: {node.title}")
  body: string,
): Promise<string | null> {
  if (!issueSvc) {
    logger.warn({ companyId, titlePrefix }, "evolution: issueService unavailable, Issue not created");
    return null;
  }
  try {
    // issueSvc.create signature (confirmed v0.2): positional companyId + data object
    // without `labels` (issues table has no labels column) and without `metadata`
    // (issues table has no metadata column). assigneeAgentId / assigneeUserId
    // omitted → both null per Phase 3a decision A (no Curator Agent).
    const issue = await issueSvc.create(companyId, {
      title: `${titlePrefix} ${title}`,
      description: body,
      status: "todo",
      priority: "medium",
    });
    return issue.id;
  } catch (err) {
    logger.warn({ err, companyId, titlePrefix }, "evolution: Issue creation failed");
    return null;
  }
}
```

Dedup (v0.2): the source node — not the issues table — stores the dedup marker. Each behavior writes `knowledge_nodes.metadata.last_<behavior>_proposal_at` (or `knowledge_drafts.metadata.last_<behavior>_proposal_at` for draft-anchored proposals) when it creates an Issue. Before creating a new proposal Issue, the candidate query filters out nodes whose `last_<behavior>_proposal_at` is within the cooldown window (default 7 days, matching the weekly tick). After Issue creation succeeds, the behavior updates the node's metadata in a single `UPDATE knowledge_nodes SET metadata = metadata || jsonb_build_object(...)` statement.

- [ ] **Step 1: promotionCheck implementation**:

  Query (`knowledge_nodes`): `type='lesson' AND status='active' AND trigger_count >= 3 AND prevention_score >= 0.7`. For each row, propose Issue "建议升级为 rule: {title}". Body includes node id / current type / trigger_count / prevention_score / link to detail page.

  Dedup (v0.2): the candidate query already excludes nodes where `knowledge_nodes.metadata.last_promotion_proposal_at` is within 7 days. No issues-table subquery needed — dedup lives entirely on the source node's metadata.

  On Issue success: (1) write `knowledge_node_events` row `event_type='promoted'`, `metadata.proposed=true`; (2) update node metadata: `UPDATE knowledge_nodes SET metadata = metadata || jsonb_build_object('last_promotion_proposal_at', NOW()::text, 'last_promotion_issue_id', $issue_id) WHERE id = $node_id`.

  Returns BehaviorResult with `issuesCreated = count of new Issues`.

- [ ] **Step 2: freshnessAudit implementation**:

  Three SQL queries (union) for the three trigger conditions:

  ```sql
  -- a) valid_until 临近 7 天
  SELECT id, title, 'expiring_validity' AS reason FROM knowledge_nodes
   WHERE company_id = $1 AND status = 'active'
     AND valid_until IS NOT NULL
     AND valid_until BETWEEN NOW() AND NOW() + INTERVAL '7 days'
  UNION ALL
  -- b) volatility=fast AND verified_at < now-90d (or NULL)
  SELECT id, title, 'fast_stale' AS reason FROM knowledge_nodes
   WHERE company_id = $1 AND status = 'active'
     AND volatility = 'fast'
     AND (verified_at IS NULL OR verified_at < NOW() - INTERVAL '90 days')
  UNION ALL
  -- c) volatility=slow AND verified_at < now-365d
  SELECT id, title, 'slow_stale' AS reason FROM knowledge_nodes
   WHERE company_id = $1 AND status = 'active'
     AND volatility = 'slow'
     AND (verified_at IS NULL OR verified_at < NOW() - INTERVAL '365 days')
  ```

  Per row create Issue "请验证 [节点]: {title}" with body including reason + last verified_at + volatility.

  Dedup (v0.2): candidate query filters out nodes where `knowledge_nodes.metadata.last_freshness_proposal_at` is within 7 days. Same per-node-metadata strategy as promotionCheck.

  On Issue success: (1) write `knowledge_node_events` row `event_type='verification_requested'`; (2) update node metadata `last_freshness_proposal_at` to NOW(). Do NOT touch `verified_at` — that's the human reviewer's job after they actually verify.

- [ ] **Step 3: Test cases** — at least 3 per behavior (happy path / dedup / issueSvc unavailable). Mock `db.execute` to return canned rows; mock `issueSvc.create` to return `{ id: 'iss-1' }`.

- [ ] **Step 4: Verify** — Vitest passes; cumulative ~12-15 tests in knowledge-evolution.test.ts.

**Acceptance:** Both behaviors produce Issue mocks correctly + dedup skips work + null-issueSvc degradation path logged-not-throw.

---

### Task 4: mergeCandidateDetect (FR6 #3, pgvector cosine + optional LLM)

**Files:**

- Modify: `server/src/services/knowledge-evolution.ts` (append method)
- Modify: `server/src/services/knowledge-evolution.test.ts` (append describe block)

**Subject:** Find top-10 node pairs in the same company with cosine similarity ≥ 0.9 and propose merge Issues. LLM is **optional** for v0.1 — Issue body just says "These two nodes look similar; consider merging" with a link. LLM-generated merge proposals stay a `// future` comment.

- [ ] **Step 1: SQL for top-N pairs** (pgvector):

  ```sql
  WITH pairs AS (
    SELECT
      a.id AS id_a, b.id AS id_b,
      a.title AS title_a, b.title AS title_b,
      a.type AS type_a, b.type AS type_b,
      1 - (a.embedding <=> b.embedding) AS cosine
    FROM knowledge_nodes a
    JOIN knowledge_nodes b
      ON a.id < b.id                       -- avoid duplicate (a,b)/(b,a) + self
      AND a.company_id = b.company_id      -- same-company only
      AND a.embedding <=> b.embedding < 0.1  -- distance < 0.1 ≡ cosine > 0.9
    WHERE a.company_id = $1
      AND a.status = 'active'
      AND b.status = 'active'
  )
  SELECT * FROM pairs
  ORDER BY cosine DESC
  LIMIT 10;
  ```

  Note `<=>` is pgvector's cosine **distance** operator (0 = identical, 2 = opposite). So cosine_similarity = 1 - distance. Distance < 0.1 ⇔ similarity > 0.9. We filter in the join condition so the index on `(embedding)` can be used; the `ORDER BY` is then over the already-filtered candidates.

  **Performance**: pgvector's `<=>` will use the **HNSW index** `knowledge_nodes_embedding_idx` (`vector_cosine_ops`, `m=16`, `ef_construction=200`) — confirmed via partial smoke EXPLAIN. For ~1000 nodes per company, the cross-join with `<=> < 0.1` filter typically returns < 100 candidates; the LIMIT 10 keeps wire size predictable.

- [ ] **Step 2: For each pair**: dedup using **per-node metadata** — skip the pair if `knowledge_nodes.metadata.last_merge_proposal_at` on either node is within 7 days, OR if `knowledge_nodes.metadata.last_merge_pair_keys` array (on either node) contains the sorted-lexicographic pair_key `"{id_a}:{id_b}"`. Create Issue with title `[Evolution:merge] 建议合并 [{title_a}] 与 [{title_b}]` and body containing both titles + types + cosine + node id links + suggested merged-node action.

  On Issue success: append the pair_key to both nodes' `metadata.last_merge_pair_keys` and set `last_merge_proposal_at = NOW()` on both. (One UPDATE per node.)

- [ ] **Step 3: Test cases**:
  - happy path: 3 pairs returned → 3 Issues created
  - dedup: 1 pair already has open Issue → only 2 Issues created
  - empty: 0 pairs → 0 Issues, no errors
  - limit respected: 15 pairs returned (mocked) → only top 10 processed (asserts SQL has LIMIT)
  - issueSvc unavailable: degrades, no throw

**Acceptance:** all merge tests pass; cosine threshold and limit values come from `BEHAVIOR_LIMITS.merge_candidate_detect`.

---

### Task 5: conflictDetect (FR6 #4, materialize Phase 3b detected_conflicts) — Decision C

**Files:**

- Modify: `server/src/services/knowledge-evolution.ts` (append method)
- Modify: `server/src/services/knowledge-evolution.test.ts` (append describe block)

**Subject:** Walk pending drafts where `detected_conflicts` array is non-empty (populated by Phase 3b reviewer), insert `conflicts_with` edges between the draft's target node (if any) and each conflict node, create one Issue per conflict pair, then clear the draft's `detected_conflicts` array to prevent re-processing on next tick.

Per Decision C: **no LLM** in this behavior. Just materialization.

- [ ] **Step 1: SQL for source drafts**:

  ```sql
  SELECT id, company_id, target_node_id, proposed_title, detected_conflicts
  FROM knowledge_drafts
  WHERE company_id = $1
    AND status = 'pending'
    AND detected_conflicts IS NOT NULL
    AND array_length(detected_conflicts, 1) >= 1
  ORDER BY created_at ASC
  ```

- [ ] **Step 2: For each draft × each conflict_node_id pair**:

  - If draft.target_node_id is non-null (draft is a revision of an existing node):
    - Insert `conflicts_with` edge `(target_node_id → conflict_node_id, auto_generated=true, metadata.source_draft=draft.id)`. Use `ON CONFLICT DO NOTHING` against the existing `knowledge_edges_unique_directed` unique index.
    - Create Issue "冲突: [{draft.proposed_title}] 与 [{conflict_node.title}]" with body listing both nodes + draft id + suggestion ("点击审查"link).
  - If draft.target_node_id is null (brand-new node proposal):
    - **No edge created** (no source node yet). Just create Issue with the same body shape, plus a note "草稿尚未物化为节点; 审查通过后再 materialize 边".

- [ ] **Step 3: Clear the array** after successful processing:

  ```sql
  UPDATE knowledge_drafts SET detected_conflicts = '{}' WHERE id = $1
  ```

  This avoids reprocessing on the next weekly tick.

- [ ] **Step 4: Test cases**:
  - draft with 2 conflicts → 2 edges (if target_node_id set) + 2 Issues
  - draft.target_node_id null → 0 edges + Issue(s) only
  - duplicate edge (already exists) → ON CONFLICT skips; Issue still attempted but blocked by Issue dedup
  - clears detected_conflicts after processing
  - issueSvc unavailable: edges still created, Issue skipped with warning

**Acceptance:** all conflict tests pass; no LLM call asserted (mocked LLM `completeChat` not called).

---

### Task 6: patternEmergence (FR6 #6, cosine threshold graph + connected-components + LLM)

**Files:**

- Modify: `server/src/services/knowledge-evolution.ts` (append method + `unionFind` helper)
- Modify: `server/src/services/knowledge-evolution.test.ts` (append describe block)

**Subject:** The most complex behavior. Group lesson nodes by `(used_for, business_domain_id)`, within each group build a cosine-similarity graph (threshold ≥ 0.7), find connected components ≥ 5 nodes, ask LLM to extract the common pattern, write a `concept`-type draft (goes through Phase 3b reviewer + human approval before becoming a node).

Per Decision B: pure in-memory union-find, no clustering library dependency.

- [ ] **Step 1: Discover groups** — find all `(used_for, business_domain_id)` tuples with ≥ 5 active lessons:

  ```sql
  SELECT used_for, business_domain_id, COUNT(*) AS lesson_count
  FROM knowledge_nodes
  WHERE company_id = $1
    AND type = 'lesson'
    AND status = 'active'
    AND used_for IS NOT NULL
    AND business_domain_id IS NOT NULL
    AND (
      metadata->>'evolution_cooldown_until' IS NULL
      OR (metadata->>'evolution_cooldown_until')::timestamptz < NOW()
    )
  GROUP BY used_for, business_domain_id
  HAVING COUNT(*) >= 5
  LIMIT 5  -- top-N groups per run (BEHAVIOR_LIMITS.pattern_emergence.topClusters)
  ```

  Note the cooldown filter at the group level: if **any** lesson in the group is on cooldown, skip the group? — No, more useful: each lesson independently. Filter individual cooldown lessons out, then re-check `COUNT(*) >= 5` post-filter. To keep SQL simple, accept that cooldown is checked per-node inside the loop and the group may be skipped if its post-filter count < 5.

- [ ] **Step 2: For each group, build the cosine graph**:

  Fetch all qualifying lesson `(id, embedding)` pairs. Compute pairwise cosine (in-memory or via pgvector); add edge if cosine ≥ 0.7. Union-find connected components. Keep components with size ≥ 5.

  Pairwise cosine via pgvector (single query per group):

  ```sql
  SELECT a.id AS id_a, b.id AS id_b, 1 - (a.embedding <=> b.embedding) AS cosine
  FROM knowledge_nodes a
  JOIN knowledge_nodes b
    ON a.id < b.id
    AND a.company_id = b.company_id
    AND 1 - (a.embedding <=> b.embedding) >= 0.7
  WHERE a.company_id = $1
    AND a.type = 'lesson'
    AND a.status = 'active'
    AND a.used_for = $2
    AND a.business_domain_id = $3
    AND b.type = 'lesson'
    AND b.status = 'active'
    AND b.used_for = $2
    AND b.business_domain_id = $3
  ```

  In-memory union-find:

  ```ts
  function findRoot(parent: Map<string, string>, x: string): string {
    let cur = x;
    while (parent.get(cur)! !== cur) cur = parent.get(cur)!;
    // path compression
    let walker = x;
    while (parent.get(walker)! !== cur) {
      const next = parent.get(walker)!;
      parent.set(walker, cur);
      walker = next;
    }
    return cur;
  }

  function unionFind(allIds: string[], edges: Array<{ a: string; b: string }>) {
    const parent = new Map<string, string>();
    for (const id of allIds) parent.set(id, id);
    for (const { a, b } of edges) {
      const ra = findRoot(parent, a);
      const rb = findRoot(parent, b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const buckets = new Map<string, string[]>();
    for (const id of allIds) {
      const root = findRoot(parent, id);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root)!.push(id);
    }
    return Array.from(buckets.values()).filter((c) => c.length >= 5);
  }
  ```

- [ ] **Step 3: LLM call per cluster**:

  Fetch cluster nodes' title + content. Build prompt:

  ```
  你是知识库 curator,从下面 N 条 lesson 中提炼共性模式。

  Lessons:
  - [id 1] {title 1} : {content excerpt 1}
  - [id 2] {title 2} : {content excerpt 2}
  ...

  输出严格 JSON:
  {
    "pattern_name": "≤30 字模式名",
    "pattern_summary": "≤200 字 summary",
    "pattern_conditions": ["触发条件 1", "触发条件 2", ...],
    "source_lesson_ids": ["id 1", "id 2", ...]
  }

  若无明显共性,输出 {"no_pattern": true, "reason": "..."}。只输出 JSON,不要 markdown 围栏。
  ```

  Parse response:
  - `no_pattern=true` → set cooldown on each lesson `metadata.evolution_cooldown_until = now + 30d`. Return without creating draft.
  - Else → create a `knowledge_drafts` row via `knowledgeDraftService.create()`:
    - `proposed_type='concept'`
    - `proposed_title=pattern_name`
    - `proposed_content=pattern_summary + (newline-joined) pattern_conditions`
    - `metadata = { is_pattern: true, derived_from_lessons: [...source_lesson_ids] }`
    - `source='agent_self_review'` (closest existing enum value; v0.2 may add `evolution_pattern_emergence`)

- [ ] **Step 4: Test cases**:
  - 1 group, 6 lessons forming 1 cluster of 5 + 1 outlier → 1 draft created
  - 1 group, 4 lessons → group skipped (count < 5)
  - LLM returns no_pattern → cooldown set on all lessons, no draft
  - cooldown active lessons excluded from candidate pool
  - 2 groups in parallel → 2 drafts (different `derived_from_lessons` lists)
  - LLM error → group cooldown set, no throw

**Acceptance:** all pattern tests pass; union-find correctness covered (e.g. transitive A-B-C cluster).

---

### Task 7: runEvolution aggregator + REST POST /api/knowledge/evolution/run

**Files:**

- Modify: `server/src/services/knowledge-evolution.ts` (add `runEvolution` + `return { runEvolution, __test__: {...} }`)
- Modify: `server/src/services/index.ts` (re-export)
- Modify: `server/src/routes/knowledge.ts` (instantiate service + add route)
- Modify: `server/src/__tests__/knowledge-routes.test.ts` (mock + 4 route cases)
- Modify: `packages/shared/src/validators/knowledge.ts` (already done in Task 1)

**Subject:** Tie the 6 behaviors into one entry point and expose it as a board-only REST endpoint, mirroring Phase 3c's `runHealthcheck` + `/healthcheck/run`.

- [ ] **Step 1: `runEvolution` method** — sequential execution in PRD §13.3 order; aggregate per-behavior results; isolate failures (one behavior throwing does not abort the rest):

  ```ts
  async function runEvolution(
    companyId: string,
    opts?: { behaviors?: KnowledgeEvolutionBehavior[] },
  ): Promise<RunEvolutionResult> {
    const behaviors = opts?.behaviors ?? [...KNOWLEDGE_EVOLUTION_BEHAVIORS];
    const perBehavior: BehaviorResult[] = [];
    const map = {
      promotion_check: () => promotionCheck(companyId),
      decay_scan: () => decayScan(companyId),
      merge_candidate_detect: () => mergeCandidateDetect(companyId),
      conflict_detect: () => conflictDetect(companyId),
      freshness_audit: () => freshnessAudit(companyId),
      pattern_emergence: () => patternEmergence(companyId),
    };
    for (const b of behaviors) {
      try {
        perBehavior.push(await map[b]());
      } catch (err) {
        logger.warn({ err, behavior: b, companyId }, "evolution: behavior failed");
        perBehavior.push({
          behavior: b,
          candidatesFound: 0,
          issuesCreated: 0,
          draftsCreated: 0,
          edgesCreated: 0,
          nodesModified: 0,
          errors: [{ subject: b, reason: err instanceof Error ? err.message : String(err) }],
          details: { aborted: true },
        });
      }
    }
    return {
      behaviorsRun: perBehavior.length,
      issuesCreated: perBehavior.reduce((sum, r) => sum + r.issuesCreated, 0),
      draftsCreated: perBehavior.reduce((sum, r) => sum + r.draftsCreated, 0),
      nodesModified: perBehavior.reduce((sum, r) => sum + r.nodesModified, 0),
      perBehavior,
    };
  }
  ```

- [ ] **Step 2: Service re-export** — `server/src/services/index.ts`:

  ```ts
  export {
    knowledgeEvolutionService,
    BEHAVIOR_LIMITS as KNOWLEDGE_EVOLUTION_LIMITS,
    type KnowledgeEvolutionService,
    type BehaviorResult,
    type RunEvolutionResult,
  } from "./knowledge-evolution.js";
  ```

- [ ] **Step 3: REST route** — `server/src/routes/knowledge.ts`:

  ```ts
  const evolution = knowledgeEvolutionService(db, llm, retriever, issueService(db));

  router.post("/evolution/run", async (req, res) => {
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = evolutionRunQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest("invalid body", parsed.error.format());
    }
    const result = await evolution.runEvolution(companyId, {
      behaviors: parsed.data.behaviors,
    });
    res.json({ data: result });
  });
  ```

- [ ] **Step 4: 4 route test cases**:
  - 200 + full 6 behaviors result, asserts service called with default behaviors list
  - subset passed through unchanged
  - 400 missing companyId
  - 400 unknown behavior name + asserts service not called

**Acceptance:** routes + service aggregation green; cumulative test count ~50+ in knowledge-evolution.test.ts and 26 in knowledge-routes.test.ts.

---

### Task 8: In-process weekly scheduler + app.ts wire

**Files:**

- Create: `server/src/services/knowledge-evolution-scheduler.ts`
- Modify: `server/src/services/index.ts` (re-export scheduler)
- Modify: `server/src/app.ts` (wire + process.exit cleanup)

**Subject:** Mirror Phase 3c `knowledge-healthcheck-scheduler` exactly. Env-gated, interval-based, single-tick guard.

- [ ] **Step 1: Scheduler file** — copy-paste from `knowledge-healthcheck-scheduler.ts`, swap names:

  - Env: `KNOWLEDGE_EVOLUTION_ENABLED=true` to enable.
  - Default interval: `KNOWLEDGE_EVOLUTION_INTERVAL_MINUTES=10080` (7 days × 24 × 60).
  - Per-company sequential loop.
  - Log line: `"evolution scheduler: company done"` with `{ companyId, behaviorsRun, issuesCreated, draftsCreated, nodesModified }`.

- [ ] **Step 2: Re-export** in `services/index.ts`:

  ```ts
  export {
    startEvolutionScheduler,
    type EvolutionSchedulerDeps,
    type EvolutionSchedulerHandle,
  } from "./knowledge-evolution-scheduler.js";
  ```

- [ ] **Step 3: app.ts wire** — alongside the existing reviewer + healthcheck schedulers:

  ```ts
  // 知识演化引擎进程内调度器 (Phase 3a); env KNOWLEDGE_EVOLUTION_ENABLED=true 开启
  // 默认 10080 min (7 天) 一次, 可由 KNOWLEDGE_EVOLUTION_INTERVAL_MINUTES 覆盖。
  // 跟 PRD §13.3 Routine 1 cron 0 9 * * 1 (每周一 9:00) 近似;真正准点 weekly
  // 由 Paperclip Routine 替代时切换。
  const evolutionSchedulerHandle = startEvolutionScheduler({
    listCompanies: async () => {
      const rows = await db.select({ id: companiesTable.id }).from(companiesTable);
      return rows;
    },
    evolutionForCompany: (_companyId) =>
      knowledgeEvolutionService(
        db,
        llmWikiClient,
        knowledgeRetriever,
        issueService(db),
      ),
  });
  ```

  Add `evolutionSchedulerHandle?.stop();` to the `process.exit` cleanup, next to the reviewer + healthcheck stops.

**Acceptance:** server starts cleanly with env off (handle is null); with env on it logs initial tick on startup.

---

### Task 9: Smoke checklist

**Files:**

- Create: `docs/plans/2026-05-14-llm-wiki-phase-3a-smoke.md`

**Subject:** 8-case manual verification doc mirroring `docs/plans/2026-05-14-llm-wiki-phase-3c-smoke.md` style. Each case includes `curl` invocation + SQL verify + expected output.

Case skeleton:

1. **Single manual trigger** — `POST /evolution/run` runs all 6 behaviors; response has `behaviorsRun=6`; per-behavior counts present.
2. **decay_scan archives idle nodes** — seed an active lesson with `last_triggered = now - 200d`; tick; assert `status='archived'` and a `knowledge_node_events` row with `event_type='archived'`.
3. **promotion_check creates Issue** — seed a lesson with `trigger_count=5`, `prevention_score=0.8`; tick; assert one new `[Evolution:promotion]` Issue.
4. **freshness_audit creates Issue for fast-stale node** — seed a `volatility='fast'` node with `verified_at = now - 100d`; tick; assert `[Evolution:freshness]` Issue.
5. **merge_candidate_detect creates Issue for similar pair** — seed 2 nodes with similar embeddings (manually compute or use `pgvector.embed`); tick; assert one new Issue with title prefix `[Evolution:merge]` and both nodes' `metadata.last_merge_pair_keys` array contains the sorted pair_key.
6. **conflict_detect materializes Phase 3b conflicts** — seed a draft with `detected_conflicts = [other_node_id]` and `target_node_id = src_node_id`; tick; assert a `conflicts_with` edge inserted + Issue created + `detected_conflicts` cleared.
7. **pattern_emergence creates concept draft** — seed 6 similar lesson nodes in same `(used_for, business_domain_id)`; tick; assert one new `type='concept'` draft with `metadata.is_pattern=true`.
8. **Subset filter + cross-company isolation** — `POST /evolution/run` with `body.behaviors=["decay_scan"]` only runs decay; cross-company `?companyId=B` from A actor returns 403.

Plus a "known limitations" section:
- LLM cost: pattern + (future merge LLM) hit ~$0.05-0.10 per company per weekly run with qwen-plus
- Cooldown not surfaced in UI in v0.1
- Curator Agent not implemented (decision A); Issues are unassigned

**Acceptance:** smoke doc committed; ≥ 7/8 cases pass during real deployment validates Phase 3a shippable.

---

## Risk Section

| Risk | Mitigation |
|---|---|
| LLM cost in weekly tick | `BEHAVIOR_LIMITS.pattern_emergence.topClusters=5` and `merge_candidate_detect.topPairs=10` bound it. Worst case ~15 LLM calls per company per week. |
| Issue noise from `decay_scan` | Explicitly **no** Issue creation for decay (archive is reversible + high-volume). Activity log entry only. |
| Issue noise from other behaviors | Dedup via `knowledge_nodes.metadata.last_<behavior>_proposal_at` per-node cooldown (default 7 days, matches weekly tick) + 30-day cooldown for failed pattern attempts via `metadata.evolution_cooldown_until`. No `issues.metadata` query needed (column doesn't exist in this fork). |
| pgvector O(n²) cost on large companies | LIMITs at every cross-join; **HNSW index** `knowledge_nodes_embedding_idx` (`vector_cosine_ops`, `m=16`, `ef_construction=200`, already in master) keeps `<=>` cheap. Will revisit if any company exceeds 5k nodes. |
| LLM unparseable JSON on pattern-emergence | Try/catch around JSON.parse; on failure set 30-day cooldown on the cluster (don't retry every week with the same unproductive prompt). |
| Phase 3b detected_conflicts may be empty for all drafts (cold start) | conflict-detect just returns `candidatesFound=0`, no error. v0.2 follow-up may add independent active-rule scan. |
| Schema drift if Phase 1 changes draft fields | All SQL uses Drizzle-typed columns via `sql\`\`\``; renames will fail at compile time. |
| Scheduler runs alongside two existing schedulers (reviewer + healthcheck) | Each is env-gated and uses `setInterval.unref()`; no shared mutex needed because each operates on different tables. |

---

## Plan Deviations (recorded for ADR-style traceability)

- **Decision A** (no Curator Agent): PRD §13.3 lists Curator Agent as Routine 1's agent. v0.1 leaves Issue.assignee=null because creating an agent entity is a separate architectural concern; the Phase 3a code path doesn't reference any agent ID and a follow-up PR can backfill assignee without code changes here.
- **Decision B** (cosine threshold graph vs HDBSCAN): PRD §6.6 algorithm 4 recommends HDBSCAN. v0.1 substitutes cosine threshold graph + union-find because no maintained Node.js HDBSCAN package was vetted. Trade-off is less density-aware clustering — but deterministic, debuggable, zero new dependency. v0.2 follow-up may swap in DBSCAN.
- **Decision C** (materialize-only conflict-detect): PRD §FR6 #4 implies independent LLM-based active-rule scan ("新 draft 与既有 rule 经 LLM 判断为冲突"). v0.1 materializes Phase 3b's already-detected conflicts because (a) Phase 3b already runs LLM for this, (b) duplicate detection is wasteful, (c) brand-new active-rule conflicts (not draft-vs-rule) are rare in PRD's expected workflow. v0.2 may add the independent scan.
- **Decision D** (single service, 6 methods): mirrors Phase 3c style. 6 separate files would be over-engineering for an MVP — shared LLM/retriever/issueSvc dependencies need only one factory.
- **Scheduler interval-based vs cron**: PRD §13.3 cron `0 9 * * 1` (Monday 9 AM). v0.1 uses `setInterval` with default 10080 min (7 days) for consistency with Phase 3b + 3c schedulers. Real wall-clock weekly arrives when Paperclip Routine 1 replaces this in-process scheduler.

---

## Appendix A: 6 SQL drafts (consolidated reference)

### A.1 decayScan

```sql
WITH archived AS (
  UPDATE knowledge_nodes
  SET status = 'archived', updated_at = NOW()
  WHERE company_id = $1
    AND status = 'active'
    AND (last_triggered IS NULL OR last_triggered < NOW() - INTERVAL '180 days')
  RETURNING id
)
INSERT INTO knowledge_node_events (node_id, event_type, metadata, created_at)
SELECT id, 'archived',
       jsonb_build_object('reason', 'auto_decay', 'idle_days', 180),
       NOW()
FROM archived
RETURNING node_id;
```

### A.2 promotionCheck (candidate query)

```sql
SELECT id, title, type, trigger_count, prevention_score
FROM knowledge_nodes
WHERE company_id = $1
  AND type = 'lesson'
  AND status = 'active'
  AND trigger_count >= 3
  AND prevention_score >= 0.7
  AND (metadata->>'evolution_cooldown_until' IS NULL
       OR (metadata->>'evolution_cooldown_until')::timestamptz < NOW())
  AND (metadata->>'last_promotion_proposal_at' IS NULL
       OR (metadata->>'last_promotion_proposal_at')::timestamptz < NOW() - INTERVAL '7 days')
ORDER BY prevention_score DESC, trigger_count DESC
LIMIT 50;
-- v0.2: dedup moved from `issues.metadata.subject_node_id` (column does not exist
-- in this fork) to `knowledge_nodes.metadata.last_promotion_proposal_at`,
-- written by promotionCheck after a successful issueSvc.create() call.
```

### A.3 freshnessAudit (three-way UNION)

```sql
(
  SELECT id, title, 'expiring_validity'::text AS reason, valid_until, verified_at
  FROM knowledge_nodes
  WHERE company_id = $1 AND status = 'active'
    AND valid_until IS NOT NULL
    AND valid_until BETWEEN NOW() AND NOW() + INTERVAL '7 days'
)
UNION ALL
(
  SELECT id, title, 'fast_stale'::text AS reason, valid_until, verified_at
  FROM knowledge_nodes
  WHERE company_id = $1 AND status = 'active' AND volatility = 'fast'
    AND (verified_at IS NULL OR verified_at < NOW() - INTERVAL '90 days')
)
UNION ALL
(
  SELECT id, title, 'slow_stale'::text AS reason, valid_until, verified_at
  FROM knowledge_nodes
  WHERE company_id = $1 AND status = 'active' AND volatility = 'slow'
    AND (verified_at IS NULL OR verified_at < NOW() - INTERVAL '365 days')
)
ORDER BY reason, id
LIMIT 100;
```

### A.4 mergeCandidateDetect (pgvector top-10 pairs)

```sql
SELECT
  a.id AS id_a, b.id AS id_b,
  a.title AS title_a, b.title AS title_b,
  a.type AS type_a, b.type AS type_b,
  1 - (a.embedding <=> b.embedding) AS cosine
FROM knowledge_nodes a
JOIN knowledge_nodes b
  ON a.id < b.id
  AND a.company_id = b.company_id
  AND a.embedding <=> b.embedding < 0.1
WHERE a.company_id = $1
  AND a.status = 'active'
  AND b.status = 'active'
  AND (a.metadata->>'evolution_cooldown_until' IS NULL
       OR (a.metadata->>'evolution_cooldown_until')::timestamptz < NOW())
  AND (b.metadata->>'evolution_cooldown_until' IS NULL
       OR (b.metadata->>'evolution_cooldown_until')::timestamptz < NOW())
ORDER BY cosine DESC
LIMIT 10;
```

### A.5 conflictDetect (source drafts)

```sql
SELECT id, company_id, target_node_id, proposed_title, detected_conflicts
FROM knowledge_drafts
WHERE company_id = $1
  AND status = 'pending'
  AND detected_conflicts IS NOT NULL
  AND array_length(detected_conflicts, 1) >= 1
ORDER BY created_at ASC
LIMIT 50;
```

And the edge upsert per pair:

```sql
INSERT INTO knowledge_edges (from_node_id, to_node_id, edge_type, auto_generated, metadata)
VALUES ($1, $2, 'conflicts_with', true, jsonb_build_object('source_draft', $3))
ON CONFLICT (from_node_id, to_node_id, edge_type) DO NOTHING;
```

And the post-process clear:

```sql
UPDATE knowledge_drafts SET detected_conflicts = '{}' WHERE id = $1;
```

### A.6 patternEmergence (group discovery)

```sql
SELECT used_for, business_domain_id, COUNT(*) AS lesson_count
FROM knowledge_nodes
WHERE company_id = $1
  AND type = 'lesson'
  AND status = 'active'
  AND used_for IS NOT NULL
  AND business_domain_id IS NOT NULL
  AND (metadata->>'evolution_cooldown_until' IS NULL
       OR (metadata->>'evolution_cooldown_until')::timestamptz < NOW())
GROUP BY used_for, business_domain_id
HAVING COUNT(*) >= 5
ORDER BY lesson_count DESC
LIMIT 5;
```

And per-group pairwise cosine for graph construction:

```sql
SELECT a.id AS id_a, b.id AS id_b, 1 - (a.embedding <=> b.embedding) AS cosine
FROM knowledge_nodes a
JOIN knowledge_nodes b
  ON a.id < b.id
  AND a.company_id = b.company_id
  AND 1 - (a.embedding <=> b.embedding) >= 0.7
WHERE a.company_id = $1
  AND a.type = 'lesson'
  AND a.status = 'active'
  AND a.used_for = $2
  AND a.business_domain_id = $3
  AND b.type = 'lesson'
  AND b.status = 'active'
  AND b.used_for = $2
  AND b.business_domain_id = $3
  AND (a.metadata->>'evolution_cooldown_until' IS NULL
       OR (a.metadata->>'evolution_cooldown_until')::timestamptz < NOW())
  AND (b.metadata->>'evolution_cooldown_until' IS NULL
       OR (b.metadata->>'evolution_cooldown_until')::timestamptz < NOW());
```

---

## Appendix B: LLM Prompt Drafts

### B.1 Pattern Emergence System Prompt

```
你是 Paperclip LLM-Wiki 的 Curator,负责从一批 lesson 节点中提炼共性模式。

输入: 同 used_for + business_domain 下的 N 条相似 lesson (N >= 5)。

任务: 判断它们是否反映出一个可复用的"模式 / 理论 / 规律",并产出 concept 节点 draft。

输出严格 JSON,二选一:

A) 存在共性模式:
{
  "pattern_name": "≤ 30 字简洁中文模式名",
  "pattern_summary": "≤ 200 字模式描述,讲清适用情景 + 核心建议",
  "pattern_conditions": ["触发条件 1 (≤ 20 字)", "触发条件 2", ...],
  "source_lesson_ids": ["uuid 1", "uuid 2", ...]
}

B) 无明显共性 (lessons 主题分散,强行抽象会产生空洞 concept):
{
  "no_pattern": true,
  "reason": "≤ 100 字说明为什么不应抽象"
}

判定标准:
- pattern_summary 必须能让一个**没看过原 lesson** 的人也能套用
- pattern_conditions 必须可机械判断 (不能是"看情况"这种空话)
- 若 lessons 之间只是表面相似 (同关键词 / 同领域 / 同时间) 但实质各管各的事,选 B
- 若 pattern_summary 写下来感觉像在重复其中一两条 lesson,而非提炼共性,选 B

只输出 JSON,不要 markdown 围栏,不要解释。
```

### B.2 (Reserved) Merge Proposal Body Generation

For v0.1: not used (Issue body is plain template). Reserved for v0.2 if maintainers want LLM-generated merge body text.

### B.3 (Reserved) Conflict Adjudication

For v0.1: not used (`conflict_detect` is materialization-only per Decision C). Reserved for v0.2 active-rule scan extension.

---

## Implementation Order Summary

| Task | Behavior(s) | LLM? | Issue? | Complexity | Dependencies |
|---|---|---|---|---|---|
| 1 | shared validators | — | — | 🟢 trivial | — |
| 2 | decayScan (FR6 #2) | no | no | 🟢 simple | Task 1 |
| 3 | promotionCheck + freshnessAudit (FR6 #1 + #5) | no | yes | 🟡 medium (Issue helper) | Task 2 |
| 4 | mergeCandidateDetect (FR6 #3) | no (v0.1) | yes | 🟡 medium (pgvector) | Task 3 |
| 5 | conflictDetect (FR6 #4) | no | yes | 🟡 medium (edge upsert) | Task 3 |
| 6 | patternEmergence (FR6 #6) | **yes** | no (creates draft) | 🔴 complex | Task 4 (union-find) |
| 7 | runEvolution + REST route | — | — | 🟡 medium (aggregation) | Tasks 2-6 |
| 8 | weekly scheduler + app.ts wire | — | — | 🟢 simple (mirror 3c) | Task 7 |
| 9 | smoke checklist doc | — | — | 🟢 simple | All |

Suggested session split:
- **Session 1** (this one): plan only, ready for review
- **Session 2**: Tasks 1 + 2 (validators + decayScan)
- **Session 3**: Tasks 3 + 4 (promotion / freshness / merge)
- **Session 4**: Task 5 (conflict)
- **Session 5**: Task 6 (pattern — most complex)
- **Session 6**: Tasks 7 + 8 + 9 (aggregator + route + scheduler + smoke)

Total estimated effort: 1-2 weeks at ~1 session per day.

---

## Phase 3 Completion Bar

After this Phase 3a plan + the merged Phase 3b + Phase 3c work, PRD §15 Phase 3 acceptance (line 1158-1164) is fully satisfied:

- ✅ Reviewer Agent screens all pending drafts (Phase 3b — in master)
- ✅ Daily healthcheck + 6 metrics + alarm Issue (Phase 3c — PR #2)
- ✅ Curator-style 6 evolution behaviors run weekly (this Phase 3a PR)
- ✅ Evolution-produced Issues created (Phase 3a)
- ✅ Modules涌现: ≥ 5 同主题 lesson → concept draft (Phase 3a Task 6)
- ✅ Outdated 节点不进搜索 (Phase 2a already enforces include_outdated)
- ⚠️ Curator Agent entity not yet created — Phase 3a explicitly opts out (decision A) and leaves Issue assignee=null for follow-up

PRD Phase 3 closes after Phase 3a Tasks 1-9 land + the Phase 1-3 acceptance smoke runs green. Phase 4 (Web UI) and Phase 5+ (external sources / MCP / graph viz) are independent and can start in parallel.
