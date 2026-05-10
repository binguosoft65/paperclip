import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { documents } from "./documents.js";

/**
 * issue_documents 表 —— Issue 关联的文档。
 *
 * 将文档附加到 Issue 中，支持命名键（key）区分不同用途的角色。
 * 一个文档只能属于一个 Issue（documentUq 唯一约束）。
 */
export const issueDocuments = pgTable(
  "issue_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueKeyUq: uniqueIndex("issue_documents_company_issue_key_uq").on(
      table.companyId,
      table.issueId,
      table.key,
    ),
    documentUq: uniqueIndex("issue_documents_document_uq").on(table.documentId),
    companyIssueUpdatedIdx: index("issue_documents_company_issue_updated_idx").on(
      table.companyId,
      table.issueId,
      table.updatedAt,
    ),
  }),
);
