import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import type { RunProcessResult } from "./server-utils.js";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  remoteWorkspacePath: string;
  privateKey: string | null;
  knownHosts: string | null;
  strictHostKeyChecking: boolean;
}
// remoteWorkspacePath 是远程服务器上的工作空间根目录，与 remoteCwd 可能相同也可能不同。

export interface SshCommandResult {
  stdout: string;
  stderr: string;
}

export interface SshRemoteExecutionSpec extends SshConnectionConfig {
  remoteCwd: string;
}

export function createSshCommandManagedRuntimeRunner(input: {
  spec: SshRemoteExecutionSpec;
  defaultCwd?: string | null;
  maxBufferBytes?: number | null;
}): CommandManagedRuntimeRunner {
  // 默认工作目录优先使用指定的 defaultCwd，其次使用 remoteSpec 中的 remoteCwd。
  const defaultCwd = input.defaultCwd?.trim() || input.spec.remoteCwd;
  // maxBufferBytes 需要是正整数，默认 1MB。单个命令的输出不得超过此限制，防止 OOM。
  const maxBufferBytes =
    typeof input.maxBufferBytes === "number" && Number.isFinite(input.maxBufferBytes) && input.maxBufferBytes > 0
      ? Math.trunc(input.maxBufferBytes)
      : 1024 * 1024;

  return {
    execute: async (commandInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const command = commandInput.command.trim();
      const args = commandInput.args ?? [];
      const cwd = commandInput.cwd?.trim() || defaultCwd;
      const envEntries = Object.entries(commandInput.env ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string");
      const envPrefix = envEntries.length > 0
        ? `env ${envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} `
        : "";
      const exportPrefix = envEntries.length > 0
        ? envEntries.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(" ") + " "
        : "";
      // 命令组装策略：
      // 当命令是 sh/bash 时，优先尝试提取 -lc 后的脚本内容直接配合 export 前缀运行，
      // 避免多余的外层 shell 嵌套；普通命令则用 env 前缀+exec 包装以传递环境变量。
      // cd 到目标目录 + exec 替换 shell 进程，确保命令在正确的目录和环境变量下执行。
      const commandScript = command === "sh" || command === "bash"
        ? args[0] === "-lc" && typeof args[1] === "string"
          ? `${exportPrefix}${args[1]}`
          : `${envPrefix}exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`
        : `${envPrefix}exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`;
      const remoteCommand = `${command === "bash" ? "bash" : "sh"} -lc ${
        shellQuote(`cd ${shellQuote(cwd)} && ${commandScript}`)
      }`;

      // runSshCommand 成功时 exitCode 恒为 0，因为 SSH 通道本身无错误。
      // 远程命令的退出码由 SSH 的 stderr/stdout 输出内容推断，而非透传。
      try {
        const result = await runSshCommand(input.spec, remoteCommand, {
          stdin: commandInput.stdin,
          timeoutMs: commandInput.timeoutMs,
          maxBuffer: maxBufferBytes,
        });
        if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
        if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const failure = error as {
          stdout?: unknown;
          stderr?: unknown;
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
        };
        const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        const stderr = typeof failure.stderr === "string"
          ? failure.stderr
          : error instanceof Error
            ? error.message
            : String(error);
        if (stdout) await commandInput.onLog?.("stdout", stdout);
        if (stderr) await commandInput.onLog?.("stderr", stderr);
        // SSH 命令失败时，从异常对象中提取退出码和信号。
        // failure.killed === true 表示超时杀死，用于 timedOut 标志。
        return {
          exitCode: typeof failure.code === "number" ? failure.code : null,
          signal: typeof failure.signal === "string" ? failure.signal : null,
          timedOut: failure.killed === true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    },
  };
}

export interface SshEnvLabSupport {
  supported: boolean;
  reason: string | null;
}

export interface SshEnvLabFixtureState {
  kind: "ssh_openbsd";
  bindHost: string;
  host: string;
  port: number;
  username: string;
  rootDir: string;
  workspaceDir: string;
  statePath: string;
  pid: number;
  createdAt: string;
  clientPrivateKeyPath: string;
  clientPublicKeyPath: string;
  hostPrivateKeyPath: string;
  hostPublicKeyPath: string;
  authorizedKeysPath: string;
  knownHostsPath: string;
  sshdConfigPath: string;
  sshdLogPath: string;
}

interface LocalGitWorkspaceSnapshot {
  headCommit: string;
  branchName: string | null;
  deletedPaths: string[];
}

// shellQuote 使用单引号包裹字符串并用 '\'"'"' 模式转义内部的单引号。
// 这种模式比双引号更安全，因为它会抑制变量展开、通配符展开等 shell 扩展行为，
// 防止通过注入 `$()`, ` `` `, `*` 等方式执行恶意命令。
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// 解析 SSH 远程执行规范，支持从 JSON/配置对象中反序列化。
// 端口必须在 1-65535 范围内；host/username/remoteCwd 不能为空。
// remoteWorkspacePath 可选，默认为 remoteCwd；strictHostKeyChecking 默认启用安全模式。
export function parseSshRemoteExecutionSpec(value: unknown): SshRemoteExecutionSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
  const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
  const remoteCwd = typeof parsed.remoteCwd === "string" ? parsed.remoteCwd.trim() : "";
  const portValue = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
  if (!host || !username || !remoteCwd || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    return null;
  }

  return {
    host,
    port: portValue,
    username,
    remoteCwd,
    remoteWorkspacePath:
      typeof parsed.remoteWorkspacePath === "string" && parsed.remoteWorkspacePath.trim().length > 0
        ? parsed.remoteWorkspacePath.trim()
        : remoteCwd,
    privateKey: typeof parsed.privateKey === "string" && parsed.privateKey.length > 0 ? parsed.privateKey : null,
    knownHosts: typeof parsed.knownHosts === "string" && parsed.knownHosts.length > 0 ? parsed.knownHosts : null,
    strictHostKeyChecking:
      typeof parsed.strictHostKeyChecking === "boolean" ? parsed.strictHostKeyChecking : true,
  };
}

async function execFileText(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function spawnText(
  file: string,
  args: string[],
  options: {
    stdin?: string;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const maxBuffer = options.maxBuffer ?? 1024 * 128;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error & { stdout?: string; stderr?: string; code?: number | null; killed?: boolean }) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    };

    // 输出累积超过 maxBuffer 时直接 SIGTERM 杀死子进程并拒绝 Promise。
    // 这是为了防止失控进程占用无限内存，同时通过逐字节的 UTF-8 长度计算确保中文字符等多字节编码不被截断。
    const append = (
      streamName: "stdout" | "stderr",
      chunk: unknown,
    ) => {
      const text = String(chunk);
      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer || Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        finishReject(Object.assign(new Error(`Process output exceeded maxBuffer of ${maxBuffer} bytes.`), {
          code: null,
        }));
      }
    };

    // 超时处理采用"优雅终止-强制杀死"两级策略：
    // 1. 先发 SIGTERM 给子进程 5 秒的优雅退出时间
    // 2. 5 秒后升级为 SIGKILL 强制终止
    // 这种策略确保挂起的远程命令不会无限阻塞，同时给进程写入日志的机会。
    let killEscalation: NodeJS.Timeout | null = null;
    const timeout = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate to SIGKILL after a 5s grace window so a hung remote
          // command that ignores SIGTERM cannot keep the child alive
          // indefinitely.
          killEscalation = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // child may have already exited between the SIGTERM and the
              // escalation — that's fine.
            }
          }, 5_000);
          killEscalation.unref?.();
        }, options.timeout)
      : null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };

    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimers();
      finishReject(Object.assign(error, { code: null }));
    });

    child.on("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code ?? -1}`), {
        stdout,
        stderr,
        code,
        signal,
        killed: timedOut,
      }));
    });

    if (options.stdin != null && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await execFileText("git", ["-C", localDir, ...args], options);
}

