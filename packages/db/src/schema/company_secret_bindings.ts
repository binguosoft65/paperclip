import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * company_secret_bindings 表 —— 密钥绑定/注入配置。
 *
 * 将密钥绑定到具体的消费目标（Agent、项目等），
 * 配置路径决定在运行环境中注入密钥的位置。
 * version_selector 控制使用哪个版本（'latest' 或指定版本号）。
 */
export const companySecretBindings = pgTable(
  "company_secret_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    configPath: text("config_path").notNull(),
    versionSelector: text("version_selector").notNull().default("latest"),
    required: boolean("required").notNull().default(true),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secret_bindings_company_idx").on(table.companyId),
    secretIdx: index("company_secret_bindings_secret_idx").on(table.secretId),
    targetIdx: index("company_secret_bindings_target_idx").on(table.companyId, table.targetType, table.targetId),
    targetPathUq: uniqueIndex("company_secret_bindings_target_path_uq").on(
      table.companyId,
      table.targetType,
      table.targetId,
      table.configPath,
    ),
  }),
);
