export interface SessionCompactionPolicy {
  enabled: boolean;
  maxSessionRuns: number;
  maxRawInputTokens: number;
  maxSessionAgeHours: number;
}

// 原生上下文管理能力分级：
// - confirmed: 适配器确实支持原生的上下文管理（如 Claude Code 的自动会话压缩），Paperclip 不需要做阈值压缩
// - likely: 估计可能支持但未完全确认
// - unknown: 不确定
// - none: 不支持原生上下文管理，Paperclip 必须自己负责会话压缩
export type NativeContextManagement = "confirmed" | "likely" | "unknown" | "none";

export interface AdapterSessionManagement {
  supportsSessionResume: boolean;
  nativeContextManagement: NativeContextManagement;
  defaultSessionCompaction: SessionCompactionPolicy;
}

export interface ResolvedSessionCompactionPolicy {
  policy: SessionCompactionPolicy;
  adapterSessionManagement: AdapterSessionManagement | null;
  explicitOverride: Partial<SessionCompactionPolicy>;
  source: "adapter_default" | "agent_override" | "legacy_fallback";
}

// 默认会话压缩策略：200 次运行或 200 万输入 token 或 72 小时后触发 session 轮换。
// 这些阈值适用于没有原生上下文管理的适配器。
const DEFAULT_SESSION_COMPACTION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 200,
  maxRawInputTokens: 2_000_000,
  maxSessionAgeHours: 72,
};

// Adapters with native context management still participate in session resume,
// but Paperclip should not rotate them using threshold-based compression.
// 适配器原生管理的策略：所有阈值设为 0，表示由适配器自己管理上下文轮换。
// session resume 仍然可用，但 Paperclip 不会主动触发 compaction。
const ADAPTER_MANAGED_SESSION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: 0,
  maxSessionAgeHours: 0,
};

// 旧的"会话式"适配器列表。在 ADAPTER_SESSION_MANAGEMENT 注册表引入之前，
// 这些类型的适配器默认启用会话功能。为了向后兼容，当适配器未在注册表中注册时，
// 通过检查此 Set 决定是否启用会话压缩。
export const LEGACY_SESSIONED_ADAPTER_TYPES = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

export const ADAPTER_SESSION_MANAGEMENT: Record<string, AdapterSessionManagement> = {
  acpx_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  claude_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  codex_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  cursor: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  gemini_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  opencode_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  pi_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  hermes_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

export function getAdapterSessionManagement(adapterType: string | null | undefined): AdapterSessionManagement | null {
  if (!adapterType) return null;
  return ADAPTER_SESSION_MANAGEMENT[adapterType] ?? null;
}

export function readSessionCompactionOverride(runtimeConfig: unknown): Partial<SessionCompactionPolicy> {
  const runtime = isRecord(runtimeConfig) ? runtimeConfig : {};
  const heartbeat = isRecord(runtime.heartbeat) ? runtime.heartbeat : {};
  const compaction = isRecord(
    heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction,
  )
    ? (heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction) as Record<string, unknown>
    : {};

  const explicit: Partial<SessionCompactionPolicy> = {};
  const enabled = readBoolean(compaction.enabled);
  const maxSessionRuns = readNumber(compaction.maxSessionRuns);
  const maxRawInputTokens = readNumber(compaction.maxRawInputTokens);
  const maxSessionAgeHours = readNumber(compaction.maxSessionAgeHours);

  if (enabled !== undefined) explicit.enabled = enabled;
  if (maxSessionRuns !== undefined) explicit.maxSessionRuns = maxSessionRuns;
  if (maxRawInputTokens !== undefined) explicit.maxRawInputTokens = maxRawInputTokens;
  if (maxSessionAgeHours !== undefined) explicit.maxSessionAgeHours = maxSessionAgeHours;

  return explicit;
}

export function resolveSessionCompactionPolicy(
  adapterType: string | null | undefined,
  runtimeConfig: unknown,
): ResolvedSessionCompactionPolicy {
  const adapterSessionManagement = getAdapterSessionManagement(adapterType);
  const explicitOverride = readSessionCompactionOverride(runtimeConfig);
  const hasExplicitOverride = Object.keys(explicitOverride).length > 0;
  const fallbackEnabled = Boolean(adapterType && LEGACY_SESSIONED_ADAPTER_TYPES.has(adapterType));
  const basePolicy = adapterSessionManagement?.defaultSessionCompaction ?? {
    ...DEFAULT_SESSION_COMPACTION_POLICY,
    enabled: fallbackEnabled,
  };

  return {
    policy: {
      enabled: explicitOverride.enabled ?? basePolicy.enabled,
      maxSessionRuns: explicitOverride.maxSessionRuns ?? basePolicy.maxSessionRuns,
      maxRawInputTokens: explicitOverride.maxRawInputTokens ?? basePolicy.maxRawInputTokens,
      maxSessionAgeHours: explicitOverride.maxSessionAgeHours ?? basePolicy.maxSessionAgeHours,
    },
    adapterSessionManagement,
    explicitOverride,
    source: hasExplicitOverride
      ? "agent_override"
      : adapterSessionManagement
        ? "adapter_default"
        : "legacy_fallback",
  };
}

export function hasSessionCompactionThresholds(policy: Pick<
  SessionCompactionPolicy,
  "maxSessionRuns" | "maxRawInputTokens" | "maxSessionAgeHours"
>) {
  return policy.maxSessionRuns > 0 || policy.maxRawInputTokens > 0 || policy.maxSessionAgeHours > 0;
}
