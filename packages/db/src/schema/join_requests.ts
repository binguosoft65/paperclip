import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { invites } from "./invites.js";
import { agents } from "./agents.js";

/**
 * join_requests 表 —— 加入申请。
 *
 * 用户或 Agent 接受邀请后提交的加入请求。
 * 如果公司需要审批（requireBoardApprovalForNewAgents），
 * 申请将处于 pending_approval 状态等待人工批准。
 * 支持密钥认领流程（claimSecretHash）。
 */
export const joinRequests = pgTable(
  "join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviteId: uuid("invite_id").notNull().references(() => invites.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    requestType: text("request_type").notNull(),
    status: text("status").notNull().default("pending_approval"),
    requestIp: text("request_ip").notNull(),
    requestingUserId: text("requesting_user_id"),
    requestEmailSnapshot: text("request_email_snapshot"),
    agentName: text("agent_name"),
    adapterType: text("adapter_type"),
    capabilities: text("capabilities"),
    agentDefaultsPayload: jsonb("agent_defaults_payload").$type<Record<string, unknown> | null>(),
    claimSecretHash: text("claim_secret_hash"),
    claimSecretExpiresAt: timestamp("claim_secret_expires_at", { withTimezone: true }),
    claimSecretConsumedAt: timestamp("claim_secret_consumed_at", { withTimezone: true }),
    createdAgentId: uuid("created_agent_id").references(() => agents.id),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: text("rejected_by_user_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inviteUniqueIdx: uniqueIndex("join_requests_invite_unique_idx").on(table.inviteId),
    companyStatusTypeCreatedIdx: index("join_requests_company_status_type_created_idx").on(
      table.companyId,
      table.status,
      table.requestType,
      table.createdAt,
    ),
    pendingHumanUserUniqueIdx: uniqueIndex("join_requests_pending_human_user_uq")
      .on(table.companyId, table.requestingUserId)
      .where(sql`${table.requestType} = 'human' AND ${table.status} = 'pending_approval' AND ${table.requestingUserId} IS NOT NULL`),
    pendingHumanEmailUniqueIdx: uniqueIndex("join_requests_pending_human_email_uq")
      .on(table.companyId, sql`lower(${table.requestEmailSnapshot})`)
      .where(sql`${table.requestType} = 'human' AND ${table.status} = 'pending_approval' AND ${table.requestEmailSnapshot} IS NOT NULL`),
  }),
);
