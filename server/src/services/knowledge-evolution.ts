import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { LlmWikiService } from "./llm-wiki.js";
import type { KnowledgeRetrieverService } from "./knowledge-retriever.js";
import type { IssueServiceLike } from "./knowledge-healthcheck.js";

/**
 * Phase 3a 演化引擎 (PRD §FR6 + §13.3 Routine 1 weekly-knowledge-evolution).
 *
 * 6 行为按 PRD §13.3 顺序串行: promotionCheck → decayScan →
 * mergeCandidateDetect → conflictDetect → freshnessAudit → patternEmergence.
 *
 * 当前 commit 范围 (Task 2): 服务工厂骨架 + decayScan (最简单, 纯 SQL,
 * 无 LLM, 无 Issue). Tasks 3-6 将逐条 append 其他 5 个方法; Task 7 加
 * runEvolution 聚合器 + REST 路由; Task 8 加 weekly scheduler.
 *
 * Maintainer decisions (recorded for in-code reference; details in plan
 * file docs/plans/2026-05-14-llm-wiki-phase-3a-evolution.md):
 * - A: Curator Agent not created in v0.1; all proposal Issues use both
 *      assigneeAgentId=null and assigneeUserId=null and rely on existing
 *      board triage flow.
 * - B: pattern-emergence uses cosine threshold graph + in-memory
 *      union-find connected-components, no external clustering deps.
 * - C: conflict-detect materializes Phase 3b detected_conflicts only;
 *      no independent active-rule scan in v0.1.
 * - D: single service factory exposing 6 methods (this file), not
 *      6 separate service files.
 *
 * v0.2 schema-truth notes (from partial smoke 2026-05-14):
 * - issueSvc.create(companyId, { title, description, status, priority })
 *   — positional companyId; no `labels` or `metadata` in data object
 *   (issues table has neither column).
 * - Per-behavior dedup lives on knowledge_nodes.metadata
 *   .last_<behavior>_proposal_at ISO timestamp + cooldownDays cooldown,
 *   NOT on issues.metadata.subject_node_id (column does not exist).
 * - Visual category is title prefix `[Evolution:<behavior>]`, not
 *   issue labels.
 *
 * No node mutation happens without human approval. Proposals go through
 * the existing draft / Issue review pipeline; decay-archive is the only
 * direct UPDATE and it merely flips status (no data loss; reversible by
 * setting status back to 'active').
 */

/**
 * Per-behavior tuning constants — controls LLM cost in weekly tick + dedup
 * cooldown windows. Each entry is exported so smoke checklists and tests
 * can reference the same source-of-truth without literal duplication.
 *
 * Cooldown semantics:
 * - cooldownDays: minimum interval between two proposal Issues against
 *   the same source node for this behavior. Default 7 matches the
 *   weekly tick (so on the *next* tick the node can re-propose if its
 *   stats are still triggering).
 * - pattern_emergence.cooldownDays is longer (30) because a failed
 *   pattern extraction should NOT retry on every weekly tick — the
 *   LLM has already said "no pattern", retrying without new data is
 *   waste.
 */
export const BEHAVIOR_LIMITS = {
  promotion_check: {
    triggerCountMin: 3,
    preventionScoreMin: 0.7,
    cooldownDays: 7,
  },
  decay_scan: {
    idleDays: 180,
    // No cooldown — decayScan does not create proposal Issues; it just
    // flips status active → archived (reversible by board operator).
  },
  merge_candidate_detect: {
    topPairs: 10,
    cosineThreshold: 0.9,
    cooldownDays: 7,
  },
  conflict_detect: {
    // No tunable limit — processes all drafts with non-empty
    // detected_conflicts (populated by Phase 3b reviewer). No cooldown
    // needed because the array is cleared after processing.
    maxDraftsPerTick: 50,
  },
  freshness_audit: {
    validUntilWindowDays: 7,
    fastVerifyWindowDays: 90,
    slowVerifyWindowDays: 365,
    cooldownDays: 7,
  },
  pattern_emergence: {
    topClusters: 5,
    cosineThreshold: 0.7,
    minClusterSize: 5,
    cooldownDays: 30,
  },
} as const;

/** Standard return shape for each behavior method. */
export interface BehaviorResult {
  /** Matches one of KNOWLEDGE_EVOLUTION_BEHAVIORS (kebab→snake mapping). */
  behavior: string;
  /** How many rows the SQL trigger query matched before any side effect. */
  candidatesFound: number;
  /** Net new Issues created by this behavior (excludes dedup-skipped). */
  issuesCreated: number;
  /** Net new knowledge_drafts created (only pattern_emergence in MVP). */
  draftsCreated: number;
  /** Net new knowledge_edges created (only conflict_detect in MVP). */
  edgesCreated: number;
  /** Net knowledge_nodes whose status/metadata changed. */
  nodesModified: number;
  /** Non-fatal per-item errors; single item failure does not abort the run. */
  errors: Array<{ subject: string; reason: string }>;
  /** Behavior-specific drill-down data (threshold values, top candidates, etc). */
  details: Record<string, unknown>;
}

/** Aggregate result returned by runEvolution (Task 7 — not yet exposed). */
export interface RunEvolutionResult {
  behaviorsRun: number;
  issuesCreated: number;
  draftsCreated: number;
  nodesModified: number;
  perBehavior: BehaviorResult[];
}

export function knowledgeEvolutionService(
  db: Db,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _llm: LlmWikiService,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _retriever: KnowledgeRetrieverService,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _issueSvc: IssueServiceLike | null,
) {
  // The unused-prefixed params are wired into the factory now so subsequent
  // Task 3-6 commits can add methods that consume them without changing the
  // factory signature (and therefore without changing the call sites in
  // routes/knowledge.ts and app.ts that Tasks 7-8 will set up).

  // ──────────────────────────────────────────────────────────────────
  // Behavior #2 — decayScan (PRD §FR6 row 2)
  //
  // Trigger: status='active' AND (last_triggered IS NULL OR
  //           NOW() - last_triggered > 180d)
  // Effect:  status = 'archived' + INSERT knowledge_node_events row
  //          with event_type='archived', metadata.reason='auto_decay'.
  // No Issue creation (decay is reversible + high-volume; surfacing
  // every archive as an Issue would spam the board).
  // ──────────────────────────────────────────────────────────────────
  async function decayScan(companyId: string): Promise<BehaviorResult> {
    const t = BEHAVIOR_LIMITS.decay_scan;
    // Single CTE: archive matching rows, return their ids, then insert
    // an audit event per archived row in the same statement.
    const rows = (await db.execute(sql`
      WITH archived AS (
        UPDATE knowledge_nodes
        SET status = 'archived', updated_at = NOW()
        WHERE company_id = ${companyId}
          AND status = 'active'
          AND (last_triggered IS NULL
               OR last_triggered < NOW() - (${String(t.idleDays)} || ' days')::INTERVAL)
        RETURNING id
      )
      INSERT INTO knowledge_node_events (node_id, event_type, metadata, created_at)
      SELECT
        id,
        'archived',
        jsonb_build_object('reason', 'auto_decay', 'idle_days', ${t.idleDays}::int),
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
    /**
     * Internal methods exposed for unit tests. Task 7's runEvolution
     * aggregator will expose a public runEvolution(companyId, opts?)
     * entry point; the __test__ namespace stays for direct per-behavior
     * verification.
     */
    __test__: {
      decayScan,
    },
  };
}

export type KnowledgeEvolutionService = ReturnType<
  typeof knowledgeEvolutionService
>;
