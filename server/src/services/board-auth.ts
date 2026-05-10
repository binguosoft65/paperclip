import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";

/**
 * Board API 密钥的有效期：30 天。
 * 超过此期限的密钥需要重新生成，降低长期密钥泄露的风险。
 */
export const BOARD_API_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * CLI 认证挑战的有效期：10 分钟。
 * 用户必须在 10 分钟内完成审批，过期后挑战失效需重新发起。
 */
export const CLI_AUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** CLI 认证挑战的状态机：pending -> approved | cancelled | expired */
export type CliAuthChallengeStatus = "pending" | "approved" | "cancelled" | "expired";

/**
 * 对 Bearer Token 进行 SHA-256 哈希。
 * Token 生成时即计算哈希存入数据库，原始 Token 只返回给用户一次（类似密码）。
 */
export function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 恒定时间比较两个哈希值，防止时序攻击。
 * 用于验证用户提供的 secret 是否与数据库中的哈希匹配。
 */
export function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * 生成 Board API Token。
 * 前缀 pcp_board_ 便于识别 token 类型，24 字节随机数提供 192 位熵。
 */
export function createBoardApiToken() {
  return `pcp_board_${randomBytes(24).toString("hex")}`;
}

/**
 * 生成 CLI 认证挑战的临时 secret。
 * 前缀 pcp_cli_auth_ 便于识别，与 Board API Token 结构对称。
 */
export function createCliAuthSecret() {
  return `pcp_cli_auth_${randomBytes(24).toString("hex")}`;
}

export function boardApiKeyExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + BOARD_API_KEY_TTL_MS);
}

export function cliAuthChallengeExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + CLI_AUTH_CHALLENGE_TTL_MS);
}

/**
 * 根据数据库行记录计算 CLI 挑战的当前状态。
 * 优先级：cancelled > expired > approved > pending。
 * 优先检查 cancelledAt 是因为用户取消后即使已过期也应展示"已取消"。
 */
function challengeStatusForRow(row: typeof cliAuthChallenges.$inferSelect): CliAuthChallengeStatus {
  if (row.cancelledAt) return "cancelled";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  if (row.approvedAt && row.boardApiKeyId) return "approved";
  return "pending";
}

/**
 * Board 认证服务 —— 管理用户 API 密钥和 CLI 认证挑战。
 *
 * 核心职责：
 * - Board API Key 的 CRUD 和验证
 * - CLI 认证挑战（挑战-响应模式，安全绑定 CLI 与 Board）
 * - 用户访问权限解析
 */
