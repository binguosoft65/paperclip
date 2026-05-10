import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CommandExitError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";
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

// E2B 驱动配置的运行时类型定义
// 与 Daytona 相比，E2B 配置更简洁：只有 template、apiKey、timeoutMs、reuseLease 四个字段
// template 默认值为 "base"（基础 Ubuntu 镜像），用户可指定自定义模板
interface E2bDriverConfig {
  template: string;
  apiKey: string | null;
  timeoutMs: number;
  reuseLease: boolean;
}

// 将用户提交的原始配置解析为强类型的 E2bDriverConfig
// template 为空时默认使用 "base"，timeoutMs 非法时回退到 300 秒
function parseDriverConfig(raw: Record<string, unknown>): E2bDriverConfig {
  const template = typeof raw.template === "string" && raw.template.trim().length > 0
    ? raw.template.trim()
    : "base";
  const timeoutMs = Number(raw.timeoutMs ?? 300_000);
  return {
    template,
    apiKey: typeof raw.apiKey === "string" && raw.apiKey.trim().length > 0 ? raw.apiKey.trim() : null,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 300_000,
    reuseLease: raw.reuseLease === true,
  };
}

// API Key 解析策略：显式配置优先，环境变量作为兜底
// 与 Daytona Provider 的策略保持一致，使用户体验统一
function resolveApiKey(config: E2bDriverConfig): string {
  if (config.apiKey) {
    return config.apiKey;
  }
  const envApiKey = process.env.E2B_API_KEY?.trim() ?? "";
  if (!envApiKey) {
    throw new Error("E2B sandbox environments require an API key in config or E2B_API_KEY.");
  }
  return envApiKey;
}

// 创建 E2B 沙箱实例：使用 Sandbox.create 静态方法
// 传入 apiKey 和 timeoutMs 作为选项，同时在 metadata 中标注 provider 来源便于追踪
// E2B 的 create 会异步等待沙箱就绪再返回，所以调用方不需要额外的轮询逻辑
async function createSandbox(config: E2bDriverConfig): Promise<Sandbox> {
  const options = {
    apiKey: resolveApiKey(config),
    timeoutMs: config.timeoutMs,
    metadata: {
      paperclipProvider: "e2b",
    },
  };
  return await Sandbox.create(config.template, options);
}

// 统一错误消息格式，确保无论抛出什么类型都能拿到可读的字符串
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 从 TimeoutError 中提取 stdout/stderr：E2B SDK 的 TimeoutError 可能有多种结构
// 有时输出在 error 对象的顶层字段，有时在嵌套的 result 对象中
// 这里做了两层查找以保证各种 SDK 版本兼容
function readTimeoutStream(error: TimeoutError, key: "stdout" | "stderr"): string {
  const record = error as unknown as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = (record as { result?: Record<string, unknown> }).result?.[key];
  if (typeof nested === "string") return nested;
  return typeof direct === "string" ? direct : "";
}

// 构建超时执行结果：将 TimeoutError 转换为 PluginEnvironmentExecuteResult
// 保留 stdout 和 stderr，并将超时错误消息附加到 stderr 尾部
// exitCode 设为 null 表示超时而非命令失败
function buildTimeoutExecuteResult(error: TimeoutError): PluginEnvironmentExecuteResult {
  const stdout = readTimeoutStream(error, "stdout");
  const stderrOutput = readTimeoutStream(error, "stderr");
  const message = error.message.trim();
  const stderr = stderrOutput.length > 0
    ? message.length > 0 && !stderrOutput.includes(message)
      ? `${stderrOutput}${stderrOutput.endsWith("\n") ? "" : "\n"}${message}\n`
      : stderrOutput
    : message.length > 0
      ? `${message}\n`
      : "";
  return {
    exitCode: null,
    timedOut: true,
    stdout,
    stderr,
  };
}

// 确保沙箱工作目录存在：使用 mkdir -p 创建目标目录，如果已存在则不会报错
async function ensureSandboxWorkspace(sandbox: Sandbox, remoteCwd: string): Promise<void> {
  await sandbox.commands.run(`mkdir -p ${shellQuote(remoteCwd)}`);
}

// 解析沙箱内的工作目录：通过 pwd 获取当前路径，然后拼接 paperclip-workspace
// 与 Daytona 实现不同，E2B 没有 getWorkDir 或 getUserHomeDir API，只能通过 shell 命令获取
async function resolveSandboxWorkingDirectory(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.commands.run("pwd");
  const cwd = result.stdout.trim();
  const remoteCwd = path.posix.join(cwd.length > 0 ? cwd : "/", "paperclip-workspace");
  await ensureSandboxWorkspace(sandbox, remoteCwd);
  return remoteCwd;
}

// 连接已有沙箱：通过 providerLeaseId（即 E2B sandboxId）恢复与沙箱的连接
// 用于 resumeLease 和 releaseLease 场景，避免重新创建沙箱
async function connectSandbox(config: E2bDriverConfig, providerLeaseId: string): Promise<Sandbox> {
  return await Sandbox.connect(providerLeaseId, {
    apiKey: resolveApiKey(config),
    timeoutMs: config.timeoutMs,
  });
}

