import type { ExecutionWorkspace } from "./types/workspace-runtime.js";

type ExecutionWorkspaceGuardTarget = Pick<ExecutionWorkspace, "closedAt" | "mode" | "name" | "status">;

/** 表示执行工作空间已关闭的状态集合 */
const CLOSED_EXECUTION_WORKSPACE_STATUSES = new Set<ExecutionWorkspace["status"]>(["archived", "cleanup_failed"]);

/**
 * 判断给定的执行工作空间是否已关闭。
 * 仅对 isolated_workspace 模式生效——共享工作空间不存在"关闭"概念。
 * 两种关闭方式：显式 closedAt 不为空，或状态为 archived/cleanup_failed。
 */
export function isClosedIsolatedExecutionWorkspace(
  workspace: Pick<ExecutionWorkspaceGuardTarget, "closedAt" | "mode" | "status"> | null | undefined,
): boolean {
  if (!workspace) return false;
  if (workspace.mode !== "isolated_workspace") return false;
  return workspace.closedAt != null || CLOSED_EXECUTION_WORKSPACE_STATUSES.has(workspace.status);
}

/**
 * 获取关闭工作空间的提示信息。
 * 当用户尝试在已关闭的隔离工作空间中操作时显示此消息。
 */
export function getClosedIsolatedExecutionWorkspaceMessage(
  workspace: Pick<ExecutionWorkspaceGuardTarget, "name">,
): string {
  return `This issue is linked to the closed workspace "${workspace.name}". Move it to an open workspace before adding comments or resuming work.`;
}
