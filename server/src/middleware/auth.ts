import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

/**
 * 对 token 进行 SHA-256 哈希，用于安全存储和比较。
 * 数据库中不存明文 token，只存哈希值，降低泄露风险。
 */
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  /**
   * 可选的 session 解析函数，由外部注入（通过 Better Auth）。
   * 在 authenticated 模式下，用于从 cookie 或 header 解析用户 session。
   */
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

/**
 * Actor 中间件 —— 请求认证的核心入口。
 *
 * 按优先级依次尝试以下认证方式，一旦命中即设置 req.actor 并终止后续尝试：
 * 1. local_trusted 模式 —— 本地开发环境，隐式信任所有请求
 * 2. Cloud Tenant Token —— 多租户云部署中的租户间认证
 * 3. Better Auth Session —— 基于 cookie 的标准 Web 登录
 * 4. Board API Key —— 用户 CLI 或 API 密钥
 * 5. Agent API Key（哈希匹配）—— Agent 持久化密钥
 * 6. Agent JWT —— Agent 临时令牌（用于任务运行时）
 */
export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    // 步骤 1：local_trusted 模式下隐式信任为本地管理员用户
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    // 可选的运行 ID 请求头，用于关联请求与 Agent 任务执行
    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    // 没有 Bearer token 时，尝试 session 或 cloud tenant 认证
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      // 步骤 2：authenticated 模式下尝试 Cloud Tenant 和 Session 认证
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        // Cloud Tenant Token 优先于普通 session，用于多租户云架构中的跨栈认证
        const cloudTenantActor = await resolveCloudTenantActor(db, req);
        if (cloudTenantActor) {
          req.actor = {
            ...cloudTenantActor,
            runId: runIdHeader ?? undefined,
          };
          next();
          return;
        }

        // 步骤 3：通过 Better Auth 解析标准 Web 登录 session（基于 cookie）
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          // session 解析失败仅记录日志，不阻断请求（后续还有其他认证方式）
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          // 并行查询：获取用户是否为实例管理员以及活跃的公司成员关系
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
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
              ),
          ]);
          req.actor = {
            type: "board",
            userId,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
    // 没有 session，保留默认 actor（type: none），继续后续中间件处理
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    // 步骤 4：有 Bearer token —— 按优先级尝试 Board API Key、Agent API Key、Agent JWT
    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    // 4a：尝试 Board API Key（用户 CLI / API 密钥）
    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        // 每次使用更新最后使用时间，用于密钥管理和审计
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    // 4b：尝试 Agent API Key（通过哈希匹配）
    // 先计算哈希再查库，避免数据库中存储明文 token
    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      // 步骤 4c：不是 API Key，尝试 Agent JWT（临时令牌，由平台签发用于任务执行）
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        // 所有认证方式均失败，保留默认匿名 actor
        next();
        return;
      }

      // JWT 验证通过后，确认 Agent 记录存在且公司匹配
      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      // 防止跨公司伪造：agent JWT 中的 company_id 必须与数据库中记录一致
      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      // 已终止或待审批的 Agent 不能通过 API 执行操作
      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runIdHeader || claims.run_id || undefined,
        source: "agent_jwt",
      };
      next();
      return;
    }

    // Agent API Key 匹配成功，更新最后使用时间用于审计
    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    // 再次检查 Agent 状态（密钥有效但 Agent 可能已被终止）
    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

/**
 * 解析 Cloud Tenant Actor —— 多租户云部署中的内部认证。
 *
 * 当 Paperclip 以多租户模式运行时，通过共享的 Server Token 和请求头
 * 实现跨栈信任认证。此方法会：
 * 1. 用恒定时间比较验证 token 以防止时序攻击
 * 2. 自动在本地数据库中创建或同步用户、公司、成员关系
 * 3. 将用户指定为实例管理员
 *
 * 这种设计避免了在每个栈之间共享用户数据库，而是通过"按需同步"策略。
 */
async function resolveCloudTenantActor(db: Db, req: Request): Promise<Express.Request["actor"] | null> {
  const expectedToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!expectedToken) return null;

  const token = req.header("x-paperclip-cloud-tenant-token")?.trim();
  if (!token || !constantTimeStringEqual(token, expectedToken)) return null;

  const userId = requiredCloudHeader(req, "x-paperclip-cloud-user-id");
  const userEmail = requiredCloudHeader(req, "x-paperclip-cloud-user-email").toLowerCase();
  const stackId = requiredCloudHeader(req, "x-paperclip-cloud-stack-id");
  const stackRole = stackMembershipRole(req.header("x-paperclip-cloud-stack-role"));
  const userName = req.header("x-paperclip-cloud-user-name")?.trim() || userEmail;
  const paperclipCompanyId = req.header("x-paperclip-cloud-paperclip-company-id")?.trim();
  // 公司 ID 基于 stackId 确定性生成，确保同一 stack 的请求映射到同一公司
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyId || `${stackId} Paperclip`;
  const now = new Date();

  await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userName,
      email: userEmail,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.id,
      set: {
        name: userName,
        email: userEmail,
        emailVerified: true,
        updatedAt: now,
      },
    });

  await db
    .insert(instanceUserRoles)
    .values({
      userId,
      role: "instance_admin",
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [instanceUserRoles.userId, instanceUserRoles.role],
    });

  await db
    .insert(companies)
    .values({
      id: companyId,
      name: companyName,
      description: `Provisioned by Paperclip Cloud for stack ${stackId}.`,
      status: "active",
      issuePrefix: issuePrefixForCloudStack(stackId),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: companies.id,
    });

  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const membership = await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        companyMemberships.companyId,
        companyMemberships.principalType,
        companyMemberships.principalId,
      ],
      set: {
        status: "active",
        membershipRole,
        updatedAt: now,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? {
      companyId,
      membershipRole,
      status: "active",
    });

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId],
    memberships: [{
      companyId,
      membershipRole: membership.membershipRole,
      status: membership.status,
    }],
    isInstanceAdmin: true,
    source: "cloud_tenant",
  };
}

/**
 * 获取必填的 Cloud Tenant 请求头，缺失时直接抛出异常。
 * 因为后续操作依赖于这些值，提前失败比静默出错更安全。
 */
function requiredCloudHeader(req: Request, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) {
    throw new Error(`Missing trusted Cloud tenant header ${name}`);
  }
  return value;
}

/**
 * 将 Cloud Tenant stack 角色映射到 Paperclip 成员角色。
 * 仅接受四个已知角色值，防止角色提升攻击。
 */
function stackMembershipRole(value: string | undefined): "owner" | "admin" | "member" | "support" {
  if (value === "owner" || value === "admin" || value === "member" || value === "support") {
    return value;
  }
  throw new Error("Invalid trusted Cloud tenant stack role");
}

/**
 * 恒定时间字符串比较，防止时序攻击。
 * 先比较长度再使用 timingSafeEqual，避免长度信息泄露。
 */
function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * 基于 stackId 确定性生成 UUIDv4 格式的公司 ID。
 * 使用 SHA-256 命名空间哈希，并按照 RFC 4122 设置版本和变体位。
 */
function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
