import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { KnowledgeMetricStatus } from "@paperclipai/shared";

/**
 * Phase 3c 健康指标计算服务（PRD §7.5 + §13.3 Routine 3）。
 *
 * Task 2 范围：全 6 个 metric computer。
 *
 * "无判断点"3 个（首批 commit）：
 * - weekly_new_drafts        过去 7 天创建的 draft 数
 * - review_backlog_hours_p50 pending draft 等待时长中位（小时）
 * - stale_unchecked_fast     volatility=fast 节点中 ≥ 90 天未验证的数
 *
 * Maintainer 决策后落地 3 个：
 * - helped_ratio          决定 1A：反馈条数 < 10 时跳过比例判断,直接 healthy
 *                         + details.low_sample=true,避免冷启动期误报。
 * - avg_edges_per_node    决定 2C：加权 human=1.0 / auto-generated=0.5,反映
 *                         人审过的边比 [[wikilink]] 自动边含更多信息。
 * - unresolved_conflicts  决定 3A：Phase 3a 演化引擎落地前一律 source-
 *                         unavailable 兜底返回 healthy。schema 已有
 *                         knowledge_edges.edge_type='conflicts_with' 但没
 *                         resolved 字段;Phase 3a 决定 conflict resolution
 *                         状态后切到真实查询。
 *
 * 阈值常量集中在 METRIC_THRESHOLDS（导出供 test 验证），改阈值无需动 computer 主逻辑。
 * 写入 knowledge_metrics + alarm Issue 集成留给 Task 3 的 runHealthcheck。
 */

/** 健康指标阈值表（PRD §7.5）。修改这里不需要动 computer 主逻辑。 */
export const METRIC_THRESHOLDS = {
  weekly_new_drafts: {
    /** ≥ 1 healthy；= 0 critical（无 warning 中间档） */
    healthyMin: 1,
  },
  review_backlog_hours_p50: {
    /** ≤ 24h healthy；(24, 48] warning；> 48 critical */
    healthyMax: 24,
    criticalMin: 48,
  },
  helped_ratio: {
    /** ≥ 0.5 healthy；[0.3, 0.5) warning；< 0.3 critical */
    healthyMin: 0.5,
    criticalMax: 0.3,
    /** maintainer 决定 1A：反馈条数 < 10 时跳过判断,直接 healthy + low_sample */
    lowSampleThreshold: 10,
  },
  avg_edges_per_node: {
    /** ≥ 1.5 healthy；[1.0, 1.5) warning；< 1.0 critical */
    healthyMin: 1.5,
    criticalMax: 1.0,
    /**
     * maintainer 决定 2C：加权 human=1.0 / auto=0.5。
     * 反映 PRD "知识真正成网络" 的初衷 —— 人审过的边比 [[wikilink]] 自动边
     * 含更多信息。
     */
    edgeWeights: { human: 1.0, auto: 0.5 },
  },
  stale_unchecked_fast: {
    /** ≤ 4 healthy；[5, 10] warning；> 10 critical */
    healthyMax: 4,
    criticalMin: 10,
  },
  // unresolved_conflicts: 无阈值条目
  //   选项 3A：Phase 3a 演化引擎落地前一律 source-unavailable 兜底,返回
  //   value=0/status=healthy。schema 已有 knowledge_edges.edge_type='conflicts_with'
  //   但没 resolved 字段;Phase 3a 决定 conflict resolution state 后切到真实查询。
} as const;

export interface MetricResult {
  value: number;
  status: KnowledgeMetricStatus;
  /** 计算明细，便于 Dashboard 下钻 + alarm Issue 展示 */
  details: Record<string, unknown>;
}

