import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * company_memberships 表 —— 用户/Agent 与公司的关联关系。
 *
 * 支持多类型主体（用户或 Agent）加入同一公司。
 * principal_type 区分主体类型（user / agent），
 * principal_id 是 authUsers 或 agents 的 ID。
 */
export const companyMemberships = pgTable(
  "company_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** 主体类型：'user'（人类用户）或 'agent'（AI Agent） */
    principalType: text("principal_type").notNull(),
    /** 主体 ID：authUsers.id 或 agents.id */
    principalId: text("principal_id").notNull(),
    status: text("status").notNull().default("active"),
    /** 成员角色：如 'admin'、'member'、'viewer' */
    membershipRole: text("membership_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPrincipalUniqueIdx: uniqueIndex("company_memberships_company_principal_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    principalStatusIdx: index("company_memberships_principal_status_idx").on(
      table.principalType,
      table.principalId,
      table.status,
    ),
    companyStatusIdx: index("company_memberships_company_status_idx").on(table.companyId, table.status),
  }),
);
