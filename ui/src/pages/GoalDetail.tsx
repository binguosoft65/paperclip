import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalProperties } from "../components/GoalProperties";
import { GoalTree } from "../components/GoalTree";
import { StatusBadge } from "../components/StatusBadge";
import { InlineEditor } from "../components/InlineEditor";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, SlidersHorizontal } from "lucide-react";
import type { Goal, Project } from "@paperclipai/shared";

interface GoalPropertiesToggleButtonProps {
  panelVisible: boolean;
  onShowProperties: () => void;
}

// 右侧属性面板的切换按钮：当面板已可见时隐藏自己（防止重复操作），不可见时显示以引导用户打开。
export function GoalPropertiesToggleButton({
  panelVisible,
  onShowProperties,
}: GoalPropertiesToggleButtonProps) {
  const { t } = useTranslation("common");
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn(
        "hidden md:inline-flex shrink-0 transition-opacity duration-200",
        panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
      )}
      onClick={onShowProperties}
      title={t("goalDetail.showProperties")}
    >
      <SlidersHorizontal className="h-4 w-4" />
    </Button>
  );
}

// 目标详情页：同时加载目标自身、同公司全部目标和全部项目的数据。
// 右侧弹出面板（Panel）展示 GoalProperties 用于编辑属性；
// 主体区域通过 Tab 切换展示"子目标树"和"关联项目"两个视图。
export function GoalDetail() {
  const { t } = useTranslation("common");
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  // 主查询：获取当前目标的详细信息
  const {
    data: goal,
    isLoading,
    error
  } = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId
  });
  const resolvedCompanyId = goal?.companyId ?? selectedCompanyId;

  // 辅助查询 I：获取同公司全部目标，用于在 detail 中展示子目标树（按 parentId 过滤）
  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(resolvedCompanyId!),
    queryFn: () => goalsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  // 辅助查询 II：获取同公司全部项目，用于展示与该目标关联的项目列表。
  // 支持两种关联方式：project.goalIds 数组和 project.goalId（旧字段，已废弃）。
  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId!),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  // 如果该目标属于另一个公司，自动切换公司上下文（例如通过 URL 直接访问跨公司目标时）。
  useEffect(() => {
    if (!goal?.companyId || goal.companyId === selectedCompanyId) return;
    setSelectedCompanyId(goal.companyId, { source: "route_sync" });
  }, [goal?.companyId, selectedCompanyId, setSelectedCompanyId]);

  // 更新目标信息的 mutation，成功后同时刷新详情缓存和列表缓存。
  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.update(goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.detail(goalId!)
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(resolvedCompanyId)
        });
      }
    }
  });

  // 图片上传 mutation：用于富文本描述中的图片插入，上传路径按 goals/{goalId} 组织。
  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(
        resolvedCompanyId,
        file,
        `goals/${goalId ?? "draft"}`
      );
    }
  });

  // 过滤出当前目标的直接子目标（parentId === goalId）
  const childGoals = (allGoals ?? []).filter((g) => g.parentId === goalId);
  // 过滤出与当前目标关联的项目：支持新旧两种关联字段。
  // goalIds 数组是当前推荐方式；goalId 单值字段为向后兼容保留；
  // goals 数组含引用对象（id + title），用于渲染时直接显示标题而不必再查。
  const linkedProjects = (allProjects ?? []).filter((p) => {
    if (!goalId) return false;
    if (p.goalIds.includes(goalId)) return true;
    if (p.goals.some((goalRef) => goalRef.id === goalId)) return true;
    return p.goalId === goalId;
  });

  // 设置面包屑导航：目标列表 -> 当前目标标题
  useEffect(() => {
    setBreadcrumbs([
      { label: t("goals.title"), href: "/goals" },
      { label: goal?.title ?? goalId ?? t("goalDetail.title") }
    ]);
  }, [setBreadcrumbs, t, goal, goalId]);

  // 当目标数据加载完成后，在右侧面板中渲染 GoalProperties 组件用于编辑属性。
  // 利用 useEffect 的 cleanup 在组件卸载时关闭面板。
  useEffect(() => {
    if (goal) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutate(data)}
        />
      );
    }
    return () => closePanel();
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          {/* 展示目标层级（company/team/agent/task）和生命周期状态 */}
          <span className="text-xs uppercase text-muted-foreground">
            {goal.level}
          </span>
          <StatusBadge status={goal.status} />
          <div className="ml-auto">
            <GoalPropertiesToggleButton
              panelVisible={panelVisible}
              onShowProperties={() => setPanelVisible(true)}
            />
          </div>
        </div>

        {/* 标题可内联编辑，保存即触发 updateGoal mutation */}
        <InlineEditor
          value={goal.title}
          onSave={(title) => updateGoal.mutate({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        {/* 描述可内联编辑，支持多行文本和图片上传（用于插入截图等富内容） */}
        <InlineEditor
          value={goal.description ?? ""}
          onSave={(description) => updateGoal.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder={t("goalDetail.placeholderAddDescription")}
          multiline
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      </div>

      {/* 标签页：子目标树 vs 关联项目列表 */}
      <Tabs defaultValue="children">
        <TabsList>
          <TabsTrigger value="children">
            {t("goalDetail.tabs.subGoals")} ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="projects">
            {t("goalDetail.tabs.projects")} ({linkedProjects.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              // 新建子目标时预填 parentId 为当前目标 ID，确保层级正确挂载
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {t("goalDetail.addSubGoal")}
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("goalDetail.noSubGoals")}</p>
          ) : (
            // 只对直接子目标展示局部树（不含深层展开），防止层级过深导致页面过长
            <GoalTree goals={childGoals} goalLink={(g) => `/goals/${g.id}`} />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("goalDetail.noLinkedProjects")}</p>
          ) : (
            <div className="border border-border">
              {linkedProjects.map((project) => (
                <EntityRow
                  key={project.id}
                  title={project.name}
                  subtitle={project.description ?? undefined}
                  to={projectUrl(project)}
                  trailing={<StatusBadge status={project.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
