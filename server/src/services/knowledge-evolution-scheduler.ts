import { logger } from "../middleware/logger.js";
import type { KnowledgeEvolutionService } from "./knowledge-evolution.js";

/**
 * 进程内 Evolution 调度器 (Phase 3a Task 8 MVP, mirrors Phase 3b
 * reviewer-scheduler + Phase 3c healthcheck-scheduler exactly).
 *
 * 启用:     env `KNOWLEDGE_EVOLUTION_ENABLED=true`
 * 周期:     env `KNOWLEDGE_EVOLUTION_INTERVAL_MINUTES` (default 10080 = 7 days)
 *
 * 行为:启动时立即跑一次,然后每 interval 跑一次;对每个公司分别调
 *      evolution.runEvolution()。单公司失败被 catch + log warn,不打断
 *      整批 loop。
 *
 * 设计偏离 plan §Task 8 (cron `0 9 * * 1` 周一 9:00):跟 Phase 3b/3c
 * scheduler 一致用 interval-based。默认 10080 min (7 天) 大致等价
 * weekly,但启动后立刻跑一次而非等到下个周一 9:00。真正"准点 weekly"
 * 由 Paperclip Routine 替代时再切换。
 *
 * 升级路径:正式 Routine 1 weekly-knowledge-evolution 替代时,关闭此 env
 * + 把 Routine 配置成调 POST /api/knowledge/evolution/run。
 */

export interface EvolutionSchedulerDeps {
  listCompanies: () => Promise<Array<{ id: string }>>;
  evolutionForCompany: (companyId: string) => KnowledgeEvolutionService;
  /** 测试用。生产读 KNOWLEDGE_EVOLUTION_INTERVAL_MINUTES env。 */
  intervalMs?: number;
}

export interface EvolutionSchedulerHandle {
  stop: () => void;
}

export function startEvolutionScheduler(
  deps: EvolutionSchedulerDeps,
): EvolutionSchedulerHandle | null {
  if (process.env.KNOWLEDGE_EVOLUTION_ENABLED !== "true") {
    return null;
  }
  const intervalMs =
    deps.intervalMs ??
    Number(process.env.KNOWLEDGE_EVOLUTION_INTERVAL_MINUTES ?? "10080") *
      60_000;

  let running = false;

  async function tick() {
    if (running) {
      logger.warn("evolution scheduler: 上一轮仍在执行,跳过本轮");
      return;
    }
    running = true;
    try {
      const companies = await deps.listCompanies();
      for (const c of companies) {
        try {
          const r = await deps.evolutionForCompany(c.id).runEvolution(c.id);
          logger.info(
            {
              companyId: c.id,
              behaviorsRun: r.behaviorsRun,
              issuesCreated: r.issuesCreated,
              draftsCreated: r.draftsCreated,
              nodesModified: r.nodesModified,
            },
            "evolution scheduler: company done",
          );
        } catch (err) {
          logger.warn(
            { err, companyId: c.id },
            "evolution scheduler: 公司处理失败",
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "evolution scheduler: 获取公司列表失败");
    } finally {
      running = false;
    }
  }

  // 立即跑一次(不 await,让 caller 立刻返回 handle)
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // 不让 timer 阻塞进程退出(同 reviewer + healthcheck scheduler)
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
