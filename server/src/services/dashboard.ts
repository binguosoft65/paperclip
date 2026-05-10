import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

// 仪表盘摘要的时间窗口：展示最近 14 天的 Run 运行活动。
// 选择 14 天而非 7 天是因为需要覆盖两个完整的周末周期，以便对比工作日/周末的运行模式。
const DASHBOARD_RUN_ACTIVITY_DAYS = 14;

// 将 Date 转换为 'YYYY-MM-DD' 格式的 UTC 日期字符串。
function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// 返回给定日期所在 UTC 月的第一天 00:00:00。
// 用于月度费用统计的时间范围起点。
export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

// 生成最近 N 天的 UTC 日期键列表（从最早到最晚）。
// 用于构造运行活动柱状图的空骨架，确保即使某天没有 Run 记录也能展示日期轴。
function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    // 生成公司级仪表盘聚合摘要。
    // 多次独立查询而非一次大 JOIN，原因：
    // 1. agents/issues 行数可能很大，分组聚合比 JOIN 后再 GROUP BY 更高效
    // 2. 各块之间有弱一致性即可（非事务快照），允许少许时间差
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      // 按状态分组统计 Agent 数量，避免在应用层遍历所有 Agent 行。
      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      // 按状态分组统计 Issue（任务）数量。
      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      // 统计待审批数量 — 仅 pending 状态的审批。
      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" 状态的 Agent 属于可工作但空闲的状态，归类为 active。
        // 这样前端只需要展示 active/running/paused/error 四种状态，减少 UI 复杂度。
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        // "open" 是除 done/cancelled 之外所有状态的累计值，代表"待处理的任务总量"。
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      // 生成最近 14 天的日期骨架，确保前端图表每一天都有数据点（值为 0 的日期保留占位）。
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      // 月度消费汇总：costEvents 中 occurredAt >= 当月第一天 的所有费用之和。
      // 使用 coalesce 确保无消费记录时返回 0 而非 null。
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      // 按 UTC 日期 + 状态分组统计 Run 数量，用于前端运行活动柱状图。
      // 使用 to_char 而非 date_trunc，因为我们需要 YYYY-MM-DD 格式的字符串键。
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      // 用 Map 填充每日数据：先初始化所有日期的零值条目，再覆盖真实数据。
      // 这样前端图表不会出现断点。
      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      // 预算利用率 = 当月已花费 / 月预算上限 * 100。
      // 如果未设置预算上限（budgetMonthlyCents <= 0），利用率为 0，由前端展示"无限预算"。
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
  };
}
