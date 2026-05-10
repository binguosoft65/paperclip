import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";
import { badRequest } from "../errors.js";

// 本地加密 Provider 的存储材料结构。
// scheme 字段用于版本标识和格式校验——当加密方案升级时，可通过 scheme 区分新旧格式。
// 使用 AES-256-GCM 认证加密模式（而非 CBC），因为它能同时提供机密性和完整性保护。
interface LocalEncryptedMaterial extends StoredSecretVersionMaterial {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

// 解析主密钥文件路径：优先使用环境变量，否则使用默认路径 data/secrets/master.key。
// 将密钥文件放在 data/ 目录下而非代码目录中，避免密钥文件被版本控制系统意外提交。
function resolveMasterKeyFilePath() {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.resolve(process.cwd(), "data/secrets/master.key");
}

// 尝试以三种格式解码主密钥：64 字符 hex、base64、或 32 字节原始字符串。
// 支持多种格式是为了减少用户在首次部署时的配置摩擦——用户可以从现有基础设施的任意密钥格式复制过来。
// 密钥必须恰好 32 字节（256 位），这是 AES-256 的要求。
function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 64 个十六进制字符 = 32 字节
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // base64 解码后检查是否为 32 字节
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // base64 解码失败的静默忽略
  }

  // 最后尝试将原始字符串当作 32 字节密钥（不常见但兼容）
  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

// 加载或创建主密钥。优先级：
// 1. 环境变量 PAPERCLIP_SECRETS_MASTER_KEY（适合容器化部署）
// 2. 密钥文件（持久化存储，适合裸机/VM 部署）
// 3. 自动生成新密钥（零配置启动）
// 生成时写入 0o600 权限（仅所有者可读），防止同一机器上的其他进程读取密钥文件。
function loadOrCreateMasterKey(): Buffer {
  const envKeyRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKeyRaw && envKeyRaw.trim().length > 0) {
    const fromEnv = decodeMasterKey(envKeyRaw);
    if (!fromEnv) {
      throw badRequest(
        "Invalid PAPERCLIP_SECRETS_MASTER_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    return fromEnv;
  }

  const keyPath = resolveMasterKeyFilePath();
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8");
    const decoded = decodeMasterKey(raw);
    if (!decoded) {
      throw badRequest(`Invalid secrets master key at ${keyPath}`);
    }
    return decoded;
  }

  // 密钥文件不存在时自动生成 32 字节随机密钥并写入磁盘。
  // 这是为了支持"开箱即用"的开发体验——但生产环境应手动提供密钥或使用外部 Provider。
  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best effort
  }
  return generated;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// 使用 AES-256-GCM 加密。IV 为 12 字节（GCM 推荐值，比 16 字节更高效），
// 每次加密生成随机 IV 确保同一密钥下相同明文的密文不同。
// GCM 模式的 auth tag 提供了完整性校验，防止密文被篡改。
function encryptValue(masterKey: Buffer, value: string): LocalEncryptedMaterial {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptValue(masterKey: Buffer, material: LocalEncryptedMaterial): string {
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

// 运行时校验并转换存储材料为 LocalEncryptedMaterial。
// 严格的字段校验防止数据库损坏数据导致解密异常——宁愿抛错也不返回错误格式的明文。
function asLocalEncryptedMaterial(value: StoredSecretVersionMaterial): LocalEncryptedMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === "local_encrypted_v1" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  ) {
    return value as LocalEncryptedMaterial;
  }
  throw badRequest("Invalid local_encrypted secret material");
}

// 本地加密 Provider 默认将 requiresExternalRef 设为 false，
// 因为本地加密完全在 Paperclip 内部完成，不需要引用外部密钥管理系统。
export const localEncryptedProvider: SecretProviderModule = {
  id: "local_encrypted",
  descriptor: {
    id: "local_encrypted",
    label: "Local encrypted (default)",
    requiresExternalRef: false,
  },
  async createVersion(input) {
    const masterKey = loadOrCreateMasterKey();
    return {
      material: encryptValue(masterKey, input.value),
      valueSha256: sha256Hex(input.value),
      externalRef: null,
    };
  },
  async resolveVersion(input) {
    const masterKey = loadOrCreateMasterKey();
    return decryptValue(masterKey, asLocalEncryptedMaterial(input.material));
  },
};
