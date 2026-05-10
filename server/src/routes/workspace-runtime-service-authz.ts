import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import type { Request } from "express";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * 有资格管理 Workspace Runtime 的 Issue 状态列表。
 * 已关闭的 Issue（done/cancelled）不再需要运行时服务管理。
 */
const WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUSES: string[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
];

/**
 * 获取指定 Agent 的所有下级 Agent ID（递归向下遍历汇报关系树）。
 * BFS 遍历，排除已终止的 Agent。
 * 用于判定 Agent 是否有权限管理其下级 Agent 的 Workspace Runtime。
 */
async function listReportingSubtreeAgentIds(db: Db, companyId: string, actorAgentId: string) {
  // 加载公司所有活跃 Agent 的汇报关系
  const companyAgents = await db
    .select({
      id: agents.id,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  // 构建管理关系映射表：managerId -> [subordinateId, ...]
  const reportsByManager = new Map<string, string[]>();
  for (const agent of companyAgents) {
    if (!agent.reportsTo) continue;
    const reports = reportsByManager.get(agent.reportsTo) ?? [];
    reports.push(agent.id);
    reportsByManager.set(agent.reportsTo, reports);
  }

  // BFS 遍历汇报树
  const visited = new Set<string>([actorAgentId]);
  const queue = [actorAgentId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const reports = reportsByManager.get(current) ?? [];
    for (const reportId of reports) {
      if (visited.has(reportId)) continue;
      visited.add(reportId);
      queue.push(reportId);
    }
  }

  return [...visited];
}

/**
 * 断言 Agent 有权管理指定 Workspace 的运行服务。
 *
 * 权限逻辑：
 * - 只有 Agent 主体可调用，用户（board）走 assertCompanyAccess 路径
 * - CEO 角色自动拥有所有 Workspace Runtime 管理权限
 * - 非 CEO Agent 只能管理其汇报子树内 Agent 所关联 Issue 的 Workspace
 *
 * 设计意图：层级汇报关系决定了 Agent 的管理范围，
 * 下级 Agent 的 Issue Workspace 对其上级可见，但反之不可。
 */
async function assertAgentCanManageRuntimeServicesForWorkspace(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    projectWorkspaceId?: string | null;
    executionWorkspaceId?: string | null;
    sourceIssueId?: string | null;
  },
) {
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    throw forbidden("Agent authentication required");
  }

  const actorAgent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      role: agents.role,
    })
    .from(agents)
    .where(eq(agents.id, req.actor.agentId))
    .then((rows) => rows[0] ?? null);

  if (!actorAgent || actorAgent.companyId !== input.companyId) {
    throw forbidden("Agent key cannot access another company");
  }

  // CEO 角色拥有所有 Workspace 管理权限，无需进一步检查
  if (actorAgent.role === "ceo") {
    return;
  }

  const eligibleAgentIds = await listReportingSubtreeAgentIds(db, input.companyId, actorAgent.id);
  const workspaceScopeConditions = [
    input.projectWorkspaceId ? eq(issues.projectWorkspaceId, input.projectWorkspaceId) : null,
    input.executionWorkspaceId ? eq(issues.executionWorkspaceId, input.executionWorkspaceId) : null,
    input.sourceIssueId ? eq(issues.id, input.sourceIssueId) : null,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== null);

  if (workspaceScopeConditions.length === 0) {
    throw forbidden("Missing permission to manage workspace runtime services");
  }

  const linkedIssue = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      isNull(issues.hiddenAt),
      inArray(issues.status, WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUSES),
      inArray(issues.assigneeAgentId, eligibleAgentIds),
      workspaceScopeConditions.length === 1
        ? workspaceScopeConditions[0]!
        : or(...workspaceScopeConditions),
    ))
    .then((rows) => rows[0] ?? null);

  if (linkedIssue) {
    return;
  }

  throw forbidden("Missing permission to manage workspace runtime services");
}

export async function assertCanManageProjectWorkspaceRuntimeServices(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    projectWorkspaceId: string;
  },
) {
  assertCompanyAccess(req, input.companyId);
  if (req.actor.type === "board") return;
  await assertAgentCanManageRuntimeServicesForWorkspace(db, req, input);
}

export async function assertCanManageExecutionWorkspaceRuntimeServices(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    executionWorkspaceId: string;
    sourceIssueId?: string | null;
  },
) {
  assertCompanyAccess(req, input.companyId);
  if (req.actor.type === "board") return;
  await assertAgentCanManageRuntimeServicesForWorkspace(db, req, input);
}
