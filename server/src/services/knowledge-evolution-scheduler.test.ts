import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startEvolutionScheduler } from "./knowledge-evolution-scheduler.js";

// 镜像 reviewer-scheduler.test.ts 的三组场景:
//   1. env flag off → 返回 null + 不调 list
//   2. enabled → 启动立即跑一次 + 每个 interval 再跑一次
//   3. 单公司抛错时不打断 loop
describe("evolution scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.KNOWLEDGE_EVOLUTION_ENABLED;
  });

  it("does not start when env flag is off", () => {
    delete process.env.KNOWLEDGE_EVOLUTION_ENABLED;
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }]);
    const run = vi.fn().mockResolvedValue({
      behaviorsRun: [],
      issuesCreated: 0,
      draftsCreated: 0,
      nodesModified: 0,
      perBehavior: [],
    });
    const handle = startEvolutionScheduler({
      listCompanies: list,
      evolutionForCompany: () => ({ runEvolution: run } as any),
      intervalMs: 60_000,
    });
    expect(handle).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("starts when enabled and fires immediately + every intervalMs", async () => {
    process.env.KNOWLEDGE_EVOLUTION_ENABLED = "true";
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }, { id: "co-2" }]);
    const run = vi.fn().mockResolvedValue({
      behaviorsRun: ["decay_scan"],
      issuesCreated: 0,
      draftsCreated: 0,
      nodesModified: 1,
      perBehavior: [],
    });
    const handle = startEvolutionScheduler({
      listCompanies: list,
      evolutionForCompany: () => ({ runEvolution: run } as any),
      intervalMs: 60_000,
    });
    expect(handle).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); // 立即触发的 microtask
    expect(run).toHaveBeenCalledTimes(2); // 2 家公司
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(4); // 又一轮 2 家
    handle?.stop();
  });

  it("swallows per-company errors and keeps the loop alive", async () => {
    process.env.KNOWLEDGE_EVOLUTION_ENABLED = "true";
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }]);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        behaviorsRun: ["decay_scan"],
        issuesCreated: 0,
        draftsCreated: 0,
        nodesModified: 0,
        perBehavior: [],
      });
    const handle = startEvolutionScheduler({
      listCompanies: list,
      evolutionForCompany: () => ({ runEvolution: run } as any),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    handle?.stop();
  });
});
