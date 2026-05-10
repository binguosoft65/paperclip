import type { SecretProvider, SecretProviderDescriptor } from "@paperclipai/shared";
import { localEncryptedProvider } from "./local-encrypted-provider.js";
import {
  awsSecretsManagerProvider,
  gcpSecretManagerProvider,
  vaultProvider,
} from "./external-stub-providers.js";
import type { SecretProviderModule } from "./types.js";
import { unprocessable } from "../errors.js";

// Provider 注册表：所有支持的密钥后端在此集中注册。
// 当前支持 local_encrypted（本地 AES-256-GCM 加密）、AWS Secrets Manager、GCP Secret Manager 和 HashiCorp Vault。
// 新增 Provider 时，只需在此数组中添加对应的模块实例，无需修改其他代码。
const providers: SecretProviderModule[] = [
  localEncryptedProvider,
  awsSecretsManagerProvider,
  gcpSecretManagerProvider,
  vaultProvider,
];

// 用 Map 构建 ID -> 模块的快速查找表。相比数组遍历，Map 查找的语义更清晰且性能更优。
const providerById = new Map<SecretProvider, SecretProviderModule>(
  providers.map((provider) => [provider.id, provider]),
);

export function getSecretProvider(id: SecretProvider): SecretProviderModule {
  const provider = providerById.get(id);
  if (!provider) throw unprocessable(`Unsupported secret provider: ${id}`);
  return provider;
}

export function listSecretProviders(): SecretProviderDescriptor[] {
  return providers.map((provider) => provider.descriptor);
}
