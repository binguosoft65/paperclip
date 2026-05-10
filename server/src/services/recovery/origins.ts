// 恢复来源（origin kind）枚举：标识触发恢复流程的不同场景
// 每种来源对应一类自愈问题——issue 图活性、生产力审查、遗留 issue 恢复、沉默运行评估
export const RECOVERY_ORIGIN_KINDS = {
  issueGraphLivenessEscalation: "harness_liveness_escalation",
  issueProductivityReview: "issue_productivity_review",
  strandedIssueRecovery: "stranded_issue_recovery",
  staleActiveRunEvaluation: "stale_active_run_evaluation",
} as const;

// 恢复原因枚举：标识触发恢复的具体原因，当前仅用于 run 活性续作
export const RECOVERY_REASON_KINDS = {
  runLivenessContinuation: "run_liveness_continuation",
} as const;

// 恢复键前缀：用于在 issue 上标记活性检测事件和叶子节点的唯一键
export const RECOVERY_KEY_PREFIXES = {
  issueGraphLivenessIncident: "harness_liveness",
  issueGraphLivenessLeaf: "harness_liveness_leaf",
} as const;

export type RecoveryOriginKind = typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS];
export type RecoveryReasonKind = typeof RECOVERY_REASON_KINDS[keyof typeof RECOVERY_REASON_KINDS];
export type RecoveryKeyPrefix = typeof RECOVERY_KEY_PREFIXES[keyof typeof RECOVERY_KEY_PREFIXES];

// 判断一个 issue 的 originKind 是否为"遗留 issue 恢复"类型
// 用于在恢复流程中避免对恢复 issue 自身再次创建嵌套恢复，形成死循环
export function isStrandedIssueRecoveryOriginKind(originKind: string | null | undefined) {
  return originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
}

// 构建 Issue 图活性检测的 incident 唯一键
// 格式: harness_liveness:<companyId>:<issueId>:<state>:<leafId>
// leafId 取 blockerIssueId、participantAgentId 或 "none"，确保相同场景的 incident 幂等
export function buildIssueGraphLivenessIncidentKey(input: {
  companyId: string;
  issueId: string;
  state: string;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident,
    input.companyId,
    input.issueId,
    input.state,
    input.blockerIssueId ?? input.participantAgentId ?? "none",
  ].join(":");
}

// 反向解析 incident key 为结构化数据，用于查找或更新已有的升级 issue
export function parseIssueGraphLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  const parts = incidentKey.split(":");
  if (parts.length !== 5 || parts[0] !== RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident) return null;
  const [, companyId, issueId, state, leafIssueId] = parts;
  if (!companyId || !issueId || !state || !leafIssueId) return null;
  return { companyId, issueId, state, leafIssueId };
}

// 构建叶子节点的指纹键，用于查找是否已存在相同的叶子恢复 issue
// 与 incident key 不同，leaf key 不包含源 issueId，聚焦于"叶子问题 + 状态"的组合
export function buildIssueGraphLivenessLeafKey(input: {
  companyId: string;
  state: string;
  leafIssueId: string;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessLeaf,
    input.companyId,
    input.state,
    input.leafIssueId,
  ].join(":");
}