async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommandPath(command)) !== null;
}

async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const result = await execFileText("sh", ["-lc", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

// 创建临时文件用于存放 SSH 私钥和 known_hosts。使用随机目录前缀防止临时文件泄露。
// 文件权限由调用方指定（私钥需要 0600），内容追加换行符以兼容 POSIX 工具。
// 返回 cleanup 函数用于安全删除临时文件。
async function withTempFile(
  prefix: string,
  contents: string,
  mode: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "payload");
  const normalizedContents = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fs.writeFile(filePath, normalizedContents, { mode, encoding: "utf8" });
  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// 构建 SSH 认证参数。
// 设计权衡：私钥和 known_hosts 写入临时文件（而非通过 stdin 传入），因为 SSH 客户端不支持从管道读取私钥。
// strictHostKeyChecking 关闭时使用 /dev/null 作为 known_hosts 文件以避免任何主机密钥检查。
// BatchMode=yes 避免 SSH 在密钥认证失败时回退到交互式密码提示。
// 临时文件在 cleanup 中统一清理，确保敏感凭证不在磁盘上残留。
async function createSshAuthArgs(
  config: Pick<SshConnectionConfig, "privateKey" | "knownHosts" | "strictHostKeyChecking">,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const tempFiles: Array<() => Promise<void>> = [];
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking ? "yes" : "no"}`,
  ];

  if (config.strictHostKeyChecking) {
    if (config.knownHosts) {
      const knownHosts = await withTempFile("paperclip-ssh-known-hosts-", config.knownHosts, 0o600);
      tempFiles.push(knownHosts.cleanup);
      sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
    }
  } else {
    sshArgs.push("-o", "UserKnownHostsFile=/dev/null");
  }

  if (config.privateKey) {
    const privateKey = await withTempFile("paperclip-ssh-key-", config.privateKey, 0o600);
    tempFiles.push(privateKey.cleanup);
    sshArgs.push("-i", privateKey.path);
  }

  return {
    args: sshArgs,
    cleanup: async () => {
      await Promise.all(tempFiles.map((cleanup) => cleanup()));
    },
  };
}

// 默认排除 ._*（Apple Double 文件），这是 macOS 文件系统的元数据产物，在 Linux 远程环境中无用。
// 此外使用调用方传入的排除列表。
function tarExcludeArgs(exclude: string[] | undefined): string[] {
  const combined = ["._*", ...(exclude ?? [])];
  return combined.flatMap((entry) => ["--exclude", entry]);
}

function tarSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Prevent macOS bsdtar from emitting AppleDouble metadata files like ._README.md.
    COPYFILE_DISABLE: "1",
  };
}
// COPYFILE_DISABLE=1 是 macOS 专用环境变量，防止 bsdtar 创建 ._ 前缀的 AppleDouble 扩展属性文件。

async function runSshScript(
  config: SshConnectionConfig,
  script: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await runSshCommand(
    config,
    `sh -lc ${shellQuote(script)}`,
    options,
  );
}

async function clearLocalDirectory(
  localDir: string,
  preserveEntries: string[] = [],
): Promise<void> {
  await fs.mkdir(localDir, { recursive: true });
  const preserve = new Set(preserveEntries);
  const entries = await fs.readdir(localDir);
  await Promise.all(
    entries
      .filter((entry) => !preserve.has(entry))
      .map((entry) => fs.rm(path.join(localDir, entry), { recursive: true, force: true })),
  );
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  await Promise.all(entries.map(async (entry) => {
    await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }));
}

async function readLocalGitWorkspaceSnapshot(localDir: string): Promise<LocalGitWorkspaceSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, deletedResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--deleted", "-z"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      deletedPaths: deletedResult.stdout
        .split("\0")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

async function streamLocalFileToSsh(input: {
  spec: SshConnectionConfig;
  localFile: string;
  remoteScript: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(input.localFile);
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      ssh.kill("SIGTERM");
      reject(error);
    };

    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    source.on("error", fail);
    ssh.on("error", fail);
    source.pipe(ssh.stdin ?? null);
    ssh.on("close", (code) => {
      if (settled) return;
      settled = true;
      if ((code ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
        return;
      }
      resolve();
    });
  }).finally(auth.cleanup);
}

async function streamSshToLocalFile(input: {
  spec: SshConnectionConfig;
  remoteScript: string;
  localFile: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sink = createWriteStream(input.localFile, { mode: 0o600 });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      ssh.kill("SIGTERM");
      sink.destroy();
      reject(error);
    };

    ssh.stdout?.pipe(sink);
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    ssh.on("error", fail);
    sink.on("error", fail);
    ssh.on("close", (code) => {
      sink.end(() => {
        if (settled) return;
        settled = true;
        if ((code ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
          return;
        }
        resolve();
      });
    });
  }).finally(auth.cleanup);
}

async function importGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const tempRef = "refs/paperclip/ssh-sync/import";

  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    const remoteSetupScript = [
      "set -e",
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "import-XXXXXX.bundle"))})`,
      'trap \'rm -f "$tmp_bundle"\' EXIT',
      'cat > "$tmp_bundle"',
      `if [ ! -d ${shellQuote(path.posix.join(input.remoteDir, ".git"))} ]; then git init ${shellQuote(input.remoteDir)} >/dev/null; fi`,
      `git -C ${shellQuote(input.remoteDir)} fetch --force "$tmp_bundle" '${tempRef}:${tempRef}' >/dev/null`,
      input.snapshot.branchName
        ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
        : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
    ].join("\n");

    await streamLocalFileToSsh({
      spec: input.spec,
      localFile: bundlePath,
      remoteScript: remoteSetupScript,
    });
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function exportGitWorkspaceFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const importedRef = "refs/paperclip/ssh-sync/imported";

  try {
    const exportScript = [
      "set -e",
      `git -C ${shellQuote(input.remoteDir)} update-ref refs/paperclip/ssh-sync/export HEAD`,
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "export-XXXXXX.bundle"))})`,
      'cleanup() { rm -f "$tmp_bundle"; git -C ' + shellQuote(input.remoteDir) + ' update-ref -d refs/paperclip/ssh-sync/export >/dev/null 2>&1 || true; }',
      'trap cleanup EXIT',
      `git -C ${shellQuote(input.remoteDir)} bundle create "$tmp_bundle" refs/paperclip/ssh-sync/export >/dev/null`,
      'cat "$tmp_bundle"',
    ].join("\n");

    await streamSshToLocalFile({
      spec: input.spec,
      remoteScript: exportScript,
      localFile: bundlePath,
    });

    await runLocalGit(input.localDir, ["fetch", "--force", bundlePath, `refs/paperclip/ssh-sync/export:${importedRef}`], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    await runLocalGit(input.localDir, ["reset", "--hard", importedRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function clearRemoteDirectory(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  preserveEntries?: string[];
}): Promise<void> {
  const preservePatterns = (input.preserveEntries ?? [])
    .map((entry) => `! -name ${shellQuote(entry)}`)
    .join(" ");
  const script = [
    "set -e",
    `mkdir -p ${shellQuote(input.remoteDir)}`,
    `find ${shellQuote(input.remoteDir)} -mindepth 1 -maxdepth 1 ${preservePatterns} -exec rm -rf -- {} +`,
  ].join("\n");
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function removeDeletedPathsOnSsh(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  const script = `cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`;
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function allocateLoopbackPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a loopback port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCondition(
  fn: () => Promise<void>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10_000);
  const intervalMs = options.intervalMs ?? 200;
  let lastError: unknown = null;
  while (Date.now() < timeoutAt) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for SSH fixture readiness.");
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  for (const format of ["command=", "args="]) {
    try {
      const result = await execFileText("ps", ["-o", format, "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
      const command = result.stdout.trim();
      if (command.length > 0) {
        return command;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function isSshEnvLabFixtureProcess(state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">): Promise<boolean> {
  if (!(await isPidRunning(state.pid))) {
    return false;
  }

  const command = await readProcessCommand(state.pid);
  if (!command) {
    return false;
  }

  return command.includes(state.sshdConfigPath);
}

export async function getSshEnvLabSupport(): Promise<SshEnvLabSupport> {
  for (const command of ["ssh", "sshd", "ssh-keygen"]) {
    if (!(await commandExists(command))) {
      return {
        supported: false,
        reason: `Missing required command: ${command}`,
      };
    }
  }

  return {
    supported: true,
    reason: null,
  };
}

export function buildKnownHostsEntry(input: {
  host: string;
  port: number;
  publicKey: string;
}): string {
  return `[${input.host}]:${input.port} ${input.publicKey.trim()}`;
}

export async function runSshCommand(
  config: SshConnectionConfig,
  remoteCommand: string,
  options: {
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  let cleanup: () => Promise<void> = () => Promise.resolve();
  try {
    const auth = await createSshAuthArgs(config);
    cleanup = auth.cleanup;
    const sshArgs = [...auth.args];
    const envEntries = Object.entries(options.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    for (const [key] of envEntries) {
      if (!isValidShellEnvKey(key)) {
        throw new Error(`Invalid SSH environment variable key: ${key}`);
      }
    }

    // 远程环境变量策略：
    // 先 source 远程主机的 shell profile（.profile / .bash_profile / .zprofile），
    // 再用 `env KEY=VAL cmd` 格式传递显式环境变量，确保用户提供的环境变量覆盖任何 profile 中的同名字段。
    // 这个顺序很重要：如果先设置 env 再 source profile，profile 可能重置 NVM_DIR/HOME 等关键变量。
    // Mirror buildSshSpawnTarget: source login profiles first, then run
    // `env KEY=VAL cmd` so user-supplied identity overrides win over anything
    // a profile re-exports. Without this, a remote profile that resets HOME
    // / NVM_DIR / etc. would silently undo the explicit env passed in here.
    const envArgs = envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`);
    const remoteScript = [
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
      envArgs.length > 0
        ? `exec env ${envArgs.join(" ")} sh -c ${shellQuote(remoteCommand)}`
        : `exec sh -c ${shellQuote(remoteCommand)}`,
    ].join(" && ");

    sshArgs.push(
      "-p",
      String(config.port),
      `${config.username}@${config.host}`,
      `sh -lc ${shellQuote(remoteScript)}`,
    );

    return options.stdin != null
      ? await spawnText("ssh", sshArgs, {
          stdin: options.stdin,
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        })
      : await execFileText("ssh", sshArgs, {
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        });
  } finally {
    await cleanup();
  }
}

