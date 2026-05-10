import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { formatMonitorOffset } from "@/lib/issue-monitor";
import { formatDateTime } from "@/lib/utils";
import { useTranslation } from "react-i18next";

function resolveScheduledMonitor(issue: Issue) {
  const nextCheckAt =
    issue.monitorNextCheckAt?.toISOString() ??
    issue.executionPolicy?.monitor?.nextCheckAt ??
    issue.executionState?.monitor?.nextCheckAt ??
    null;
  if (!nextCheckAt) return null;

  return {
    nextCheckAt,
    notes: issue.executionPolicy?.monitor?.notes ?? issue.monitorNotes ?? issue.executionState?.monitor?.notes ?? null,
    attemptCount: issue.monitorAttemptCount ?? issue.executionState?.monitor?.attemptCount ?? 0,
    serviceName: issue.executionPolicy?.monitor?.serviceName ?? issue.executionState?.monitor?.serviceName ?? null,
  };
}

interface IssueMonitorActivityCardProps {
  issue: Issue;
  onCheckNow?: (() => void) | null;
  checkingNow?: boolean;
}

// 监工活动卡片：展示外部服务监控调度信息。
// 在 Issue 详情页中作为一个信息面板，向用户说明：
// - 下次检查时间
// - 已尝试次数
// - 关联的外部服务
// - 自定义备注
//
// 提供"立即检查"按钮，便于人工触发即时检查（如 CI 状态查询）。
export function IssueMonitorActivityCard({
  issue,
  onCheckNow = null,
  checkingNow = false,
}: IssueMonitorActivityCardProps) {
  const { t } = useTranslation("common");
  const monitor = resolveScheduledMonitor(issue);
  if (!monitor) return null;

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Monitor scheduled</div>
          <div className="text-xs text-muted-foreground">
            Next check {formatDateTime(monitor.nextCheckAt)} ({formatMonitorOffset(monitor.nextCheckAt)})
          </div>
          {monitor.notes ? (
            <div className="mt-1 text-xs text-muted-foreground">{monitor.notes}</div>
          ) : null}
          {monitor.serviceName ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {monitor.serviceName}
            </div>
          ) : null}
          {monitor.attemptCount > 0 ? (
            <div className="mt-1 text-xs text-muted-foreground">Attempt {monitor.attemptCount}</div>
          ) : null}
        </div>
        {onCheckNow ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 shadow-none"
            onClick={onCheckNow}
            disabled={checkingNow}
          >
            {checkingNow ? t("issueMonitorActivityCard.checking") : t("issueMonitorActivityCard.checkNow")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
