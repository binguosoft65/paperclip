import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

/**
 * 断言请求已通过认证（actor 不为 none 类型）。
 * 这是所有受保护路由的第一道防线。
 */
export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

/**
 * 断言请求来自 Board（人类用户操作），而非 Agent。
 * 某些操作（如管理配置、用户管理）只允许人类用户执行。
 */
export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

/**
 * 检查用户是否拥有公司级访问权限。
 * 以下情况视为有权限：
 * - 本地隐式信任模式（开发环境）
 * - 实例管理员
 * - 用户至少属于一个活跃公司
 * 此函数不抛出异常，用于条件判断。
 */
export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

/**
 * 断言用户拥有公司级访问权限，无权限则抛出 403。
 * 用于需要在公司上下文中操作但不指定具体公司 ID 的场景。
 */
export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

/**
 * 断言用户是实例管理员。
 * 实例管理员是最高权限角色，可以管理所有公司、用户和配置。
 */
export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

/**
 * 断言请求主体对指定的公司有访问权限。
 *
 * 检查规则按 actor 类型区分：
 * - Agent：只能访问其所属公司，防止跨公司数据泄露
 * - Board 用户：检查公司成员关系，读操作对所有成员开放，
 *   写操作额外检查成员状态和角色（viewer 只读）
 *
 * 边界条件：
 * - local_implicit（开发模式）跳过公司级别检查
 * - 实例管理员不受写操作限制
 * - viewer 角色只能执行 GET/HEAD/OPTIONS 请求
 */
export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    // 非安全方法（写操作）需要额外的角色检查
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

/**
 * 获取请求主体的审计信息。
 * 用于日志记录和操作审计，统一 Agent 和用户两种主体的信息格式。
 * 注意：此函数要求请求已通过认证，未认证的请求会抛出 401。
 */
export function getActorInfo(req: Request) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