// 用于清理场景的连接：如果沙箱已不存在（SandboxNotFoundError），返回 null 而非报错
// 避免在释放/销毁已过期或被外部删除的沙箱时抛出未处理异常
async function connectForCleanup(config: E2bDriverConfig, providerLeaseId: string): Promise<Sandbox | null> {
  try {
    return await connectSandbox(config, providerLeaseId);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return null;
    throw error;
  }
}

// 构建租赁元数据：与 Daytona Provider 结构类似，但 E2B 固定使用 bash 作为 shell
// 包含沙箱 ID、域名、模板等关键信息，用于后续恢复和审计
function leaseMetadata(input: {
  config: E2bDriverConfig;
  sandbox: Sandbox;
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "e2b",
    shellCommand: "bash",
    template: input.config.template,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    sandboxId: input.sandbox.sandboxId,
    sandboxDomain: input.sandbox.sandboxDomain,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

// Shell 参数安全引用：用单引号包裹并用 '"'"' 转义内部的单引号
// 防止用户传入的文件名或命令参数含有空格、引号等特殊字符导致的注入问题
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// 校验环境变量键名是否合法：必须符合 shell 标识符规范
function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// Mirror SSH's buildSshSpawnTarget: source the user's login profiles (and nvm)
// before exec so commands run with the same PATH the user sees in an
// interactive shell. e2b's `sandbox.commands.run` otherwise spawns a
// non-login, non-interactive shell whose PATH does not include npm-globals,
// nvm shims, or anything else the template installs via .profile/.bashrc —
// which makes the hello probe fail with `exec: <cli>: not found` even when
// the binary is on disk.
// 构建登录 shell 脚本：在执行用户命令前 source 常见的 profile 文件
// E2B 的 commands.run 默认在非登录、非交互 shell 中运行，PATH 中缺少 npm-globals、nvm shims
// 通过模拟登录 shell 的初始化流程，保证沙箱内所有 CLI 工具都可被解析到
// 与 Daytona 的 buildLoginShellScript 逻辑一致，区别在于使用 exec 替换当前进程
function buildLoginShellScript(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
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
  const execLine = envArgs.length > 0
    ? `exec env ${envArgs.join(" ")} ${commandParts}`
    : `exec ${commandParts}`;
  return [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    // .bash_profile typically sources .bashrc itself; only source .bashrc
    // directly when no .bash_profile exists to avoid re-running idempotency-
    // sensitive setup (nvm, PATH prepends) twice on templates that wire
    // .bash_profile -> .bashrc.
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    execLine,
  ].join(" && ");
}

// 尽力终止沙箱：如果 kill 失败，只打印警告而不抛出异常
// 因为释放/销毁操作不应该因为清理失败而影响上层流程
async function killSandboxBestEffort(sandbox: Sandbox, reason: string): Promise<void> {
  await sandbox.kill().catch((error) => {
    console.warn(`Failed to kill E2B sandbox during ${reason}: ${formatErrorMessage(error)}`);
  });
}

// 按复用策略释放沙箱：
// - reuseLease=false: 直接 kill（彻底销毁）
// - reuseLease=true: 先 pause（保留状态），pause 失败时 fallback 到 kill
// pause 可以让沙箱的磁盘状态保留，后续 resume 时快速恢复，节省冷启动时间
async function releaseSandboxBestEffort(sandbox: Sandbox, reuseLease: boolean): Promise<void> {
  if (!reuseLease) {
    await killSandboxBestEffort(sandbox, "lease release");
    return;
  }

  try {
    await sandbox.pause();
  } catch (error) {
    console.warn(
      `Failed to pause E2B sandbox during lease release: ${formatErrorMessage(error)}. Attempting kill instead.`,
    );
    await killSandboxBestEffort(sandbox, "lease release fallback cleanup");
  }
}

// 将 E2B 驱动注册为 Paperclip 插件
// 完整的沙箱生命周期：validateConfig -> probe -> acquireLease -> execute -> releaseLease -> destroyLease
// 与 Daytona Provider 实现相同的 Plugin SDK 接口，可被上层无差别调度
const plugin = definePlugin({
  // setup 在 worker 启动时调用，用于初始化日志和资源
  async setup(ctx) {
    ctx.logger.info("E2B sandbox provider plugin ready");
  },

  // 健康检查端点：Paperclip 控制平面会定期调用以确认 worker 存活
  async onHealth() {
    return { status: "ok", message: "E2B sandbox provider plugin healthy" };
  },

  // 环境配置校验：在用户保存环境配置时被调用
  // 校验 template 不能为空字符串、timeoutMs 必须在合法范围内
  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (typeof params.config.template === "string" && params.config.template.trim().length === 0) {
      errors.push("E2B sandbox environments require a template.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1 and 86400000.");
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
  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    try {
      const sandbox = await createSandbox(config);
      try {
        await sandbox.setTimeout(config.timeoutMs);
        const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
        return {
          ok: true,
          summary: `Connected to E2B sandbox template ${config.template}.`,
          metadata: {
            provider: "e2b",
            template: config.template,
            timeoutMs: config.timeoutMs,
            reuseLease: config.reuseLease,
            sandboxId: sandbox.sandboxId,
            sandboxDomain: sandbox.sandboxDomain,
            remoteCwd,
          },
        };
      } finally {
        await sandbox.kill().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `E2B sandbox probe failed for template ${config.template}.`,
        metadata: {
          provider: "e2b",
          template: config.template,
          timeoutMs: config.timeoutMs,
          reuseLease: config.reuseLease,
          error: message,
        },
      };
    }
  },

  // 获取租赁：在 Paperclip 需要执行代码时被调用
  // 创建 E2B 沙箱、设置超时、建立工作目录，然后返回租赁句柄
  // 如果任何步骤失败，确保已创建的沙箱被清理避免资源泄漏
  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await createSandbox(config);
    try {
      await sandbox.setTimeout(config.timeoutMs);
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);

      return {
        providerLeaseId: sandbox.sandboxId,
        metadata: leaseMetadata({ config, sandbox, remoteCwd, resumedLease: false }),
      };
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  },

  // 恢复租赁：当 reuseLease=true 时，Paperclip 在后续运行中尝试复用之前的沙箱
  // 通过 Sandbox.connect 连接已有沙箱，如果沙箱已不存在则标记为 expired
  // E2B 不需要显式启动沙箱——connect 后沙箱自动可用
  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    try {
      const sandbox = await connectSandbox(config, params.providerLeaseId);
      try {
        await sandbox.setTimeout(config.timeoutMs);
        const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);

        return {
          providerLeaseId: sandbox.sandboxId,
          metadata: leaseMetadata({ config, sandbox, remoteCwd, resumedLease: true }),
        };
      } catch (error) {
        await sandbox.kill().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      throw error;
    }
  },

  // 释放租赁：根据 reuseLease 策略决定是暂停沙箱（以便后续复用）还是直接终止
  // 暂停失败时有 fallback 逻辑——尝试 kill，避免沙箱无限期残留
  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await connectForCleanup(config, params.providerLeaseId);
    if (!sandbox) return;

    await releaseSandboxBestEffort(sandbox, config.reuseLease);
  },

  // 销毁租赁：强制终止沙箱，不保留任何状态
  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await connectForCleanup(config, params.providerLeaseId);
    if (!sandbox) return;
    await killSandboxBestEffort(sandbox, "lease destroy");
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
      const sandbox = await connectSandbox(config, params.lease.providerLeaseId);
      await ensureSandboxWorkspace(sandbox, remoteCwd);
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "e2b",
        remoteCwd,
      },
    };
  },

  // 执行命令：在已获取租赁的沙箱中运行用户命令
  // 对于带有 stdin 的命令，采用"先写临时文件再重定向"的策略
  // 避免使用 sendStdin 时竞态条件（快速退出的命令在 stdin 到达前就已结束）
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
    const sandbox = await connectSandbox(config, params.lease.providerLeaseId);
    const baseCommand = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      env: params.env,
    });
    const timeoutMs = params.timeoutMs ?? config.timeoutMs;

    // For commands with stdin, stage the payload to a temp file inside the
    // sandbox and shell-redirect it. Streaming stdin via `sendStdin` raced
    // with fast-failing commands (the process exits before the RPC lands),
    // and the previous code awaited a foreground `run` before sending stdin
    // at all, so the data was never delivered. The staged-file approach
    // keeps execution synchronous, avoids the race, and is unaffected by
    // whether the command exits in microseconds or minutes.
    let stagedStdinPath: string | null = null;
    if (params.stdin != null) {
      stagedStdinPath = `/tmp/paperclip-stdin-${randomUUID()}`;
      try {
        await sandbox.files.write(stagedStdinPath, params.stdin);
      } catch (error) {
        // Best-effort cleanup in case the write partially succeeded; ignore
        // remove failures so the original error is what propagates.
        await sandbox.files.remove(stagedStdinPath).catch(() => undefined);
        throw error;
      }
    }

    const command = stagedStdinPath
      ? `${baseCommand} < ${shellQuote(stagedStdinPath)}`
      : baseCommand;

    try {
      // Env is interpolated into the script via `exec env KEY=val …` after
      // profile sourcing so user-configured env wins over anything profiles
      // export. No need to pass `envs:` separately.
      const result = await sandbox.commands.run(command, {
        cwd: params.cwd,
        timeoutMs,
      }) as Awaited<ReturnType<Sandbox["commands"]["run"]>> & {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      return {
        exitCode: result.exitCode,
        timedOut: false,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          timedOut: false,
          stdout: error.stdout,
          stderr: error.stderr,
        };
      }
      if (error instanceof TimeoutError) {
        return buildTimeoutExecuteResult(error);
      }
      throw error;
    } finally {
      if (stagedStdinPath) {
        await sandbox.files.remove(stagedStdinPath).catch(() => undefined);
      }
    }
  },
});

export default plugin;
