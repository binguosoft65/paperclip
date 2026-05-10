import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { onboard } from "./onboard.js";
import { doctor } from "./doctor.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { configExists, resolveConfigPath } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig } from "../config/store.js";
import {
  describeLocalInstancePaths,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

interface RunOptions {
  config?: string;
  instance?: string;
  repair?: boolean;
  yes?: boolean;
  bind?: "loopback" | "lan" | "tailnet";
}

interface StartedServer {
  apiUrl: string;
  databaseUrl: string;
  host: string;
  listenPort: number;
}

// run 命令："一键启动"编排
// 1) 创建实例目录结构；2) 如果配置不存在，自动触发 onboard（非交互时提示用户先去运行 onboard）；
// 3) 运行 doctor 全面检查（默认启用 --repair）；4) 导入并启动 Paperclip 服务器；
// 5) 如果使用 embedded-postgres 且为 authenticated 模式，在服务器启动后生成 CEO 邀请
// 这样用户只需一个命令即可从零到完整运行
export async function runCommand(opts: RunOptions): Promise<void> {
  const instanceId = resolvePaperclipInstanceId(opts.instance);
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;

  const homeDir = resolvePaperclipHomeDir();
  fs.mkdirSync(homeDir, { recursive: true });

  const paths = describeLocalInstancePaths(instanceId);
  fs.mkdirSync(paths.instanceRoot, { recursive: true });

  const configPath = resolveConfigPath(opts.config);
  process.env.PAPERCLIP_CONFIG = configPath;
  loadPaperclipEnvFile(configPath);

  p.intro(pc.bgCyan(pc.black(" paperclipai run ")));
  p.log.message(pc.dim(`Home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Config: ${configPath}`));

  if (!configExists(configPath)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      p.log.error("No config found and terminal is non-interactive.");
      p.log.message(`Run ${pc.cyan("paperclipai onboard")} once, then retry ${pc.cyan("paperclipai run")}.`);
      process.exit(1);
    }

    p.log.step("No config found. Starting onboarding...");
    await onboard({ config: configPath, invokedByRun: true, bind: opts.bind });
  }

  p.log.step("Running doctor checks...");
  const summary = await doctor({
    config: configPath,
    repair: opts.repair ?? true,
    yes: opts.yes ?? true,
  });

  if (summary.failed > 0) {
    p.log.error("Doctor found blocking issues. Not starting server.");
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}.`);
    process.exit(1);
  }

  p.log.step("Starting Paperclip server...");
  const startedServer = await importServerEntry();

  if (shouldGenerateBootstrapInviteAfterStart(config)) {
    p.log.step("Generating bootstrap CEO invite");
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: startedServer.databaseUrl,
      baseUrl: resolveBootstrapInviteBaseUrl(config, startedServer),
    });
  }
}

function resolveBootstrapInviteBaseUrl(
  config: PaperclipConfig,
  startedServer: StartedServer,
): string {
  const explicitBaseUrl =
    process.env.PAPERCLIP_PUBLIC_URL ??
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    (config.auth.baseUrlMode === "explicit" ? config.auth.publicBaseUrl : undefined);

  if (typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0) {
    return explicitBaseUrl.trim().replace(/\/+$/, "");
  }

  return startedServer.apiUrl.replace(/\/api$/, "");
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.trim().length > 0) return err.message;
    return err.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") return true;
  return err.message.includes("Cannot find module");
}

function getMissingModuleSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const packageMatch = err.message.match(/Cannot find package '([^']+)' imported from/);
  if (packageMatch?.[1]) return packageMatch[1];
  const moduleMatch = err.message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch?.[1]) return moduleMatch[1];
  return null;
}

function maybeEnableUiDevMiddleware(entrypoint: string): void {
  if (process.env.PAPERCLIP_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  if (normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@paperclipai/server/src/index.ts")) {
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "true";
  }
}

function ensureDevWorkspaceBuildDeps(projectRoot: string): void {
  const buildScript = path.resolve(projectRoot, "scripts/ensure-plugin-build-deps.mjs");
  if (!fs.existsSync(buildScript)) return;

  const result = spawnSync(process.execPath, [buildScript], {
    cwd: projectRoot,
    stdio: "inherit",
    timeout: 120_000,
  });

  if (result.error) {
    throw new Error(
      `Failed to prepare workspace build artifacts before starting the Paperclip dev server.\n${formatError(result.error)}`,
    );
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      "Failed to prepare workspace build artifacts before starting the Paperclip dev server.",
    );
  }
}

// 服务器入口加载策略（开发/生产双模式）：
// 开发模式：查找 monorepo 中的 server/src/index.ts，使用 tsx 直接运行 TypeScript
// 生产模式：导入已编译的 @paperclipai/server 包
// 如果两者都不存在，给出明确的错误提示
async function importServerEntry(): Promise<StartedServer> {
  // Dev mode: try local workspace path (monorepo with tsx)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devEntry = path.resolve(projectRoot, "server/src/index.ts");
  if (fs.existsSync(devEntry)) {
    ensureDevWorkspaceBuildDeps(projectRoot);
    maybeEnableUiDevMiddleware(devEntry);
    const mod = await import(pathToFileURL(devEntry).href);
    return await startServerFromModule(mod, devEntry);
  }

  // Production mode: import the published @paperclipai/server package
  try {
    const mod = await import("@paperclipai/server");
    return await startServerFromModule(mod, "@paperclipai/server");
  } catch (err) {
    const missingSpecifier = getMissingModuleSpecifier(err);
    const missingServerEntrypoint = !missingSpecifier || missingSpecifier === "@paperclipai/server";
    if (isModuleNotFoundError(err) && missingServerEntrypoint) {
      throw new Error(
        `Could not locate a Paperclip server entrypoint.\n` +
          `Tried: ${devEntry}, @paperclipai/server\n` +
          `${formatError(err)}`,
      );
    }
    throw new Error(
      `Paperclip server failed to start.\n` +
        `${formatError(err)}`,
    );
  }
}

function shouldGenerateBootstrapInviteAfterStart(config: PaperclipConfig): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode === "embedded-postgres";
}

async function startServerFromModule(mod: unknown, label: string): Promise<StartedServer> {
  const startServer = (mod as { startServer?: () => Promise<StartedServer> }).startServer;
  if (typeof startServer !== "function") {
    throw new Error(`Paperclip server entrypoint did not export startServer(): ${label}`);
  }
  return await startServer();
}
