import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalTree } from "../components/GoalTree";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Target, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

// 目标列表页：作为 /goals 路由的入口组件。
// 从公司上下文中获取当前选中公司，拉取该公司全部目标后交由 GoalTree 渲染树形结构。
// 当公司尚未选择或无目标时，显示对应的空状态提示。
export function Goals() {
  const { t } = useTranslation("common");
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: t("goals.title") }]);
  }, [setBreadcrumbs]);

  // 该查询依赖 selectedCompanyId：只有用户选定公司后才发起请求，
  // 避免在未选定公司时发送无效请求。
  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message={t("goals.noCompany")} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {/* 无目标时展示空状态并引导用户创建第一个目标 */}
      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message={t("goals.noGoals")}
          action={t("goals.addGoal")}
          onAction={() => openNewGoal()}
        />
      )}

      {/* 有目标时展示"新建目标"按钮和完整的树形视图 */}
      {goals && goals.length > 0 && (
        <>
          <div className="flex items-center justify-start">
            <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {t("goals.newGoal")}
            </Button>
          </div>
          {/* GoalTree 组件接收全部目标数据，递归解析 parentId 构建层级树；goalLink 控制点击节点后的跳转行为 */}
          <GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
        </>
      )}
    </div>
  );
}
