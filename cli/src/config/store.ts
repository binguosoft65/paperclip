import fs from "node:fs";
import path from "node:path";
import { paperclipConfigSchema, type PaperclipConfig } from "./schema.js";
import {
  resolveDefaultConfigPath,
  resolvePaperclipInstanceId,
} from "./home.js";

const DEFAULT_CONFIG_BASENAME = "config.json";

// 从当前目录向上递归查找 .paperclip/config.json
// 这一查找策略允许用户在项目的子目录中运行 CLI 命令，自动找到项目根目录的配置
// 类似 git 查找 .git 目录的方式，方便 monorepo 和工作树场景
function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", DEFAULT_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

// 配置文件的查找优先级（从高到低）：
// 1) 命令行 --config 显式指定；2) 环境变量 PAPERCLIP_CONFIG；3) 从 cwd 向上找 .paperclip/config.json；
// 4) 回退到 ~/.paperclip/instances/<id>/config.json 默认路径
export function resolveConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.PAPERCLIP_CONFIG) return path.resolve(process.env.PAPERCLIP_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath(resolvePaperclipInstanceId());
}

function parseJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 旧版配置迁移：将 pglite 模式重命名为 embedded-postgres
// 向前兼容 —— 用户在旧版本创建的 config.json 中包含 pglite 字段，升级后自动识别
// 同时将 pgliteDataDir/pglitePort 映射到新的字段名，避免用户手动编辑配置文件
function migrateLegacyConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const config = { ...(raw as Record<string, unknown>) };
  const databaseRaw = config.database;
  if (typeof databaseRaw !== "object" || databaseRaw === null || Array.isArray(databaseRaw)) {
    return config;
  }

  const database = { ...(databaseRaw as Record<string, unknown>) };
  if (database.mode === "pglite") {
    database.mode = "embedded-postgres";

    if (typeof database.embeddedPostgresDataDir !== "string" && typeof database.pgliteDataDir === "string") {
      database.embeddedPostgresDataDir = database.pgliteDataDir;
    }
    if (
      typeof database.embeddedPostgresPort !== "number" &&
      typeof database.pglitePort === "number" &&
      Number.isFinite(database.pglitePort)
    ) {
      database.embeddedPostgresPort = database.pglitePort;
    }
  }

  config.database = database;
  return config;
}

function formatValidationError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: unknown; message?: unknown }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue) => {
        const pathParts = Array.isArray(issue.path) ? issue.path.map(String) : [];
        const issuePath = pathParts.length > 0 ? pathParts.join(".") : "config";
        const message = typeof issue.message === "string" ? issue.message : "Invalid value";
        return `${issuePath}: ${message}`;
      })
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

// 读取并校验配置文件：经过"解析 JSON -> 旧版迁移 -> Zod schema 校验"三步
// 校验失败时给出精确的字段级错误信息，帮助用户快速定位问题
// 返回 null 仅表示文件不存在，不会抛错；校验失败则抛异常
export function readConfig(configPath?: string): PaperclipConfig | null {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) return null;
  const raw = parseJson(filePath);
  const migrated = migrateLegacyConfig(raw);
  const parsed = paperclipConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${filePath}: ${formatValidationError(parsed.error)}`);
  }
  return parsed.data;
}

// 写入配置文件：自动创建目录 + 写前备份
// 备份文件（config.json.backup）和正式文件均使用 0600 权限
// 目的是防止密钥类配置（如 secrets key 路径）被其他进程读取
export function writeConfig(
  config: PaperclipConfig,
  configPath?: string,
): void {
  const filePath = resolveConfigPath(configPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // 覆盖前自动创建 .backup 文件，防止写入失败导致配置丢失
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + ".backup";
    fs.copyFileSync(filePath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function configExists(configPath?: string): boolean {
  return fs.existsSync(resolveConfigPath(configPath));
}
