import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * agent_wakeup_requests 表 —— Agent 唤醒请求队列。
 *
 * 当 Agent 处于空闲/暂停状态时，外部事件或定时器通过此表
 * 请求唤醒 Agent。Agent 的心跳循环消费此队列，
 * 取出请求后执行对应的任务。
 * coalesced_count 表示合并的重复请求数（去重优化）。
 */
export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    /** 唤醒来源：'routine'（定时）、'issue'（Issue变更）、'manual'（手动）等 */
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** queued=排队中, claimed=已领取, processing=处理中, done=完成, error=错误 */
    status: text("status").notNull().default("queued"),
    /** 合并次数：当多个相同请求在队列中时合并以减少处理次数 */
    coalescedCount: integer("coalesced_count").notNull().default(0),
    /** 请求方类型：'user' 或 'agent' */
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    /** 幂等键，防止重复提交 */
    idempotencyKey: text("idempotency_key"),
    /** 处理该请求的 heartbeat run ID */
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_wakeup_requests_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyRequestedIdx: index("agent_wakeup_requests_company_requested_idx").on(
      table.companyId,
      table.requestedAt,
    ),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(table.agentId, table.requestedAt),
  }),
);
