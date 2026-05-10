/**
 * 密钥与环境变量绑定相关类型定义。
 * 支持明文绑定和密钥引用绑定两种方式，
 * 兼容旧版直接使用字符串作为值的做法。
 */

// 支持的密钥后端列表。新增后端时需要同时更新此类型和 server/src/secrets/provider-registry.ts 中的注册列表。
export type SecretProvider =
  | "local_encrypted"
  | "aws_secrets_manager"
  | "gcp_secret_manager"
  | "vault";

// 版本选择器：可以是具体编号或 "latest"（最新版本）。
// 使用 "latest" 而不是最新版本号的好处是：当密钥轮换后，消费者自动获取新版本。
// 固定版本号则用于需要版本稳定性的场景，如审计要求或 A/B 测试。
export type SecretVersionSelector = number | "latest";

export interface EnvPlainBinding {
  type: "plain";
  value: string;
}

export interface EnvSecretRefBinding {
  type: "secret_ref";
  secretId: string;
  version?: SecretVersionSelector;
}

// 向后兼容：旧版直接将明文字符串作为值，如 { MY_KEY: "myvalue" }。
// 新版支持显式的 { type: "plain", value: "myvalue" } 和 { type: "secret_ref", secretId: "uuid" }。
// union 类型让解析代码可以统一处理三种格式。
export type EnvBinding = string | EnvPlainBinding | EnvSecretRefBinding;

export type AgentEnvConfig = Record<string, EnvBinding>;

export interface CompanySecret {
  id: string;
  companyId: string;
  name: string;
  provider: SecretProvider;
  externalRef: string | null;
  latestVersion: number;
  description: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Provider 描述信息，用于前端展示和创建密钥时的选择。
export interface SecretProviderDescriptor {
  id: SecretProvider;
  label: string;
  requiresExternalRef: boolean;
}
