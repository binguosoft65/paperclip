// Daytona 沙箱 Provider 插件：将 Daytona 远程沙箱注册为 Paperclip 执行环境。
// 核心职责：沙箱生命周期管理（创建/启动/停止/删除/SSH 执行）、租约管理、
// 工作空间代码同步（Git bundle 增量传输）、环境配置校验。
// 支持 snapshot 恢复和 image 重建两种沙箱创建模式。
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Daytona, DaytonaNotFoundError, DaytonaTimeoutError } from "@daytonaio/sdk";
import type {
  CreateSandboxBaseParams,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  DaytonaConfig,
  Resources,
  Sandbox,
} from "@daytonaio/sdk";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

// Daytona 驱动配置的运行时类型定义
// 所有字段均从用户提交的原始 JSON 解析而来，parseDriverConfig 负责类型转换和默认值填充
// 与 manifest 中的 configSchema 对应，但这里只保留运行时关心的字段
interface DaytonaDriverConfig {
  apiKey: string | null;
  apiUrl: string | null;
  target: string | null;
  snapshot: string | null;
  image: string | null;
  language: string | null;
  timeoutMs: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  gpu: number | null;
  autoStopInterval: number | null;
  autoArchiveInterval: number | null;
  autoDeleteInterval: number | null;
  reuseLease: boolean;
}

// 这些 helper 函数保证了用户输入经过严格的类型校验，避免运行时因非法值崩溃
// 它们主动处理 null、空字符串、NaN 等边缘情况，返回 null 表示"未提供"
function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// 将用户提交的原始配置（来自 JSON）转换为强类型的 DaytonaDriverConfig
// 这里做了一层防御性编程：非法的 timeoutMs 会兜底到默认值，而不是直接崩溃
function parseDriverConfig(raw: Record<string, unknown>): DaytonaDriverConfig {
  const timeoutMs = Number(raw.timeoutMs ?? 300_000);
  return {
    apiKey: parseOptionalString(raw.apiKey),
    apiUrl: parseOptionalString(raw.apiUrl),
    target: parseOptionalString(raw.target),
    snapshot: parseOptionalString(raw.snapshot),
    image: parseOptionalString(raw.image),
    language: parseOptionalString(raw.language),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 300_000,
    cpu: parseOptionalNumber(raw.cpu),
    memory: parseOptionalNumber(raw.memory),
    disk: parseOptionalNumber(raw.disk),
    gpu: parseOptionalNumber(raw.gpu),
    autoStopInterval: parseOptionalInteger(raw.autoStopInterval),
    autoArchiveInterval: parseOptionalInteger(raw.autoArchiveInterval),
    autoDeleteInterval: parseOptionalInteger(raw.autoDeleteInterval),
    reuseLease: raw.reuseLease === true,
  };
}

// API Key 解析策略：显式配置优先，环境变量作为兜底
// 这样用户可以在 Paperclip 的环境配置中指定密钥，也可以利用 CI/CD 流水线的环境变量注入
// 抛出清晰的错误消息有助于用户快速定位配置问题
function resolveApiKey(config: DaytonaDriverConfig): string {
  if (config.apiKey) {
    return config.apiKey;
  }
  const envApiKey = process.env.DAYTONA_API_KEY?.trim() ?? "";
  if (!envApiKey) {
    throw new Error("Daytona sandbox environments require an API key in config or DAYTONA_API_KEY.");
  }
  return envApiKey;
}

// 创建 Daytona SDK 客户端实例，复用相同的配置模式
// Daytona 客户端是线程安全的，每个请求都独立创建新实例以避免并发状态污染
function createDaytonaClient(config: DaytonaDriverConfig): Daytona {
  const clientConfig: DaytonaConfig = {
    apiKey: resolveApiKey(config),
  };
  if (config.apiUrl) clientConfig.apiUrl = config.apiUrl;
  if (config.target) clientConfig.target = config.target;
  return new Daytona(clientConfig);
}

// 按需构建资源规格对象：当用户没有指定任何资源限制时返回 undefined
// 让 Daytona 使用其默认分配，避免传空值导致 SDK 报错
function buildResources(config: DaytonaDriverConfig): Resources | undefined {
  if (config.cpu == null && config.memory == null && config.disk == null && config.gpu == null) {
    return undefined;
  }
  return {
    cpu: config.cpu ?? undefined,
    memory: config.memory ?? undefined,
    disk: config.disk ?? undefined,
    gpu: config.gpu ?? undefined,
  };
}

