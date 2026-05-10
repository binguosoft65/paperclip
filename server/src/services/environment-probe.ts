import type { Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import {
  resolveEnvironmentDriverConfigForRuntime,
  type ParsedEnvironmentConfig,
} from "./environment-config.js";
import os from "node:os";
import { isBuiltinSandboxProvider, probeSandboxProvider } from "./sandbox-provider-runtime.js";
import { probePluginEnvironmentDriver, probePluginSandboxProviderDriver } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

// 环境连通性探测：根据 driver 类型执行不同的验证逻辑。
// local 直接返回成功；ssh 尝试建立连接并确保远程工作空间可用；
// sandbox 通过内置或插件 provider 验证；plugin 委托插件驱动
export async function probeEnvironment(
  db: Db,
  environment: Environment,
  options: { pluginWorkerManager?: PluginWorkerManager; resolvedConfig?: ParsedEnvironmentConfig } = {},
): Promise<EnvironmentProbeResult> {
  const parsed = options.resolvedConfig ?? await resolveEnvironmentDriverConfigForRuntime(db, environment.companyId, environment);

  if (parsed.driver === "local") {
    // 本地环境总是可用的
    return {
      ok: true,
      driver: "local",
      summary: "Local environment is available on this Paperclip host.",
      details: {
        hostname: os.hostname(),
        cwd: process.cwd(),
      },
    };
  }

  if (parsed.driver === "sandbox") {
    if (!isBuiltinSandboxProvider(parsed.config.provider)) {
      // 插件沙箱 provider 需要 plugin worker 来执行探测
      if (!options.pluginWorkerManager) {
        return {
          ok: false,
          driver: "sandbox",
          summary: `Sandbox provider "${parsed.config.provider}" requires a running provider plugin.`,
          details: {
            provider: parsed.config.provider,
          },
        };
      }
      return await probePluginSandboxProviderDriver({
        db,
        workerManager: options.pluginWorkerManager,
        companyId: environment.companyId,
        environmentId: environment.id,
        provider: parsed.config.provider,
        config: parsed.config as unknown as Record<string, unknown>,
      });
    }
    return await probeSandboxProvider(parsed.config);
  }

  if (parsed.driver === "plugin") {
    if (!options.pluginWorkerManager) {
      return {
        ok: false,
        driver: "plugin",
        summary: `Plugin environment probes require a plugin worker manager for "${parsed.config.pluginKey}:${parsed.config.driverKey}".`,
        details: {
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      };
    }
    return await probePluginEnvironmentDriver({
      db,
      workerManager: options.pluginWorkerManager,
      companyId: environment.companyId,
      environmentId: environment.id,
      config: parsed.config,
    });
  }

  // SSH 探测：尝试建立 SSH 连接并确认远程工作空间路径存在。
  // ensureSshWorkspaceReady 会自动创建不存在的目录。
  // 捕获 stderr/stdout/code 供用户诊断连接失败原因
  try {
    const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);

    return {
      ok: true,
      driver: "ssh",
      summary: `Connected to ${parsed.config.username}@${parsed.config.host} and verified the remote workspace path.`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        remoteCwd,
      },
    };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const stdout =
      error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout.trim()
        : "";
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    const message =
      stderr ||
      stdout ||
      (error instanceof Error ? error.message : String(error)) ||
      "SSH probe failed.";

    return {
      ok: false,
      driver: "ssh",
      summary: `SSH probe failed for ${parsed.config.username}@${parsed.config.host}.`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        error: message,
        code,
      },
    };
  }
}