export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<{
  command: string;
  args: string[];
  cleanup: () => Promise<void>;
}> {
  for (const key of Object.keys(input.env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
  }
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [...auth.args];
  const envArgs = Object.entries(input.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const remoteCommandParts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
  // buildSshSpawnTarget 与 runSshCommand 的区别：
  // 此函数用于 spawn 场景（长时间运行的进程），额外加载 NVM 环境并 cd 到工作目录。
  // 之所以单独加载 NVM_DIR/nvm.sh，是因为 Node.js 项目通常依赖 nvm 管理的 Node 版本。
  // profile sourcing 使用 >/dev/null 2>&1 抑制 profile 中的错误输出，避免污染 stdout/stderr。
  const remoteScript = [
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    `cd ${shellQuote(input.spec.remoteCwd)}`,
    envArgs.length > 0
      ? `exec env ${envArgs.join(" ")} ${remoteCommandParts}`
      : `exec ${remoteCommandParts}`,
  ].join(" && ");

  sshArgs.push(
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(remoteScript)}`,
  );

  return {
    command: "ssh",
    args: sshArgs,
    cleanup: auth.cleanup,
  };
}

// 通过管道将本地目录的 tar 归档流式传输到远程 SSH 主机并自动解包。
// 使用了 tar | ssh 管道模式：本地 tar 打包输出到 stdout，SSH 的 stdin 接收数据并在远程解包。
// 这种方式不需要在 SSH 主机上事先上传文件，适合大目录同步。
export async function syncDirectoryToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(`mkdir -p ${shellQuote(input.remoteDir)} && tar -xf - -C ${shellQuote(input.remoteDir)}`)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const tarArgs = [
      ...(input.followSymlinks ? ["-h"] : []),
      "-C",
      input.localDir,
      ...tarExcludeArgs(input.exclude),
      "-cf",
      "-",
      ".",
    ];
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: tarSpawnEnv(),
    });
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let tarStderr = "";
    let sshStderr = "";
    let settled = false;
    let tarExited = false;
    let sshExited = false;
    let tarExitCode: number | null = null;
    let sshExitCode: number | null = null;

    const maybeFinish = () => {
      if (settled || !tarExited || !sshExited) {
        return;
      }
      settled = true;
      if ((tarExitCode ?? 0) !== 0) {
        reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
        return;
      }
      if ((sshExitCode ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
        return;
      }
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      tar.kill("SIGTERM");
      ssh.kill("SIGTERM");
      reject(error);
    };

    tar.stdout?.pipe(ssh.stdin ?? null);
    tar.stderr?.on("data", (chunk) => {
      tarStderr += String(chunk);
    });
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });

    tar.on("error", fail);
    ssh.on("error", fail);
    tar.on("close", (code) => {
      tarExited = true;
      tarExitCode = code;
      maybeFinish();
    });
    ssh.on("close", (code) => {
      sshExited = true;
      sshExitCode = code;
      maybeFinish();
    });
  }).finally(auth.cleanup);
}

export async function syncDirectoryFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  exclude?: string[];
  preserveLocalEntries?: string[];
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
  const remoteTarScript = [
    `cd ${shellQuote(input.remoteDir)}`,
    `tar ${[...tarExcludeArgs(input.exclude).map(shellQuote), "-cf", "-", "."].join(" ")}`,
  ].join(" && ");
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -lc ${shellQuote(remoteTarScript)}`,
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", sshArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tar = spawn("tar", ["-xf", "-", "-C", stagingDir], {
        stdio: ["pipe", "ignore", "pipe"],
        env: tarSpawnEnv(),
      });

      let sshStderr = "";
      let tarStderr = "";
      let settled = false;
      let sshExited = false;
      let tarExited = false;
      let sshExitCode: number | null = null;
      let tarExitCode: number | null = null;

      const maybeFinish = () => {
        if (settled || !sshExited || !tarExited) return;
        settled = true;
        if ((sshExitCode ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
          return;
        }
        if ((tarExitCode ?? 0) !== 0) {
          reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
          return;
        }
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ssh.kill("SIGTERM");
        tar.kill("SIGTERM");
        reject(error);
      };

      ssh.stdout?.pipe(tar.stdin ?? null);
      ssh.stderr?.on("data", (chunk) => {
        sshStderr += String(chunk);
      });
      tar.stderr?.on("data", (chunk) => {
        tarStderr += String(chunk);
      });

      ssh.on("error", fail);
      tar.on("error", fail);
      ssh.on("close", (code) => {
        sshExited = true;
        sshExitCode = code;
        maybeFinish();
      });
      tar.on("close", (code) => {
        tarExited = true;
        tarExitCode = code;
        maybeFinish();
      });
    });

    await clearLocalDirectory(input.localDir, input.preserveLocalEntries);
    await copyDirectoryContents(stagingDir, input.localDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await auth.cleanup();
  }
}

