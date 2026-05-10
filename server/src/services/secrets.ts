import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions } from "@paperclipai/db";
import type { AgentEnvConfig, EnvBinding, SecretProvider } from "@paperclipai/shared";
import { envBindingSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";

// 环境变量名正则：必须以字母或下划线开头，仅包含字母、数字、下划线。
// 这是 POSIX 环境变量的命名规范，确保注入到 Agent 进程中的变量名合法。
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 敏感环境变量关键字的正则匹配。用于 strictMode 下强制要求敏感变量必须通过 Secret 引用，
// 不能以明文方式存储，防止密钥意外泄露到数据库日志或备份中。
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
// 脱敏占位符常量。当前端返回已存在的 Secret 绑定时，将密钥值替换为此字符串，
// 防止前端再次提交时将脱敏后的占位符当作实际值持久化。
const REDACTED_SENTINEL = "***REDACTED***";

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version: number | "latest" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

// 将 EnvBinding（兼容字符串、plain 对象、secret_ref 三种格式）标准化为内部统一格式。
// 旧版直接使用字符串作为值的方式（如 { MY_KEY: "myvalue" }）需要转为 { type: "plain", value: "myvalue" }。
// 这个兼容层保证了新旧数据格式都能被正常处理。
function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (typeof binding === "string") {
    return { type: "plain", value: binding };
  }
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  return {
    type: "secret_ref",
    secretId: binding.secretId,
    version: binding.version ?? "latest",
  };
}

