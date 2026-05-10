import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * principal_permission_grants 表 —— 主体权限授予。
 *
 * 细粒度权限控制，支持为不同类型的主体（用户/Agent）
 * 授予特定权限键（如 'issue.create'、'agent.manage'）。
 * scope 字段支持权限作用域限定。
 */
export const principalPermissionGrants = pgTable(
  "principal_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown> | null>(),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueGrantIdx: uniqueIndex("principal_permission_grants_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
      table.permissionKey,
    ),
    companyPermissionIdx: index("principal_permission_grants_company_permission_idx").on(
      table.companyId,
      table.permissionKey,
    ),
  }),
);
