import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { KnowledgeMetricStatus } from "@paperclipai/shared";

/**
 * Phase 3c 健康指标计算服务（PRD §7.5 + §13.3 Routine 3）。
 *
 * 当前 commit 范围：Task 2 落地 3 个"无判断点"的 computer。
 * - weekly_new_drafts        过去 7 天创建的 draft 数
 * - review_backlog_hours_p50 pending draft 等待时长中位（小时）
 * - stale_unchecked_fast     volatility=fast 节点中 ≥ 90 天未验证的数
 *
 * 留待 maintainer 拍板（在后续 commit 加入）：
 * - helped_ratio            low-sample 阈值（plan 暂用 < 10 条 healthy 兜底，待确认）
 * - avg_edges_per_node      是否排除 is_auto_generated 边
 * - unresolved_conflicts    依赖 Phase 3a 的 event_type=conflict_detected
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
  stale_unchecked_fast: {
    /** ≤ 4 healthy；[5, 10] warning；> 10 critical */
    healthyMax: 4,
    criticalMin: 10,
  },
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
    },
  };
}

export type KnowledgeHealthcheckService = ReturnType<
  typeof knowledgeHealthcheckService
>;
