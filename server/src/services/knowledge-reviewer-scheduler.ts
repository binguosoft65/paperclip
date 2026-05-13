import { logger } from "../middleware/logger.js";
import type { ReviewerAgentService } from "./knowledge-reviewer.js";

/**
 * 进程内 Reviewer 调度器（Phase 3b MVP）。
 *
 * 启用：env `KNOWLEDGE_REVIEWER_ENABLED=true`
 * 周期：env `KNOWLEDGE_REVIEWER_INTERVAL_MINUTES`（默认 60min）
 *
 * 行为：启动时立即跑一次，然后每 interval 跑一次；对每个公司分别调
 * reviewer.screenPendingDrafts。失败被 catch 吞掉只 logger.warn，不打断 loop。
 *
 * 升级路径：正式 Routine（Routine 2 hourly-draft-pre-review）替代时，
 * 关闭此 env + 把 Routine 配置成调 POST /api/knowledge/reviewer/run。
 */

export interface ReviewerSchedulerDeps {
  listCompanies: () => Promise<Array<{ id: string }>>;
  reviewerForCompany: (companyId: string) => ReviewerAgentService;
  intervalMs?: number;
}

export interface ReviewerSchedulerHandle {
  stop: () => void;
}

export function startReviewerScheduler(
  deps: ReviewerSchedulerDeps,
): ReviewerSchedulerHandle | null {
  if (process.env.KNOWLEDGE_REVIEWER_ENABLED !== "true") {
    return null;
  }
  const intervalMs =
    deps.intervalMs ??
    Number(process.env.KNOWLEDGE_REVIEWER_INTERVAL_MINUTES ?? "60") * 60_000;

  let running = false;

  async function tick() {
    if (running) {
      logger.warn("reviewer scheduler: 上一轮仍在执行，跳过本轮");
      return;
    }
    running = true;
    try {
      const companies = await deps.listCompanies();
      for (const c of companies) {
        try {
          const r = await deps.reviewerForCompany(c.id).screenPendingDrafts({
            companyId: c.id,
          });
          logger.info(
            { companyId: c.id, processed: r.processed, errors: r.errors.length },
            "reviewer scheduler: company done",
          );
        } catch (err) {
          logger.warn({ err, companyId: c.id }, "reviewer scheduler: 公司处理失败");
        }
      }
    } catch (err) {
      logger.warn({ err }, "reviewer scheduler: 获取公司列表失败");
    } finally {
      running = false;
    }
  }

  // 立即跑一次（不 await，让 caller 立刻返回 handle）
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // 不让 timer 阻塞进程退出（生产 service 是常驻进程，这里只为了 dev/test 优雅退出）
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
