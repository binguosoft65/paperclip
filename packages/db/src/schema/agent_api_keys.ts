import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * agent_api_keys 表 —— Agent API 密钥。
 *
 * Agent 通过 API 密钥与 Paperclip 控制平面进行认证通信。
 * 密钥以哈希形式存储，原始密钥只在创建时返回一次。
 * 支持吊销（revoked_at）以实现密钥轮换。
 */
export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    /** 密钥的 SHA-256 哈希值（原始密钥不在数据库中明文存储） */
    keyHash: text("key_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** 吊销时间，非空表示密钥已被吊销 */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyHashIdx: index("agent_api_keys_key_hash_idx").on(table.keyHash),
    companyAgentIdx: index("agent_api_keys_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
