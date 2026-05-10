import { pgTable, uuid, text, timestamp, integer, jsonb, index, bigserial } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * heartbeat_run_events 表 —— Agent 运行事件日志流。
 *
 * 记录 Agent 在执行过程中产生的事件流（日志行、状态变更等），
 * 按顺序编号（seq），支持事件回放和调试。
 */
export const heartbeatRunEvents = pgTable(
  "heartbeat_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    stream: text("stream"),
    level: text("level"),
    color: text("color"),
    message: text("message"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSeqIdx: index("heartbeat_run_events_run_seq_idx").on(table.runId, table.seq),
    companyRunIdx: index("heartbeat_run_events_company_run_idx").on(table.companyId, table.runId),
    companyCreatedIdx: index("heartbeat_run_events_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

