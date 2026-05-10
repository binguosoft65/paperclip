import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * labels 表 —— 标签定义（分类/标记）。
 *
 * 公司级别的标签系统，用于对 Issue 进行分类和过滤。
 * 每个标签有名称和颜色，名称在公司内唯一。
 */
export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("labels_company_idx").on(table.companyId),
    companyNameIdx: uniqueIndex("labels_company_name_idx").on(table.companyId, table.name),
  }),
);