// 将本地工作空间准备到远程 SSH 目标。
// 设计策略：
// - 如果本地目录是 Git 仓库，通过 git bundle 导入完整 Git 历史到远程，然后同步工作文件，再清理已删除文件。
//   这样可以保留 Git 历史，方便远程调试和版本追溯。
// - 如果不是 Git 仓库，则执行"先清空再同步"策略清空远程目录（保留 .paperclip-runtime 运行时文件），
//   然后 tar 流式同步所有文件。
export async function prepareWorkspaceForSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    await importGitWorkspaceToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      snapshot: gitSnapshot,
    });
    await syncDirectoryToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      exclude: [".git", ".paperclip-runtime"],
    });
    await removeDeletedPathsOnSsh({
      spec: input.spec,
      remoteDir,
      deletedPaths: gitSnapshot.deletedPaths,
    });
    return;
  }

  await clearRemoteDirectory({
    spec: input.spec,
    remoteDir,
    preserveEntries: [".paperclip-runtime"],
  });
  await syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    exclude: [".paperclip-runtime"],
  });
}

export async function restoreWorkspaceFromSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    await exportGitWorkspaceFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
    });
    await syncDirectoryFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      exclude: [".git", ".paperclip-runtime"],
      preserveLocalEntries: [".git"],
    });
    return;
  }

  await syncDirectoryFromSsh({
    spec: input.spec,
    remoteDir,
    localDir: input.localDir,
    exclude: [".paperclip-runtime"],
  });
}

