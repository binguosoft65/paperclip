import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * agent_config_revisions 表 —— Agent 配置变更历史审计。
 *
 * 每次 Agent 配置发生变更时记录一条修订记录，
 * 包含变更前后的完整配置快照，支持回滚审计。
 */
export const agentConfigRevisions = pgTable(
  "agent_config_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    /** 变更来源：'patch'（增量更新）、'rollback'（回滚）、'initial'（首次配置） */
    source: text("source").notNull().default("patch"),
    /** 回滚来源的修订 ID（当 source='rollback' 时指向被回滚到的版本） */
    rolledBackFromRevisionId: uuid("rolled_back_from_revision_id"),
    /** 发生变更的配置键列表 */
    changedKeys: jsonb("changed_keys").$type<string[]>().notNull().default([]),
    /** 变更前的完整配置快照 */
    beforeConfig: jsonb("before_config").$type<Record<string, unknown>>().notNull(),
    /** 变更后的完整配置快照 */
    afterConfig: jsonb("after_config").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("agent_config_revisions_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    agentCreatedIdx: index("agent_config_revisions_agent_created_idx").on(table.agentId, table.createdAt),
  }),
);
