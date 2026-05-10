// 恢复操作使用"cheap"模型规格——恢复任务通常是轻量级的决策/重试
// 不需要昂贵的推理模型，用低成本模型即可完成，也避免资源浪费
export const RECOVERY_MODEL_PROFILE_KEY = "cheap" as const;

// 为恢复操作的 payload/context 注入 "cheap" 模型配置标记
// 该标记会传递给执行引擎，确保恢复 run 使用低成本模型完成，而非默认的全量模型
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
): T & { modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY } {
  return {
    ...input,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
  };
}

// 返回 assignee 适配器的覆盖配置，确保恢复 issue 的 assignee 使用低成本模型
// 用于创建恢复 issue 时传入 assigneeAdapterOverrides 字段
export function recoveryAssigneeAdapterOverrides() {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}
