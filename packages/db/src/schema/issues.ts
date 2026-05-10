import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { executionWorkspaces } from "./execution_workspaces.js";

/**
 * issues 表 —— 核心业务编排单元（任务/Issue）。
 *
 * 每个 Issue 代表一个待完成的工作项，是 Agent 执行的最小调度单元。
 * Issue 可以关联项目、目标、父 Issue（子任务分解），
 * 支持分配 Agent 或用户、监工模式（monitor）、
 * 执行工作空间绑定、来源追踪等丰富功能。
 *
 * 约束说明：
 * - identifier：人类可读的唯一标识（如 "PAP-123"），由公司前缀+计数器生成
 * - origin_kind + origin_id + origin_fingerprint：用于去重和追踪 Issue 来源
 * - monitor_*：监工机制，在 Issue 完成后自动检查结果并决定下一步
 */
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id),
    title: text("title").notNull(),
    description: text("description"),
    /** backlog=待办, todo=预分配, in_progress=执行中, in_review=审查中, blocked=阻塞, done=完成, cancelled=取消 */
    status: text("status").notNull().default("backlog"),
    /** 工作模式：'standard'（标准）, 'monitor'（监工）, 'recovery'（恢复）等 */
    workMode: text("work_mode").notNull().default("standard"),
    priority: text("priority").notNull().default("medium"),
    /** 负责执行的 Agent */
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    /** 负责执行的人类用户（当分配给用户时） */
    assigneeUserId: text("assignee_user_id"),
    /**
     * Checkout run ID：Agent 锁定并签出此 Issue 时的心跳运行 ID。
     * 用于追踪哪个运行实例正在处理此 Issue。
     */
    checkoutRunId: uuid("checkout_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    /** 实际执行的工作流运行 ID */
    executionRunId: uuid("execution_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    /** 负责执行的 Agent 名称键（用于日志和监控） */
    executionAgentNameKey: text("execution_agent_name_key"),
    /** Issue 被锁定执行的时间戳（防止并发执行） */
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    /** 公司级自增 Issue 序号（与公司 issue_prefix 组合成 identifier） */
    issueNumber: integer("issue_number"),
    /**
     * 人类可读唯一标识符：`{issue_prefix}-{issueNumber}`（如 "PAP-123"）。
     * 在 UI 和外部引用中使用。
     */
    identifier: text("identifier"),
    /**
     * 来源类型：'manual'（手动创建）、'routine_execution'（定时任务触发）、
     * 'harness_liveness_escalation'（健康检查升级）等。
     * 用于去重和追踪 Issue 来源。
     */
    originKind: text("origin_kind").notNull().default("manual"),
    /** 来源实体 ID（如 routine_run_id） */
    originId: text("origin_id"),
    /** 来源运行 ID */
    originRunId: text("origin_run_id"),
    /**
     * 来源指纹：与 origin_kind + origin_id 共同构成唯一性约束。
     * 默认值为 "default"，不参与唯一索引时为占位符。
     */
    originFingerprint: text("origin_fingerprint").notNull().default("default"),
    /** 请求深度：子任务递归创建时递增，用于防止无限递归 */
    requestDepth: integer("request_depth").notNull().default(0),
    billingCode: text("billing_code"),
    /** 分配给 Agent 时的适配器覆盖配置 */
    assigneeAdapterOverrides: jsonb("assignee_adapter_overrides").$type<Record<string, unknown>>(),
    /** 执行策略配置（重试、超时、并行限制等） */
    executionPolicy: jsonb("execution_policy").$type<Record<string, unknown>>(),
    /** Issue 执行上下文快照（用于中断恢复） */
    executionState: jsonb("execution_state").$type<Record<string, unknown>>(),
    /** 监工机制：下次自动检查运行结果的时间 */
    monitorNextCheckAt: timestamp("monitor_next_check_at", { withTimezone: true }),
    /** 监工唤醒请求时间 */
    monitorWakeRequestedAt: timestamp("monitor_wake_requested_at", { withTimezone: true }),
    /** 监工上次触发时间 */
    monitorLastTriggeredAt: timestamp("monitor_last_triggered_at", { withTimezone: true }),
    /** 监工尝试次数 */
    monitorAttemptCount: integer("monitor_attempt_count").notNull().default(0),
    monitorNotes: text("monitor_notes"),
    monitorScheduledBy: text("monitor_scheduled_by"),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    /** 执行工作空间偏好：'auto'（自动）、'reuse'（复用）、'new'（新建） */
    executionWorkspacePreference: text("execution_workspace_preference"),
    executionWorkspaceSettings: jsonb("execution_workspace_settings").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("issues_company_status_idx").on(table.companyId, table.status),
    assigneeStatusIdx: index("issues_company_assignee_status_idx").on(
      table.companyId,
      table.assigneeAgentId,
      table.status,
    ),
    assigneeUserStatusIdx: index("issues_company_assignee_user_status_idx").on(
      table.companyId,
      table.assigneeUserId,
      table.status,
    ),
    parentIdx: index("issues_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("issues_company_project_idx").on(table.companyId, table.projectId),
    originIdx: index("issues_company_origin_idx").on(table.companyId, table.originKind, table.originId),
    projectWorkspaceIdx: index("issues_company_project_workspace_idx").on(table.companyId, table.projectWorkspaceId),
    executionWorkspaceIdx: index("issues_company_execution_workspace_idx").on(table.companyId, table.executionWorkspaceId),
    dueMonitorIdx: index("issues_company_monitor_due_idx").on(table.companyId, table.monitorNextCheckAt),
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier),
    titleSearchIdx: index("issues_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("issues_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    descriptionSearchIdx: index("issues_description_search_idx").using("gin", table.description.op("gin_trgm_ops")),
    openRoutineExecutionIdx: uniqueIndex("issues_open_routine_execution_uq")
      .on(table.companyId, table.originKind, table.originId, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'routine_execution'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.executionRunId} is not null
          and ${table.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')`,
      ),
    activeLivenessRecoveryIncidentIdx: uniqueIndex("issues_active_liveness_recovery_incident_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeLivenessRecoveryLeafIdx: uniqueIndex("issues_active_liveness_recovery_leaf_uq")
      .on(table.companyId, table.originKind, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originFingerprint} <> 'default'
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStaleRunEvaluationIdx: uniqueIndex("issues_active_stale_run_evaluation_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stale_active_run_evaluation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeProductivityReviewIdx: uniqueIndex("issues_active_productivity_review_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'issue_productivity_review'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStrandedIssueRecoveryIdx: uniqueIndex("issues_active_stranded_issue_recovery_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stranded_issue_recovery'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
  }),
);