// 根据配置决定沙箱是从镜像还是快照创建
// image 和 snapshot 互斥（已在 validateConfig 中校验），但这里仍然做了防御性判断
// 使用 image 时可以同时指定资源规格，用 snapshot 时资源由快照决定
function buildCreateParams(
  config: DaytonaDriverConfig,
  labels: Record<string, string>,
): CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams {
  const base: CreateSandboxBaseParams = {
    labels,
    language: config.language ?? undefined,
    autoStopInterval: config.autoStopInterval ?? undefined,
    autoArchiveInterval: config.autoArchiveInterval ?? undefined,
    autoDeleteInterval: config.autoDeleteInterval ?? undefined,
  };
  if (config.image) {
    return {
      ...base,
      image: config.image,
      resources: buildResources(config),
    };
  }
  return {
    ...base,
    snapshot: config.snapshot ?? undefined,
  };
}

// 给 Daytona 沙箱打上 Paperclip 元数据标签
// 这些标签用于在 Daytona 仪表盘和 API 层面识别沙箱归属，便于审计和清理
// reuseLease 标签让运维人员可以区分哪些沙箱是"用完即删"的
function buildSandboxLabels(input: {
  companyId: string;
  environmentId: string;
  runId?: string;
  reuseLease: boolean;
}): Record<string, string> {
  return {
    "paperclip-provider": "daytona",
    "paperclip-company-id": input.companyId,
    "paperclip-environment-id": input.environmentId,
    "paperclip-reuse-lease": input.reuseLease ? "true" : "false",
    ...(input.runId ? { "paperclip-run-id": input.runId } : {}),
  };
}

// 毫秒转秒（Daytona SDK 的 API 以秒为单位），至少为 1 秒
// 使用 Math.ceil 保证如果用户设置了很小的值也不会截断为 0
function toTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

// 运行时超时解析：允许单次执行请求覆盖全局超时设置
// 返回值必须为正整数，若传入非法值则回退到配置中的默认值
function resolveTimeoutMs(paramsTimeoutMs: number | undefined, config: DaytonaDriverConfig): number {
  return paramsTimeoutMs != null && Number.isFinite(paramsTimeoutMs) && paramsTimeoutMs > 0
    ? Math.trunc(paramsTimeoutMs)
    : config.timeoutMs;
}

// 统一错误消息格式，确保无论抛出什么类型都能拿到可读的字符串
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 使用 URL 构造函数做 URL 合法性校验，比正则表达式更可靠
function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// 确保沙箱处于已启动状态，用于租赁恢复场景
// 如果沙箱处于错误状态且可恢复则尝试 recover，否则直接抛错
// 避免在已停止的沙箱上执行命令时收到含糊的 Daytona API 错误
async function ensureSandboxStarted(sandbox: Sandbox, timeoutSeconds: number): Promise<void> {
  if (sandbox.state === "started") return;
  if (sandbox.state === "error") {
    if (sandbox.recoverable) {
      await sandbox.recover(timeoutSeconds);
      return;
    }
    throw new Error(`Daytona sandbox ${sandbox.id} is in an unrecoverable error state: ${sandbox.errorReason ?? "unknown error"}`);
  }
  await sandbox.start(timeoutSeconds);
}

// 解析沙箱内的工作目录：优先使用 Daytona 的工作目录，然后是用户 home 目录，最后是硬编码兜底
// 统一创建 paperclip-workspace 子目录，确保执行命令时有一个一致的 workspace 路径
// 不同 Sandbox 镜像的工作目录可能不同，此函数做了三层 fallback
async function resolveSandboxWorkingDirectory(sandbox: Sandbox): Promise<string> {
  const root = (await sandbox.getWorkDir())?.trim()
    || (await sandbox.getUserHomeDir())?.trim()
    || "/home/daytona";
  const remoteCwd = path.posix.join(root, "paperclip-workspace");
  await sandbox.fs.createFolder(remoteCwd, "755");
  return remoteCwd;
}

// 检测沙箱内可用的 shell 类型
// 在沙箱内运行探测命令判断 bash 是否可用，兜底到 sh
// 这个信息后续被用来决定构建登录脚本时是否可以利用 bash 特有的特性
async function detectSandboxShellCommand(sandbox: Sandbox, timeoutSeconds: number): Promise<"bash" | "sh"> {
  try {
    const result = await sandbox.process.executeCommand(
      "if command -v bash >/dev/null 2>&1; then printf bash; else printf sh; fi",
      undefined,
      undefined,
      timeoutSeconds,
    );
    return result.result?.trim() === "bash" ? "bash" : "sh";
  } catch {
    return "sh";
  }
}

