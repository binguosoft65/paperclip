import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentDriver,
  FakeSandboxEnvironmentConfig,
  LocalEnvironmentConfig,
  PluginEnvironmentConfig,
  PluginSandboxEnvironmentConfig,
  SandboxEnvironmentConfig,
  SshEnvironmentConfig,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { secretService } from "./secrets.js";
import {
  resolvePluginSandboxProviderDriverByKey,
  validatePluginEnvironmentDriverConfig,
  validatePluginSandboxProviderConfig,
} from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
  writeConfigValueAtPath,
} from "./json-schema-secret-refs.js";

// secret_ref 结构：指向 secrets 表的引用，代替明文存储敏感配置值。
// 持久化时自动将 SSH 私钥等敏感字段转为 secret_ref，
// 运行时再解析回明文。version 支持 latest 或指定版本
const secretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional().default("latest"),
}).strict();

// SSH 环境配置：远程主机 + 认证信息。
// privateKey 在持久化时通过 createEnvironmentSecret 转为 secret_ref，
// 避免 SSH 私钥以明文存储在数据库中。不同阶段（probe/persistence/runtime）使用不同 schema
const sshEnvironmentConfigSchema = z.object({
  host: z.string({ required_error: "SSH environments require a host." }).trim().min(1, "SSH environments require a host."),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string({ required_error: "SSH environments require a username." }).trim().min(1, "SSH environments require a username."),
  remoteWorkspacePath: z
    .string({ required_error: "SSH environments require a remote workspace path." })
    .trim()
    .min(1, "SSH environments require a remote workspace path.")
    .refine((value) => value.startsWith("/"), "SSH remote workspace path must be absolute."),
  privateKey: z.null().optional().default(null),
  privateKeySecretRef: secretRefSchema.optional().nullable().default(null),
  knownHosts: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
  strictHostKeyChecking: z.boolean().optional().default(true),
}).strict();

const sshEnvironmentConfigProbeSchema = sshEnvironmentConfigSchema.extend({
  privateKey: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
}).strict();

const sshEnvironmentConfigPersistenceSchema = sshEnvironmentConfigProbeSchema;

// fake 沙箱 provider：仅用于 probe（连通性测试）和本地开发验证，
// 不提供实际的容器/虚拟机运行时，不可用于 run 执行
const fakeSandboxEnvironmentConfigSchema = z.object({
  provider: z.literal("fake").default("fake"),
  image: z
    .string()
    .trim()
    .min(1, "Fake sandbox environments require an image.")
    .default("ubuntu:24.04"),
  reuseLease: z.boolean().optional().default(false),
}).strict();

// 插件沙箱 provider 的 provider key 格式校验：小写字母数字开头，允许点、短横、下划线
const pluginSandboxProviderKeySchema = z.string()
  .trim()
  .min(1, "Sandbox provider is required.")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Sandbox provider key must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores",
  );

// 插件沙箱环境配置：provider 标识 + 可选超时 + 租约复用。
// catchall 允许各 provider 定义自己的扩展字段（如 region、template 等）
const pluginSandboxEnvironmentConfigSchema = z.object({
  provider: pluginSandboxProviderKeySchema,
  timeoutMs: z.coerce.number().int().min(1).max(86_400_000).optional(),
  reuseLease: z.boolean().optional().default(false),
}).catchall(z.unknown());

// 通用插件环境配置：由插件暴露的 driver 驱动，driverConfig 由插件 Schema 定义。
// pluginKey + driverKey 唯一标识一个插件环境驱动
const pluginEnvironmentConfigSchema = z.object({
  pluginKey: z.string().min(1),
  driverKey: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Environment driver key must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores",
  ),
  driverConfig: z.record(z.unknown()).optional().default({}),
}).strict();

export type ParsedEnvironmentConfig =
  | { driver: "local"; config: LocalEnvironmentConfig }
  | { driver: "ssh"; config: SshEnvironmentConfig }
  | { driver: "sandbox"; config: SandboxEnvironmentConfig }
  | { driver: "plugin"; config: PluginEnvironmentConfig };

function toErrorMessage(error: z.ZodError) {
  const first = error.issues[0];
  if (!first) return "Invalid environment config.";
  return first.message;
}