export function secretService(db: Db) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

  async function getById(id: string) {
    // 按主键精确查找密钥元数据。不包含实际密文。
    return db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(companyId: string, name: string) {
    // 按公司 ID + 名称查找密钥。公司级别唯一性约束——同一公司下密钥名称不可重复。
    return db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, name)))
      .then((rows) => rows[0] ?? null);
  }

  // 按 secretId + 精确版本号查询版本数据。通常用于消费者固定版本号的场景。
  async function getSecretVersion(secretId: string, version: number) {
    return db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secretId),
          eq(companySecretVersions.version, version),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  // 断言某个密钥属于某个公司。用于跨租户防护——防止一个公司的环境变量绑定另一个公司的密钥。
  // 这是多租户环境下的关键安全边界检查。
  async function assertSecretInCompany(companyId: string, secretId: string) {
    const secret = await getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    return secret;
  }

  // 解析密钥值为明文。流程：确认密钥所属公司 -> 确定版本号 -> 读取版本存储材料 -> 委托 Provider 解密。
  // "latest" 版本始终指向 latestVersion 字段，由轮换操作维护其值。
  async function resolveSecretValue(
    companyId: string,
    secretId: string,
    version: number | "latest",
  ): Promise<string> {
    const secret = await assertSecretInCompany(companyId, secretId);
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    const versionRow = await getSecretVersion(secret.id, resolvedVersion);
    if (!versionRow) throw notFound("Secret version not found");
    const provider = getSecretProvider(secret.provider as SecretProvider);
    return provider.resolveVersion({
      material: versionRow.material as Record<string, unknown>,
      externalRef: secret.externalRef,
    });
  }

  async function normalizeEnvConfig(
    companyId: string,
    envValue: unknown,
    opts?: NormalizeEnvOptions,
  ): Promise<AgentEnvConfig> {
    // 将用户提交的环境变量配置解析并校验，确保：
    // 1. 所有 key 符合 POSIX 环境变量命名规范
    // 2. 每个值要么是明文（plain string），要么是合法的密钥引用
    // 3. 如果启用了 strictMode，敏感变量名必须使用密钥引用
    // 4. 禁止持久化脱敏占位符（REDACTED_SENTINEL）
    const record = asRecord(envValue);
    if (!record) throw unprocessable(`${opts?.fieldPath ?? "env"} must be an object`);

    const normalized: AgentEnvConfig = {};
    for (const [key, rawBinding] of Object.entries(record)) {
      if (!ENV_KEY_RE.test(key)) {
        throw unprocessable(`Invalid environment variable name: ${key}`);
      }

      const parsed = envBindingSchema.safeParse(rawBinding);
      if (!parsed.success) {
        throw unprocessable(`Invalid environment binding for key: ${key}`);
      }

      const binding = canonicalizeBinding(parsed.data as EnvBinding);
      if (binding.type === "plain") {
        if (opts?.strictMode && isSensitiveEnvKey(key) && binding.value.trim().length > 0) {
          throw unprocessable(
            `Strict secret mode requires secret references for sensitive key: ${key}`,
          );
        }
        if (binding.value === REDACTED_SENTINEL) {
          throw unprocessable(`Refusing to persist redacted placeholder for key: ${key}`);
        }
        normalized[key] = binding;
        continue;
      }

      await assertSecretInCompany(companyId, binding.secretId);
      normalized[key] = {
        type: "secret_ref",
        secretId: binding.secretId,
        version: binding.version,
      };
    }
    return normalized;
  }

  async function normalizeAdapterConfigForPersistenceInternal(
    companyId: string,
    adapterConfig: Record<string, unknown>,
    opts?: { strictMode?: boolean },
  ) {
    // 持久化前标准化 Adapter 配置。只有包含 "env" 字段时才需要处理，
    // 没有 env 字段的 Adapter 配置直接原样存储。
    const normalized = { ...adapterConfig };
    if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
      return normalized;
    }
    normalized.env = await normalizeEnvConfig(companyId, adapterConfig.env, opts);
    return normalized;
  }

  return {
    listProviders: () => listSecretProviders(),

    list: (companyId: string) =>
      // 按创建时间倒序列出公司所有密钥。不包含密文，仅返回元数据。
      db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, companyId))
        .orderBy(desc(companySecrets.createdAt)),

    getById,
    getByName,
    resolveSecretValue,

    // 创建密钥的完整流程：
    // 1. 校验名称在公司级别唯一性
    // 2. 委托 Provider 对明文加密/预处理，生成存储材料
    // 3. 在同一个事务中写入密钥元数据和第一版本数据
    // 这样设计确保密钥不会出现"元数据存在但版本数据缺失"的不一致状态。
    create: async (
      companyId: string,
      input: {
        name: string;
        provider: SecretProvider;
        value: string;
        description?: string | null;
        externalRef?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await getByName(companyId, input.name);
      if (existing) throw conflict(`Secret already exists: ${input.name}`);

      const provider = getSecretProvider(input.provider);
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? null,
      });

      return db.transaction(async (tx) => {
        const secret = await tx
          .insert(companySecrets)
          .values({
            companyId,
            name: input.name,
            provider: input.provider,
            externalRef: prepared.externalRef,
            latestVersion: 1,
            description: input.description ?? null,
            createdByAgentId: actor?.agentId ?? null,
            createdByUserId: actor?.userId ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        return secret;
      });
    },

    // 轮换密钥：递增版本号并写入新版本数据。
    // 注意：旧版本数据不删除，以便消费者可以延迟切换到新版本，
    // 或者在出现问题时回滚到旧版本。
    // 更新 companySecrets 的 latestVersion 和 externalRef，
    // 保证下次 "latest" 解析指向最新的版本。
    rotate: async (
      secretId: string,
      input: { value: string; externalRef?: string | null },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const nextVersion = secret.latestVersion + 1;
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? secret.externalRef ?? null,
      });

      return db.transaction(async (tx) => {
        // 先插入新版本，再更新元数据表的 latestVersion。
        // 顺序不能颠倒——如果在插入版本之前更新 latestVersion，
        // 会导致短暂地指向不存在的版本号。
        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: nextVersion,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        const updated = await tx
          .update(companySecrets)
          .set({
            latestVersion: nextVersion,
            externalRef: prepared.externalRef,
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, secret.id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!updated) throw notFound("Secret not found");
        return updated;
      });
    },

    // 更新密钥元数据（名称、描述、外部引用）。不调整版本号。
    // 改名时需要检查公司内是否已有同名密钥（除自身外）。
    // 注意：update 不涉及密钥值，不会调用 Provider。
    update: async (
      secretId: string,
      patch: { name?: string; description?: string | null; externalRef?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");

      if (patch.name && patch.name !== secret.name) {
        const duplicate = await getByName(secret.companyId, patch.name);
        if (duplicate && duplicate.id !== secret.id) {
          throw conflict(`Secret already exists: ${patch.name}`);
        }
      }

      return db
        .update(companySecrets)
        .set({
          name: patch.name ?? secret.name,
          description:
            patch.description === undefined ? secret.description : patch.description,
          externalRef:
            patch.externalRef === undefined ? secret.externalRef : patch.externalRef,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // 删除密钥。仅删除 companySecrets 行，
    // version 数据通过数据库级联删除自动清理。
    // 返回被删除的密钥元数据（不含密文）供调用方使用。
    remove: async (secretId: string) => {
      const secret = await getById(secretId);
      if (!secret) return null;
      await db.delete(companySecrets).where(eq(companySecrets.id, secretId));
      return secret;
    },

    normalizeAdapterConfigForPersistence: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => normalizeAdapterConfigForPersistenceInternal(companyId, adapterConfig, opts),

    normalizeEnvBindingsForPersistence: async (
      companyId: string,
      envValue: unknown,
      opts?: NormalizeEnvOptions,
    ) => normalizeEnvConfig(companyId, envValue, opts),

    normalizeHireApprovalPayloadForPersistence: async (
      companyId: string,
      payload: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => {
      // 招聘审批负载中也包含 adapterConfig，需要递归标准化 env 绑定。
      const normalized = { ...payload };
      const adapterConfig = asRecord(payload.adapterConfig);
      if (adapterConfig) {
        normalized.adapterConfig = await normalizeAdapterConfigForPersistenceInternal(
          companyId,
          adapterConfig,
          opts,
        );
      }
      return normalized;
    },

    resolveEnvBindings: async (companyId: string, envValue: unknown): Promise<{ env: Record<string, string>; secretKeys: Set<string> }> => {
      // 运行时解析所有环境变量绑定为最终明文。
      // 返回结果包含两组信息：
      // - env: key -> 明文值的映射，可直接注入到 Agent 进程
      // - secretKeys: 使用了密钥引用的 key 集合，供调用方记录审计信息
      const record = asRecord(envValue);
      if (!record) return { env: {} as Record<string, string>, secretKeys: new Set<string>() };
      const resolved: Record<string, string> = {};
      const secretKeys = new Set<string>();

      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          resolved[key] = binding.value;
        } else {
          resolved[key] = await resolveSecretValue(companyId, binding.secretId, binding.version);
          secretKeys.add(key);
        }
      }
      return { env: resolved, secretKeys };
    },

    resolveAdapterConfigForRuntime: async (companyId: string, adapterConfig: Record<string, unknown>): Promise<{ config: Record<string, unknown>; secretKeys: Set<string> }> => {
      // 运行时解析 Adapter 配置中的环境变量绑定。
      // 与 resolveEnvBindings 类似，但作用于嵌套在 adapterConfig.env 中的绑定。
      const resolved = { ...adapterConfig };
      const secretKeys = new Set<string>();
      if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
        return { config: resolved, secretKeys };
      }
      const record = asRecord(adapterConfig.env);
      if (!record) {
        resolved.env = {};
        return { config: resolved, secretKeys };
      }
      const env: Record<string, string> = {};
      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          env[key] = binding.value;
        } else {
          env[key] = await resolveSecretValue(companyId, binding.secretId, binding.version);
          secretKeys.add(key);
        }
      }
      resolved.env = env;
      return { config: resolved, secretKeys };
    },
  };
}
