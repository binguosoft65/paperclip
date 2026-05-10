import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

/**
 * company_secret_versions 表 —— 密钥版本管理。
 *
 * 支持密钥轮换和版本回滚。每次更新密钥时创建新版本，
 * 支持吊销（revokedAt）单个版本而不影响其他版本。
 * valueSha256 用于内容去重和完整性校验。
 */
export const companySecretVersions = pgTable(
  "company_secret_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    material: jsonb("material").$type<Record<string, unknown>>().notNull(),
    valueSha256: text("value_sha256").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    secretIdx: index("company_secret_versions_secret_idx").on(table.secretId, table.createdAt),
    valueHashIdx: index("company_secret_versions_value_sha256_idx").on(table.valueSha256),
    secretVersionUq: uniqueIndex("company_secret_versions_secret_version_uq").on(table.secretId, table.version),
  }),
);