export function knowledgeHealthcheckService(db: Db) {
  /**
   * weekly_new_drafts —— 过去 7 天创建的 knowledge_drafts 数。
   * 归零意味着写入路径阻塞 / Agent 不再自评（PRD §7.5）。
   */
  async function computeWeeklyNewDrafts(
    companyId: string,
  ): Promise<MetricResult> {
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM knowledge_drafts
      WHERE company_id = ${companyId}
        AND created_at > NOW() - INTERVAL '7 days'
    `)) as Array<{ count: number }>;
    const value = rows[0]?.count ?? 0;
    const status: KnowledgeMetricStatus =
      value >= METRIC_THRESHOLDS.weekly_new_drafts.healthyMin
        ? "healthy"
        : "critical";
    return { value, status, details: { window_days: 7 } };
  }

  /**
   * review_backlog_hours_p50 —— pending knowledge_drafts 的等待时长中位（小时）。
   * 无 pending 时 p50 = 0 → healthy（队列空，无积压）。
   */
  async function computeReviewBacklogHoursP50(
    companyId: string,
  ): Promise<MetricResult> {
    const rows = (await db.execute(sql`
      SELECT
        COALESCE(
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0
          )::numeric,
          0
        ) AS p50_hours,
        COUNT(*)::int AS pending_count
      FROM knowledge_drafts
      WHERE company_id = ${companyId}
        AND status = 'pending'
    `)) as Array<{ p50_hours: string | number | null; pending_count: number }>;
    const value = Number(rows[0]?.p50_hours ?? 0);
    const pendingCount = rows[0]?.pending_count ?? 0;

    const t = METRIC_THRESHOLDS.review_backlog_hours_p50;
    const status: KnowledgeMetricStatus =
      value <= t.healthyMax
        ? "healthy"
        : value > t.criticalMin
          ? "critical"
          : "warning";
    return { value, status, details: { pending_count: pendingCount } };
  }

  /**
   * stale_unchecked_fast —— volatility=fast 节点中 ≥ 90 天未验证（或从未验证）的数。
   * 索引 knowledge_nodes_volatility_verified_idx 已在 migration 0084 中建好。
   */
  async function computeStaleUncheckedFast(
    companyId: string,
  ): Promise<MetricResult> {
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM knowledge_nodes
      WHERE company_id = ${companyId}
        AND volatility = 'fast'
        AND (verified_at IS NULL OR verified_at < NOW() - INTERVAL '90 days')
    `)) as Array<{ count: number }>;
    const value = rows[0]?.count ?? 0;

    const t = METRIC_THRESHOLDS.stale_unchecked_fast;
    const status: KnowledgeMetricStatus =
      value <= t.healthyMax
        ? "healthy"
        : value > t.criticalMin
          ? "critical"
          : "warning";
    return { value, status, details: { window_days: 90 } };
  }

  /**
   * helped_ratio —— 过去 30 天 feedback='helped' 占所有 feedback 事件的比例。
   *
   * Maintainer 决定 1A：反馈条数 < lowSampleThreshold(=10) 时跳过比例判断,
   * 直接 healthy + details.low_sample=true,避免冷启动期"反馈不够"误报。
   *
   * knowledge_node_events 表没有 company_id,必须 JOIN knowledge_nodes 做隔离。
   * 索引 knowledge_node_events_feedback_idx 覆盖 (event_type, feedback, created_at)
   * where event_type IN ('triggered','feedback'),命中本查询。
   */
  async function computeHelpedRatio(
    companyId: string,
  ): Promise<MetricResult> {
    const rows = (await db.execute(sql`
      WITH feedback_30d AS (
        SELECT kne.feedback
        FROM knowledge_node_events kne
        JOIN knowledge_nodes kn ON kn.id = kne.node_id
        WHERE kn.company_id = ${companyId}
          AND kne.event_type = 'feedback'
          AND kne.created_at > NOW() - INTERVAL '30 days'
      )
      SELECT
        COUNT(*)::int AS total,
        COALESCE(
          SUM(CASE WHEN feedback = 'helped' THEN 1 ELSE 0 END)::numeric
          / NULLIF(COUNT(*), 0),
          0
        ) AS ratio
      FROM feedback_30d
    `)) as Array<{ total: number; ratio: string | number | null }>;
    const total = rows[0]?.total ?? 0;
    const ratio = Number(rows[0]?.ratio ?? 0);

    const t = METRIC_THRESHOLDS.helped_ratio;

    // Low-sample 兜底：反馈数据不足时不报警。
    if (total < t.lowSampleThreshold) {
      return {
        value: ratio,
        status: "healthy",
        details: {
          total_feedback: total,
          low_sample: true,
          low_sample_threshold: t.lowSampleThreshold,
          window_days: 30,
        },
      };
    }

    const status: KnowledgeMetricStatus =
      ratio >= t.healthyMin
        ? "healthy"
        : ratio < t.criticalMax
          ? "critical"
          : "warning";
    return {
      value: ratio,
      status,
      details: { total_feedback: total, window_days: 30 },
    };
  }

  /**
   * avg_edges_per_node —— 加权平均边数（PRD §7.5：> 1.5 healthy）。
   *
   * Maintainer 决定 2C：human edges ×1.0 / auto-generated edges ×0.5。
   * 反映"人审过的边含信息量大于 [[wikilink]] 自动边",更准地反映网络成熟度。
   *
   * knowledge_edges 表没有 company_id,通过 JOIN knowledge_nodes (from_node_id)
   * 做 company 隔离。从 from_node 而非 to_node 出发：避免重复计算 + 多租户
   * 不允许 cross-company 边,from/to 都应在同 company,from 已足够代表。
   *
   * 边为 0 但有 nodes：value=0/status=critical (孤岛化是真问题)。
   * Nodes 也为 0：value=0/status=healthy + details.no_nodes=true (新公司没数据
   * 不应报警,等用户开始建知识)。
   */
  async function computeAvgEdgesPerNode(
    companyId: string,
  ): Promise<MetricResult> {
    const t = METRIC_THRESHOLDS.avg_edges_per_node;
    const w = t.edgeWeights;
    const rows = (await db.execute(sql`
      WITH
        n AS (
          SELECT COUNT(*)::int AS c
          FROM knowledge_nodes
          WHERE company_id = ${companyId}
        ),
        e AS (
          SELECT
            COALESCE(SUM(CASE WHEN ke.auto_generated THEN ${w.auto}::numeric ELSE ${w.human}::numeric END), 0) AS weighted,
            COALESCE(SUM(CASE WHEN ke.auto_generated THEN 1 ELSE 0 END)::int, 0) AS auto_count,
            COALESCE(SUM(CASE WHEN NOT ke.auto_generated THEN 1 ELSE 0 END)::int, 0) AS human_count,
            COUNT(*)::int AS total
          FROM knowledge_edges ke
          JOIN knowledge_nodes kn ON kn.id = ke.from_node_id
          WHERE kn.company_id = ${companyId}
        )
      SELECT
        n.c AS node_count,
        e.weighted,
        e.auto_count,
        e.human_count,
        e.total
      FROM n, e
    `)) as Array<{
      node_count: number;
      weighted: string | number | null;
      auto_count: number;
      human_count: number;
      total: number;
    }>;

    const row = rows[0];
    const nodeCount = row?.node_count ?? 0;
    const weighted = Number(row?.weighted ?? 0);
    const autoCount = row?.auto_count ?? 0;
    const humanCount = row?.human_count ?? 0;
    const totalEdges = row?.total ?? 0;

    // 空 company 防御：没节点不报警,等用户建知识。
    if (nodeCount === 0) {
      return {
        value: 0,
        status: "healthy",
        details: {
          no_nodes: true,
          node_count: 0,
          total_edges: totalEdges,
          weighting: w,
        },
      };
    }

    const avgWeighted = weighted / nodeCount;
    const status: KnowledgeMetricStatus =
      avgWeighted >= t.healthyMin
        ? "healthy"
        : avgWeighted < t.criticalMax
          ? "critical"
          : "warning";
    return {
      value: avgWeighted,
      status,
      details: {
        node_count: nodeCount,
        total_edges: totalEdges,
        auto_edges: autoCount,
        human_edges: humanCount,
        weighting: w,
      },
    };
  }

  /**
   * unresolved_conflicts —— 未解决的知识冲突数（PRD §7.5：< 10 healthy）。
   *
   * Maintainer 决定 3A：Phase 3a 演化引擎落地前一律 source-unavailable 兜底。
   *
   * 现状：knowledge_edges 已支持 edge_type='conflicts_with',但目前没有任何
   * code path 在创建这类边(Phase 3a 6 条自动行为之一才会 emit)。schema 也
   * 没有 resolved 字段去区分"未决 vs 已解决"。
   *
   * 当前实现：不查 DB,直接返回 value=0/status=healthy + source_unavailable
   * 标记。Phase 3a 落地后切换为真实查询(可能需要加 resolved 列或在 metadata
   * 标记)无需调用方修改。
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function computeUnresolvedConflicts(
    _companyId: string,
  ): Promise<MetricResult> {
    return {
      value: 0,
      status: "healthy",
      details: {
        source_unavailable: true,
        reason:
          "Phase 3a evolution engine not implemented; conflicts_with edges not yet emitted and no resolved-state field defined",
        will_switch_when: "Phase 3a defines conflict-resolution state",
      },
    };
  }

  return {
    /**
     * Internal computers 暴露给单元测试。Task 3 的 runHealthcheck 落地后,
     * 公开 API 会改为 runHealthcheck(companyId, opts?) 一个入口,本字段保留
     * 给测试场景。
     */
    __test__: {
      computeWeeklyNewDrafts,
      computeReviewBacklogHoursP50,
      computeStaleUncheckedFast,
      computeHelpedRatio,
      computeAvgEdgesPerNode,
      computeUnresolvedConflicts,
    },
  };
}

export type KnowledgeHealthcheckService = ReturnType<
  typeof knowledgeHealthcheckService
>;
