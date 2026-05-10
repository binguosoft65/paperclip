import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * agent_task_sessions 表 —— Agent 任务级会话记录。
 *
 * 每个 Agent 可能同时运行多个不同任务，每个任务有独立会话。
 * 通过 (company_id, agent_id, adapter_type, task_key) 唯一约束
 * 确保同一 Agent 的同一任务不会创建重复会话。
 */
export const agentTaskSessions = pgTable(
  "agent_task_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    adapterType: text("adapter_type").notNull(),
    /** 任务键：标识 Agent 内的具体任务类型 */
    taskKey: text("task_key").notNull(),
    /** 会话参数的 JSON 快照，用于重建会话上下文 */
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>(),
    sessionDisplayId: text("session_display_id"),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentTaskUniqueIdx: uniqueIndex("agent_task_sessions_company_agent_adapter_task_uniq").on(
      table.companyId,
      table.agentId,
      table.adapterType,
      table.taskKey,
    ),
    companyAgentUpdatedIdx: index("agent_task_sessions_company_agent_updated_idx").on(
      table.companyId,
      table.agentId,
      table.updatedAt,
    ),
    companyTaskUpdatedIdx: index("agent_task_sessions_company_task_updated_idx").on(
      table.companyId,
      table.taskKey,
      table.updatedAt,
    ),
  }),
);
