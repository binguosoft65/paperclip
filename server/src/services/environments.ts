import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases, environments } from "@paperclipai/db";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_POLICIES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
  type CreateEnvironment,
  type Environment,
  type EnvironmentLease,
  type EnvironmentLeaseCleanupStatus,
  type EnvironmentLeasePolicy,
  type EnvironmentLeaseStatus,
  type UpdateEnvironment,
} from "@paperclipai/shared";

type EnvironmentRow = typeof environments.$inferSelect;
type EnvironmentLeaseRow = typeof environmentLeases.$inferSelect;
// 每个公司默认有一个不可删除的 Local 环境，用于无远程/沙箱环境时的降级运行
const DEFAULT_LOCAL_ENVIRONMENT_NAME = "Local";
const DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION =
  "Default execution environment for Paperclip runs on this machine.";

// 防御性拷贝：避免业务代码意外突变数据库行引用。
// 对于 null/非对象输入返回 fallback，统一 null 和 {} 的行为
function cloneRecord(value: unknown, fallback: Record<string, unknown> | null = null): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  return { ...(value as Record<string, unknown>) };
}

// 安全枚举转换：从数据库字符串转为 TypeScript union type。
// 遇到未知值抛异常而非静默吞掉，以便尽早发现数据损坏
function readEnum<T extends string>(value: string | null, allowed: readonly T[], fieldName: string): T | null {
  if (value === null) return null;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${fieldName} value: ${value}`);
}

// DB 行 → 领域对象映射。降级策略：driver/status 为 null 时默认 "local"/"active"，
// 保持对旧数据的向后兼容
function toEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description ?? null,
    driver: readEnum(row.driver, ENVIRONMENT_DRIVERS, "environment driver") ?? "local",
    status: readEnum(row.status, ENVIRONMENT_STATUSES, "environment status") ?? "active",
    config: cloneRecord(row.config, {}) ?? {},
    metadata: cloneRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEnvironmentLease(row: EnvironmentLeaseRow): EnvironmentLease {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    status: readEnum(row.status, ENVIRONMENT_LEASE_STATUSES, "environment lease status") ?? "active",
    leasePolicy: readEnum(row.leasePolicy, ENVIRONMENT_LEASE_POLICIES, "environment lease policy") ?? "ephemeral",
    provider: row.provider ?? null,
    providerLeaseId: row.providerLeaseId ?? null,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    cleanupStatus: readEnum(
      row.cleanupStatus,
      ENVIRONMENT_LEASE_CLEANUP_STATUSES,
      "environment lease cleanup status",
    ),
    metadata: cloneRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function environmentService(db: Db) {
  return {
    list: async (
      companyId: string,
      filters: {
        status?: string;
        driver?: string;
      } = {},
    ): Promise<Environment[]> => {
      const conditions = [eq(environments.companyId, companyId)];
      if (filters.status) conditions.push(eq(environments.status, filters.status));
      if (filters.driver) conditions.push(eq(environments.driver, filters.driver));
      const rows = await db
        .select()
        .from(environments)
        .where(and(...conditions))
        .orderBy(desc(environments.updatedAt), desc(environments.createdAt));
      return rows.map(toEnvironment);
    },

    getById: async (id: string): Promise<Environment | null> => {
      const row = await db.select().from(environments).where(eq(environments.id, id)).then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    getLeaseById: async (id: string): Promise<EnvironmentLease | null> => {
      const row = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    ensureLocalEnvironment: async (companyId: string): Promise<Environment> => {
      // 确保每个公司都有一个 Local 环境：尝试插入默认 Local 环境（onConflictDoNothing 防止重复），
      // 如果插入失败（已存在），则通过 driver+companyId 的唯一约束查询已存在的行。
      // 这是 run 执行的最低保障环境，确保即使没有任何配置也能在宿主机上运行
      const now = new Date();
      const row = await db
        .insert(environments)
        .values({
          companyId,
          name: DEFAULT_LOCAL_ENVIRONMENT_NAME,
          description: DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION,
          driver: "local",
          status: "active",
          config: {},
          metadata: {
            managedByPaperclip: true,
            defaultForCompany: true,
          },
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [environments.companyId, environments.driver],
          where: sql`${environments.driver} = 'local'`,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (row) return toEnvironment(row);

      const existing = await db
        .select()
        .from(environments)
        .where(and(eq(environments.companyId, companyId), eq(environments.driver, "local")))
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw new Error("Failed to ensure local environment");
      }
      return toEnvironment(existing);
    },

    create: async (companyId: string, input: CreateEnvironment): Promise<Environment> => {
      const now = new Date();
      const row = await db
        .insert(environments)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          driver: input.driver,
          status: input.status ?? "active",
          config: input.config ?? {},
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) {
        throw new Error("Failed to create environment");
      }
      return toEnvironment(row);
    },

    update: async (id: string, patch: UpdateEnvironment): Promise<Environment | null> => {
      const values: Partial<typeof environments.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.description !== undefined) values.description = patch.description ?? null;
      if (patch.driver !== undefined) values.driver = patch.driver;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.config !== undefined) values.config = patch.config;
      if (patch.metadata !== undefined) values.metadata = patch.metadata ?? null;

      const row = await db
        .update(environments)
        .set(values)
        .where(eq(environments.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    remove: async (id: string): Promise<Environment | null> => {
      const row = await db
        .delete(environments)
        .where(eq(environments.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironment(row) : null;
    },

    listLeases: async (
      environmentId: string,
      filters: {
        status?: string;
      } = {},
    ): Promise<EnvironmentLease[]> => {
      const conditions = [eq(environmentLeases.environmentId, environmentId)];
      if (filters.status) conditions.push(eq(environmentLeases.status, filters.status));
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(and(...conditions))
        .orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt));
      return rows.map(toEnvironmentLease);
    },

    acquireLease: async (input: {
      companyId: string;
      environmentId: string;
      executionWorkspaceId?: string | null;
      issueId?: string | null;
      heartbeatRunId?: string | null;
      leasePolicy?: EnvironmentLeasePolicy;
      provider?: string | null;
      providerLeaseId?: string | null;
      expiresAt?: Date | null;
      metadata?: Record<string, unknown> | null;
    }): Promise<EnvironmentLease> => {
      // 创建一个新的活动租约。每个 heartbeat run 在环境中执行时持有一个租约，
      // 租约策略（leasePolicy）决定释放时的行为：ephemeral 直接释放，
      // reuse_by_environment 允许后续 run 复用同一 provider 资源
      const now = new Date();
      const row = await db
        .insert(environmentLeases)
        .values({
          companyId: input.companyId,
          environmentId: input.environmentId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          issueId: input.issueId ?? null,
          heartbeatRunId: input.heartbeatRunId ?? null,
          status: "active",
          leasePolicy: input.leasePolicy ?? "ephemeral",
          provider: input.provider ?? null,
          providerLeaseId: input.providerLeaseId ?? null,
          acquiredAt: now,
          lastUsedAt: now,
          expiresAt: input.expiresAt ?? null,
          releasedAt: null,
          failureReason: null,
          cleanupStatus: null,
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) {
        throw new Error("Failed to acquire environment lease");
      }
      return toEnvironmentLease(row);
    },

    releaseLease: async (
      id: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed" | "retained"> = "released",
      options?: {
        failureReason?: string;
        cleanupStatus?: EnvironmentLeaseCleanupStatus;
      },
    ) => {
      // 释放租约。注意 "retained" 状态的特殊语义：当 run 失败但配置了
      // retain_on_failure 策略时，保留沙箱/SSH 连接以便人工调试，不设置 releasedAt
      const now = new Date();
      const row = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: status === "retained" ? null : now,
          lastUsedAt: now,
          updatedAt: now,
          ...(options?.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
          ...(options?.cleanupStatus !== undefined ? { cleanupStatus: options.cleanupStatus } : {}),
        })
        .where(eq(environmentLeases.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    updateLeaseMetadata: async (
      id: string,
      metadata: Record<string, unknown> | null,
    ): Promise<EnvironmentLease | null> => {
      const row = await db
        .update(environmentLeases)
        .set({
          metadata,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(environmentLeases.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toEnvironmentLease(row) : null;
    },

    releaseLeasesForRun: async (
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
    ): Promise<EnvironmentLease[]> => {
      // 批量释放某个 heartbeat run 的所有活跃租约。当 run 结束、取消或超时时调用。
      // 仅释放 status=active 的租约，已释放/已过期的保持不变
      const now = new Date();
      const rows = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(environmentLeases.heartbeatRunId, heartbeatRunId),
            eq(environmentLeases.status, "active"),
          ),
        )
        .returning();
      return rows.map(toEnvironmentLease);
    },
  };
}
