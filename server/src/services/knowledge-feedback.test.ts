import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeFeedbackService } from "./knowledge-feedback.js";

function makeMockDb(opts: { nodeRow?: Record<string, unknown> | null }) {
  const selectQueue = [opts.nodeRow ? [opts.nodeRow] : []];
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(selectQueue.shift() ?? []),
      }),
    }),
  });
  const updateReturning = vi.fn().mockResolvedValue([{ id: opts.nodeRow?.id ?? "n-1" }]);
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: updateReturning }),
  });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  const insertReturning = vi.fn().mockResolvedValue([{ id: "evt-1" }]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  return {
    db: { select, update, insert } as any,
    spies: { select, update, updateSet, updateReturning, insert, insertValues, insertReturning },
  };
}

beforeEach(() => vi.clearAllMocks());

const baseNode = {
  id: "n-1",
  companyId: "c-1",
  status: "active",
  triggerCount: 3,
  metadata: {},
};

describe("knowledgeFeedbackService.record", () => {
  it("节点不存在抛 404", async () => {
    const { db } = makeMockDb({ nodeRow: null });
    const svc = knowledgeFeedbackService(db);
    await expect(
      svc.record({
        companyId: "c-1",
        nodeId: "missing",
        feedback: "helped",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("跨公司节点抛 404", async () => {
    const { db } = makeMockDb({ nodeRow: { ...baseNode, companyId: "other" } });
    const svc = knowledgeFeedbackService(db);
    await expect(
      svc.record({
        companyId: "c-1",
        nodeId: "n-1",
        feedback: "helped",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("helped → trigger_count += 1 + last_triggered + event(type='triggered')", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "helped",
      runId: "r-1",
      issueId: "i-1",
      userId: "u-1",
    });
    expect(spies.update).toHaveBeenCalled();
    const updatePayload = spies.updateSet.mock.calls[0][0];
    expect(updatePayload).toEqual(
      expect.objectContaining({ triggerCount: 4 }),
    );
    expect(updatePayload.lastTriggered).toBeInstanceOf(Date);

    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "n-1",
        eventType: "triggered",
        feedback: "helped",
        runId: "r-1",
        issueId: "i-1",
        userId: "u-1",
      }),
    );
  });

  it("outdated → metadata.forced_outdated_at 设置 + event(type='feedback', feedback='outdated')", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode, metadata: { foo: "bar" } } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "outdated",
    });
    const updatePayload = spies.updateSet.mock.calls[0][0];
    expect(updatePayload).toHaveProperty("metadata");
    const meta = updatePayload.metadata;
    expect(meta).toEqual(
      expect.objectContaining({
        foo: "bar",
        forced_outdated_at: expect.any(String),
      }),
    );
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "feedback", feedback: "outdated" }),
    );
  });

  it("wrong → 仅 event(type='feedback', feedback='wrong')，不 update 节点", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "wrong",
      comment: "conflicts with PG 17 docs",
    });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "feedback",
        feedback: "wrong",
        metadata: expect.objectContaining({ comment: "conflicts with PG 17 docs" }),
      }),
    );
  });

  it("irrelevant → 仅 event(type='feedback', feedback='irrelevant')，不 update 节点", async () => {
    const { db, spies } = makeMockDb({ nodeRow: { ...baseNode } });
    const svc = knowledgeFeedbackService(db);
    await svc.record({
      companyId: "c-1",
      nodeId: "n-1",
      feedback: "irrelevant",
    });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "feedback", feedback: "irrelevant" }),
    );
  });
});
