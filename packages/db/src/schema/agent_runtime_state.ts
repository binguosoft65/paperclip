import { pgTable, uuid, text, timestamp, jsonb, bigint, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * agent_runtime_state 表 —— Agent 运行时状态（1:1 关系）。
 *
 * 与 agents 表一对一关联，存储 Agent 的当前运行时快照，
 * 包括会话信息、Token 用量和累计成本。
 * 在 Agent 重启或故障恢复时用于重建上下文。
 */
export const agentRuntimeState = pgTable(
  "agent_runtime_state",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    adapterType: text("adapter_type").notNull(),
    /** 当前 adapter 会话 ID（用于重连恢复） */
    sessionId: text("session_id"),
    /** Agent 运行时状态 JSON（adapter 特定格式） */
    stateJson: jsonb("state_json").$type<Record<string, unknown>>().notNull().default({}),
    /** 上次执行的 run ID */
    lastRunId: uuid("last_run_id"),
    /** 上次执行的状态 */
    lastRunStatus: text("last_run_status"),
    totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull().default(0),
    totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull().default(0),
    totalCachedInputTokens: bigint("total_cached_input_tokens", { mode: "number" }).notNull().default(0),
    /** 累计花费（美分），用于预算管控 */
    totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull().default(0),
    /** 最近一次错误信息 */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_runtime_state_company_agent_idx").on(table.companyId, table.agentId),
    companyUpdatedIdx: index("agent_runtime_state_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);

