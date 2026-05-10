import type { FeedbackDataSharingPreference } from "./feedback.js";

// 备份保留策略预设值。日备最多保留 14 天，周备最多 4 周，
// 月备最多 6 个月。此组合覆盖常见备份合规需求（如 SOC2 要求至少保留 30 天）。
export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
// Issue 活性自动恢复回看窗口默认 24 小时，最小 1 小时，最大 720 小时（30 天）。
// 30 天上限的考虑：极少需要回溯超过一个月的活性检测数据，且超长窗口会带来性能开销。
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24;
export const MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 1;
export const MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24 * 30;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

// 通用设置：控制实例级别的日常运行行为，影响所有组织。
// censorUsernameInLogs 用于隐私合规场景（如 SOC2/GDPR 审计）。
// feedbackDataSharingPreference 决定是否允许向产品团队共享用户反馈数据。
export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
}

// 实验性设置：默认全部关闭，需要管理员显式开启。
// 这些功能通常处于 beta 阶段，可能影响系统稳定性或数据一致性。
export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueGraphLivenessAutoRecoveryPreviewItem {
  issueId: string;
  identifier: string | null;
  title: string;
  state: string;
  severity: string;
  reason: string;
  recoveryIssueId: string;
  recoveryIdentifier: string | null;
  recoveryTitle: string | null;
  recommendedOwnerAgentId: string | null;
  incidentKey: string;
  latestDependencyUpdatedAt: string;
  dependencyPath: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
  }>;
}

export interface IssueGraphLivenessAutoRecoveryPreview {
  lookbackHours: number;
  cutoff: string;
  generatedAt: string;
  findings: number;
  recoverableFindings: number;
  skippedOutsideLookback: number;
  items: IssueGraphLivenessAutoRecoveryPreviewItem[];
}
