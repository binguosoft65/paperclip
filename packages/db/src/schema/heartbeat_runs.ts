import { type AnyPgColumn, pgTable, uuid, text, timestamp, jsonb, index, integer, bigint, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

/**
 * heartbeat_runs 表 —— Agent 心跳运行记录（核心执行追踪表）。
 *
 * 每个 Agent 通过心跳循环持续工作。每次心跳循环的一次完整执行
 * 就是一条 heartbeat run。运行期间 Agent 可以处理多个 Issue、
 * 执行命令、产生输出。此表追踪每次运行的完整生命周期，
 * 包括进程信息、输出日志、错误处理和重试机制。
 */
export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    /** 调用来源：'on_demand'（按需）、'wakeup'（唤醒）、'schedule'（定时）等 */
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    /** queued=排队中, running=运行中, success=成功, failed=失败, cancelled=取消 */
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    /** 运行开始前的会话 ID（用于恢复追踪） */
    sessionIdBefore: text("session_id_before"),
    /** 运行结束后的会话 ID（如果会话有变更） */
    sessionIdAfter: text("session_id_after"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    externalRunId: text("external_run_id"),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastOutputSeq: integer("last_output_seq").notNull().default(0),
    lastOutputStream: text("last_output_stream"),
    lastOutputBytes: bigint("last_output_bytes", { mode: "number" }),
    /** 重试链：指向被重试的原始 run（用于追踪重试历史） */
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    /** 进程丢失后的重试计数 */
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),
    scheduledRetryAt: timestamp("scheduled_retry_at", { withTimezone: true }),
    scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
    scheduledRetryReason: text("scheduled_retry_reason"),
    /**
     * Issue 评论状态：追踪是否需要为此运行发布评论更新。
     * 'not_applicable' / 'pending' / 'satisfied'
     */
    issueCommentStatus: text("issue_comment_status").notNull().default("not_applicable"),
    /** 满足 Issue 评论条件的评论 ID */
    issueCommentSatisfiedByCommentId: uuid("issue_comment_satisfied_by_comment_id"),
    issueCommentRetryQueuedAt: timestamp("issue_comment_retry_queued_at", { withTimezone: true }),
    /** 健康状态：用于检测 Agent 是否无响应 */
    livenessState: text("liveness_state"),
    livenessReason: text("liveness_reason"),
    /** 连续执行次数（Agent 在运行上下文中持续工作） */
    continuationAttempt: integer("continuation_attempt").notNull().default(0),
    /** 最后一次有意义的操作时间（用于判断是否停滞） */
    lastUsefulActionAt: timestamp("last_useful_action_at", { withTimezone: true }),
    /** 下次执行的动作提示 */
    nextAction: text("next_action"),
    /** 运行上下文快照（用于恢复长时间运行） */
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
    companyLivenessIdx: index("heartbeat_runs_company_liveness_idx").on(
      table.companyId,
      table.livenessState,
      table.createdAt,
    ),
    companyStatusLastOutputIdx: index("heartbeat_runs_company_status_last_output_idx").on(
      table.companyId,
      table.status,
      table.lastOutputAt,
    ),
    companyStatusProcessStartedIdx: index("heartbeat_runs_company_status_process_started_idx").on(
      table.companyId,
      table.status,
      table.processStartedAt,
    ),
  }),
);
