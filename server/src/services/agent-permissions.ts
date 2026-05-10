export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
};

// 根据角色返回默认权限。设计意图：CEO 是组织创建者，天然拥有创建 Agent 的权限；
// 普通 Agent 默认无权创建其他 Agent，需要显式授权。
// 这是最小权限原则的体现——默认拒绝，按需开放。
export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
  };
}

// 校验并规范化传入的权限对象：只读取认可的字段，忽略未知字段；
// 类型不匹配时回退到角色默认值，不抛出异常。
// 这种"宽容"处理方式的权衡：牺牲了输入校验的严格性，换来上游数据格式变化的兼容性。
export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    // 扩展权限字段时在此处添加，所有使用 normalizeAgentPermissions 的地方自动收窄权限集。
  };
}
