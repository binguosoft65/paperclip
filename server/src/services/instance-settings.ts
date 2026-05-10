import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";

// 实例配置采用单行模式（singleton），数据库中始终只存在一行记录，
// 通过 singleton_key="default" 唯一索引约束保证。这样设计简化了配置读写逻辑，
// 避免了多行冲突问题；若未来需要多实例配置，可扩展 singleton_key 枚举值。
const DEFAULT_SINGLETON_KEY = "default";

// 通用设置规范化函数：使用 Zod schema 校验并填充默认值。
// safeParse 而非 parse 是为了防止数据库中的陈旧数据因 schema 升级而报错，
// 兜底返回全默认值，保证系统在 schema 变更后仍可正常启动和运行。
function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const parsed = instanceGeneralSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      keyboardShortcuts: parsed.data.keyboardShortcuts ?? false,
      feedbackDataSharingPreference:
        parsed.data.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
      backupRetention: parsed.data.backupRetention ?? DEFAULT_BACKUP_RETENTION,
    };
  }
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
    backupRetention: DEFAULT_BACKUP_RETENTION,
  };
}

// 实验性设置规范化函数：与通用设置相同的兜底策略。
// 默认情况下列出的功能开关全部关闭，需要管理员手动开启；
// issueGraphLivenessAutoRecoveryLookbackHours 默认为 24 小时（业界常见窗口值）。
function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableEnvironments: parsed.data.enableEnvironments ?? false,
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableIssueGraphLivenessAutoRecovery: parsed.data.enableIssueGraphLivenessAutoRecovery ?? false,
      issueGraphLivenessAutoRecoveryLookbackHours:
        parsed.data.issueGraphLivenessAutoRecoveryLookbackHours ??
        DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
    };
  }
  return {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    issueGraphLivenessAutoRecoveryLookbackHours:
      DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  };
}

// 将数据库行转换为层安全的 InstanceSettings 领域对象。
// 经过 normalize 函数处理确保返回的结构字段完整、类型正确，
// 避免上层代码处理 undefined/null 的边界情况。
function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
  return {
    id: row.id,
    general: normalizeGeneralSettings(row.general),
    experimental: normalizeExperimentalSettings(row.experimental),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function instanceSettingsService(db: Db) {
  // 读取或创建单行配置记录。三层兜底：
  // 1. 先从数据库查询已有行；
  // 2. 如果不存在则尝试 INSERT（使用 onConflictDoUpdate 处理并发冲突）；
  // 3. 如果 INSERT 返回空（罕见并发回显问题），再查询一次确认。
  // 这种设计在保证单行约束的同时，也能优雅处理高并发初始化时的竞态条件。
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    if (created) return created;

    const raced = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return raced;

    throw new Error("Failed to initialize instance settings row");
  }

  return {
    // 获取完整配置对象，由 toInstanceSettings 统一处理字段规范化。
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return normalizeExperimentalSettings(row.experimental);
    },

    // 更新通用设置：采用"读取当前值 → 合并 patch → 写入"的偏更新模式。
    // 只传入部分字段即可更新，未传入的字段保留原值。这允许前端原子性地更新单个开关。
    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextGeneral = normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    // 更新实验性设置：与 updateGeneral 相同策略。
    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = normalizeExperimentalSettings({
        ...normalizeExperimentalSettings(current.experimental),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    // 获取所有公司 ID，用于审计日志广播。
    // 实例配置变更需要通知所有公司，这是多租户架构下的审计合规要求。
    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
