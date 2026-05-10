import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * company_secrets 表 —— 公司级密钥/凭据。
 *
 * 存储 API 密钥、访问令牌等敏感信息。
 * 实际值存储在 company_secret_versions 表中（版本化管理）。
 * provider 决定加密/存储方式（local_encrypted、vault 等）。
 */
export const companySecrets = pgTable(
  "company_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("local_encrypted"),
    externalRef: text("external_ref"),
    latestVersion: integer("latest_version").notNull().default(1),
    description: text("description"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secrets_company_idx").on(table.companyId),
    companyProviderIdx: index("company_secrets_company_provider_idx").on(table.companyId, table.provider),
    companyNameUq: uniqueIndex("company_secrets_company_name_uq").on(table.companyId, table.name),
  }),
);
