// ---------------------------------------------------------------------------
// Minimal adapter-facing interfaces (no drizzle dependency)
// 本文件是所有适配器模块共享的类型定义，不依赖 drizzle ORM，确保可以被 UI 等前端代码安全导入。
// 核心设计原则：让适配器模块只依赖纯 TypeScript 类型，避免引入服务端数据库层的负担。
// ---------------------------------------------------------------------------

import type { SshRemoteExecutionSpec } from "./ssh.js";
import type { AdapterExecutionTarget } from "./execution-target.js";

export interface AdapterAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string | null;
  adapterConfig: unknown;
}

export interface AdapterRuntime {
  /**
   * Legacy single session id view. Prefer `sessionParams` + `sessionDisplayId`.
   * 保留 sessionId 是为了向下兼容旧版适配器，新代码应使用 sessionParams 来表达完整的会话状态。
   */
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

// ---------------------------------------------------------------------------
// Execution types (moved from server/src/adapters/types.ts)
// 从服务端迁移过来的执行相关类型，集中定义以便适配器模块和 UI 共享。
// ---------------------------------------------------------------------------

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type AdapterBillingType =
  | "api"
  | "subscription"
  | "metered_api"
  | "subscription_included"
  | "subscription_overage"
  | "credits"
  | "fixed"
  | "unknown";
// 计费类型枚举：区分 API 调用计费、订阅制、预购额度等模式，用于成本核算和展示。

export interface AdapterRuntimeServiceReport {
  id?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  issueId?: string | null;
  scopeType?: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId?: string | null;
  serviceName: string;
  status?: "starting" | "running" | "stopped" | "failed";
  lifecycle?: "shared" | "ephemeral";
  reuseKey?: string | null;
  command?: string | null;
  cwd?: string | null;
  port?: number | null;
  url?: string | null;
  providerRef?: string | null;
  ownerAgentId?: string | null;
  stopPolicy?: Record<string, unknown> | null;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}

export type AdapterExecutionErrorFamily = "transient_upstream";

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorFamily?: AdapterExecutionErrorFamily | null;
  retryNotBefore?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary;
  /**
   * Legacy single session id output. Prefer `sessionParams` + `sessionDisplayId`.
   * 与 AdapterRuntime.sessionId 对应，保留以兼容旧适配器。
   */
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  runtimeServices?: AdapterRuntimeServiceReport[];
  summary?: string | null;
  clearSession?: boolean;
  question?: {
    prompt: string;
    choices: Array<{
      key: string;
      label: string;
      description?: string;
    }>;
  } | null;
}

export interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}

export interface AdapterInvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  env?: Record<string, string>;
  prompt?: string;
  promptMetrics?: Record<string, number>;
  context?: Record<string, unknown>;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtimeCommandSpec?: AdapterRuntimeCommandSpec | null;
  executionTarget?: AdapterExecutionTarget | null;
  /**
   * Legacy remote transport view. Prefer `executionTarget`, which is the
   * provider-neutral contract produced by core runtime code.
   * 旧版远程传输方式，保留以支持从旧配置反序列化的场景。
   */
  executionTransport?: {
    remoteExecution?: Record<string, unknown> | null;
  };
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  authToken?: string;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export type AdapterModelProfileKey = "cheap";

