import {
  pgTable,
  uuid,
  text,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { knowledgeNodes } from "./knowledge_nodes.js";
import { businessDomains } from "./business_domains.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { authUsers } from "./auth.js";

/**
 * knowledge_drafts 表 —— 三路写入的统一审查队列（FR4）。
 *
 * Agent 自评（agent_self_review）、失败信号自动提取（failure_signal）、
 * 人工写入（manual）三路都先进 drafts，经审查通过后才物化为节点。
 *
 * Reviewer Agent 初筛字段（pre_verdict / pre_verdict_reasoning / detected_conflicts）
 * 由 hourly-draft-pre-review Routine 填充，给人审提供建议。
 *
 * 详见 docs/specs/...-database.md §4.4。
 */
export const knowledgeDrafts = pgTable(
  "knowledge_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** 目标节点：新建为 NULL，修改时指向已有节点 */
    targetNodeId: uuid("target_node_id").references(() => knowledgeNodes.id, {
      onDelete: "cascade",
    }),

    // 提议内容
    proposedTitle: text("proposed_title").notNull(),
    proposedContent: text("proposed_content").notNull(),
    /** concept | lesson | rule | decision | fact */
    proposedType: text("proposed_type").notNull(),
    /** personal | project | company */
    proposedLevel: text("proposed_level").notNull(),
    proposedBusinessDomainId: uuid("proposed_business_domain_id")
      .notNull()
      .references(() => businessDomains.id, { onDelete: "restrict" }),
    proposedMetadata: jsonb("proposed_metadata").notNull().default(sql`'{}'::jsonb`),
    /** stable | slow | fast */
    proposedVolatility: text("proposed_volatility"),
    proposedValidUntil: timestamp("proposed_valid_until", { withTimezone: true }),

    // 来源
    /** agent_self_review | failure_signal | manual */
    source: text("source").notNull(),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    sourceUserId: text("source_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),

    confidence: real("confidence").notNull().default(0.5),

    // Reviewer Agent 初筛结果（FR4 §6.4 梯度审查）
    /** recommend_approve | recommend_reject | needs_human | NULL（未初筛） */
    preVerdict: text("pre_verdict"),
    /** Reviewer 输出的简短理由，≤ 200 字（SQL 层 CHECK） */
    preVerdictReasoning: text("pre_verdict_reasoning"),
    preVerdictAt: timestamp("pre_verdict_at", { withTimezone: true }),
    /** Reviewer 检测到的潜在冲突节点 ID 数组 */
    detectedConflicts: uuid("detected_conflicts")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    // 审查
    /** pending | approved | rejected | revision_requested */
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    reviewNotes: text("review_notes"),

    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => ({
    /** 审查队列主索引：按公司过滤 pending */
    companyPendingIdx: index("knowledge_drafts_company_pending_idx")
      .on(table.companyId, table.status, table.createdAt)
      .where(sql`status = 'pending'`),
    /** Reviewer Agent 找尚未初筛的 pending */
    unscreenedIdx: index("knowledge_drafts_unscreened_idx")
      .on(table.companyId, table.createdAt)
      .where(sql`status = 'pending' AND pre_verdict IS NULL`),
    /** 按来源过滤 */
    sourceStatusIdx: index("knowledge_drafts_source_status_idx").on(
      table.source,
      table.status,
    ),
  }),
);