export async function ensureSshWorkspaceReady(
  config: SshConnectionConfig,
): Promise<{ remoteCwd: string }> {
  const result = await runSshCommand(
    config,
    `sh -lc ${shellQuote(`mkdir -p ${shellQuote(config.remoteWorkspacePath)} && cd ${shellQuote(config.remoteWorkspacePath)} && pwd`)}`,
  );
  return {
    remoteCwd: result.stdout.trim(),
  };
}

export async function readSshEnvLabFixtureState(
  statePath: string,
): Promise<SshEnvLabFixtureState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath, "utf8")) as SshEnvLabFixtureState;
    if (!raw || raw.kind !== "ssh_openbsd") return null;
    return raw;
  } catch {
    return null;
  }
}

export async function stopSshEnvLabFixture(statePath: string): Promise<boolean> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) return false;

  if (await isSshEnvLabFixtureProcess(state)) {
    process.kill(state.pid, "SIGTERM");
    await waitForCondition(async () => {
      if (await isSshEnvLabFixtureProcess(state)) {
        throw new Error("SSH fixture process is still running.");
      }
    }, { timeoutMs: 5_000, intervalMs: 100 });
  }

  await fs.rm(state.rootDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

// 启动 SSH 环境实验室 fixture —— 在本地启动一个真实的 sshd 进程用于集成测试。
// 设计决策：
// - 如果已有运行的 fixture（PID 存活且进程命令行匹配），复用该 fixture 而非重复创建。
// - 如果存在 stale fixture（PID 已死），清除其根目录并重新创建。
// - sshd 以无密码密钥认证方式运行，仅允许创建用户登录。
// - 所有敏感文件（私钥、known_hosts、sshd_config）权限设为 0600。
export async function startSshEnvLabFixture(input: {
  statePath: string;
  bindHost?: string;
  host?: string;
}): Promise<SshEnvLabFixtureState> {
  const existing = await readSshEnvLabFixtureState(input.statePath);
  if (existing && await isSshEnvLabFixtureProcess(existing)) {
    return existing;
  }
  if (existing) {
    await fs.rm(existing.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    throw new Error(`SSH env-lab fixture is unavailable: ${support.reason}`);
  }
  const sshdPath = await resolveCommandPath("sshd");
  if (!sshdPath) {
    throw new Error("SSH env-lab fixture is unavailable: missing required command: sshd");
  }

  const bindHost = input.bindHost ?? "127.0.0.1";
  const host = input.host ?? bindHost;
  const rootDir = path.dirname(input.statePath);
  await fs.mkdir(rootDir, { recursive: true });

  const username = os.userInfo().username;
  const port = await allocateLoopbackPort(bindHost);
  const workspaceDir = path.join(rootDir, "workspace");
  const clientPrivateKeyPath = path.join(rootDir, "client_key");
  const clientPublicKeyPath = `${clientPrivateKeyPath}.pub`;
  const hostPrivateKeyPath = path.join(rootDir, "host_key");
  const hostPublicKeyPath = `${hostPrivateKeyPath}.pub`;
  const authorizedKeysPath = path.join(rootDir, "authorized_keys");
  const knownHostsPath = path.join(rootDir, "known_hosts");
  const sshdConfigPath = path.join(rootDir, "sshd_config");
  const sshdLogPath = path.join(rootDir, "sshd.log");
  const sshdPidPath = path.join(rootDir, "sshd.pid");

  await fs.mkdir(workspaceDir, { recursive: true });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientPrivateKeyPath], {
    timeout: 15_000,
  });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  });

  await fs.copyFile(clientPublicKeyPath, authorizedKeysPath);
  const hostPublicKey = (await execFileText("ssh-keygen", ["-y", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  })).stdout.trim();
  await fs.writeFile(
    knownHostsPath,
    `${buildKnownHostsEntry({ host, port, publicKey: hostPublicKey })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    sshdConfigPath,
    [
      `Port ${port}`,
      `ListenAddress ${bindHost}`,
      `HostKey ${hostPrivateKeyPath}`,
      `PidFile ${sshdPidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "PasswordAuthentication no",
      "ChallengeResponseAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin no",
      "UsePAM no",
      "StrictModes no",
      `AllowUsers ${username}`,
      "LogLevel VERBOSE",
      "PrintMotd no",
      "UseDNS no",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const child = spawn(sshdPath, ["-D", "-f", sshdConfigPath, "-E", sshdLogPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const state: SshEnvLabFixtureState = {
    kind: "ssh_openbsd",
    bindHost,
    host,
    port,
    username,
    rootDir,
    workspaceDir,
    statePath: input.statePath,
    pid: child.pid ?? 0,
    createdAt: new Date().toISOString(),
    clientPrivateKeyPath,
    clientPublicKeyPath,
    hostPrivateKeyPath,
    hostPublicKeyPath,
    authorizedKeysPath,
    knownHostsPath,
    sshdConfigPath,
    sshdLogPath,
  };

  if (!state.pid) {
    throw new Error("Failed to start SSH env-lab fixture.");
  }

  try {
    await waitForCondition(async () => {
      if (!(await isPidRunning(state.pid))) {
        const logOutput = await fs.readFile(sshdLogPath, "utf8").catch(() => "");
        throw new Error(logOutput || "SSH env-lab fixture exited before becoming ready.");
      }
      const config = await buildSshEnvLabFixtureConfig(state);
      await ensureSshWorkspaceReady(config);
    }, { timeoutMs: 10_000, intervalMs: 250 });
    await fs.writeFile(input.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    if (await isPidRunning(state.pid)) {
      process.kill(state.pid, "SIGTERM");
    }
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function buildSshEnvLabFixtureConfig(
  state: SshEnvLabFixtureState,
): Promise<SshConnectionConfig> {
  const [privateKey, knownHosts] = await Promise.all([
    fs.readFile(state.clientPrivateKeyPath, "utf8"),
    fs.readFile(state.knownHostsPath, "utf8"),
  ]);
  return {
    host: state.host,
    port: state.port,
    username: state.username,
    remoteWorkspacePath: state.workspaceDir,
    privateKey,
    knownHosts,
    strictHostKeyChecking: true,
  };
}

export async function readSshEnvLabFixtureStatus(statePath: string): Promise<{
  running: boolean;
  state: SshEnvLabFixtureState | null;
}> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) {
    return { running: false, state: null };
  }
  return {
    running: await isSshEnvLabFixtureProcess(state),
    state,
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
