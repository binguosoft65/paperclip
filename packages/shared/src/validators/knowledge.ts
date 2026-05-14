import { z } from "zod";

/** 节点类型枚举（与 DB schema knowledge_nodes.type 对齐）*/
export const KNOWLEDGE_NODE_TYPES = ["concept", "lesson", "rule", "decision", "fact"] as const;
/** 层级枚举 */
export const KNOWLEDGE_LEVELS = ["personal", "project", "company"] as const;
/** 时效性枚举 */
export const KNOWLEDGE_VOLATILITIES = ["stable", "slow", "fast"] as const;
/** Draft 来源；Phase 1b-1 起 3 路都开放 */
export const KNOWLEDGE_DRAFT_SOURCES = [
  "manual",
  "agent_self_review",
  "failure_signal",
] as const;
/** @deprecated 用 KNOWLEDGE_DRAFT_SOURCES，下个 phase 移除 */
export const KNOWLEDGE_DRAFT_SOURCES_PHASE_1A = KNOWLEDGE_DRAFT_SOURCES;
/** Draft 状态机 */
export const KNOWLEDGE_DRAFT_STATUSES = ["pending", "approved", "rejected", "revision_requested"] as const;
/** Reviewer Agent 预判 */
export const KNOWLEDGE_PRE_VERDICTS = ["recommend_approve", "recommend_reject", "needs_human"] as const;

/** 节点内容最大长度（DB CHECK 8192，留 192 缓冲给应用层校验） */
const MAX_CONTENT_LENGTH = 8000;

export const createKnowledgeDraftSchema = z
  .object({
    target_node_id: z.string().uuid().nullable().optional(),
    title: z.string().min(1).max(500),
    content: z.string().min(1).max(MAX_CONTENT_LENGTH),
    type: z.enum(KNOWLEDGE_NODE_TYPES),
    level: z.enum(KNOWLEDGE_LEVELS),
    business_domain_name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
      message: "business_domain_name must be slug format (lowercase, hyphens)",
    }),
    metadata: z.record(z.unknown()).optional().default({}),
    volatility: z.enum(KNOWLEDGE_VOLATILITIES).optional(),
    valid_until: z.coerce.date().nullable().optional(),
    confidence: z.number().min(0).max(1).optional().default(0.5),
    source: z.enum(KNOWLEDGE_DRAFT_SOURCES).optional().default("manual"),
    source_run_id: z.string().uuid().nullable().optional(),
    source_issue_id: z.string().uuid().nullable().optional(),
    skip_review: z.boolean().optional().default(false),
  })
  .strict();

export type CreateKnowledgeDraft = z.infer<typeof createKnowledgeDraftSchema>;

export const approveKnowledgeDraftSchema = z
  .object({
    review_notes: z.string().max(2000).optional(),
  })
  .strict();

export type ApproveKnowledgeDraft = z.infer<typeof approveKnowledgeDraftSchema>;

export const rejectKnowledgeDraftSchema = z
  .object({
    review_notes: z.string().max(2000).optional(),
  })
  .strict();

export type RejectKnowledgeDraft = z.infer<typeof rejectKnowledgeDraftSchema>;

export const requestRevisionKnowledgeDraftSchema = z
  .object({
    review_notes: z.string().min(1).max(2000),
  })
  .strict();

export type RequestRevisionKnowledgeDraft = z.infer<typeof requestRevisionKnowledgeDraftSchema>;

export const batchApproveKnowledgeDraftSchema = z
  .object({
    draft_ids: z.array(z.string().uuid()).min(1).max(100),
    review_notes: z.string().max(2000).optional(),
  })
  .strict();

export type BatchApproveKnowledgeDraft = z.infer<typeof batchApproveKnowledgeDraftSchema>;

/** GET /api/knowledge/drafts 查询参数 */
export const listKnowledgeDraftsQuerySchema = z
  .object({
    status: z.string().optional(),     // csv，如 "pending,approved"
    source: z.string().optional(),
    pre_verdict: z.string().optional(),
    domain: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    cursor: z.string().optional(),
  })
  .strict();

export type ListKnowledgeDraftsQuery = z.infer<typeof listKnowledgeDraftsQuerySchema>;

/** GET /api/knowledge/search 查询参数 */
export const knowledgeSearchQuerySchema = z
  .object({
    q: z.string().min(1).max(2000),
    type: z.string().optional(),              // csv: lesson,rule,...
    domain: z.string().optional(),            // csv: software,content
    used_for: z.string().optional(),          // csv: bug-fix,architecture
    project_id: z.string().uuid().optional(),
    include_outdated: z.coerce.boolean().optional().default(false),
    limit: z.coerce.number().int().min(1).max(50).optional().default(5),
  })
  .strict();

