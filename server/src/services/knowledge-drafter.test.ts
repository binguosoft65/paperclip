import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeDrafterService } from "./knowledge-drafter.js";

// Mock knowledge-drafts service (drafter 复用它写入)
const mockDraftCreate = vi.fn();
vi.mock("./knowledge-drafts.js", () => ({
  knowledgeDraftService: () => ({ create: mockDraftCreate }),
}));

function makeLlmStub(response: string) {
  return { completeChat: vi.fn().mockResolvedValue(response) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("knowledgeDrafterService.run", () => {
  it("LLM 返回空数组 → draftIds 为空，未调 create", async () => {
    const llm = makeLlmStub(JSON.stringify({ drafts: [] }));
    mockDraftCreate.mockResolvedValue({ id: "should-not-be-called" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      issueId: "i-1",
      context: { title: "t", description: "d" },
    });
    expect(res.draftIds).toEqual([]);
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });

  it("LLM 返回 1 条 valid draft → 调 create 1 次，draftIds 含返回 id", async () => {
    const llm = makeLlmStub(
      JSON.stringify({
        drafts: [
          {
            type: "lesson",
            title: "学到的",
            content: "事务里不要调外部 API",
            confidence: 0.7,
            volatility: "slow",
            used_for: ["bug-fix"],
          },
        ],
      }),
    );
    mockDraftCreate.mockResolvedValueOnce({ id: "d-new-1", status: "pending" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      issueId: "i-1",
      agentId: "a-1",
      context: { title: "t", description: "d" },
    });
    expect(res.draftIds).toEqual(["d-new-1"]);
    expect(mockDraftCreate).toHaveBeenCalledTimes(1);
    expect(mockDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "c-1",
        payload: expect.objectContaining({
          type: "lesson",
          title: "学到的",
          source: "agent_self_review",
          business_domain_name: "general",
        }),
      }),
    );
  });

  it("LLM 返回 3 条 draft 但其中 1 条 type 非法 → 跳过非法，写入 2 条", async () => {
    const llm = makeLlmStub(
      JSON.stringify({
        drafts: [
          { type: "lesson", title: "ok1", content: "x", confidence: 0.5 },
          { type: "BANANA", title: "bad", content: "x", confidence: 0.5 },
          { type: "rule", title: "ok2", content: "y", confidence: 0.6 },
        ],
      }),
    );
    mockDraftCreate
      .mockResolvedValueOnce({ id: "d-1" })
      .mockResolvedValueOnce({ id: "d-2" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      context: {},
    });
    expect(res.draftIds).toEqual(["d-1", "d-2"]);
    expect(mockDraftCreate).toHaveBeenCalledTimes(2);
  });

  it("LLM 抛错 → draftIds 空 + error 字段含原因", async () => {
    const llm = { completeChat: vi.fn().mockRejectedValue(new Error("rate limit")) };
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      context: {},
    });
    expect(res.draftIds).toEqual([]);
    expect(res.error).toMatch(/rate limit/);
  });

  it("LLM 返回非 JSON → 返回 error，无 create 调用", async () => {
    const llm = makeLlmStub("this is not json at all");
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      context: {},
    });
    expect(res.draftIds).toEqual([]);
    expect(res.error).toMatch(/json/i);
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });

  it("issue_reopened trigger → source=failure_signal", async () => {
    const llm = makeLlmStub(
      JSON.stringify({
        drafts: [{ type: "lesson", title: "t", content: "c", confidence: 0.5 }],
      }),
    );
    mockDraftCreate.mockResolvedValueOnce({ id: "d-1" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    await svc.run({
      kind: "issue_reopened",
      companyId: "c-1",
      issueId: "i-1",
      context: { previousStatus: "done", status: "in_progress" },
    });
    expect(mockDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ source: "failure_signal" }),
      }),
    );
  });

  it("approval_rejected trigger → 调用 prompt 不同于 task_complete", async () => {
    const llm = makeLlmStub(JSON.stringify({ drafts: [] }));
    const svc = knowledgeDrafterService({} as any, llm as any);
    await svc.run({
      kind: "approval_rejected",
      companyId: "c-1",
      approvalId: "ap-1",
      context: { decisionNote: "scope too big" },
    });
    // 验证 user prompt 提到了 approval / rejected 关键词
    const callArg = (llm.completeChat as any).mock.calls[0][0];
    expect(callArg.user).toMatch(/approval|reject|驳回|审批/i);
  });
});
