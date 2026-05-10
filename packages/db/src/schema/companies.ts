import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * companies 表 —— 租户（公司）级别实体。
 *
 * 每个 Paperclip 实例可以管理多个公司，每个公司拥有独立的
 * 成员、Agent、项目、预算和 Issue 命名空间。公司是数据隔离
 * 的最高层级，几乎所有业务表都通过 company_id 外键引用此表。
 */
export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    /** active=正常, paused=暂停（超出预算或手动暂停） */
    status: text("status").notNull().default("active"),
    /** 暂停原因，例如 "budget_exceeded" 或 "manual" */
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /** Issue 编号前缀，用于生成人类可读的 Issue 标识符（如 PAP-123） */
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    /** 自增计数器，用于生成下一个 Issue 编号（与 issuePrefix 拼接成 identifier） */
    issueCounter: integer("issue_counter").notNull().default(0),
    /** 月度预算上限（单位：美分），0 表示不限制 */
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    /** 本月已消费金额（美分），由 cost_events 汇总更新 */
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    /** 附件大小上限（字节），默认 10MB */
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    /**
     * 新 Agent 加入是否需要 Board 审批。
     * 对需人工审核 Agent 入职流程的安全控制。
     */
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    /**
     * 是否启用用户反馈数据共享（用于改进产品）。
     * 涉及隐私合规，需要用户明确同意后设为 true。
     */
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    /** 用户同意数据共享的时间戳 */
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    /** 执行同意的用户 ID */
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    /** 用户同意的条款版本号 */
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    /** 公司品牌色（十六进制颜色码），用于 UI 主题定制 */
    brandColor: text("brand_color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
  }),
);