// 构建租赁元数据：包含沙箱标识、配置快照和执行环境信息
// 这些元数据会被持久化在 Paperclip 的租赁记录中，用于后续恢复操作（resume）时重建上下文
// resumedLease 字段让上层区分这是新创建还是恢复的沙箱
function leaseMetadata(input: {
  config: DaytonaDriverConfig;
  sandbox: Sandbox;
  shellCommand: "bash" | "sh";
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "daytona",
    shellCommand: input.shellCommand,
    sandboxId: input.sandbox.id,
    sandboxName: input.sandbox.name,
    sandboxState: input.sandbox.state ?? null,
    image: input.config.image,
    snapshot: input.config.snapshot,
    target: input.sandbox.target,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

// Shell 参数安全引用：用单引号包裹并用 '"'"' 转义内部的单引号
// 防止用户传入文件名或命令参数中含有空格、引号等特殊字符导致的注入或解析错误
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// 校验环境变量键名是否合法：必须符合 shell 标识符规范
// 防止通过 env 注入非法键名导致 shell 脚本执行失败
function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// Mirror the E2B sandbox executor: source common login profiles (and nvm)
// before running the command so Daytona one-shot calls see the same PATH an
// interactive shell would. Without this, adapter probes can fail to resolve
// CLIs that are installed via profile-driven PATH mutations inside the
// sandbox image.
// 构建登录 shell 脚本：在执行用户命令前 source 常见的 profile 文件
// Daytona 的 executeCommand 默认在非登录、非交互 shell 中运行，PATH 中缺少 nvm 等工具
// 通过模拟登录 shell 的初始化流程，保证沙箱内所有 CLI 工具都可被解析到
function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinPath?: string;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const redirectedCommand = input.stdinPath
    ? `${commandParts} < ${shellQuote(input.stdinPath)}`
    : commandParts;
  // Each `executeCommand` call runs in its own shell, so we don't `exec`-
  // replace it; running the command as the last `&&`-chained line is enough to
  // surface the right exit code. Env is interpolated after profile sourcing so
  // the caller's env wins over any defaults the profile exports.
  const finalLine = envArgs.length > 0
    ? `env ${envArgs.join(" ")} ${redirectedCommand}`
    : redirectedCommand;
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    // .bash_profile typically sources .bashrc itself; only source .bashrc
    // directly when no .bash_profile exists to avoid double-running setup.
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  lines.push(finalLine);
  return lines.join(" && ");
}

async function createSandbox(
  params: PluginEnvironmentAcquireLeaseParams | PluginEnvironmentProbeParams,
  config: DaytonaDriverConfig,
): Promise<Sandbox> {
  const client = createDaytonaClient(config);
  const createParams = buildCreateParams(config, buildSandboxLabels({
    companyId: params.companyId,
    environmentId: params.environmentId,
    runId: "runId" in params ? params.runId : undefined,
    reuseLease: config.reuseLease,
  }));
  return await client.create(createParams, {
    timeout: toTimeoutSeconds(config.timeoutMs),
  });
}

async function getSandbox(config: DaytonaDriverConfig, sandboxId: string): Promise<Sandbox> {
  const client = createDaytonaClient(config);
  return await client.get(sandboxId);
}

async function getSandboxOrNull(config: DaytonaDriverConfig, sandboxId: string): Promise<Sandbox | null> {
  try {
    return await getSandbox(config, sandboxId);
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) {
      return null;
    }
    throw error;
  }
}

