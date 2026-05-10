import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * heartbeat_run_watchdog_decisions 表 —— 看门狗决策记录。
 *
 * 当 Agent 运行超时或出现异常时，看门狗（Watchdog）机制
 * 检查运行状态并做出决策（如重试、暂停、升级为 Issue）。
 * snoozed_until 字段支持临时静音以避免重复告警。
 */
export const heartbeatRunWatchdogDecisions = pgTable(
  "heartbeat_run_watchdog_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    evaluationIssueId: uuid("evaluation_issue_id").references(() => issues.id, { onDelete: "set null" }),
    decision: text("decision").notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    reason: text("reason"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunCreatedIdx: index("heartbeat_run_watchdog_decisions_company_run_created_idx").on(
      table.companyId,
      table.runId,
      table.createdAt,
    ),
    companyRunSnoozeIdx: index("heartbeat_run_watchdog_decisions_company_run_snooze_idx").on(
      table.companyId,
      table.runId,
      table.snoozedUntil,
    ),
  }),
);
