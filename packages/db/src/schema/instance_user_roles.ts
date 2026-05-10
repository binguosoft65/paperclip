import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * instance_user_roles 表 —— 实例级用户角色。
 * 用于管理整个 Paperclip 实例的管理员权限，
 * 独立于公司级角色。一个用户可以拥有多个角色。
 */
export const instanceUserRoles = pgTable(
  "instance_user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    /** 角色名：instance_admin（实例管理员）等 */
    role: text("role").notNull().default("instance_admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userRoleUniqueIdx: uniqueIndex("instance_user_roles_user_role_unique_idx").on(table.userId, table.role),
    roleIdx: index("instance_user_roles_role_idx").on(table.role),
  }),
);
