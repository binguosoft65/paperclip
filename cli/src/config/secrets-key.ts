import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PaperclipConfig } from "./schema.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";

// Secrets 主密钥文件的状态枚举：
// - created: 新创建了密钥文件
// - existing: 密钥文件已存在
// - skipped_env: 跳过，因为环境变量 PAPERCLIP_SECRETS_MASTER_KEY 已设置（优先级更高）
// - skipped_provider: 跳过，因为 secrets provider 不是 local_encrypted
export type EnsureSecretsKeyResult =
  | { status: "created"; path: string }
  | { status: "existing"; path: string }
  | { status: "skipped_env"; path: null }
  | { status: "skipped_provider"; path: null };

// 确保 local_encrypted 模式的 secrets 主密钥文件存在
// 密钥文件为 32 字节随机数据的 base64 编码，0600 权限
// 设计权衡：如果 PAPERCLIP_SECRETS_MASTER_KEY 环境变量已设置，则不做文件管理
// 因为环境变量的优先级高于文件，且环境变量本身就可以作为密钥源
export function ensureLocalSecretsKeyFile(
  config: Pick<PaperclipConfig, "secrets">,
  configPath?: string,
): EnsureSecretsKeyResult {
  if (config.secrets.provider !== "local_encrypted") {
    return { status: "skipped_provider", path: null };
  }

  const envMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envMasterKey && envMasterKey.trim().length > 0) {
    return { status: "skipped_env", path: null };
  }

  const keyFileOverride = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const configuredPath =
    keyFileOverride && keyFileOverride.trim().length > 0
      ? keyFileOverride.trim()
      : config.secrets.localEncrypted.keyFilePath;
  const keyFilePath = resolveRuntimeLikePath(configuredPath, configPath);

  if (fs.existsSync(keyFilePath)) {
    return { status: "existing", path: keyFilePath };
  }

  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
  fs.writeFileSync(keyFilePath, randomBytes(32).toString("base64"), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(keyFilePath, 0o600);
  } catch {
    // best effort
  }
  return { status: "created", path: keyFilePath };
}