export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

/** POST /api/knowledge/nodes/:id/feedback body */
export const knowledgeFeedbackSchema = z
  .object({
    feedback: z.enum(["helped", "outdated", "wrong", "irrelevant"]),
    run_id: z.string().uuid().nullable().optional(),
    issue_id: z.string().uuid().nullable().optional(),
    comment: z.string().max(2000).optional(),
  })
  .strict();

export type KnowledgeFeedback = z.infer<typeof knowledgeFeedbackSchema>;

export const KNOWLEDGE_FEEDBACK_VALUES = ["helped", "outdated", "wrong", "irrelevant"] as const;

// ──────────────────────────────────────────────────────────────────
// Phase 3b: Reviewer Agent 初筛
// ──────────────────────────────────────────────────────────────────

/**
 * Reviewer Agent 三档初筛结果（KNOWLEDGE_PRE_VERDICTS 的别名，供 Phase 3b 服务显式引用）。
 * - recommend_approve：质量高、与既有节点无冲突 → 人审可一键过
 * - recommend_reject：信息量低 / 与既有节点重复 / 无价值 → 人审可一键驳
 * - needs_human：confidence 中等、检测到 conflicts、或新主题需人判断
 */
export const KNOWLEDGE_PRE_VERDICT_VALUES = KNOWLEDGE_PRE_VERDICTS;
export type KnowledgePreVerdict = (typeof KNOWLEDGE_PRE_VERDICT_VALUES)[number];

/**
 * Reviewer 批量初筛入参。limit 用于单次最大处理 draft 数，避免长事务+OpenAI quota 突刺。
 */
export const reviewerRunQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type ReviewerRunQuery = z.infer<typeof reviewerRunQuerySchema>;

/**
 * 一键批量应用初筛建议：对 verdict=recommend_approve 的 draft 一键 approve；
 * 对 verdict=recommend_reject 的 draft 一键 reject。
 */
export const batchApplyVerdictSchema = z.object({
  verdict: z.enum(["recommend_approve", "recommend_reject"]),
  draft_ids: z.array(z.string().uuid()).min(1).max(100),
  review_notes: z.string().max(500).optional(),
}).strict();
export type BatchApplyVerdict = z.infer<typeof batchApplyVerdictSchema>;

// ──────────────────────────────────────────────────────────────────
// Phase 3c: Daily Healthcheck + Metrics + Alarm
// ──────────────────────────────────────────────────────────────────

/**
 * Phase 3c 健康指标枚举（与 PRD §7.5 一一对应）。
 *
 * 新增指标时同步：
 * - server/src/services/knowledge-healthcheck.ts 的 METRIC_THRESHOLDS / computer 注册
 * - packages/db/src/schema/knowledge_metrics.ts 的 metric_name 注释列表
 *
 * 这里用 const tuple 而非 enum,方便 z.enum() 推导出字面量联合类型,也方便
 * runtime 用 `KNOWLEDGE_METRIC_NAMES.includes(...)` 校验。
 */
export const KNOWLEDGE_METRIC_NAMES = [
  "weekly_new_drafts",
  "review_backlog_hours_p50",
  "helped_ratio",
  "avg_edges_per_node",
  "unresolved_conflicts",
  "stale_unchecked_fast",
] as const;

export type KnowledgeMetricName = (typeof KNOWLEDGE_METRIC_NAMES)[number];

/**
 * knowledge_metrics.status 三档,与 DB CHECK 约束镜像。
 * 同名常量在 packages/db/src/migrations/0084_*.sql 第 200 行附近。
 */
export const KNOWLEDGE_METRIC_STATUSES = [
  "healthy",
  "warning",
  "critical",
] as const;

export type KnowledgeMetricStatus = (typeof KNOWLEDGE_METRIC_STATUSES)[number];

/**
 * POST /api/knowledge/healthcheck/run 请求体。
 *
 * `metrics` 可选,缺省时跑全部 6 个;给子集时只跑指定的几个(用于手动调试或
 * routine 分批跑)。
 */
export const healthcheckRunQuerySchema = z
  .object({
    metrics: z
      .array(z.enum(KNOWLEDGE_METRIC_NAMES))
      .min(1)
      .optional()
      .default([...KNOWLEDGE_METRIC_NAMES]),
  })
  .strict();

export type HealthcheckRunQuery = z.infer<typeof healthcheckRunQuerySchema>;
