import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
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
  issueSvc: IssueServiceLike | null,
) {
  // _llm + _retriever remain unused until Tasks 4 + 6 (merge / pattern_emergence).
  // issueSvc is now consumed by promotionCheck + freshnessAudit (Task 3) and
  // will be reused by mergeCandidateDetect + conflictDetect + patternEmergence.

  // ──────────────────────────────────────────────────────────────────
  // Internal helpers (shared by behaviors that propose via Issue)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Create an Issue with the v0.2-correct issueSvc.create signature
   * (positional companyId; no `labels`, no `metadata` data fields).
   * Returns the new Issue's id on success; returns null and logs a
   * warning if issueSvc is unavailable or create() throws.
   * Caller decides whether null is a soft skip or a counted error.
   */
  async function proposeViaIssue(
    companyId: string,
    titlePrefix: string,
    title: string,
    body: string,
  ): Promise<string | null> {
    if (!issueSvc) {
      logger.warn(
        { companyId, titlePrefix },
        "evolution: issueSvc unavailable, Issue not created",
      );
      return null;
    }
    try {
      const issue = await issueSvc.create(companyId, {
        title: `${titlePrefix} ${title}`,
        description: body,
        status: "todo",
        priority: "medium",
      });
      return issue.id;
    } catch (err) {
      logger.warn(
        { err, companyId, titlePrefix },
        "evolution: Issue creation failed",
      );
      return null;
    }
  }

  /**
   * After a successful proposal Issue creation, record the dedup marker
   * on the source node + write an audit event. Both mutations land in a
   * single CTE statement so callers only issue one db.execute per
   * successful proposal (matches decayScan's single-statement pattern;
   * keeps test mocking simple).
   *
   * v0.2 dedup strategy: writes to knowledge_nodes.metadata, NOT to
   * issues.metadata (which does not exist in this fork's schema).
   */
  async function recordProposalSuccess(params: {
    nodeId: string;
    proposalAtKey: string; // e.g. 'last_promotion_proposal_at'
    issueIdKey: string; // e.g. 'last_promotion_issue_id'
    issueId: string;
    eventType: string; // e.g. 'promoted' / 'verification_requested'
  }): Promise<void> {
    await db.execute(sql`
      WITH up AS (
        UPDATE knowledge_nodes
        SET metadata = metadata || jsonb_build_object(
          ${params.proposalAtKey}::text, NOW()::text,
          ${params.issueIdKey}::text, ${params.issueId}::text
        )
        WHERE id = ${params.nodeId}::uuid
        RETURNING id
      )
      INSERT INTO knowledge_node_events (node_id, event_type, metadata, created_at)
      SELECT id, ${params.eventType}::text,
             jsonb_build_object('proposed', true, 'issue_id', ${params.issueId}::text),
             NOW()
      FROM up
    `);
  }

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

  // ──────────────────────────────────────────────────────────────────
  // Behavior #1 — promotionCheck (PRD §FR6 row 1)
  //
  // Trigger: type='lesson' AND status='active'
  //          AND trigger_count >= 3 AND prevention_score >= 0.7
  //          AND NOT in cooldown (per-node metadata, 7-day default).
  // Effect:  for each candidate, create a proposal Issue
  //          "[Evolution:promotion] 建议升级为 rule: {title}".
  //          On Issue success: write knowledge_nodes.metadata
  //          .last_promotion_proposal_at + last_promotion_issue_id +
  //          an audit event with event_type='promoted', proposed=true.
  //          NOT a direct type change — human approves the Issue to
  //          flip type lesson→rule (Phase 4 UI / manual route call).
  // ──────────────────────────────────────────────────────────────────
  async function promotionCheck(companyId: string): Promise<BehaviorResult> {
    const t = BEHAVIOR_LIMITS.promotion_check;
    const candidates = (await db.execute(sql`
      SELECT id, title, type, trigger_count, prevention_score
      FROM knowledge_nodes
      WHERE company_id = ${companyId}
        AND type = 'lesson'
        AND status = 'active'
        AND trigger_count >= ${t.triggerCountMin}::int
        AND prevention_score >= ${t.preventionScoreMin}::numeric
        AND (metadata->>'evolution_cooldown_until' IS NULL
             OR (metadata->>'evolution_cooldown_until')::timestamptz < NOW())
        AND (metadata->>'last_promotion_proposal_at' IS NULL
             OR (metadata->>'last_promotion_proposal_at')::timestamptz
                  < NOW() - (${String(t.cooldownDays)} || ' days')::INTERVAL)
      ORDER BY prevention_score DESC, trigger_count DESC
      LIMIT 50
    `)) as Array<{
      id: string;
      title: string;
      type: string;
      trigger_count: number;
      prevention_score: number;
    }>;

    let issuesCreated = 0;
    const errors: Array<{ subject: string; reason: string }> = [];

    for (const c of candidates) {
      const body = [
        `Node id: ${c.id}`,
        `当前 type: ${c.type}`,
        `trigger_count: ${c.trigger_count} (≥ ${t.triggerCountMin})`,
        `prevention_score: ${c.prevention_score} (≥ ${t.preventionScoreMin})`,
        ``,
        `请人审决定是否升级为 rule。通过后类型将改为 rule + 添加 derived_from 边。`,
      ].join("\n");
      const issueId = await proposeViaIssue(
        companyId,
        "[Evolution:promotion]",
        `建议升级为 rule: ${c.title}`,
        body,
      );
      if (issueId === null) {
        errors.push({ subject: c.id, reason: "issue_create_failed_or_unavailable" });
        continue;
      }
      try {
        await recordProposalSuccess({
          nodeId: c.id,
          proposalAtKey: "last_promotion_proposal_at",
          issueIdKey: "last_promotion_issue_id",
          issueId,
          eventType: "promoted",
        });
        issuesCreated += 1;
      } catch (err) {
        errors.push({
          subject: c.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      behavior: "promotion_check",
      candidatesFound: candidates.length,
      issuesCreated,
      draftsCreated: 0,
      edgesCreated: 0,
      nodesModified: issuesCreated,
      errors,
      details: {
        trigger_count_min: t.triggerCountMin,
        prevention_score_min: t.preventionScoreMin,
        cooldown_days: t.cooldownDays,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Behavior #3 — mergeCandidateDetect (PRD §FR6 row 3)
  //
  // Trigger: any two active nodes in the same company with cosine
  //          similarity ≥ 0.9 (== pgvector distance `<=>` < 0.1),
  //          top 10 by similarity, neither node in 7-day cooldown.
  // Effect:  per pair, create "[Evolution:merge] 建议合并 [A] 与 [B]"
  //          Issue. On success: update BOTH nodes' metadata —
  //            last_merge_proposal_at = NOW
  //            last_merge_issue_id    = <issue id>
  //            last_merge_pair_keys  += "{a.id}:{b.id}"  (sorted)
  //          + write 2 audit events (one per node), event_type=
  //          'merge_proposed', metadata.pair_key set.
  //          NO direct node mutation — human approves the Issue to
  //          materialize a new node + merged_from edges (out of scope).
  //
  // Performance: pgvector `<=>` operator uses the HNSW index
  // `knowledge_nodes_embedding_idx` (vector_cosine_ops, m=16,
  // ef_construction=200). For ≤1000 nodes/company the join with
  // `<=> < 0.1` filter typically yields ≤ 100 raw candidates; the
  // ORDER BY cosine DESC + LIMIT keeps wire size bounded.
  //
  // Dedup (v0.2 strategy):
  //   1. cooldown filter: skip if either node's last_merge_proposal_at
  //      is within `cooldownDays` (default 7)
  //   2. pair-key filter: skip if either node's last_merge_pair_keys
  //      array already contains "{id_a}:{id_b}"  (so re-proposing the
  //      same pair after cooldown is possible IF the prior pair was
  //      explicitly cleared, but in MVP we just dedup on pair_key
  //      perpetually — board operator can manually clear if needed)
  // ──────────────────────────────────────────────────────────────────
  async function mergeCandidateDetect(
    companyId: string,
  ): Promise<BehaviorResult> {
    const t = BEHAVIOR_LIMITS.merge_candidate_detect;
    // pgvector `<=>` returns cosine **distance** in [0, 2]
    // (0 = identical, 1 = orthogonal, 2 = opposite).
    // cosine **similarity** = 1 - distance.
    // We translate the maintainer-set cosine threshold (0.9) into a
    // distance ceiling (0.1) for the WHERE clause so the HNSW index
    // can use the operator predicate, then re-compute similarity in
    // the projection for human-readable Issue body + ORDER BY.
    const distanceCeiling = 1 - t.cosineThreshold;

    const candidates = (await db.execute(sql`
      WITH pairs AS (
        SELECT
          a.id AS id_a, b.id AS id_b,
          a.title AS title_a, b.title AS title_b,
          a.type AS type_a, b.type AS type_b,
          a.metadata AS metadata_a, b.metadata AS metadata_b,
          1 - (a.embedding <=> b.embedding) AS cosine
        FROM knowledge_nodes a
        JOIN knowledge_nodes b
          ON a.id < b.id
          AND a.company_id = b.company_id
          AND a.embedding <=> b.embedding < ${String(distanceCeiling)}::float
        WHERE a.company_id = ${companyId}
          AND a.status = 'active'
          AND b.status = 'active'
          AND (a.metadata->>'last_merge_proposal_at' IS NULL
               OR (a.metadata->>'last_merge_proposal_at')::timestamptz
                    < NOW() - (${String(t.cooldownDays)} || ' days')::INTERVAL)
          AND (b.metadata->>'last_merge_proposal_at' IS NULL
               OR (b.metadata->>'last_merge_proposal_at')::timestamptz
                    < NOW() - (${String(t.cooldownDays)} || ' days')::INTERVAL)
      )
      SELECT id_a, id_b, title_a, title_b, type_a, type_b, cosine
      FROM pairs
      WHERE NOT (
        COALESCE(metadata_a->'last_merge_pair_keys', '[]'::jsonb)
          ? (id_a::text || ':' || id_b::text)
        OR COALESCE(metadata_b->'last_merge_pair_keys', '[]'::jsonb)
          ? (id_a::text || ':' || id_b::text)
      )
      ORDER BY cosine DESC
      LIMIT ${t.topPairs}::int
    `)) as Array<{
      id_a: string;
      id_b: string;
      title_a: string;
      title_b: string;
      type_a: string;
      type_b: string;
      cosine: number | string;
    }>;

    let issuesCreated = 0;
    const errors: Array<{ subject: string; reason: string }> = [];

    for (const p of candidates) {
      const cosine = Number(p.cosine);
      // a.id < b.id is guaranteed in the JOIN ⇒ pair_key is already
      // in sorted lexicographic order. Stored as text for jsonb
      // array membership lookup via `?` operator.
      const pairKey = `${p.id_a}:${p.id_b}`;
      const body = [
        `Pair key: ${pairKey}`,
        `cosine 相似度: ${cosine.toFixed(3)} (≥ ${t.cosineThreshold})`,
        ``,
        `Node A:`,
        `- id: ${p.id_a}`,
        `- title: ${p.title_a}`,
        `- type: ${p.type_a}`,
        ``,
        `Node B:`,
        `- id: ${p.id_b}`,
        `- title: ${p.title_b}`,
        `- type: ${p.type_b}`,
        ``,
        `请人审决定是否合并。通过后:`,
        `1. 创建新节点继承两者内容`,
        `2. 添加 merged_from 边从新节点指向 A 与 B`,
        `3. 把 A 和 B status 改为 archived`,
      ].join("\n");

      const issueId = await proposeViaIssue(
        companyId,
        "[Evolution:merge]",
        `建议合并 [${p.title_a}] 与 [${p.title_b}]`,
        body,
      );
      if (issueId === null) {
        errors.push({
          subject: pairKey,
          reason: "issue_create_failed_or_unavailable",
        });
        continue;
      }

      try {
        // Single CTE: update both nodes' metadata in one UPDATE
        // (uses IN-clause), then INSERT 2 audit events from the
        // RETURNING list. Atomic per pair.
        await db.execute(sql`
          WITH up AS (
            UPDATE knowledge_nodes
            SET metadata = metadata
              || jsonb_build_object(
                'last_merge_proposal_at', NOW()::text,
                'last_merge_issue_id', ${issueId}::text
              )
              || jsonb_build_object(
                'last_merge_pair_keys',
                COALESCE(metadata->'last_merge_pair_keys', '[]'::jsonb)
                  || to_jsonb(ARRAY[${pairKey}::text])
              )
            WHERE id IN (${p.id_a}::uuid, ${p.id_b}::uuid)
              AND company_id = ${companyId}::uuid
            RETURNING id
          )
          INSERT INTO knowledge_node_events
            (node_id, event_type, metadata, created_at)
          SELECT
            id,
            'merge_proposed',
            jsonb_build_object(
              'proposed', true,
              'issue_id', ${issueId}::text,
              'pair_key', ${pairKey}::text
            ),
            NOW()
          FROM up
        `);
        issuesCreated += 1;
      } catch (err) {
        errors.push({
          subject: pairKey,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      behavior: "merge_candidate_detect",
      candidatesFound: candidates.length,
      issuesCreated,
      draftsCreated: 0,
      edgesCreated: 0,
      // Each successful proposal touches 2 nodes (id_a + id_b metadata).
      nodesModified: issuesCreated * 2,
      errors,
      details: {
        cosine_threshold: t.cosineThreshold,
        top_pairs_limit: t.topPairs,
        cooldown_days: t.cooldownDays,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Behavior #5 — freshnessAudit (PRD §FR6 row 5)
  //
  // 3-way UNION ALL: (a) valid_until 临近 7 天 / (b) volatility=fast
  // 90 天未验证 / (c) volatility=slow 365 天未验证.
  // Per matched row, create "[Evolution:freshness] 请验证 [节点]" Issue.
  // On success: record proposal marker on node metadata + write event
  // event_type='verification_requested'. Does NOT touch verified_at —
  // that's the human reviewer's job after they actually verify.
  // ──────────────────────────────────────────────────────────────────
  async function freshnessAudit(companyId: string): Promise<BehaviorResult> {
    const t = BEHAVIOR_LIMITS.freshness_audit;
    const candidates = (await db.execute(sql`
      (
        SELECT id, title, 'expiring_validity'::text AS reason,
               valid_until, verified_at, volatility
        FROM knowledge_nodes
        WHERE company_id = ${companyId}
          AND status = 'active'
          AND valid_until IS NOT NULL
          AND valid_until BETWEEN NOW()
               AND NOW() + (${String(t.validUntilWindowDays)} || ' days')::INTERVAL
          AND (metadata->>'last_freshness_proposal_at' IS NULL
               OR (metadata->>'last_freshness_proposal_at')::timestamptz
                    < NOW() - (${String(t.cooldownDays)} || ' days')::INTERVAL)
      )
      UNION ALL
      (
        SELECT id, title, 'fast_stale'::text AS reason,
               valid_until, verified_at, volatility
        FROM knowledge_nodes
        WHERE company_id = ${companyId}
          AND status = 'active'
          AND volatility = 'fast'
          AND (verified_at IS NULL
               OR verified_at < NOW() - (${String(t.fastVerifyWindowDays)} || ' days')::INTERVAL)
          AND (metadata->>'last_freshness_proposal_at' IS NULL
               OR (metadata->>'last_freshness_proposal_at')::timestamptz
                    < NOW() - (${String(t.cooldownDays)} || ' days')::INTERVAL)
      )
      UNION ALL
      (
        SELECT id, title, 'slow_stale'::text AS reason,
               valid_until, verified_at, volatility
        FROM knowledge_nodes
        WHERE company_id = ${companyId}
          AND status = 'active'
          AND volatility = 'slow'
          AND (verified_at IS NULL
               OR verified_at < NOW() - (${String(t.slowVerifyWindowDays)} || ' days')::INTERVAL)
          AND (metadata->>'last_freshness_proposal_at' IS NULL
               OR (metadata->>'last_freshness_proposal_at')::timestamptz
                    < NOW() - (${String(t.cooldownDays)} || ' days')::INTERVAL)
      )
      ORDER BY reason, id
      LIMIT 100
    `)) as Array<{
      id: string;
      title: string;
      reason: string;
      valid_until: Date | string | null;
      verified_at: Date | string | null;
      volatility: string;
    }>;

    let issuesCreated = 0;
    const errors: Array<{ subject: string; reason: string }> = [];
    const reasonCounts: Record<string, number> = {
      expiring_validity: 0,
      fast_stale: 0,
      slow_stale: 0,
    };

    for (const c of candidates) {
      reasonCounts[c.reason] = (reasonCounts[c.reason] ?? 0) + 1;
      const body = [
        `Node id: ${c.id}`,
        `volatility: ${c.volatility}`,
        `verified_at: ${c.verified_at ?? "(never)"}`,
        `valid_until: ${c.valid_until ?? "(none)"}`,
        `Reason: ${c.reason}`,
        ``,
        `请人审验证该节点的内容仍然准确。验证后将 verified_at 设为当前时间。`,
      ].join("\n");
      const issueId = await proposeViaIssue(
        companyId,
        "[Evolution:freshness]",
        `请验证: ${c.title}`,
        body,
      );
      if (issueId === null) {
        errors.push({ subject: c.id, reason: "issue_create_failed_or_unavailable" });
        continue;
      }
      try {
        await recordProposalSuccess({
          nodeId: c.id,
          proposalAtKey: "last_freshness_proposal_at",
          issueIdKey: "last_freshness_issue_id",
          issueId,
          eventType: "verification_requested",
        });
        issuesCreated += 1;
      } catch (err) {
        errors.push({
          subject: c.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      behavior: "freshness_audit",
      candidatesFound: candidates.length,
      issuesCreated,
      draftsCreated: 0,
      edgesCreated: 0,
      nodesModified: issuesCreated,
      errors,
      details: {
        valid_until_window_days: t.validUntilWindowDays,
        fast_verify_window_days: t.fastVerifyWindowDays,
        slow_verify_window_days: t.slowVerifyWindowDays,
        cooldown_days: t.cooldownDays,
        reason_counts: reasonCounts,
      },
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
      promotionCheck,
      freshnessAudit,
      mergeCandidateDetect,
    },
  };
}

export type KnowledgeEvolutionService = ReturnType<
  typeof knowledgeEvolutionService
>;
