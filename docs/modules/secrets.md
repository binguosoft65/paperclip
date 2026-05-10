# Secrets 模块文档

## 模块概述

Secrets 模块是 Paperclip 的密钥管理系统，负责密钥的创建、存储、轮换、解析以及环境变量绑定的全生命周期管理。该模块采用 **Provider 架构**，支持多种密钥后端实现，将密钥的存储与使用解耦。

### 核心能力

- **多 Provider 支持**：本地加密（AES-256-GCM）、AWS Secrets Manager、GCP Secret Manager、HashiCorp Vault
- **版本化管理**：每次轮换创建新版本，支持固定版本和 "latest" 两种消费方式
- **环境变量绑定**：将密钥引用绑定到 Agent/Project 的环境变量中，运行时自动解析
- **插件密钥注入**：插件工作进程通过 `ctx.secrets.resolve()` 获取密钥
- **密钥脱敏与审计**：存储的密钥值不重新展示，所有操作记录审计日志
- **多租户隔离**：密钥归属 Company，跨公司引用被严格禁止

---

## Provider 架构

```
SecretProviderModule (interface)
  |
  |-- local-encrypted-provider   (AES-256-GCM 本地加密)
  |-- aws-secrets-manager-provider (AWS Secrets Manager)
  |-- gcp-secret-manager-provider (GCP Secret Manager, coming_soon)
  |-- vault-provider              (HashiCorp Vault, coming_soon)
```

每个 Provider 实现 `SecretProviderModule` 接口，仅有两个核心方法：

```typescript
interface SecretProviderModule {
  id: SecretProvider;
  descriptor: SecretProviderDescriptor;
  createVersion(input: {
    value: string;
    externalRef: string | null;
  }): Promise<PreparedSecretVersion>;

  resolveVersion(input: {
    material: StoredSecretVersionMaterial;
    externalRef: string | null;
  }): Promise<string>;
}
```

### 注册机制

在 `server/src/secrets/provider-registry.ts` 中集中注册。所有支持的 Provider 以数组形式列出，通过 Map 建立 `id -> module` 的快速查找。

### 设计权衡

- **极简接口**：Provider 接口只有 createVersion 和 resolveVersion 两个方法。额外的功能（健康检查、远程列表、删除归档）通过扩展接口实现，不是强制要求。这使得新增 Provider 的成本非常低。
- **存储材料透明**：Provider 可以自由定义 `StoredSecretVersionMaterial` 的结构，数据库不关心具体内容，只负责存储和返回。这种设计让 Provider 可以使用加密、引用、指针等任意存储策略。
- **外部引用模式**：除托管模式外，Provider 支持 "external_reference" 模式——仅存储外部密钥的引用，不参与写入和轮换。这适用于需要引用现有基础设施密钥的场景。

---

## 核心流程

### 1. 创建密钥 (Create)

```
用户 (UI/API) -> Routes -> secretService.create()
   |
   1. 校验名称唯一性 (companyId + name)
   2. 调用 Provider.createVersion() 加密/处理明文
   3. 事务：写入 companySecrets + companySecretVersions (version=1)
   |
   -> 记录审计日志 (secret.created)
```

### 2. 轮换密钥 (Rotate)

```
用户 (UI/API) -> Routes -> secretService.rotate()
   |
   1. 查询现有密钥
   2. 计算 nextVersion = latestVersion + 1
   3. 调用 Provider.createVersion() 加密新值
   4. 事务：
     a. 插入新版本到 companySecretVersions
     b. 更新 companySecrets.latestVersion = nextVersion
   |
   -> 记录审计日志 (secret.rotated)
```

**旧版本保留策略**：轮换不删除旧版本数据。消费者可以：
- 使用 "latest" 自动获取最新版本
- 固定到某个旧版本号，等待测试通过后再切换

**AWS 特殊处理**：AWS Provider 在新版本上标记 `PAPERCLIP_PENDING` 阶段，不立即覆盖 `AWSCURRENT`。后续由独立协调流程推进版本切换，防止轮换过程中的竞态。

### 3. 解析密钥 (Resolve)