// One-shot command execution via Daytona's `process.executeCommand`. The
// session-based API (`createSession` + `executeSessionCommand` with
// `runAsync: false`) hangs indefinitely when the supplied command ends with
// `exec <something>`, which `buildLoginShellScript` always produces. Reproduced
// directly against the Daytona SDK: identical login-shell wrapper returns in
// ~600 ms via `executeCommand` but times out via `executeSessionCommand`. So we
// use the one-shot path, mirroring e2b's `sandbox.commands.run` model.
//
// `executeCommand` returns combined stdout+stderr in `result`. We surface that
// as `stdout` and leave `stderr` empty; callers that grep for error messages
// still see them in `stdout`.
// 单次命令执行：使用 Daytona 的 process.executeCommand 而非 session API
// session API（createSession + executeSessionCommand）在命令以 exec 结尾时会无限挂起
// 复现测试确认 executeCommand 可在 ~600ms 内返回，而 executeSessionCommand 超时
// 因此采用类似 e2b 的 commands.run 模式，保持两个 Provider 的行为一致
async function executeOneShot(
  sandbox: Sandbox,
  params: PluginEnvironmentExecuteParams,
  config: DaytonaDriverConfig,
): Promise<PluginEnvironmentExecuteResult> {
  const timeoutMs = resolveTimeoutMs(params.timeoutMs, config);
  const timeoutSeconds = toTimeoutSeconds(timeoutMs);
  const stdinPath = params.stdin != null ? `/tmp/paperclip-stdin-${randomUUID()}` : null;

  try {
    if (stdinPath) {
      await sandbox.fs.uploadFile(Buffer.from(params.stdin ?? "", "utf8"), stdinPath, timeoutSeconds);
    }

    const command = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdinPath: stdinPath ?? undefined,
    });

    // Pass cwd undefined: `buildLoginShellScript` already injects `cd` after
    // profile sourcing when params.cwd is set, and the Daytona executor's own
    // cwd argument runs before our login-shell init, which is the wrong order
    // (env from .bashrc would override caller env).
    const result = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds);

    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
      timedOut: false,
      stdout: result.result ?? result.artifacts?.stdout ?? "",
      stderr: "",
    };
  } catch (error) {
    if (error instanceof DaytonaTimeoutError) {
      return {
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: `${error.message.trim()}\n`,
      };
    }
    throw error;
  } finally {
    if (stdinPath) {
      await sandbox.fs.deleteFile(stdinPath).catch(() => undefined);
    }
  }
}

