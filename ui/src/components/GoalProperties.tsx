import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Goal } from "@paperclipai/shared";
import { GOAL_STATUSES, GOAL_LEVELS } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

// 通用选择器按钮：用于在下拉 Popover 中切换 status 或 level 等枚举值。
// 当前选中项高亮（bg-accent），点击即触发 onChange 回调并关闭弹窗。
function PickerButton({
  current,
  options,
  onChange,
  formatLabel,
  children,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  formatLabel: (value: string) => string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {formatLabel(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// 目标属性面板：展示在详情页右侧，用于查看和编辑目标的元数据。
// 当传入 onUpdate 时字段变为可编辑（点击触发 Popover 选择器），否则为只读展示。
// 额外依赖两个查询：agents（用于查找责任人名称）和 allGoals（用于显示父目标标题）。
export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { t } = useTranslation("common");
  const { selectedCompanyId } = useCompany();

  // 查询全部 Agent，用于解析 ownerAgentId 为可读的名称
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // 查询全部目标，用于从 parentId 反查父目标的标题
  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // 解析责任人（ownerAgent）和父目标（parentGoal）的完整对象，用于展示名称和链接
  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label={t("goalProperties.status")}>
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
              formatLabel={(s) => t(`goalProperties.statusOptions.${s}`)}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label={t("goalProperties.level")}>
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
              formatLabel={(l) => t(`goalProperties.levelOptions.${l}`)}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        <PropertyRow label={t("goalProperties.owner")}>
          {ownerAgent ? (
            <Link
              to={agentUrl(ownerAgent)}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">{t("goalProperties.none")}</span>
          )}
        </PropertyRow>

        {goal.parentId && (
          <PropertyRow label={t("goalProperties.parentGoal")}>
            <Link
              to={`/goals/${goal.parentId}`}
              className="text-sm hover:underline"
            >
              {/* 显示父目标标题；若父目标不在当前查询结果中（可能已删除），则回退显示 ID 前 8 位 */}
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label={t("goalProperties.created")}>
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={t("goalProperties.updated")}>
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
