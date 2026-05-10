import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * user_sidebar_preferences 表 —— 用户侧边栏偏好（全局）。
 *
 * 记录用户在实例级侧边栏中的公司排序偏好。
 */
export const userSidebarPreferences = pgTable(
  "user_sidebar_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    companyOrder: jsonb("company_order").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_sidebar_preferences_user_uq").on(table.userId),
  }),
);