// 默认 provider 为 fake（兼容未指定 provider 的旧配置）
function getSandboxProvider(raw: Record<string, unknown>) {
  return typeof raw.provider === "string" && raw.provider.trim().length > 0 ? raw.provider.trim() : "fake";
}

// 根据 provider 分发到不同沙箱 schema 进行校验。
// fake → 内置 fakeSchema；其他 → 插件沙箱 schema（支持扩展字段）
function parseSandboxEnvironmentConfig(
  input: Record<string, unknown> | null | undefined,
) {
  const raw = parseObject(input);
  const provider = getSandboxProvider(raw);

  if (provider === "fake") {
    const parsed = fakeSandboxEnvironmentConfigSchema.safeParse(raw);
    return parsed.success
      ? ({ success: true as const, data: parsed.data satisfies FakeSandboxEnvironmentConfig })
      : ({ success: false as const, error: parsed.error });
  }

  const parsed = pluginSandboxEnvironmentConfigSchema.safeParse(raw);
  return parsed.success
    ? ({ success: true as const, data: parsed.data satisfies PluginSandboxEnvironmentConfig })
    : ({ success: false as const, error: parsed.error });
}

async function getSandboxProviderConfigSchema(
  db: Db,
  provider: string,
): Promise<Record<string, unknown> | null> {
  const resolved = await resolvePluginSandboxProviderDriverByKey({
    db,
    driverKey: provider,
  });
  const schema = resolved?.driver.configSchema;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : null;
}

// 环境关联 secret 的命名约定："environment-{driver}-{name}-{field}-{suffix}"。
// 通过名称前缀即可识别哪些 secret 由环境配置自动创建，便于审计和清理
function secretName(input: {
  environmentName: string;
  driver: EnvironmentDriver;
  field: string;
}) {
  const slug = input.environmentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "environment";
  return `environment-${input.driver}-${slug}-${input.field}-${randomUUID().slice(0, 8)}`;
}

// 自动为环境配置中的敏感字段创建加密 secret（provider="local_encrypted"），
// 返回 secret_ref 结构代替明文值存储在 config 中。
// 这样用户提交 SSH 私钥后，数据库中存的是 secretId 而非私钥明文
async function createEnvironmentSecret(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  field: string;
  value: string;
  actor?: { userId?: string | null; agentId?: string | null };
}) {
  const created = await secretService(input.db).create(
    input.companyId,
    {
      name: secretName(input),
      provider: "local_encrypted",
      value: input.value,
      description: `Secret for ${input.environmentName} ${input.field}.`,
    },
    input.actor,
  );
  return {
    type: "secret_ref" as const,
    secretId: created.id,
    version: "latest" as const,
  };
}

// 遍历 config 中所有标注为 secret_ref 型字段，将明文值转为 secret_ref。
// 核心逻辑：如果字段值是 UUID 格式（说明已是 secretId），跳过不处理；
// 如果是明文，则创建 secret 并将字段替换为 {type:"secret_ref", secretId:"..."}
async function persistConfigSecretRefs(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  config: Record<string, unknown>;
  schema: Record<string, unknown> | null;
  actor?: { userId?: string | null; agentId?: string | null };
}): Promise<Record<string, unknown>> {
  let nextConfig = { ...input.config };
  for (const path of collectSecretRefPaths(input.schema)) {
    const rawValue = readConfigValueAtPath(nextConfig, path);
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    // 空字符串视为未设置，移除该字段
    if (trimmed.length === 0) {
      nextConfig = writeConfigValueAtPath(nextConfig, path, undefined);
      continue;
    }
    // 如果已经是 UUID 格式的 secretId，保持不动（如从已有 secret 下拉选择的场景）
    if (isUuidSecretRef(trimmed)) {
      nextConfig = writeConfigValueAtPath(nextConfig, path, trimmed);
      continue;
    }
    // 明文值 → 创建加密 secret → 替换为 secret_ref
    const created = await createEnvironmentSecret({
      db: input.db,
      companyId: input.companyId,
      environmentName: input.environmentName,
      driver: input.driver,
      field: path.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
      value: trimmed,
      actor: input.actor,
    });
    nextConfig = writeConfigValueAtPath(nextConfig, path, created.secretId);
  }
  return nextConfig;
}