```
注入点 (Agent/Plugin 启动时)
   |
   secretService.resolveSecretValue(companyId, secretId, version)
   |
   1. assertSecretInCompany() 跨租户检查
   2. 确定版本号 (latest -> latestVersion, 固定 -> 指定版本)
   3. 从 companySecretVersions 读取存储材料
   4. 调用 Provider.resolveVersion() 解密
   |
   -> 返回明文
```

### 4. 插件密钥解析 (Plugin Secret Resolve)

```
插件工作进程 -> JSON-RPC -> createPluginSecretsHandler.resolve()
   |
   1. 限流检查 (30 次/分钟/插件)
   2. UUID 格式校验
   3. 作用域检查：secretRef 必须在插件配置中声明
   4. 查询 companySecrets 元数据
   5. 获取最新版本存储材料
   6. 委托 Provider 解密
   |
   -> 返回明文给插件工作进程
```

**安全设计**：
- 速率限制防止 UUID 暴力枚举
- 作用域检查确保插件只能访问配置中声明的密钥
- 错误消息不泄露密钥是否存在的信息
- 解析值不记录日志（遵循 PLUGIN_SPEC.md §22）

### 5. 环境变量绑定解析

```
Agent/Project 配置 -> secretService.resolveEnvBindings()
   |
   1. 遍历所有 env 条目
   2. 明文值直接通过
   3. 密钥引用调用 resolveSecretValue() 解析
   4. 聚合为 { env: Record<string, string>, secretKeys: Set<string> }
   |
   -> 注入到进程环境变量
```

---

## 数据模型

### company_secrets（密钥元数据表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| company_id | UUID | 所属公司，多租户隔离键 |
| name | string | 密钥名称，公司内唯一 |
| key | string | 密钥标识符，用于绑定 |
| provider | enum | 密钥后端类型 |
| external_ref | string? | 外部 Provider 的密钥引用（ARN/路径） |
| latest_version | int | 当前最新版本号 |
| managed_mode | enum | paperclip_managed / external_reference |
| description | string? | 描述 |
| status | enum | active / disabled / archived / deleted |
| provider_config_id | UUID? | 关联的 Provider 配置 |
| created_by_agent_id | UUID? | 创建者 Agent ID |
| created_by_user_id | UUID? | 创建者用户 ID |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

### company_secret_versions（密钥版本数据表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| secret_id | UUID | 关联密钥，外键 |
| version | int | 版本号（从 1 开始递增） |
| material | JSONB | Provider 存储材料（加密后的密文/引用） |
| value_sha256 | string | 原始值的 SHA-256 指纹 |
| created_by_agent_id | UUID? | 创建者 |
| created_by_user_id | UUID? | 创建者 |
| created_at | timestamp | 创建时间 |

**material 字段的存储结构**（各 Provider 不同）：

- **local_encrypted**: `{ scheme: "local_encrypted_v1", iv: string, tag: string, ciphertext: string }`
- **aws_secrets_manager** (managed): `{ scheme: "aws_secrets_manager_v1", secretId: string, versionId: string | null, source: "managed" }`
- **aws_secrets_manager** (external): `{ scheme: "aws_secrets_manager_v1", secretId: string, versionId: string | null, source: "external_reference" }`

---

## 加密策略

### 本地加密 (Local Encrypted Provider)

- **算法**: AES-256-GCM（认证加密模式，同时提供机密性和完整性）
- **密钥**: 32 字节 (256-bit)，支持环境变量或文件方式提供
- **IV**: 12 字节随机值（GCM 推荐值，比 16 字节性能更优）
- **主密钥加载优先级**:
  1. `PAPERCLIP_SECRETS_MASTER_KEY` 环境变量
  2. 密钥文件（默认 `data/secrets/master.key`，权限 0o600）
  3. 自动生成新密钥（零配置开发模式）

### AWS Secrets Manager

- **Vault 配置**: 路由元数据（region, namespace 等）存储在数据库中
- **凭证**: 通过 AWS SDK 默认凭证链获取（支持 IAM 角色、环境变量、配置文件等）
- **凭证缓存**: 5 分钟 TTL，进程级缓存，按区域隔离
- **版本管理**: 使用两阶段提交（PAPERCLIP_PENDING -> AWSCURRENT）

---

## 环境变量绑定

### 绑定格式

环境变量绑定支持三种格式，向后兼容：