export function boardAuthService(db: Db) {
  /**
   * 解析用户的 Board 访问权限。
   * 并行查询：用户基本信息、活跃的公司成员关系、实例管理员角色。
   * 这些数据在后续的认证和授权中广泛使用。
   */
  async function resolveBoardAccess(userId: string) {
    const [user, memberships, adminRole] = await Promise.all([
      db
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          companyId: companyMemberships.companyId,
          membershipRole: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows),
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
    ]);

    return {
      user,
      companyIds: memberships.map((row) => row.companyId),
      memberships,
      isInstanceAdmin: Boolean(adminRole),
    };
  }

  /**
   * 解析用户在 Board 操作中可用的公司 ID 列表。
   * 回退优先级：活跃成员关系 > 请求的公司 ID > CLI 挑战中请求的公司 > 实例管理员（所有公司）。
   * 此方法确保 Key-based 认证的用户能看到其有权操作的所有公司。
   */
  async function resolveBoardActivityCompanyIds(input: {
    userId: string;
    requestedCompanyId?: string | null;
    boardApiKeyId?: string | null;
  }) {
    const access = await resolveBoardAccess(input.userId);
    const companyIds = new Set(access.companyIds);

    if (companyIds.size === 0 && input.requestedCompanyId?.trim()) {
      companyIds.add(input.requestedCompanyId.trim());
    }

    if (companyIds.size === 0 && input.boardApiKeyId?.trim()) {
      const challengeCompanyIds = await db
        .select({ requestedCompanyId: cliAuthChallenges.requestedCompanyId })
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.boardApiKeyId, input.boardApiKeyId.trim()))
        .then((rows) =>
          rows
            .map((row) => row.requestedCompanyId?.trim() ?? null)
            .filter((value): value is string => Boolean(value)),
        );
      for (const companyId of challengeCompanyIds) {
        companyIds.add(companyId);
      }
    }

    if (companyIds.size === 0 && access.isInstanceAdmin) {
      const allCompanyIds = await db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id));
      for (const companyId of allCompanyIds) {
        companyIds.add(companyId);
      }
    }

    return Array.from(companyIds);
  }

  /**
   * 通过原始 Token 查找 Board API Key。
   * 先对 Token 哈希再查询，同时过滤已吊销和已过期的密钥。
   * 使用 find() 而非 filter()[0] 是因为哈希碰撞概率极低，取第一个有效即可。
   */
  async function findBoardApiKeyByToken(token: string) {
    const tokenHash = hashBearerToken(token);
    const now = new Date();
    return db
      .select()
      .from(boardApiKeys)
      .where(
        and(
          eq(boardApiKeys.keyHash, tokenHash),
          isNull(boardApiKeys.revokedAt),
        ),
      )
      .then((rows) => rows.find((row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime()) ?? null);
  }

  /** 更新 API Key 的最后使用时间，用于密钥活跃度审计。 */
  async function touchBoardApiKey(id: string) {
    await db.update(boardApiKeys).set({ lastUsedAt: new Date() }).where(eq(boardApiKeys.id, id));
  }

  /**
   * 吊销 Board API Key。
   * 设置 revokedAt 后，该密钥将无法通过 findBoardApiKeyByToken 验证。
   * 使用 isNull(revokedAt) 条件防止重复吊销。
   */
  async function revokeBoardApiKey(id: string) {
    const now = new Date();
    return db
      .update(boardApiKeys)
      .set({ revokedAt: now, lastUsedAt: now })
      .where(and(eq(boardApiKeys.id, id), isNull(boardApiKeys.revokedAt)))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /**
   * 创建 CLI 认证挑战 —— 挑战-响应认证流程的第一步。
   *
   * 流程：
   * 1. CLI 生成一个挑战（包含命令描述和请求的访问级别）
   * 2. 用户需要在 Board 中批准此挑战
   * 3. 批准后自动创建 Board API Key，CLI 用预生成的 token 完成绑定
   *
   * 关键设计：pendingBoardToken 在创建时即预生成，避免批准时出现竞态条件。
   * 如果请求 instance_admin_required 级别，密钥名称会标注以示区别。
   */
  async function createCliAuthChallenge(input: {
    command: string;
    clientName?: string | null;
    requestedAccess: "board" | "instance_admin_required";
    requestedCompanyId?: string | null;
  }) {
    const challengeSecret = createCliAuthSecret();
    const pendingBoardToken = createBoardApiToken();
    const expiresAt = cliAuthChallengeExpiresAt();
    const labelBase = input.clientName?.trim() || "paperclipai cli";
    const pendingKeyName =
      input.requestedAccess === "instance_admin_required"
        ? `${labelBase} (instance admin)`
        : `${labelBase} (board)`;

    const created = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(challengeSecret),
        command: input.command.trim(),
        clientName: input.clientName?.trim() || null,
        requestedAccess: input.requestedAccess,
        requestedCompanyId: input.requestedCompanyId?.trim() || null,
        pendingKeyHash: hashBearerToken(pendingBoardToken),
        pendingKeyName,
        expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      challenge: created,
      challengeSecret,
      pendingBoardToken,
    };
  }

  async function getCliAuthChallenge(id: string) {
    return db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getCliAuthChallengeBySecret(id: string, token: string) {
    const challenge = await getCliAuthChallenge(id);
    if (!challenge) return null;
    if (!tokenHashesMatch(challenge.secretHash, hashBearerToken(token))) return null;
    return challenge;
  }

  async function describeCliAuthChallenge(id: string, token: string) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) return null;

    const [company, approvedBy] = await Promise.all([
      challenge.requestedCompanyId
        ? db
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(eq(companies.id, challenge.requestedCompanyId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      challenge.approvedByUserId
        ? db
            .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
            .from(authUsers)
            .where(eq(authUsers.id, challenge.approvedByUserId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    return {
      id: challenge.id,
      status: challengeStatusForRow(challenge),
      command: challenge.command,
      clientName: challenge.clientName ?? null,
      requestedAccess: challenge.requestedAccess as "board" | "instance_admin_required",
      requestedCompanyId: challenge.requestedCompanyId ?? null,
      requestedCompanyName: company?.name ?? null,
      approvedAt: challenge.approvedAt?.toISOString() ?? null,
      cancelledAt: challenge.cancelledAt?.toISOString() ?? null,
      expiresAt: challenge.expiresAt.toISOString(),
      approvedByUser: approvedBy
        ? {
            id: approvedBy.id,
            name: approvedBy.name,
            email: approvedBy.email,
          }
        : null,
    };
  }

  /**
   * 批准 CLI 认证挑战 —— Board 用户确认授权 CLI 的访问请求。
   *
   * 此操作在事务中执行以确保一致性：
   * 1. SELECT FOR UPDATE 锁定挑战行，防止并发批准
   * 2. 验证挑战状态（已过期 / 已取消的不再处理）
   * 3. 检查访问级别：instance_admin_required 需要审批者是实例管理员
   * 4. 首次批准时创建 Board API Key（后续再批准不重复创建）
   *
   * 幂等性：同一挑战多次批准只执行一次创建 Key 的操作。
   */
  async function approveCliAuthChallenge(id: string, token: string, userId: string) {
    const access = await resolveBoardAccess(userId);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${cliAuthChallenges.id} from ${cliAuthChallenges} where ${cliAuthChallenges.id} = ${id} for update`,
      );

      const challenge = await tx
        .select()
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.id, id))
        .then((rows) => rows[0] ?? null);
      if (!challenge || !tokenHashesMatch(challenge.secretHash, hashBearerToken(token))) {
        throw notFound("CLI auth challenge not found");
      }

      const status = challengeStatusForRow(challenge);
      if (status === "expired") return { status, challenge };
      if (status === "cancelled") return { status, challenge };

      if (challenge.requestedAccess === "instance_admin_required" && !access.isInstanceAdmin) {
        throw forbidden("Instance admin required");
      }

      let boardKeyId = challenge.boardApiKeyId;
      if (!boardKeyId) {
        const createdKey = await tx
          .insert(boardApiKeys)
          .values({
            userId,
            name: challenge.pendingKeyName,
            keyHash: challenge.pendingKeyHash,
            expiresAt: boardApiKeyExpiresAt(),
          })
          .returning()
          .then((rows) => rows[0]);
        boardKeyId = createdKey.id;
      }

      const approvedAt = challenge.approvedAt ?? new Date();
      const updated = await tx
        .update(cliAuthChallenges)
        .set({
          approvedByUserId: userId,
          boardApiKeyId: boardKeyId,
          approvedAt,
          updatedAt: new Date(),
        })
        .where(eq(cliAuthChallenges.id, challenge.id))
        .returning()
        .then((rows) => rows[0] ?? challenge);

      return { status: "approved" as const, challenge: updated };
    });
  }

  async function cancelCliAuthChallenge(id: string, token: string) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const status = challengeStatusForRow(challenge);
    if (status === "approved") return { status, challenge };
    if (status === "expired") return { status, challenge };
    if (status === "cancelled") return { status, challenge };

    const updated = await db
      .update(cliAuthChallenges)
      .set({
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(cliAuthChallenges.id, challenge.id))
      .returning()
      .then((rows) => rows[0] ?? challenge);

    return { status: "cancelled" as const, challenge: updated };
  }

  async function assertCurrentBoardKey(keyId: string | undefined, userId: string | undefined) {
    if (!keyId || !userId) throw conflict("Board API key context is required");
    const key = await db
      .select()
      .from(boardApiKeys)
      .where(and(eq(boardApiKeys.id, keyId), eq(boardApiKeys.userId, userId)))
      .then((rows) => rows[0] ?? null);
    if (!key || key.revokedAt) throw notFound("Board API key not found");
    return key;
  }

  return {
    resolveBoardAccess,
    findBoardApiKeyByToken,
    touchBoardApiKey,
    revokeBoardApiKey,
    createCliAuthChallenge,
    getCliAuthChallengeBySecret,
    describeCliAuthChallenge,
    approveCliAuthChallenge,
    cancelCliAuthChallenge,
    assertCurrentBoardKey,
    resolveBoardActivityCompanyIds,
  };
}
