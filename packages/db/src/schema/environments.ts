import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * environments 表 —— 执行环境配置。
 *
 * 定义 Agent 任务的执行环境（如本地、Docker、远程服务器等）。
 * driver 字段标识环境驱动类型，driver = 'local' 时有唯一约束
 * （每个公司只能有一个 local 环境）。
 * config 字段存储驱动特定的连接/配置信息。
 */
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    driver: text("driver").notNull().default("local"),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("environments_company_status_idx").on(table.companyId, table.status),
    companyDriverIdx: uniqueIndex("environments_company_driver_idx")
      .on(table.companyId, table.driver)
      .where(sql`${table.driver} = 'local'`),
    companyNameIdx: index("environments_company_name_idx").on(table.companyId, table.name),
  }),
);
