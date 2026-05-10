import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * feedback_votes 表 —— 用户投票/反馈收集。
 *
 * 收集用户对系统生成的代码、文档、回复等内容的评价
 * （赞同/反对），用于改进 AI Agent 输出质量。
 * 支持匿名共享和隐私遮罩（redactionSummary）。
 */
export const feedbackVotes = pgTable(
  "feedback_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    vote: text("vote").notNull(),
    reason: text("reason"),
    sharedWithLabs: boolean("shared_with_labs").notNull().default(false),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    consentVersion: text("consent_version"),
    redactionSummary: jsonb("redaction_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("feedback_votes_company_issue_idx").on(table.companyId, table.issueId),
    issueTargetIdx: index("feedback_votes_issue_target_idx").on(table.issueId, table.targetType, table.targetId),
    authorIdx: index("feedback_votes_author_idx").on(table.authorUserId, table.createdAt),
    companyTargetAuthorUniqueIdx: uniqueIndex("feedback_votes_company_target_author_idx").on(
      table.companyId,
      table.targetType,
      table.targetId,
      table.authorUserId,
    ),
  }),
);
