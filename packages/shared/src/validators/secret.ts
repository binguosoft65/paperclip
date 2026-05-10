import { z } from "zod";
import { SECRET_PROVIDERS } from "../constants.js";

export const envBindingPlainSchema = z.object({
  type: z.literal("plain"),
  value: z.string(),
});

// secretId 校验为 UUID 格式——这是系统内部标识，不支持 ARN 或其他外部 ID。
export const envBindingSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});

// 向后兼容：接受旧版直接将字符串作为值的做法。
// 同时支持新版显式类型标注的两种格式，保证新旧数据格式无缝过渡。
export const envBindingSchema = z.union([
  z.string(),
  envBindingPlainSchema,
  envBindingSecretRefSchema,
]);

export const envConfigSchema = z.record(envBindingSchema);

// 创建密钥的校验规则：
// - name、value 必填（min(1) 确保非空）
// - provider 可选，不传时使用服务端默认值
// - 托管模式（paperclip_managed）禁止设置 externalRef——外部引用和管理模式互斥
export const createSecretSchema = z
  .object({
    name: z.string().min(1),
    provider: z.enum(SECRET_PROVIDERS).optional(),
    managedMode: z.enum(["paperclip_managed", "external_reference"]).optional(),
    value: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    externalRef: z.string().optional().nullable(),
  })
  .refine(
    (data) => {
      if (data.managedMode !== "paperclip_managed") return true;
      return !data.externalRef;
    },
    { message: "Managed secrets cannot set externalRef", path: ["externalRef"] },
  );

export type CreateSecret = z.infer<typeof createSecretSchema>;

export const rotateSecretSchema = z.object({
  value: z.string().min(1),
  externalRef: z.string().optional().nullable(),
});

export type RotateSecret = z.infer<typeof rotateSecretSchema>;

export const updateSecretSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
});

export type UpdateSecret = z.infer<typeof updateSecretSchema>;

// Vault 地址校验：必须是 HTTP/HTTPS 的 origin-only URL。
// transform 用于统一格式（去除多余路径、查询参数等），
// refine 用于最终确认格式合法。
const vaultOriginUrl = z
  .string()
  .trim()
  .transform((value) => {
    try {
      const url = new URL(value.trim());
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      url.pathname = "";
      return url.origin;
    } catch {
      return value.trim();
    }
  })
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          !url.pathname &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    { message: "Must be an origin-only HTTP(S) URL with no path, query, hash, or credentials" },
  );

// Provider 配置的 Schema：每个 Provider 有自己的配置结构。
// 为什么用 discriminatedUnion 而不是 union？
// 因为 discriminatedUnion 根据 "provider" 字段的值自动选择对应的 schema，
// 提供更好的类型推断和更清晰的错误消息。

const localProviderConfigSchema = z.object({
  // 本地加密 Provider 不需要特殊配置，仅需要一个确认备份的标记。
  backupReminderAcknowledged: z.boolean().optional(),
});

const awsProviderConfigSchema = z.object({
  region: z.string().min(1), // 必填
  namespace: z.string().min(1).optional(),
  secretNamePrefix: z.string().optional(),
});

const vaultProviderConfigSchema = z.object({
  address: vaultOriginUrl,
});

const secretProviderConfigMap = {
  local_encrypted: localProviderConfigSchema,
  aws_secrets_manager: awsProviderConfigSchema,
  vault: vaultProviderConfigSchema,
} as const;

export const secretProviderConfigPayloadSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local_encrypted"), config: localProviderConfigSchema }),
  z.object({ provider: z.literal("aws_secrets_manager"), config: awsProviderConfigSchema }),
  z.object({ provider: z.literal("vault"), config: vaultProviderConfigSchema }),
]);

export const createSecretProviderConfigSchema = z.intersection(
  secretProviderConfigPayloadSchema,
  z.object({ displayName: z.string().min(1).max(255) }),
);

export const updateSecretProviderConfigSchema = z.union([
  z.object({ config: localProviderConfigSchema }),
  z.object({ config: awsProviderConfigSchema }),
  z.object({ config: vaultProviderConfigSchema }),
]);

export const remoteSecretImportPreviewSchema = z.object({
  providerConfigId: z.string().uuid(),
  query: z.string().optional(),
  // 分页大小限制：1~100，默认 50。避免单次请求加载过多外部密钥。
  pageSize: z.number().int().min(1).max(100).default(50),
});

const remoteImportSecretSchema = z.object({
  externalRef: z.string().min(1),
  name: z.string().min(1).max(255),
  key: z.string().min(1).max(255),
  description: z.string().trim().optional().nullable(),
  providerMetadata: z.record(z.unknown()).optional(),
});

// 批量导入限制：一次最多导入 100 个密钥，防止超时。
export const remoteSecretImportSchema = z.object({
  providerConfigId: z.string().uuid(),
  secrets: z.array(remoteImportSecretSchema).min(1).max(100),
});

export type CreateSecretProviderConfig = z.infer<typeof createSecretProviderConfigSchema>;
export type RemoteSecretImportPreview = z.infer<typeof remoteSecretImportPreviewSchema>;
export type RemoteSecretImport = z.infer<typeof remoteSecretImportSchema>;