export interface AdapterModelProfileDefinition {
  key: AdapterModelProfileKey;
  label: string;
  description?: string;
  adapterConfig: Record<string, unknown>;
  source?: "adapter_default" | "discovered";
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export type AdapterSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AdapterSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AdapterSkillOrigin =
  | "company_managed"
  | "paperclip_required"
  | "user_installed"
  | "external_unknown";

export interface AdapterSkillEntry {
  key: string;
  runtimeName: string | null;
  desired: boolean;
  managed: boolean;
  required?: boolean;
  requiredReason?: string | null;
  state: AdapterSkillState;
  origin?: AdapterSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AdapterSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: AdapterSkillSyncMode;
  desiredSkills: string[];
  entries: AdapterSkillEntry[];
  warnings: string[];
}

export interface AdapterSkillContext {
  agentId: string;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

export interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  /**
   * Optional execution target the adapter should run probes against.
   *
   * If omitted (or `kind === "local"`), the adapter tests on the Paperclip
   * host. For SSH/sandbox targets the adapter should run command/auth probes
   * inside the remote environment so the result reflects what an agent run
   * would actually see at execution time.
   * 远程环境连通性测试必须在目标环境内部执行，而非本机，才能真实反映 Agent 运行时的状态。
   */
  executionTarget?: AdapterExecutionTarget | null;
  /**
   * Friendly name of the environment being tested (when `executionTarget` is set).
   * Surfaced in check messages so users see which environment the probe ran in.
   */
  environmentName?: string | null;
  deployment?: {
    mode?: "local_trusted" | "authenticated";
    exposure?: "private" | "public";
    bindHost?: string | null;
    allowedHostnames?: string[];
  };
}

/** Payload for the onHireApproved adapter lifecycle hook (e.g. join-request or hire_agent approval). */
export interface HireApprovedPayload {
  companyId: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  /** "join_request" | "approval" */
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt: string;
  /** Canonical operator-facing message for cloud adapters to show the user. */
  message: string;
}

/** Result of onHireApproved hook; failures are non-fatal to the approval flow. */
export interface HireApprovedHookResult {
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Quota window types — used by adapters that can report provider quota/rate-limit state
// ---------------------------------------------------------------------------

/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
}

/** result for one provider from getQuotaWindows() */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
}

// ---------------------------------------------------------------------------
// Adapter config schema — declarative UI config for external adapters
// ---------------------------------------------------------------------------

export interface ConfigFieldOption {
  label: string;
  value: string;
  /** Optional group key for categorizing options (e.g. provider name) */
  group?: string;
}

export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea" | "combobox";
  options?: ConfigFieldOption[];
  default?: unknown;
  hint?: string;
  required?: boolean;
  group?: string;
  /** Optional metadata — not rendered, but available to custom UI logic */
  meta?: Record<string, unknown>;
}

export interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

export interface AdapterRuntimeCommandSpec {
  /**
   * The command Paperclip should execute for this adapter in the current config.
   */
  command: string;
  /**
   * Optional command name/path to probe for availability before launch.
   * Defaults to `command` when omitted by the consumer.
   */
  detectCommand?: string | null;
  /**
   * Optional shell snippet that can install or expose the adapter command in a
   * fresh remote runtime. It should be idempotent.
   */
  installCommand?: string | null;
}

export interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  listSkills?: (ctx: AdapterSkillContext) => Promise<AdapterSkillSnapshot>;
  syncSkills?: (ctx: AdapterSkillContext, desiredSkills: string[]) => Promise<AdapterSkillSnapshot>;
  sessionCodec?: AdapterSessionCodec;
  sessionManagement?: import("./session-compaction.js").AdapterSessionManagement;
  supportsLocalAgentJwt?: boolean;
  models?: AdapterModel[];
  listModels?: () => Promise<AdapterModel[]>;
  modelProfiles?: AdapterModelProfileDefinition[];
  listModelProfiles?: () => Promise<AdapterModelProfileDefinition[]>;
  /**
   * Optional explicit refresh hook for model discovery.
   * Use this when the adapter caches discovered models and needs a bypass path
   * so the UI can fetch newly released models without waiting for cache expiry
   * or a Paperclip code update.
   */
  refreshModels?: () => Promise<AdapterModel[]>;
  agentConfigurationDoc?: string;
  /**
   * Optional lifecycle hook when an agent is approved/hired (join-request or hire_agent approval).
   * adapterConfig is the agent's adapter config so the adapter can e.g. send a callback to a configured URL.
   */
  onHireApproved?: (
    payload: HireApprovedPayload,
    adapterConfig: Record<string, unknown>,
  ) => Promise<HireApprovedHookResult>;
  /**
   * Optional: fetch live provider quota/rate-limit windows for this adapter.
   * Returns a ProviderQuotaResult so the server can aggregate across adapters
   * without knowing provider-specific credential paths or API shapes.
   */
  getQuotaWindows?: () => Promise<ProviderQuotaResult>;
  /**
   * Optional: detect the currently configured model from local config files.
   * Returns the detected model/provider and the config source, or null if
   * the adapter does not support detection or no config is found.
   */
  detectModel?: () => Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null>;
  /**
   * Optional: return a declarative config schema so the UI can render
   * adapter-specific form fields without shipping React components.
   * Dynamic options (e.g. scanning a profiles directory) should be
   * resolved inside this method — the caller receives a fully hydrated schema.
   */
  getConfigSchema?: () => Promise<AdapterConfigSchema> | AdapterConfigSchema;

  // ---------------------------------------------------------------------------
  // Adapter capability flags
  //
  // These allow adapter plugins to declare what "local" capabilities they
  // support, replacing hardcoded type lists in the server and UI.
  // All flags are optional — when undefined, the server falls back to
  // legacy hardcoded lists for built-in adapters.
  // 这些标志位让适配器插件可以声明自身能力，服务端和 UI 不再需要维护硬编码的适配器类型列表。
  // ---------------------------------------------------------------------------

  /**
   * Adapter supports managed instructions bundle (AGENTS.md files).
   * When true, the server uses instructionsPathKey (default "instructionsFilePath")
   * to resolve the instructions config key, and the UI shows the bundle editor.
   * Built-in local adapters default to true; external plugins must opt in.
   */
  supportsInstructionsBundle?: boolean;

  /**
   * The adapterConfig key that holds the instructions file path.
   * Defaults to "instructionsFilePath" when supportsInstructionsBundle is true.
   * 外部适配器需要显式指定配置键名，因为无法像内建适配器那样通过约定路径发现。
   */
  instructionsPathKey?: string;

  /**
   * Adapter needs runtime skill entries materialized (written to disk)
   * before being passed via config. Used by adapters that scan a directory
   * rather than reading config.paperclipRuntimeSkills.
   */
  requiresMaterializedRuntimeSkills?: boolean;
  /**
   * Optional: describe how this adapter's runtime command should be launched
   * and provisioned in fresh remote environments such as sandboxes.
   * 沙箱环境在首次启动时可能需要安装或探测命令是否存在，通过此方法提供安装脚本和探测命令。
   */
  getRuntimeCommandSpec?: (config: Record<string, unknown>) => AdapterRuntimeCommandSpec | null;
}

