type MaybeId = string | null | undefined;

// Issue 目标的回退解析逻辑。
// 当创建 Issue 时，如果没有显式指定 goalId，则按优先级回退：
// 1. 直接指定的 goalId
// 2. 项目关联的 goalId（projectGoalId）
// 3. 公司的默认 goal（defaultGoalId）
// 这种设计确保每个 Issue 都有归属的目标，即使创建者没有显式指定。
export function resolveIssueGoalId(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  if (input.goalId) return input.goalId;
  if (input.projectId) return input.projectGoalId ?? null;
  return input.defaultGoalId ?? null;
}

export function resolveNextIssueGoalId(input: {
  currentProjectId: MaybeId;
  currentGoalId: MaybeId;
  currentProjectGoalId?: MaybeId;
  projectId?: MaybeId;
  goalId?: MaybeId;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  const projectId =
    input.projectId !== undefined ? input.projectId : input.currentProjectId;
  const projectGoalId =
    input.projectGoalId !== undefined
      ? input.projectGoalId
      : projectId
        ? input.currentProjectGoalId
        : null;

  const resolveFallbackGoalId = (targetProjectId: MaybeId, targetProjectGoalId: MaybeId) => {
    if (targetProjectId) return targetProjectGoalId ?? null;
    return input.defaultGoalId ?? null;
  };

  if (input.goalId !== undefined) {
    return input.goalId ?? resolveFallbackGoalId(projectId, projectGoalId);
  }

  const currentFallbackGoalId = resolveFallbackGoalId(
    input.currentProjectId,
    input.currentProjectGoalId,
  );
  const nextFallbackGoalId = resolveFallbackGoalId(projectId, projectGoalId);

  if (!input.currentGoalId) {
    return nextFallbackGoalId;
  }

  if (input.currentGoalId === currentFallbackGoalId) {
    return nextFallbackGoalId;
  }

  return input.currentGoalId;
}
