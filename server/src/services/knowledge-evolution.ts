import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { LlmWikiService } from "./llm-wiki.js";
import type { KnowledgeRetrieverService } from "./knowledge-retriever.js";
import type { IssueServiceLike } from "./knowledge-healthcheck.js";
import type { knowledgeDraftService } from "./knowledge-drafts.js";

/**
 * Minimal interface Phase 3a needs from knowledgeDraftService.create.
 * Same Pick<...> pattern as IssueServiceLike (Phase 3c). Avoids coupling
 * Phase 3a to all of Phase 1a's draft service surface while still letting
 * TypeScript derive the exact CreateKnowledgeDraftInput shape.
 */
export type DraftServiceLike = Pick<
  ReturnType<typeof knowledgeDraftService>,
  "create"
>;

/**
 * Behavior identifiers in PRD §13.3 Routine 1 declaration order.
 * Source-of-truth for runEvolution's default iteration order.
 * Mirrors the @paperclipai/shared KNOWLEDGE_EVOLUTION_BEHAVIORS tuple
 * (kept local to avoid an import cycle through the route layer).
 */
export const KNOWLEDGE_EVOLUTION_BEHAVIORS_ORDER = [
  "promotion_check",
  "decay_scan",
  "merge_candidate_detect",
  "conflict_detect",
  "freshness_audit",
  "pattern_emergence",
] as const;

export type KnowledgeEvolutionBehavior =
  (typeof KNOWLEDGE_EVOLUTION_BEHAVIORS_ORDER)[number];

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

/**
 * Union-find connected-components helper used by pattern_emergence
 * (PRD §FR6 row 6). Exported for direct testing — proves the graph
 * algorithm is correct independent of the SQL / LLM machinery around it.
 *
 * Per maintainer decision B (PR #3 plan v0.2): zero external clustering
 * dependency. Each pair of lessons with cosine ≥ threshold becomes a
 * graph edge; union-find finds connected components in O(α(n) * |E|);
 * components with size ≥ minClusterSize move on to LLM extraction.
 */
export function unionFindClusters(
  allIds: string[],
  edges: Array<{ a: string; b: string }>,
): string[][] {
  const parent = new Map<string, string>();
  for (const id of allIds) parent.set(id, id);

  function find(x: string): string {
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

  for (const { a, b } of edges) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const buckets = new Map<string, string[]>();
  for (const id of allIds) {
    const root = find(id);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root)!.push(id);
  }
  return Array.from(buckets.values());
}

/**
 * LLM system prompt for pattern emergence extraction.
 * Exported so the route layer (Task 7) + smoke checklist (Task 9)
 * + tests can reference the exact same prompt without literal copy-paste.
 *
 * Output contract is strict JSON, two-branch (pattern found vs no_pattern).
 * v0.1 confidence: 0.6 baseline because patterns are derived, not direct
 * observations; Phase 3b reviewer can promote to higher confidence after
 * human approval.
 */
export const PATTERN_EMERGENCE_SYSTEM_PROMPT =
  `你是 Paperclip LLM-Wiki 的 Curator,负责从一批 lesson 节点中提炼共性模式。

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

只输出 JSON,不要 markdown 围栏,不要解释。`.trim();

/** Maximum chars of lesson content sent to LLM (per lesson). */
const LESSON_CONTENT_EXCERPT_CHARS = 500;
/** Cap on lessons per cluster sent to LLM (defensive). */
const LESSON_PROMPT_BATCH_CAP = 20;