```typescript
type EnvBinding =
  | string                              // 旧版：直接明文字符串
  | { type: "plain", value: string }    // 新版：显式明文
  | { type: "secret_ref", secretId: string, version?: number | "latest" };
                                    // 新版：密钥引用
```

### 严格模式 (Strict Mode)

在严格模式下，包含敏感关键字（如 api_key, password, token, secret, jwt 等）的环境变量名**必须**使用密钥引用，禁止明文存储。这是为了防止密钥意外泄露到数据库日志或备份中。

### 脱敏占位符

`***REDACTED***` 是系统定义的脱敏占位符。当前端返回已存储的密钥绑定时，密钥值被替换为此字符串。持久化时遇到该占位符会拒绝写入，防止脱敏数据被二次存储。

---

## 密钥版本选择器

| 选择器 | 含义 | 适用场景 |
|--------|------|----------|
| `latest` | 始终指向最新版本 | 普通运行，轮换后自动更新 |
| 数字 `n` | 固定到指定版本 | 审计要求、A/B 测试、延迟切换 |

---

## 上下游依赖

### 上游（调用该模块的模块）

| 模块 | 使用方式 |
|------|----------|
| Agent Runtime | 运行时解析环境变量中的密钥引用 |
| Plugin Worker | 通过 `ctx.secrets.resolve()` 获取密钥 |
| Project Config | 项目级环境变量中包含密钥绑定 |
| Hire Approval | 审批负载中包含 adapterConfig，需要标准化 |
| Activity Log | 密钥操作记录审计事件 |

### 下游（该模块依赖的模块）

| 模块 | 依赖内容 |
|------|----------|
| `@paperclipai/db` | Drizzle ORM、company_secrets/company_secret_versions 表定义 |
| `@paperclipai/shared` | 共享类型（SecretProvider, EnvBinding 等）和 Zod 校验器 |
| AWS SDK (S3Client) | 仅用于通过默认凭证链获取 AWS 凭证 |
| Node.js crypto | 本地加密（AES-256-GCM）和 SHA-256 哈希 |

---

## 安全约束

1. **跨租户隔离**：`assertSecretInCompany()` 确保一个公司的密钥不能被另一个公司引用
2. **密钥值不落日志**：所有日志记录仅包含密钥名称、版本号等元数据，不包含值
3. **错误消息脱敏**：Provider 错误被分类为安全消息（access_denied, throttled 等），原始错误消息不暴露给前端
4. **插件的密钥作用域**：插件只能访问其配置中声明的密钥引用
5. **速率限制**：插件密钥解析限制为 30 次/分钟，防止 UUID 暴力枚举
6. **环境变量严格模式**：敏感变量名必须使用密钥引用
7. **主密钥文件权限**：本地加密的主密钥文件权限设为 0o600

---

## 关键文件清单

| 文件路径 | 职责 |
|----------|------|
| `server/src/routes/secrets.ts` | HTTP 路由定义，权限校验，审计日志 |
| `server/src/services/secrets.ts` | 核心业务逻辑，CRUD 操作，环境变量规范化与解析 |
| `server/src/secrets/provider-registry.ts` | Provider 注册与查找 |
| `server/src/secrets/types.ts` | SecretProviderModule 接口定义 |
| `server/src/secrets/local-encrypted-provider.ts` | 本地 AES-256-GCM 加密实现 |
| `server/src/secrets/aws-secrets-manager-provider.ts` | AWS Secrets Manager 完整实现（含 SigV4 签名） |
| `server/src/secrets/configured-provider.ts` | 部署级别默认 Provider 解析 |
| `server/src/secrets/external-stub-providers.ts` | GCP/Vault 的桩模块（coming_soon） |
| `server/src/services/plugin-secrets-handler.ts` | 插件密钥解析处理器 |
| `ui/src/pages/Secrets.tsx` | 密钥管理页面（CRUD、轮换、Provider 配置） |
| `ui/src/components/SecretBindingPicker.tsx` | 密钥绑定选择器组件 |
| `ui/src/components/EnvVarEditor.tsx` | 环境变量编辑器（支持明文/密钥切换和密封操作） |
| `packages/shared/src/types/secrets.ts` | 共享类型定义 |
| `packages/shared/src/validators/secret.ts` | Zod 校验器定义 |
