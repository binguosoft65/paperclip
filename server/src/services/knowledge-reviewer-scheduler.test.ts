import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startReviewerScheduler } from "./knowledge-reviewer-scheduler.js";

describe("reviewer scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.KNOWLEDGE_REVIEWER_ENABLED;
  });

  it("does not start when env flag is off", () => {
    delete process.env.KNOWLEDGE_REVIEWER_ENABLED;
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }]);
    const screen = vi.fn().mockResolvedValue({ processed: 0, errors: [] });
    const handle = startReviewerScheduler({
      listCompanies: list,
      reviewerForCompany: () => ({ screenPendingDrafts: screen } as any),
      intervalMs: 60_000,
    });
    expect(handle).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("starts when enabled and fires immediately + every intervalMs", async () => {
    process.env.KNOWLEDGE_REVIEWER_ENABLED = "true";
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }, { id: "co-2" }]);
    const screen = vi.fn().mockResolvedValue({ processed: 1, errors: [] });
    const handle = startReviewerScheduler({
      listCompanies: list,
      reviewerForCompany: () => ({ screenPendingDrafts: screen } as any),
      intervalMs: 60_000,
    });
    expect(handle).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); // 让首次立即触发的 microtask 跑完
    expect(screen).toHaveBeenCalledTimes(2); // 2 家公司
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen).toHaveBeenCalledTimes(4); // 又触发一轮 2 公司
    handle?.stop();
  });

  it("swallows screen errors and keeps the loop alive", async () => {
    process.env.KNOWLEDGE_REVIEWER_ENABLED = "true";
    const list = vi.fn().mockResolvedValue([{ id: "co-1" }]);
    const screen = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ processed: 5, errors: [] });
    const handle = startReviewerScheduler({
      listCompanies: list,
      reviewerForCompany: () => ({ screenPendingDrafts: screen } as any),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen).toHaveBeenCalledTimes(2);
    handle?.stop();
  });
});
