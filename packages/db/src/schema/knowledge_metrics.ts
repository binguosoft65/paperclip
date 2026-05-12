import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * knowledge_metrics 表 —— 健康指标缓存（FR7.5 + Routine 3 每日自检）。
 *
 * daily-knowledge-healthcheck Routine 每天 8:00 计算 6 个核心健康指标
 * 并写入此表，Dashboard 读此表展示，避免每次请求都现算。
 *
 * 6 个指标（metric_name 应用层校验，不入 DB CHECK 以方便扩展）：
 * - weekly_new_drafts
 * - review_backlog_hours_p50
 * - helped_ratio
 * - avg_edges_per_node
 * - unresolved_conflicts
 * - stale_unchecked_fast
 *
 * status（text + CHECK）: healthy | warning | critical
 *
 * 保留每个 (company, metric) 最新一条 + 90 天历史（趋势图）。超过 90
 * 天的由 Routine 自行清理。
 */
export const knowledgeMetrics = pgTable(
  "knowledge_metrics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    /** 指标名（应用层枚举，文档见 §4.8） */
    metricName: text("metric_name").notNull(),
    metricValue: numeric("metric_value").notNull(),
    /** healthy | warning | critical */
    status: text("status").notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** 计算明细（如哪些节点过期、哪些 draft 等待最久），便于 Dashboard 下钻 */
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => ({
    /** 按 metric 查最新值（Dashboard 主查询） */
    companyMetricIdx: index("knowledge_metrics_company_metric_idx").on(
      table.companyId,
      table.metricName,
      table.computedAt,
    ),
  }),
);
