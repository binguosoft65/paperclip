// Run 的最终结果分类。succeeded 代表正常完成，failed 代表执行错误，
// cancelled 代表被手动或预算暂停取消，timed_out 代表超过超时时间。
export type HeartbeatRunOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

// Run 停止原因的细分类别，用于后续的重试决策和活跃度分析。
// 不同原因触发不同的后续行为：
// - completed / timeout: 正常结束或超时，可能触发续作
// - budget_paused / paused: 预算或手动暂停，不自动续作
// - max_turns_exhausted: 达到最大轮次，触发续作以继续执行
// - process_lost: 进程意外退出，标记为需要重试
// - adapter_failed: adapter 层错误，通常不可恢复
export type HeartbeatRunStopReason =
  | "completed"
  | "timeout"
  | "cancelled"
  | "budget_paused"
  | "paused"
  | "max_turns_exhausted"
  | "process_lost"
  | "adapter_failed";

// 超时策略定义：adapter 级别和单个 Run 级别的超时配置。
// timeoutSource 区分超时是来自显式配置还是系统默认值，用于排查超时根因。
export interface HeartbeatRunTimeoutPolicy {
  effectiveTimeoutSec: number | null;
  effectiveTimeoutMs?: number | null;
  timeoutConfigured: boolean;
  timeoutSource: "config" | "default" | "unknown";
}

// Run 停止时的完整元数据，包含停止原因和超时策略信息。
// 这个结构会被持久化到 resultJson 中，供后续分析和审计使用。
export interface HeartbeatRunStopMetadata extends HeartbeatRunTimeoutPolicy {
  stopReason: HeartbeatRunStopReason;
  timeoutFired: boolean;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// openclaw_gateway adapter 的特殊默认超时。该 adapter 通常用于需要长时间运行的 CI/CD 集成场景，
// 因此默认给 120 秒超时。其他 adapter 默认为 0（无超时），由 adapter 自身控制。
function defaultTimeoutSecForAdapter(adapterType: string) {
  return adapterType === "openclaw_gateway" ? 120 : 0;
}

// 规范化"最大轮次耗尽"的停止原因。兼容新旧两种命名（"max_turns_exhausted" 和旧的 "turn_limit_exhausted"）。
export function normalizeMaxTurnStopReason(value: unknown): Extract<HeartbeatRunStopReason, "max_turns_exhausted"> | null {
  return value === "max_turns_exhausted" || value === "turn_limit_exhausted"
    ? "max_turns_exhausted"
    : null;
}

// 根据 adapter 类型和配置解析超时策略。
// http adapter 使用 timeoutMs（毫秒级精度），其他 adapter 使用 timeoutSec（秒级）。
// 这种区分是因为 http 请求的超时通常以毫秒为单位配置，而 AI adapter 的轮次超时以秒为单位。
export function resolveHeartbeatRunTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): HeartbeatRunTimeoutPolicy {
  const config = adapterConfig ?? {};

  if (adapterType === "http") {
    const hasTimeoutMs = hasOwn(config, "timeoutMs");
    const rawTimeoutMs = hasTimeoutMs ? readFiniteNumber(config.timeoutMs) : 0;
    const timeoutMs = Math.max(0, Math.floor(rawTimeoutMs ?? 0));
    return {
      effectiveTimeoutSec: timeoutMs / 1000,
      effectiveTimeoutMs: timeoutMs,
      timeoutConfigured: timeoutMs > 0,
      timeoutSource: hasTimeoutMs ? "config" : "default",
    };
  }

  const hasTimeoutSec = hasOwn(config, "timeoutSec");
  const defaultTimeoutSec = defaultTimeoutSecForAdapter(adapterType);
  const rawTimeoutSec = hasTimeoutSec ? readFiniteNumber(config.timeoutSec) : defaultTimeoutSec;
  const timeoutSec = Math.max(0, Math.floor(rawTimeoutSec ?? defaultTimeoutSec));

  return {
    effectiveTimeoutSec: timeoutSec,
    timeoutConfigured: timeoutSec > 0,
    timeoutSource: hasTimeoutSec ? "config" : "default",
  };
}

// 从 outcome + error 信息推断 Run 的详细停止原因。
// 核心逻辑：
// 1. succeeded → completed（正常完成）
// 2. 检查 errorCode 是否是 max_turns_exhausted（轮次耗尽，可续作）
// 3. timed_out → timeout（超时，可续作）
// 4. failed 且 errorCode 为 process_lost → 进程丢失（需要重试）
// 5. cancelled → 根据 errorMessage 内容区分为 budget_paused / paused / cancelled
// 6. 其他失败 → adapter_failed（通常不可恢复）
// 这个分类直接决定了后续是否触发自动恢复或续作。
export function inferHeartbeatRunStopReason(input: {
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopReason {
  if (input.outcome === "succeeded") return "completed";
  const maxTurnStopReason = normalizeMaxTurnStopReason(input.errorCode);
  if (maxTurnStopReason) return maxTurnStopReason;
  if (input.outcome === "timed_out") return "timeout";
  if (input.outcome === "failed" && input.errorCode === "process_lost") return "process_lost";
  if (input.outcome === "cancelled") {
    const message = (input.errorMessage ?? "").toLowerCase();
    if (message.includes("budget")) return "budget_paused";
    if (message.includes("pause") || message.includes("paused")) return "paused";
    return "cancelled";
  }
  return "adapter_failed";
}

export function buildHeartbeatRunStopMetadata(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopMetadata {
  const timeoutPolicy = resolveHeartbeatRunTimeoutPolicy(input.adapterType, input.adapterConfig);
  const stopReason = inferHeartbeatRunStopReason(input);
  return {
    ...timeoutPolicy,
    stopReason,
    timeoutFired: stopReason === "timeout",
  };
}

export function mergeHeartbeatRunStopMetadata(
  resultJson: Record<string, unknown> | null | undefined,
  metadata: HeartbeatRunStopMetadata,
): Record<string, unknown> {
  const existingMaxTurnStopReason = normalizeMaxTurnStopReason(resultJson?.stopReason);
  return {
    ...(resultJson ?? {}),
    stopReason: existingMaxTurnStopReason ?? metadata.stopReason,
    effectiveTimeoutSec: metadata.effectiveTimeoutSec,
    timeoutConfigured: metadata.timeoutConfigured,
    timeoutSource: metadata.timeoutSource,
    timeoutFired: metadata.timeoutFired,
    ...(metadata.effectiveTimeoutMs != null ? { effectiveTimeoutMs: metadata.effectiveTimeoutMs } : {}),
  };
}