export function knowledgeEvolutionService(
  db: Db,
  llm: LlmWikiService,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _retriever: KnowledgeRetrieverService,
  issueSvc: IssueServiceLike | null,
  draftSvc: DraftServiceLike | null = null,
) {
  // _retriever remains unused until Tasks 7+ (runEvolution / future routing).
  // llm is consumed by patternEmergence (Task 6).
  // issueSvc consumed by promotionCheck / freshnessAudit / mergeCandidateDetect /
  //   conflictDetect.
  // draftSvc consumed by patternEmergence (Task 6) to create concept drafts.

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
  // Behavior #4 — conflictDetect (PRD §FR6 row 4) — v0.1 Decision C
  //
  // Strategy: materialize Phase 3b-detected conflicts. The Reviewer
  // Agent (Phase 3b) already runs LLM on every pending draft and
  // writes detected_conflicts UUID[] when it finds duplicates. This
  // behavior turns that flagged data into:
  //   1. conflicts_with edges (when draft has target_node_id set)
  //   2. proposal Issues per (draft, conflict_node) pair
  //   3. array clear on the source draft so next tick won't reprocess
  //
  // No LLM in v0.1 — Phase 3b already paid that cost. Duplicate
  // detection (cosine vs LLM) is wasted compute. v0.2 may add an
  // independent active-rule-pair scan, but PRD §FR6 row 4 originally
  // says "新 draft 与既有 rule" which is exactly the draft-rule
  // scenario Phase 3b handles.
  //
  // Dedup: ON CONFLICT (from, to, edge_type) DO NOTHING on the
  // knowledge_edges_unique_directed index. If the edge already exists
  // we skip the Issue too (so re-running with same conflicts is a
  // no-op except for the array clear).
  // ──────────────────────────────────────────────────────────────────
  async function conflictDetect(companyId: string): Promise<BehaviorResult> {
    const t = BEHAVIOR_LIMITS.conflict_detect;

    // 1. Flatten (draft × conflict_node) pairs via LATERAL unnest.
    //    LEFT JOIN knowledge_nodes to surface conflict_node's title
    //    in the Issue body (NULL if the conflict node was deleted).
    const pairs = (await db.execute(sql`
      WITH limited_drafts AS (
        SELECT id, company_id, target_node_id, proposed_title, detected_conflicts
        FROM knowledge_drafts
        WHERE company_id = ${companyId}
          AND status = 'pending'
          AND detected_conflicts IS NOT NULL
          AND array_length(detected_conflicts, 1) >= 1
        ORDER BY created_at ASC
        LIMIT ${t.maxDraftsPerTick}::int
      )
      SELECT
        d.id AS draft_id,
        d.target_node_id,
        d.proposed_title,
        conflict_id AS conflict_node_id,
        cn.title AS conflict_node_title
      FROM limited_drafts d
      CROSS JOIN LATERAL unnest(d.detected_conflicts) AS conflict_id
      LEFT JOIN knowledge_nodes cn
        ON cn.id = conflict_id AND cn.company_id = d.company_id
      ORDER BY d.id, conflict_id
    `)) as Array<{
      draft_id: string;
      target_node_id: string | null;
      proposed_title: string;
      conflict_node_id: string;
      conflict_node_title: string | null;
    }>;

    let issuesCreated = 0;
    let edgesCreated = 0;
    const errors: Array<{ subject: string; reason: string }> = [];
    const processedDrafts = new Set<string>();

    for (const p of pairs) {
      processedDrafts.add(p.draft_id);
      const subjectKey = `${p.draft_id}:${p.conflict_node_id}`;

      // 2a. If draft has a materialized target node, attempt the
      //     conflicts_with edge upsert. If the edge already existed
      //     (ON CONFLICT DO NOTHING returns empty), we treat that as
      //     "already proposed" and skip the Issue creation below.
      let edgeWasNew = false;
      if (p.target_node_id !== null) {
        try {
          const inserted = (await db.execute(sql`
            INSERT INTO knowledge_edges
              (from_node_id, to_node_id, edge_type, auto_generated, metadata)
            VALUES (
              ${p.target_node_id}::uuid,
              ${p.conflict_node_id}::uuid,
              'conflicts_with',
              true,
              jsonb_build_object('source_draft', ${p.draft_id}::text)
            )
            ON CONFLICT (from_node_id, to_node_id, edge_type) DO NOTHING
            RETURNING id
          `)) as Array<{ id: string }>;
          if (inserted.length > 0) {
            edgesCreated += 1;
            edgeWasNew = true;
          }
        } catch (err) {
          errors.push({
            subject: subjectKey,
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      // 2b. Issue creation rules:
      //     - target_node_id null (brand-new draft, no node yet)
      //       → always propose (no edge to dedup against)
      //     - target_node_id set AND edge was new
      //       → propose
      //     - target_node_id set AND edge already existed
      //       → skip (already-proposed dedup; clearing array below
      //         still happens so we don't reprocess on next tick)
      const shouldCreateIssue = p.target_node_id === null || edgeWasNew;
      if (!shouldCreateIssue) {
        continue;
      }

      const conflictDisplayName =
        p.conflict_node_title ?? `(节点 ${p.conflict_node_id})`;
      const body = [
        `Draft id: ${p.draft_id}`,
        `Draft 标题: ${p.proposed_title}`,
        `Draft target node: ${p.target_node_id ?? "(无,新提案,尚未物化)"}`,
        ``,
        `冲突节点 id: ${p.conflict_node_id}`,
        `冲突节点标题: ${conflictDisplayName}`,
        ``,
        p.target_node_id !== null
          ? `已在 knowledge_edges 表落 conflicts_with 边 (${p.target_node_id} → ${p.conflict_node_id}).`
          : `Draft 尚未物化为节点; 审查通过后再 materialize 边.`,
        ``,
        `请人审决定:`,
        `1. 接受 draft + 把冲突节点 status 改为 outdated`,
        `2. 拒绝 draft (保留冲突节点)`,
        `3. 合并 draft + conflict_node 形成新版本`,
      ].join("\n");

      const issueId = await proposeViaIssue(
        companyId,
        "[Evolution:conflict]",
        `冲突: [${p.proposed_title}] 与 [${conflictDisplayName}]`,
        body,
      );
      if (issueId === null) {
        errors.push({
          subject: subjectKey,
          reason: "issue_create_failed_or_unavailable",
        });
        continue;
      }
      issuesCreated += 1;
    }

    // 3. Clear detected_conflicts on every draft we processed (single
    //    UPDATE with id = ANY($1::uuid[]) covers all of them at once).
    //    Even drafts whose pairs all skipped due to edge dedup get
    //    cleared — the conflicts ARE already represented in the edge
    //    table; reprocessing on every tick is wasteful.
    if (processedDrafts.size > 0) {
      try {
        const draftIds = Array.from(processedDrafts);
        await db.execute(sql`
          UPDATE knowledge_drafts
          SET detected_conflicts = '{}'::uuid[]
          WHERE company_id = ${companyId}::uuid
            AND id = ANY(${draftIds}::uuid[])
        `);
      } catch (err) {
        errors.push({
          subject: "array_clear",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      behavior: "conflict_detect",
      candidatesFound: pairs.length,
      issuesCreated,
      draftsCreated: 0,
      edgesCreated,
      // conflictDetect mutates knowledge_drafts (clearing arrays) and
      // knowledge_edges (new edges), but not knowledge_nodes.
      nodesModified: 0,
      errors,
      details: {
        max_drafts_per_tick: t.maxDraftsPerTick,
        processed_drafts: processedDrafts.size,
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

  // ──────────────────────────────────────────────────────────────────
  // Public entry: runEvolution(companyId, opts?) — Task 7 aggregator
  //
  // Sequential per PRD §13.3 Routine 1 Action list order:
  //   promotion_check → decay_scan → merge_candidate_detect →
  //   conflict_detect → freshness_audit → pattern_emergence
  //
  // Single behavior failure does NOT abort the rest — the offending
  // behavior gets a synthetic BehaviorResult with errors[0] set.
  // ──────────────────────────────────────────────────────────────────
  async function runEvolution(
    companyId: string,
    opts?: { behaviors?: KnowledgeEvolutionBehavior[] },
  ): Promise<RunEvolutionResult> {
    const behaviors =
      opts?.behaviors ?? [...KNOWLEDGE_EVOLUTION_BEHAVIORS_ORDER];
    const dispatch: Record<
      KnowledgeEvolutionBehavior,
      () => Promise<BehaviorResult>
    > = {
      promotion_check: () => promotionCheck(companyId),
      decay_scan: () => decayScan(companyId),
      merge_candidate_detect: () => mergeCandidateDetect(companyId),
      conflict_detect: () => conflictDetect(companyId),
      freshness_audit: () => freshnessAudit(companyId),
      pattern_emergence: () => patternEmergence(companyId),
    };

    const perBehavior: BehaviorResult[] = [];
    for (const b of behaviors) {
      try {
        perBehavior.push(await dispatch[b]());
      } catch (err) {
        logger.warn(
          { err, behavior: b, companyId },
          "evolution: behavior threw, continuing with the rest",
        );
        perBehavior.push({
          behavior: b,
          candidatesFound: 0,
          issuesCreated: 0,
          draftsCreated: 0,
          edgesCreated: 0,
          nodesModified: 0,
          errors: [
            {
              subject: b,
              reason: err instanceof Error ? err.message : String(err),
            },
          ],
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

  return {
    runEvolution,
    /**
     * Internal methods exposed for unit tests. Routes / scheduler
     * use runEvolution() above.
     */
    __test__: {
      decayScan,
      promotionCheck,
      freshnessAudit,
      mergeCandidateDetect,
      conflictDetect,
      patternEmergence,
    },
  };

  // ──────────────────────────────────────────────────────────────────
  // Behavior #6 — patternEmergence (PRD §FR6 row 6) — most complex
  //
  // Pipeline:
  //   1. Discover (used_for, business_domain_id) groups with ≥ 5
  //      active lessons not in cooldown. Top 5 by lesson_count.
  //   2. For each group:
  //      a) Fetch qualifying lesson (id, title, content).
  //      b) Compute pairwise cosine similarity via pgvector;
  //         threshold ≥ 0.7 → graph edge.
  //      c) Union-find connected components; keep size ≥ 5.
  //      d) Per eligible cluster, LLM call extracts:
  //         { pattern_name, pattern_summary, pattern_conditions[],
  //           source_lesson_ids[] }
  //         OR
  //         { no_pattern: true, reason }
  //      e) Pattern path: create knowledge_drafts row via draftSvc
  //         (type=concept, source=agent_self_review, system actor,
  //         metadata.is_pattern=true, metadata.derived_from_lessons=[...]).
  //      f) No-pattern path: set 30-day evolution_cooldown_until on
  //         every lesson in the cluster (avoids retrying same group
  //         every weekly tick without new data).
  //
  // Returns BehaviorResult with draftsCreated = pattern drafts created,
  // nodesModified = cluster lessons whose metadata.cooldown was set,
  // details = groupings + LLM call stats.
  //
  // Decisions baked in:
  //   B (PR #3 plan v0.2): no external clustering deps; cosine
  //     threshold graph + union-find connected components.
  //   30-day cooldown for failed pattern extraction
  //     (BEHAVIOR_LIMITS.pattern_emergence.cooldownDays = 30).
  //   Concept drafts go through Phase 1b draft → Phase 3b reviewer
  //     → human approval pipeline; this behavior never bypasses review.
  // ──────────────────────────────────────────────────────────────────
  async function patternEmergence(
    companyId: string,
  ): Promise<BehaviorResult> {
    const t = BEHAVIOR_LIMITS.pattern_emergence;

    // Step 1: discover candidate groups.
    const groups = (await db.execute(sql`
      SELECT
        n.used_for,
        n.business_domain_id,
        bd.name AS business_domain_name,
        COUNT(*)::int AS lesson_count
      FROM knowledge_nodes n
      JOIN business_domains bd ON bd.id = n.business_domain_id
      WHERE n.company_id = ${companyId}
        AND n.type = 'lesson'
        AND n.status = 'active'
        AND n.used_for IS NOT NULL
        AND n.business_domain_id IS NOT NULL
        AND (n.metadata->>'evolution_cooldown_until' IS NULL
             OR (n.metadata->>'evolution_cooldown_until')::timestamptz < NOW())
      GROUP BY n.used_for, n.business_domain_id, bd.name
      HAVING COUNT(*) >= ${t.minClusterSize}::int
      ORDER BY COUNT(*) DESC
      LIMIT ${t.topClusters}::int
    `)) as Array<{
      used_for: string;
      business_domain_id: string;
      business_domain_name: string;
      lesson_count: number;
    }>;

    let draftsCreated = 0;
    let cooldownsSet = 0;
    let clustersProcessed = 0;
    let llmCalls = 0;
    const errors: Array<{ subject: string; reason: string }> = [];

    for (const g of groups) {
      const groupKey = `${g.used_for}:${g.business_domain_id}`;

      // Step 2a: fetch lesson tuples for this group.
      let lessons: Array<{ id: string; title: string; content: string }>;
      try {
        lessons = (await db.execute(sql`
          SELECT id, title, content
          FROM knowledge_nodes
          WHERE company_id = ${companyId}
            AND type = 'lesson'
            AND status = 'active'
            AND used_for = ${g.used_for}
            AND business_domain_id = ${g.business_domain_id}::uuid
            AND (metadata->>'evolution_cooldown_until' IS NULL
                 OR (metadata->>'evolution_cooldown_until')::timestamptz < NOW())
        `)) as Array<{ id: string; title: string; content: string }>;
      } catch (err) {
        errors.push({
          subject: groupKey,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Sanity: post-filter could yield < minClusterSize (race against
      // a concurrent cooldown / status change between Step 1 and 2a).
      if (lessons.length < t.minClusterSize) continue;

      // Step 2b: pairwise cosine edges via pgvector. Uses the HNSW
      // index for the `<=>` predicate.
      const distanceCeiling = 1 - t.cosineThreshold;
      let edges: Array<{ id_a: string; id_b: string; cosine: number | string }>;
      try {
        edges = (await db.execute(sql`
          SELECT a.id AS id_a, b.id AS id_b,
                 1 - (a.embedding <=> b.embedding) AS cosine
          FROM knowledge_nodes a
          JOIN knowledge_nodes b
            ON a.id < b.id
            AND a.company_id = b.company_id
            AND a.embedding <=> b.embedding < ${String(distanceCeiling)}::float
          WHERE a.company_id = ${companyId}
            AND a.type = 'lesson' AND a.status = 'active'
            AND a.used_for = ${g.used_for}
            AND a.business_domain_id = ${g.business_domain_id}::uuid
            AND b.type = 'lesson' AND b.status = 'active'
            AND b.used_for = ${g.used_for}
            AND b.business_domain_id = ${g.business_domain_id}::uuid
        `)) as Array<{ id_a: string; id_b: string; cosine: number | string }>;
      } catch (err) {
        errors.push({
          subject: groupKey,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Step 2c: union-find connected components.
      const lessonIds = lessons.map((l) => l.id);
      const clusters = unionFindClusters(
        lessonIds,
        edges.map((e) => ({ a: e.id_a, b: e.id_b })),
      );
      const eligibleClusters = clusters.filter(
        (c) => c.length >= t.minClusterSize,
      );

      // Step 3: LLM call per eligible cluster.
      for (const cluster of eligibleClusters) {
        clustersProcessed += 1;
        const clusterKey = `${groupKey}:size${cluster.length}:${cluster[0]}`;
        const clusterLessons = lessons.filter((l) =>
          cluster.includes(l.id),
        ).slice(0, LESSON_PROMPT_BATCH_CAP);

        const userMessage = JSON.stringify(
          {
            used_for: g.used_for,
            business_domain: g.business_domain_name,
            lessons: clusterLessons.map((l) => ({
              id: l.id,
              title: l.title,
              content_excerpt: l.content.slice(0, LESSON_CONTENT_EXCERPT_CHARS),
            })),
          },
          null,
          2,
        );

        let raw: string;
        try {
          raw = await llm.completeChat({
            system: PATTERN_EMERGENCE_SYSTEM_PROMPT,
            user: userMessage,
          });
          llmCalls += 1;
        } catch (err) {
          errors.push({
            subject: clusterKey,
            reason: `llm_failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }

        // Parse LLM output (allow accidental markdown fence).
        let parsed: {
          pattern_name?: string;
          pattern_summary?: string;
          pattern_conditions?: string[];
          source_lesson_ids?: string[];
          no_pattern?: boolean;
          reason?: string;
        };
        try {
          const cleaned = raw
            .trim()
            .replace(/^```(?:json)?\n?/, "")
            .replace(/\n?```$/, "");
          parsed = JSON.parse(cleaned);
        } catch {
          // Unparseable → set cooldown to avoid retrying same prompt
          // with same lessons every weekly tick.
          const setOk = await setClusterCooldown(companyId, cluster, t.cooldownDays);
          if (setOk) cooldownsSet += cluster.length;
          errors.push({
            subject: clusterKey,
            reason: "llm_output_not_json",
          });
          continue;
        }

        // Branch B: LLM explicitly said no useful pattern.
        if (parsed.no_pattern === true) {
          const setOk = await setClusterCooldown(companyId, cluster, t.cooldownDays);
          if (setOk) cooldownsSet += cluster.length;
          continue;
        }

        // Branch A validation. Malformed → treat as no_pattern for
        // cooldown purposes + record specific error.
        if (
          typeof parsed.pattern_name !== "string" ||
          parsed.pattern_name.length === 0 ||
          typeof parsed.pattern_summary !== "string" ||
          parsed.pattern_summary.length === 0 ||
          !Array.isArray(parsed.pattern_conditions) ||
          !Array.isArray(parsed.source_lesson_ids) ||
          parsed.source_lesson_ids.length === 0
        ) {
          const setOk = await setClusterCooldown(companyId, cluster, t.cooldownDays);
          if (setOk) cooldownsSet += cluster.length;
          errors.push({
            subject: clusterKey,
            reason: "llm_output_malformed",
          });
          continue;
        }

        // Create concept draft via Phase 1a draft service.
        if (!draftSvc) {
          errors.push({
            subject: clusterKey,
            reason: "draftSvc unavailable",
          });
          continue;
        }
        const conditionsBlock = parsed.pattern_conditions.length > 0
          ? `\n\n触发条件:\n${parsed.pattern_conditions.map((c) => `- ${c}`).join("\n")}`
          : "";
        try {
          await draftSvc.create({
            companyId,
            actor: { type: "system" },
            payload: {
              title: parsed.pattern_name.slice(0, 500),
              content: (parsed.pattern_summary + conditionsBlock).slice(0, 8000),
              type: "concept",
              level: "company",
              business_domain_name: g.business_domain_name,
              metadata: {
                is_pattern: true,
                derived_from_lessons: parsed.source_lesson_ids,
                used_for: g.used_for,
              },
              confidence: 0.6,
              source: "agent_self_review",
              // 不跳过审核:概念草案进 reviewer pipeline,由 Phase 3b 自动筛选
              // 后,Board 人工最终拍板。与 PRD §FR6 "Curator 自治 ≠ 自动入库" 一致。
              skip_review: false,
            },
          });
          draftsCreated += 1;
        } catch (err) {
          errors.push({
            subject: clusterKey,
            reason: `draft_create_failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    return {
      behavior: "pattern_emergence",
      candidatesFound: groups.length,
      issuesCreated: 0,
      draftsCreated,
      edgesCreated: 0,
      // Each cooldown set bumps a lesson's metadata.evolution_cooldown_until.
      nodesModified: cooldownsSet,
      errors,
      details: {
        cosine_threshold: t.cosineThreshold,
        min_cluster_size: t.minClusterSize,
        cooldown_days: t.cooldownDays,
        top_clusters_limit: t.topClusters,
        clusters_processed: clustersProcessed,
        cooldowns_set: cooldownsSet,
        llm_calls: llmCalls,
      },
    };
  }

  /**
   * Helper: stamp `metadata.evolution_cooldown_until = NOW() + N days`
   * on every lesson in the cluster. Used for both LLM-says-no-pattern
   * and LLM-output-malformed paths so the cluster doesn't get retried
   * weekly with the same unproductive prompt.
   * Returns true on success, false on error (errors logged but not thrown).
   */
  async function setClusterCooldown(
    companyId: string,
    clusterIds: string[],
    cooldownDays: number,
  ): Promise<boolean> {
    try {
      await db.execute(sql`
        UPDATE knowledge_nodes
        SET metadata = metadata || jsonb_build_object(
          'evolution_cooldown_until',
          (NOW() + (${String(cooldownDays)} || ' days')::INTERVAL)::text
        )
        WHERE id = ANY(${clusterIds}::uuid[])
          AND company_id = ${companyId}::uuid
      `);
      return true;
    } catch (err) {
      logger.warn(
        { err, companyId, clusterSize: clusterIds.length },
        "evolution: setClusterCooldown failed",
      );
      return false;
    }
  }
}

export type KnowledgeEvolutionService = ReturnType<
  typeof knowledgeEvolutionService
>;
