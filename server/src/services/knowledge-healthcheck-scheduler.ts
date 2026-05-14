import { logger } from "../middleware/logger.js";
import type { KnowledgeHealthcheckService } from "./knowledge-healthcheck.js";

/**
 * 进程内 Healthcheck 调度器（Phase 3c Task 5 MVP）。
 *
 * 启用：env `KNOWLEDGE_HEALTHCHECK_ENABLED=true`
 * 周期：env `KNOWLEDGE_HEALTHCHECK_INTERVAL_MINUTES`（默认 1440 = 24h）
 *
 * 行为：启动时立即跑一次，然后每 interval 跑一次；对每个公司分别调
 * healthcheck.runHealthcheck。单个公司失败被 catch + log warn，不打断
 * 整批 loop，跟 Phase 3b reviewer-scheduler 一致。
 *
 * 设计偏离 plan §Task 5（"每小时 tick + 判断目标 hour"）：
 * 实际跟 Phase 3b reviewer-scheduler 一致用 interval-based。默认 1440 min
 * (24h) 大致等价 daily,但启动后第一次立即跑而非等到次日 8:00。这对 MVP
 * 足够;真正的"准点 daily"留给 Routine 3 daily-knowledge-healthcheck
 * 上线时替换。
 *
 * 升级路径：正式 Routine（Routine 3 daily-knowledge-healthcheck）替代时，
 * 关闭此 env + 把 Routine 配置成调 POST /api/knowledge/healthcheck/run。
 */

export interface HealthcheckSchedulerDeps {
  listCompanies: () => Promise<Array<{ id: string }>>;
  healthcheckForCompany: (companyId: string) => KnowledgeHealthcheckService;
  /** 测试用。生产读 KNOWLEDGE_HEALTHCHECK_INTERVAL_MINUTES env。 */
  intervalMs?: number;
}

export interface HealthcheckSchedulerHandle {
  stop: () => void;
}

export function startHealthcheckScheduler(
  deps: HealthcheckSchedulerDeps,
): HealthcheckSchedulerHandle | null {
  if (process.env.KNOWLEDGE_HEALTHCHECK_ENABLED !== "true") {
    return null;
  }
  const intervalMs =
    deps.intervalMs ??
    Number(process.env.KNOWLEDGE_HEALTHCHECK_INTERVAL_MINUTES ?? "1440") *
      60_000;

  let running = false;

  async function tick() {
    if (running) {
      logger.warn("healthcheck scheduler: 上一轮仍在执行，跳过本轮");
      return;
    }
    running = true;
    try {
      const companies = await deps.listCompanies();
      for (const c of companies) {
        try {
          const r = await deps
            .healthcheckForCompany(c.id)
            .runHealthcheck(c.id);
          logger.info(
            {
              companyId: c.id,
              metricsComputed: r.metricsComputed,
              alarmsCreated: r.alarmsCreated,
            },
            "healthcheck scheduler: company done",
          );
        } catch (err) {
          logger.warn(
            { err, companyId: c.id },
            "healthcheck scheduler: 公司处理失败",
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "healthcheck scheduler: 获取公司列表失败");
    } finally {
      running = false;
    }
  }

  // 立即跑一次（不 await，让 caller 立刻返回 handle）
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // 不让 timer 阻塞进程退出（同 reviewer-scheduler）
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
