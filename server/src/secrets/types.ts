import type { SecretProvider, SecretProviderDescriptor } from "@paperclipai/shared";

// 密钥版本存储材料的通用类型。各 Provider 可定义自己的具体结构（如 LocalEncryptedMaterial 包含 iv/tag/ciphertext），
// 只要继承此接口即可。这种设计让 Provider 可以自由选择存储格式，
// 而不受上层数据库模型的约束。
export interface StoredSecretVersionMaterial {
  [key: string]: unknown;
}

// SecretProviderModule 是每个密钥后端必须实现的接口。
// 核心职责只有两个：
// 1. createVersion: 将明文加密/处理为存储材料
// 2. resolveVersion: 将存储材料解密/解析为明文
// 这种极简接口设计使得新增 Provider 的成本非常低。
export interface SecretProviderModule {
  id: SecretProvider;
  descriptor: SecretProviderDescriptor;
  createVersion(input: {
    value: string;
    externalRef: string | null;
  }): Promise<{
    material: StoredSecretVersionMaterial;
    valueSha256: string;
    externalRef: string | null;
  }>;
  resolveVersion(input: {
    material: StoredSecretVersionMaterial;
    externalRef: string | null;
  }): Promise<string>;
}
