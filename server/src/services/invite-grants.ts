import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
import { grantsForHumanRole } from "./company-member-roles.js";

// 从邀请的 defaultsPayload 中提取显式声明的权限列表（human 或 agent 维度）。
// 用于在加入公司时赋予精细粒度的权限，而非仅依赖角色隐式权限
export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope &&
        typeof record.scope === "object" &&
        !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null,
    });
  }
  return result;
}

// Agent 加入时的默认权限：始终包含 tasks:assign（即使 defaults 中未显式声明），
// 因为 agent 的核心职责就是执行任务，没有 assign 权限的 agent 没有实际价值
export function agentJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  const grants = grantsFromDefaults(defaultsPayload, "agent");
  if (grants.some((grant) => grant.permissionKey === "tasks:assign")) {
    return grants;
  }
  return [
    ...grants,
    {
      permissionKey: "tasks:assign",
      scope: null,
    },
  ];
}

// 人类用户加入时的默认权限：优先使用显式声明的 grants，
// 若未配置则回退到角色对应的隐式权限集
export function humanJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  membershipRole: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  const grants = grantsFromDefaults(defaultsPayload, "human");
  return grants.length > 0 ? grants : grantsForHumanRole(membershipRole);
}
