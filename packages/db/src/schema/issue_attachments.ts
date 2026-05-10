import { pgTable, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { assets } from "./assets.js";
import { issueComments } from "./issue_comments.js";

/**
 * issue_attachments 表 —— Issue 附件关联。
 *
 * 将资源（assets）关联到 Issue，可选关联到具体评论。
 */
export const issueAttachments = pgTable(
  "issue_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    issueCommentId: uuid("issue_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_attachments_company_issue_idx").on(table.companyId, table.issueId),
    issueCommentIdx: index("issue_attachments_issue_comment_idx").on(table.issueCommentId),
    assetUq: uniqueIndex("issue_attachments_asset_uq").on(table.assetId),
  }),
);