// 将 Daytona 驱动注册为 Paperclip 插件
// definePlugin 是 Plugin SDK 提供的工厂函数，负责生命周期管理和类型推导
// 完整的沙箱生命周期：validateConfig -> probe -> acquireLease -> execute -> releaseLease -> destroyLease
const plugin = definePlugin({
  // setup 在 worker 启动时调用，用于初始化日志和资源
  // 这里没有需要异步初始化的资源，仅打印就绪消息
  async setup(ctx) {
    ctx.logger.info("Daytona sandbox provider plugin ready");
  },

  // 健康检查端点：Paperclip 控制平面会定期调用以确认 worker 存活
  async onHealth() {
    return { status: "ok", message: "Daytona sandbox provider plugin healthy" };
  },

  // 环境配置校验：在用户保存环境配置时被调用
  // 返回详细的错误列表让前端可以逐个字段提示用户修改
  // 这在实际创建沙箱之前就拦截了无效配置，减少 API 调用浪费
  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (typeof params.config.image === "string" && params.config.image.trim().length === 0) {
      errors.push("Daytona image cannot be empty.");
    }
    if (typeof params.config.snapshot === "string" && params.config.snapshot.trim().length === 0) {
      errors.push("Daytona snapshot cannot be empty.");
    }
    if (config.image && config.snapshot) {
      errors.push("Daytona sandbox environments must set either image or snapshot, not both.");
    }
    if (config.apiUrl && !isValidUrl(config.apiUrl)) {
      errors.push("apiUrl must be a valid URL.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1 and 86400000.");
    }
    if (config.autoStopInterval != null && config.autoStopInterval < 0) {
      errors.push("autoStopInterval must be greater than or equal to 0.");
    }
    if (config.autoArchiveInterval != null && config.autoArchiveInterval < 0) {
      errors.push("autoArchiveInterval must be greater than or equal to 0.");
    }
    if (config.autoDeleteInterval != null && config.autoDeleteInterval < -1) {
      errors.push("autoDeleteInterval must be greater than or equal to -1.");
    }
    if (!config.apiKey && !(process.env.DAYTONA_API_KEY?.trim())) {
      errors.push("Daytona sandbox environments require an API key in config or DAYTONA_API_KEY.");
    }
    for (const [key, value] of Object.entries({
      cpu: config.cpu,
      memory: config.memory,
      disk: config.disk,
      gpu: config.gpu,
    })) {
      if (value != null && value <= 0) {
        errors.push(`${key} must be greater than 0 when provided.`);
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  // 环境探测：创建一个临时沙箱测试连通性，然后立即删除
  // 用于验证 API Key、网络可达性、模板配置等是否有效
  // 探测结果包含沙箱的基础信息，让用户确认环境正常后再开始使用
  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    try {
      const sandbox = await createSandbox(params, config);
      try {
        const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
        const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
        return {
          ok: true,
          summary: `Connected to Daytona sandbox ${sandbox.name}.`,
          metadata: {
            provider: "daytona",
            shellCommand,
            sandboxId: sandbox.id,
            sandboxName: sandbox.name,
            target: sandbox.target,
            image: config.image,
            snapshot: config.snapshot,
            timeoutMs: config.timeoutMs,
            reuseLease: config.reuseLease,
            remoteCwd,
          },
        };
      } finally {
        await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
      }
    } catch (error) {
      return {
        ok: false,
        summary: "Daytona sandbox probe failed.",
        metadata: {
          provider: "daytona",
          image: config.image,
          snapshot: config.snapshot,
          timeoutMs: config.timeoutMs,
          reuseLease: config.reuseLease,
          error: formatErrorMessage(error),
        },
      };
    }
  },

  // 获取租赁：在 Paperclip 需要执行代码时被调用
  // 创建 Daytona 沙箱、建立工作目录、检测 shell 类型，然后返回租赁句柄
  // 如果任何步骤失败，确保已创建的沙箱被清理（delete）避免资源泄漏
  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await createSandbox(params, config);
    try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({ config, sandbox, shellCommand, remoteCwd, resumedLease: false }),
      };
    } catch (error) {
      await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
      throw error;
    }
  },

  // 恢复租赁：当 reuseLease=true 时，Paperclip 在后续运行中尝试复用之前的沙箱
  // 先通过 providerLeaseId 查找已有沙箱，如果不存在则标记为 expired（让上层重新 acquire）
  // 如果沙箱存在但处于停止状态，调用 ensureSandboxStarted 重新启动
  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) {
      return { providerLeaseId: null, metadata: { expired: true } };
    }

    await ensureSandboxStarted(sandbox, toTimeoutSeconds(config.timeoutMs));
    try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      const shellCommand = await detectSandboxShellCommand(sandbox, toTimeoutSeconds(config.timeoutMs));
      return {
        providerLeaseId: sandbox.id,
        metadata: leaseMetadata({ config, sandbox, shellCommand, remoteCwd, resumedLease: true }),
      };
    } catch (error) {
      await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch(() => undefined);
      throw error;
    }
  },

  // 释放租赁：根据 reuseLease 策略决定是停止沙箱（以便后续复用）还是直接删除
  // 停止失败时有 fallback 逻辑——尝试删除沙箱，避免沙箱无限期残留
  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) return;

    if (config.reuseLease) {
      if (sandbox.state !== "stopped") {
        try {
          await sandbox.stop(toTimeoutSeconds(config.timeoutMs));
        } catch (error) {
          console.warn(
            `Failed to stop Daytona sandbox during lease release: ${formatErrorMessage(error)}. Attempting delete instead.`,
          );
          await sandbox.delete(toTimeoutSeconds(config.timeoutMs)).catch((deleteError) => {
            console.warn(
              `Failed to delete Daytona sandbox after stop failure: ${formatErrorMessage(deleteError)}`,
            );
          });
        }
      }
      return;
    }

    await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
  },

  // 销毁租赁：强制删除沙箱，不保留任何状态
  // 与 releaseLease 不同，destroy 没有"保留"选项——无论 reuseLease 为何值都直接删除
  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxOrNull(config, params.providerLeaseId);
    if (!sandbox) return;
    await sandbox.delete(toTimeoutSeconds(config.timeoutMs));
  },

  // 实现工作空间：在 Paperclip 需要将代码同步到沙箱前被调用
  // 确保沙箱内的目标目录存在，返回远程 cwd 供后续文件同步和命令执行使用
  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      typeof params.lease.metadata?.remoteCwd === "string" &&
      params.lease.metadata.remoteCwd.trim().length > 0
        ? params.lease.metadata.remoteCwd.trim()
        : params.workspace.remotePath ?? params.workspace.localPath ?? "/paperclip-workspace";

    if (params.lease.providerLeaseId) {
      const sandbox = await getSandbox(config, params.lease.providerLeaseId);
      await ensureSandboxStarted(sandbox, toTimeoutSeconds(config.timeoutMs));
      await sandbox.fs.createFolder(remoteCwd, "755");
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "daytona",
        remoteCwd,
      },
    };
  },

  // 执行命令：在已获取租赁的沙箱中运行用户命令
  // 需要先恢复沙箱到 started 状态再执行，防止在停止的沙箱上调用 executeCommand 报错
  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const sandbox = await getSandbox(config, params.lease.providerLeaseId);
    await ensureSandboxStarted(sandbox, toTimeoutSeconds(resolveTimeoutMs(params.timeoutMs, config)));
    return await executeOneShot(sandbox, params, config);
  },
});

export default plugin;
