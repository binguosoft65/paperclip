import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "../adapters/utils.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

// 将环境 + 租约解析为适配器可理解的执行目标（AdapterExecutionTarget）。
// local → 本地进程执行；sandbox → 远程命名的沙箱，附带 runner 执行函数；
// SSH → 远程服务器，附带连接凭据
// 仅远程管理型适配器（acpx_local/claude_local/cursor 等）支持非 local 环境
export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
}): Promise<AdapterExecutionTarget | null> {
  if (input.environment.driver === "local") {
    // 本地执行：adapter 在本机 fork 子进程，不需要远程连接信息
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    // 沙箱环境仅对远程管理型适配器可用。普通适配器（process/http）返回 null
    if (
      input.adapterType !== "acpx_local" &&
      input.adapterType !== "codex_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor"
    ) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const shellCommand =
      input.leaseMetadata?.shellCommand === "bash" || input.leaseMetadata?.shellCommand === "sh"
        ? input.leaseMetadata.shellCommand
        : null;

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      shellCommand,
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs,
      // runner 执行函数：通过环境运行时在沙箱中执行命令，并将 stdout/stderr
      // 通过 onLog 回调实时反馈给 adapter
      runner: input.environmentRuntime && input.lease
        ? {
            execute: async (commandInput) => {
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
              });
              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
          }
        : undefined,
    };
  }

  // SSH 环境仅对远程管理型适配器可用
  if (
    (
      input.adapterType !== "codex_local" &&
      input.adapterType !== "acpx_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor"
    ) ||
    input.environment.driver !== "ssh"
  ) {
    return null;
  }

  const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
    driver: input.environment.driver as "ssh",
    config: parseObject(input.environment.config),
  });
  if (parsed.driver !== "ssh") {
    return null;
  }

  const remoteCwd =
    typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
      ? input.leaseMetadata.remoteCwd.trim()
      : parsed.config.remoteWorkspacePath;

  // SSH 目标返回完整连接凭据，adapter 使用这些信息建立 SSH 通道执行命令
  return {
    kind: "remote",
    transport: "ssh",
    environmentId: input.environment.id ?? null,
    leaseId: input.leaseId ?? null,
    remoteCwd,
    spec: {
      host: parsed.config.host,
      port: parsed.config.port,
      username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath,
      privateKey: parsed.config.privateKey,
      knownHosts: parsed.config.knownHosts,
      strictHostKeyChecking: parsed.config.strictHostKeyChecking,
      remoteCwd,
    },
  };
}

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
