import os from "node:os";
import path from "node:path";

// 默认实例 ID 和合法字符集：只允许字母、数字、下划线和连字符
// 限制字符集是为了保证实例 ID 可以安全地用作文件路径和 URL 片段
const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Paperclip 家目录解析：优先使用 PAPERCLIP_HOME 环境变量，支持 ~/ 缩写
// 默认路径为 ~/.paperclip，所有本地状态（配置、数据库、日志、密钥）均在该目录下
export function resolvePaperclipHomeDir(): string {
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".paperclip");
}

// 实例 ID 解析：
// 如果传入 override 则使用之；否则读取 PAPERCLIP_INSTANCE_ID 环境变量；
// 兜底使用 "default"。多实例隔离机制 —— 每个实例拥有独立的配置、数据库和日志目录
export function resolvePaperclipInstanceId(override?: string): string {
  const raw = override?.trim() || process.env.PAPERCLIP_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(
      `Invalid instance id '${raw}'. Allowed characters: letters, numbers, '_' and '-'.`,
    );
  }
  return raw;
}

// 实例根目录：~/.paperclip/instances/<id>/
// 所有子资源（配置、日志、数据库、密钥、存储、备份）均以此为基准
export function resolvePaperclipInstanceRoot(instanceId?: string): string {
  const id = resolvePaperclipInstanceId(instanceId);
  return path.resolve(resolvePaperclipHomeDir(), "instances", id);
}

export function resolveDefaultConfigPath(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "config.json");
}

export function resolveDefaultContextPath(): string {
  return path.resolve(resolvePaperclipHomeDir(), "context.json");
}

export function resolveDefaultCliAuthPath(): string {
  return path.resolve(resolvePaperclipHomeDir(), "auth.json");
}

export function resolveDefaultEmbeddedPostgresDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "db");
}

export function resolveDefaultLogsDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "logs");
}

export function resolveDefaultSecretsKeyFilePath(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "secrets", "master.key");
}

export function resolveDefaultStorageDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "data", "storage");
}

export function resolveDefaultBackupDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "data", "backups");
}

// 展开路径中的 ~ 前缀为当前用户家目录
// 配置文件和环境变量中的路径可能包含 ~，需要展平为绝对路径
export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function describeLocalInstancePaths(instanceId?: string) {
  const resolvedInstanceId = resolvePaperclipInstanceId(instanceId);
  const instanceRoot = resolvePaperclipInstanceRoot(resolvedInstanceId);
  return {
    homeDir: resolvePaperclipHomeDir(),
    instanceId: resolvedInstanceId,
    instanceRoot,
    configPath: resolveDefaultConfigPath(resolvedInstanceId),
    embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(resolvedInstanceId),
    backupDir: resolveDefaultBackupDir(resolvedInstanceId),
    logDir: resolveDefaultLogsDir(resolvedInstanceId),
    secretsKeyFilePath: resolveDefaultSecretsKeyFilePath(resolvedInstanceId),
    storageDir: resolveDefaultStorageDir(resolvedInstanceId),
  };
}