// ---------------------------------------------------------------------------
// UI types (moved from ui/src/adapters/types.ts)
// 转录条目类型，用于在前端展示 Agent 与适配器的交互历史。所有条目都包含时间戳，支持有序渲染。
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string }
  | { kind: "diff"; ts: string; changeType: "add" | "remove" | "context" | "hunk" | "file_header" | "truncation"; text: string };

export type StdoutLineParser = (line: string, ts: string) => TranscriptEntry[];

// ---------------------------------------------------------------------------
// CLI types (moved from cli/src/adapters/types.ts)
// CLI 端适配器接口，用于终端输出格式化，不需要完整的服务端适配器模块。
// ---------------------------------------------------------------------------

export interface CLIAdapterModule {
  type: string;
  formatStdoutEvent: (line: string, debug: boolean) => void;
}

// ---------------------------------------------------------------------------
// UI config form values (moved from ui/src/components/AgentConfigForm.tsx)
// Agent 创建/编辑表单的配置值类型，涵盖本地运行、远程 SSH、沙箱等多种执行目标。
// ---------------------------------------------------------------------------

export interface CreateConfigValues {
  adapterType: string;
  cwd: string;
  instructionsFilePath?: string;
  promptTemplate: string;
  model: string;
  thinkingEffort: string;
  /**
   * Optional cheap model profile config for new agents on adapters that
   * support model profiles. Persisted under
   * `runtimeConfig.modelProfiles.cheap.adapterConfig`, never on the primary
   * `adapterConfig`.
   */
  cheapModel?: string;
  cheapModelEnabled?: boolean;
  chrome: boolean;
  dangerouslySkipPermissions: boolean;
  search: boolean;
  fastMode: boolean;
  dangerouslyBypassSandbox: boolean;
  command: string;
  args: string;
  extraArgs: string;
  envVars: string;
  envBindings: Record<string, unknown>;
  url: string;
  bootstrapPrompt: string;
  payloadTemplateJson?: string;
  workspaceStrategyType?: string;
  workspaceBaseRef?: string;
  workspaceBranchTemplate?: string;
  worktreeParentDir?: string;
  runtimeServicesJson?: string;
  defaultEnvironmentId?: string;
  maxTurnsPerRun: number;
  heartbeatEnabled: boolean;
  intervalSec: number;
  /** Arbitrary key-value pairs populated by schema-driven config fields. */
  adapterSchemaValues?: Record<string, unknown>;
}
