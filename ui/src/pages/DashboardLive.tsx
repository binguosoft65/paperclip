// 实时仪表盘页面 — 显示当前正在运行的 Agent Run 的实时状态。
// 与概览仪表盘（Dashboard.tsx）不同，此页面聚焦于"此刻正在发生什么"。
// 通过 ActiveAgentsPanel 展示每个 Agent 的最近 Run，包括运行中的会话内容和日志。
// 数据通过轮询（3 秒间隔）刷新，适合监控当前正在执行的任务。

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RadioTower } from "lucide-react";
import { Link } from "@/lib/router";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

// 限制展示的 Run 数量，防止页面加载过多数据影响性能。
// 50 是经验值，在信息密度和页面加载速度之间取得平衡。
const DASHBOARD_LIVE_RUN_LIMIT = 50;

export function DashboardLive() {
  const { t } = useTranslation("common");
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("dashboardLive.breadcrumbDashboard"), href: "/dashboard" },
      { label: t("dashboardLive.breadcrumbLiveRuns") },
    ]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0 ? t("dashboardLive.createCompanyEmpty") : t("dashboardLive.selectCompanyEmpty")}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("dashboardLive.backToDashboard")}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{t("dashboardLive.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dashboardLive.description")}
          </p>
        </div>
        <div className="text-sm text-muted-foreground">{t("dashboardLive.showingUpTo", { count: DASHBOARD_LIVE_RUN_LIMIT })}</div>
      </div>

      {/* ActiveAgentsPanel 组件负责渲染每个 Agent 的运行卡片。
          通过 queryScope="dashboard-live" 区分数据源，与概览页面的 ActiveAgentsPanel 共享同一组件模板。
          cardLimit 和 fetchLimit 分别控制显示和获取的 Run 数量上限。 */}
      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title={t("dashboardLive.activeRecent")}
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        gridClassName="gap-3 md:grid-cols-2 2xl:grid-cols-3"
        cardClassName="h-[420px]"
        emptyMessage={t("dashboardLive.emptyMessage")}
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}