async function resolveConfigSecretRefsForRuntime(input: {
  db: Db;
  companyId: string;
  config: Record<string, unknown>;
  schema: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> {
  const secrets = secretService(input.db);
  let nextConfig = { ...input.config };
  for (const path of collectSecretRefPaths(input.schema)) {
    const current = readConfigValueAtPath(nextConfig, path);
    if (typeof current !== "string") continue;
    const trimmed = current.trim();
    if (!isUuidSecretRef(trimmed)) continue;
    nextConfig = writeConfigValueAtPath(
      nextConfig,
      path,
      await secrets.resolveSecretValue(input.companyId, trimmed, "latest"),
    );
  }
  return nextConfig;
}

export function stripSandboxProviderEnvelope(config: SandboxEnvironmentConfig): Record<string, unknown> {
  const { provider: _provider, ...driverConfig } = config as Record<string, unknown>;
  return driverConfig;
}

// 基础配置校验和规范化：不涉及 secret_ref 转换或插件校验。
// 用于不需要持久化或运行时解析的"朴素"校验路径
export function normalizeEnvironmentConfig(input: {
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  if (input.driver === "local") {
    // local 没有严格 schema，直接透传
    return { ...parseObject(input.config) };
  }

  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies SshEnvironmentConfig;
  }

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config);
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  if (input.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies PluginEnvironmentConfig;
  }

  throw unprocessable(`Unsupported environment driver "${input.driver}".`);
}

// 探测用的配置规范化：允许传入明文私钥（SSH），
// 不需要 actor 信息和 secret_ref 转换。
// 插件沙箱 provider 配置会通过 validatePluginSandboxProviderConfig 校验
export function normalizeEnvironmentConfigForProbe(input: {
  db: Db;
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
  pluginWorkerManager?: PluginWorkerManager;
}): Promise<Record<string, unknown>> | Record<string, unknown> {
  if (input.driver === "ssh") {
    // probe 阶段允许明文 privateKey，因为用户需要在保存前测试 SSH 连接
    const parsed = sshEnvironmentConfigProbeSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies SshEnvironmentConfig;
  }

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config);
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.provider === "fake") {
      return parsed.data;
    }
    if (!input.pluginWorkerManager) {
      throw unprocessable("Sandbox provider config validation requires a running plugin worker manager.");
    }
    return validatePluginSandboxProviderConfig({
      db: input.db,
      workerManager: input.pluginWorkerManager,
      provider: parsed.data.provider,
      config: stripSandboxProviderEnvelope(parsed.data),
    }).then((validated) => ({
      provider: parsed.data.provider,
      ...validated.normalizedConfig,
    }));
  }

  return normalizeEnvironmentConfig({
    driver: input.driver,
    config: input.config,
  });
}

