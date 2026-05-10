import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * company_secret_provider_configs 表 —— 密钥提供者配置。
 *
 * 配置密钥的存储后端（如 local_encrypted、AWS Secrets Manager、
 * Vault 等）。每个公司可以有多个提供者，isDefault 标记默认提供者。
 */
export const companySecretProviderConfigs = pgTable(
  "company_secret_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("ready"),
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    healthStatus: text("health_status"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    healthMessage: text("health_message"),
    healthDetails: jsonb("health_details").$type<Record<string, unknown>>(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secret_provider_configs_company_idx").on(table.companyId),
    companyProviderIdx: index("company_secret_provider_configs_company_provider_idx").on(table.companyId, table.provider),
    companyDefaultProviderUq: uniqueIndex("company_secret_provider_configs_default_uq")
      .on(table.companyId, table.provider)
      .where(sql`${table.isDefault} = true`),
  }),
);
