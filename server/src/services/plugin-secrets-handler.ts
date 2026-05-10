/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef)`, the JSON-RPC
 * request arrives at the host with `{ secretRef }`. This module provides the
 * concrete `HostServices.secrets` adapter that:
 *
 * 1. Parses the `secretRef` string to identify the secret.
 * 2. Looks up the secret record and its latest version in the database.
 * 3. Delegates to the configured `SecretProviderModule` to decrypt /
 *    resolve the raw value.
 * 4. Returns the resolved plaintext value to the worker.
 *
 * ## Secret Reference Format
 *
 * A `secretRef` is a **secret UUID** — the primary key (`id`) of a row in
 * the `company_secrets` table. Operators place these UUIDs into plugin
 * config values; plugin workers resolve them at execution time via
 * `ctx.secrets.resolve(secretId)`.
 *
 * ## Security Invariants
 *
 * - Resolved values are **never** logged, persisted, or included in error
 *   messages (per PLUGIN_SPEC.md §22).
 * - The handler is capability-gated: only plugins with `secrets.read-ref`
 *   declared in their manifest may call it (enforced by `host-client-factory`).
 * - The host handler itself does not cache resolved values. Each call goes
 *   through the secret provider to honour rotation.
 *
 * ── 为什么不缓存解析后的密钥 ──
 * 密钥轮换（rotation）是重要的安全实践。如果宿主缓存了解析后的值，
 * 管理员轮换密钥后，插件可能继续使用旧值。
 * 每次调用都通过 secret provider 确保获取最新版本。
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions, pluginConfig } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Create a sanitised error that never leaks secret material.
 * Only the ref identifier is included; never the resolved value.
 */
function secretNotFound(secretRef: string): Error {
  const err = new Error(`Secret not found: ${secretRef}`);
  err.name = "SecretNotFoundError";
  return err;
}

function secretVersionNotFound(secretRef: string): Error {
  const err = new Error(`No version found for secret: ${secretRef}`);
  err.name = "SecretVersionNotFoundError";
  return err;
}

function invalidSecretRef(secretRef: string): Error {
  const err = new Error(`Invalid secret reference: ${secretRef}`);
  err.name = "InvalidSecretRefError";
  return err;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Extract secret reference UUIDs from a plugin's configJson, scoped to only
 * the fields annotated with `format: "secret-ref"` in the schema.
 *
 * When no schema is provided, falls back to collecting all UUID-shaped strings
 * (backwards-compatible for plugins without a declared instanceConfigSchema).
 */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  const refs = new Set<string>();
  if (configJson == null || typeof configJson !== "object") return refs;

  const secretPaths = collectSecretRefPaths(schema);

  // If schema declares secret-ref paths, extract only those values.
  if (secretPaths.size > 0) {
    for (const dotPath of secretPaths) {
      const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
      if (typeof current === "string" && isUuidSecretRef(current)) {
        refs.add(current);
      }
    }
    return refs;
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuidSecretRef(value)) refs.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walkAll(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walkAll(v);
    }
  }

  walkAll(configJson);
  return refs;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Input shape for the `secrets.resolve` handler.
 *
 * Matches `WorkerToHostMethods["secrets.resolve"][0]` from `protocol.ts`.
 */
export interface PluginSecretsResolveParams {
  /** The secret reference string (a secret UUID). */
  secretRef: string;
}

/**
 * Options for creating the plugin secrets handler.
 */
export interface PluginSecretsHandlerOptions {
  /** Database connection. */
  db: Db;
  /**
   * The plugin ID using this handler.
   * Used for logging context only; never included in error payloads
   * that reach the plugin worker.
   */
  pluginId: string;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value.
   *
   * @param params - Contains the `secretRef` (UUID of the secret)
   * @returns The resolved secret value
   * @throws {Error} If the secret is not found, has no versions, or
   *   the provider fails to resolve
   */
  resolve(params: PluginSecretsResolveParams): Promise<string>;
}

/**
 * Create a `HostServices.secrets` adapter for a specific plugin.
 *
 * The returned service looks up secrets by UUID, fetches the latest version
 * material, and delegates to the appropriate `SecretProviderModule` for
 * decryption.
 *
 * @example
 * ```ts
 * const secretsHandler = createPluginSecretsHandler({ db, pluginId });
 * const handlers = createHostClientHandlers({
 *   pluginId,
 *   capabilities: manifest.capabilities,
 *   services: {
 *     secrets: secretsHandler,
 *     // ...
 *   },
 * });
 * ```
 *
 * @param options - Database connection and plugin identity
 * @returns A `PluginSecretsService` suitable for `HostServices.secrets`
 */
/** 滑动窗口限流器，用于限制密钥解析请求的频率。
 * 每个密钥（由 key 标识）在给定的时间窗口内最多允许 maxAttempts 次尝试。
 * 旧的时间戳会从数组中移除以避免内存泄漏。
 * 此限流器的目的是防止恶意插件通过 secretRef UUID 枚举来暴力破解密钥。 */
function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId } = options;
  const registry = pluginRegistryService(db);

  // 速率限制：每个插件每分钟最多 30 次密钥解析请求。
  // 这个限制基于典型使用模式——一个 Agent 触发一个插件任务通常只解析 1~5 个密钥。
  // 30/min 足够正常使用，同时防止暴力枚举。
  const rateLimiter = createRateLimiter(30, 60_000);

  // 允许的密钥引用缓存。缓存有效期为 30 秒。
  // 缓存的是从插件配置中提取的 UUID 集合——这个集合在大多数情况下不会频繁变更。
  // 缓存设计：如果插件调用了 resolve() 但配置被更新了，最多延迟 30 秒即可获知新的密钥引用。
  let cachedAllowedRefs: Set<string> | null = null;
  let cachedAllowedRefsExpiry = 0;
  const CONFIG_CACHE_TTL_MS = 30_000; // 30 秒，与事件总线 TTL 一致

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. 限流——防止恶意插件暴力枚举 UUID
      // ---------------------------------------------------------------
      if (!rateLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. 校验参数格式——空字符串和非 UUID 格式直接拒绝
      // ---------------------------------------------------------------
      if (!secretRef || typeof secretRef !== "string" || secretRef.trim().length === 0) {
        throw invalidSecretRef(secretRef ?? "<empty>");
      }

      const trimmedRef = secretRef.trim();

      if (!isUuidSecretRef(trimmedRef)) {
        throw invalidSecretRef(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 1b. 作用域检查——只允许解析插件配置中声明的密钥引用
      //     这是能力（capability）门控的关键环节。
      //     如果插件请求的 secretRef 不在其配置中，返回 "not found"
      //     而不是 "permission denied"，以避免泄露密钥的存在性信息。
      // ---------------------------------------------------------------
      const now = Date.now();
      if (!cachedAllowedRefs || now > cachedAllowedRefsExpiry) {
        const [configRow, plugin] = await Promise.all([
          db
            .select()
            .from(pluginConfig)
            .where(eq(pluginConfig.pluginId, pluginId))
            .then((rows) => rows[0] ?? null),
          registry.getById(pluginId),
        ]);

        const schema = (plugin?.manifestJson as unknown as Record<string, unknown> | null)
          ?.instanceConfigSchema as Record<string, unknown> | undefined;
        cachedAllowedRefs = extractSecretRefsFromConfig(configRow?.configJson, schema);
        cachedAllowedRefsExpiry = now + CONFIG_CACHE_TTL_MS;
      }

      if (!cachedAllowedRefs.has(trimmedRef)) {
        // 返回 "not found" 而非 "permission denied"——防止攻击者枚举哪些 UUID 存在
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 2. 按 UUID 查询密钥元数据
      // ---------------------------------------------------------------
      const secret = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, trimmedRef))
        .then((rows) => rows[0] ?? null);

      if (!secret) {
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 3. 获取最新版本的存储材料
      //     插件始终解析最新版本——不支持固定版本号。
      //     这是设计选择：插件通常运行周期短（几分钟），
      //     轮换期间版本切换的窗口很窄，使用 latest 最合理。
      // ---------------------------------------------------------------
      const versionRow = await db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            eq(companySecretVersions.secretId, secret.id),
            eq(companySecretVersions.version, secret.latestVersion),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!versionRow) {
        throw secretVersionNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 4. 透过对应的 SecretProvider 解析明文
      //     解析后的值直接返回给插件工作进程。
      //     注意：该值不会被日志记录或持久化（参见 PLUGIN_SPEC.md §22）。
      // ---------------------------------------------------------------
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const resolved = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
      });

      return resolved;
    },
  };
}