// 持久化用的配置规范化：自动处理敏感字段的 secret_ref 转换。
// SSH 私钥转为加密 secret；fake 沙箱不可保存；插件沙箱配置需要 plugin worker 校验
export async function normalizeEnvironmentConfigForPersistence(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
  actor?: { userId?: string | null; agentId?: string | null };
  pluginWorkerManager?: PluginWorkerManager;
}): Promise<Record<string, unknown>> {
  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigPersistenceSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    const secrets = secretService(input.db);
    const { privateKey, ...stored } = parsed.data;
    let nextPrivateKeySecretRef = stored.privateKeySecretRef;
    if (privateKey) {
      // 用户提交了新的明文私钥 → 创建加密 secret 替换原有引用
      nextPrivateKeySecretRef = await createEnvironmentSecret({
        db: input.db,
        companyId: input.companyId,
        environmentName: input.environmentName,
        driver: input.driver,
        field: "private-key",
        value: privateKey,
        actor: input.actor,
      });
      // 清理旧的 secret_ref（如果用户切换了私钥）
      if (
        stored.privateKeySecretRef &&
        stored.privateKeySecretRef.secretId !== nextPrivateKeySecretRef.secretId
      ) {
        await secrets.remove(stored.privateKeySecretRef.secretId);
      }
    }
    return {
      ...stored,
      privateKey: null, // 保证数据库中不存明文
      privateKeySecretRef: nextPrivateKeySecretRef,
    } satisfies SshEnvironmentConfig;
  }

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config);
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    // fake 只允许 probe 使用，不允许保存为持久化环境
    if (parsed.data.provider === "fake") {
      throw unprocessable(
        "Built-in fake sandbox environments are reserved for internal probes and cannot be saved.",
      );
    }
    if (!input.pluginWorkerManager) {
      throw unprocessable("Sandbox provider config validation requires a running plugin worker manager.");
    }
    const validated = await validatePluginSandboxProviderConfig({
      db: input.db,
      workerManager: input.pluginWorkerManager,
      provider: parsed.data.provider,
      config: stripSandboxProviderEnvelope(parsed.data),
    });
    // 插件沙箱的配置中可能包含 secret_ref 字段（如 API token），需要统一处理
    return await persistConfigSecretRefs({
      db: input.db,
      companyId: input.companyId,
      environmentName: input.environmentName,
      driver: input.driver,
      config: {
        provider: parsed.data.provider,
        ...validated.normalizedConfig,
      },
      schema:
        validated.driver.configSchema && typeof validated.driver.configSchema === "object" && !Array.isArray(validated.driver.configSchema)
          ? validated.driver.configSchema as Record<string, unknown>
          : null,
      actor: input.actor,
    });
  }

  if (input.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    if (!input.pluginWorkerManager) {
      throw unprocessable("Plugin environment config validation requires a running plugin worker manager.");
    }
    return { ...(await validatePluginEnvironmentDriverConfig({
      db: input.db,
      workerManager: input.pluginWorkerManager,
      config: parsed.data,
    })) };
  }

  return normalizeEnvironmentConfig({
    driver: input.driver,
    config: input.config,
  });
}

export async function resolveEnvironmentDriverConfigForRuntime(
  db: Db,
  companyId: string,
  environment: Pick<Environment, "driver" | "config">,
): Promise<ParsedEnvironmentConfig> {
  const parsed = parseEnvironmentDriverConfig(environment);
  const secrets = secretService(db);

  if (parsed.driver === "ssh" && parsed.config.privateKeySecretRef) {
    return {
      driver: "ssh",
      config: {
        ...parsed.config,
        privateKey: await secrets.resolveSecretValue(
          companyId,
          parsed.config.privateKeySecretRef.secretId,
          parsed.config.privateKeySecretRef.version ?? "latest",
        ),
      },
    };
  }

  if (parsed.driver === "sandbox" && parsed.config.provider !== "fake") {
    return {
      driver: "sandbox",
      config: await resolveConfigSecretRefsForRuntime({
        db,
        companyId,
        config: parsed.config as Record<string, unknown>,
        schema: await getSandboxProviderConfigSchema(db, parsed.config.provider),
      }) as SandboxEnvironmentConfig,
    };
  }

  return parsed;
}

export function readSshEnvironmentPrivateKeySecretId(
  environment: Pick<Environment, "driver" | "config">,
): string | null {
  if (environment.driver !== "ssh") return null;
  const parsed = sshEnvironmentConfigSchema.safeParse(parseObject(environment.config));
  if (!parsed.success) return null;
  return parsed.data.privateKeySecretRef?.secretId ?? null;
}

export function parseEnvironmentDriverConfig(
  environment: Pick<Environment, "driver" | "config">,
): ParsedEnvironmentConfig {
  if (environment.driver === "local") {
    return {
      driver: "local",
      config: { ...parseObject(environment.config) },
    };
  }

  if (environment.driver === "ssh") {
    const parsed = sshEnvironmentConfigSchema.parse(parseObject(environment.config));
    return {
      driver: "ssh",
      config: parsed,
    };
  }

  if (environment.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(environment.config);
    if (!parsed.success) {
      throw parsed.error;
    }
    return {
      driver: "sandbox",
      config: parsed.data,
    };
  }

  if (environment.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.parse(parseObject(environment.config));
    return {
      driver: "plugin",
      config: parsed,
    };
  }

  throw new Error(`Unsupported environment driver "${environment.driver}".`);
}
