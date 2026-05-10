import { boolean, index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * budget_policies 表 —— 预算策略配置。
 *
 * 支持多层级预算控制（公司级、项目级、Agent 级）。
 * scope_type + scope_id 确定预算作用域，
 * window_kind 定义时间窗口（'monthly'、'weekly'、'daily'）。
 * 超过 warn_percent 时发出告警，hardStopEnabled 为 true 时
 * 达到上限后自动暂停相关 Agent 或项目。
 */
export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    metric: text("metric").notNull().default("billed_cents"),
    windowKind: text("window_kind").notNull(),
    amount: integer("amount").notNull().default(0),
    warnPercent: integer("warn_percent").notNull().default(80),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    notifyEnabled: boolean("notify_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeActiveIdx: index("budget_policies_company_scope_active_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.isActive,
    ),
    companyWindowIdx: index("budget_policies_company_window_idx").on(
      table.companyId,
      table.windowKind,
      table.metric,
    ),
    companyScopeMetricUniqueIdx: uniqueIndex("budget_policies_company_scope_metric_unique_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.metric,
      table.windowKind,
    ),
  }),
);
