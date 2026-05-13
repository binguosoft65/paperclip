import { describe, it, expect, vi } from "vitest";
import { reviewerAgentService, REVIEWER_SYSTEM_PROMPT } from "./knowledge-reviewer.js";

// Drizzle 在测试中 mock 成手写 fluent builder
function fakeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([
      {
        id: "draft-1",
        companyId: "co-1",
        proposedTitle: "Avoid global mutable singletons",
        proposedContent: "Singletons make tests flaky; prefer factory.",
        proposedType: "lesson",
        proposedLevel: "company",
        confidence: 0.85,
        source: "agent_self_review",
        status: "pending",
        preVerdict: null,
      },
    ]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: "draft-1" }]),
  } as any;
}

const fakeRetriever = {
  search: vi.fn().mockResolvedValue({
    results: [],
    search_type: "semantic",
    took_ms: 1,
  }),
};

const fakeLlm = {
  completeChat: vi.fn().mockResolvedValue(JSON.stringify({
    verdict: "recommend_approve",
    reasoning: "Clear lesson with concrete advice, no conflicts.",
    conflicts: [],
  })),
};

describe("reviewerAgentService.screenDraft", () => {
  it("writes pre_verdict=recommend_approve when LLM returns clean approve", async () => {
    const db = fakeDb();
    const svc = reviewerAgentService(db, fakeRetriever as any, fakeLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.pre_verdict).toBe("recommend_approve");
    expect(result.reasoning).toContain("Clear lesson");
    expect(result.conflicts).toEqual([]);

    // 校验落库
    const updateArgs = db.set.mock.calls[0]?.[0];
    expect(updateArgs.preVerdict).toBe("recommend_approve");
    expect(updateArgs.preVerdictReasoning).toContain("Clear lesson");
  });

  it("falls back to needs_human when LLM JSON cannot parse", async () => {
    const db = fakeDb();
    const brokenLlm = { completeChat: vi.fn().mockResolvedValue("not json") };
    const svc = reviewerAgentService(db, fakeRetriever as any, brokenLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.pre_verdict).toBe("needs_human");
    expect(result.reasoning).toMatch(/parse|invalid|解析/i);
  });

  it("clamps reasoning to ≤ 200 chars", async () => {
    const db = fakeDb();
    const longLlm = {
      completeChat: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: "recommend_approve",
        reasoning: "x".repeat(500),
        conflicts: [],
      })),
    };
    const svc = reviewerAgentService(db, fakeRetriever as any, longLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.reasoning.length).toBeLessThanOrEqual(200);
  });

  it("rejects unknown verdict from LLM as needs_human", async () => {
    const db = fakeDb();
    const weirdLlm = {
      completeChat: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: "MAYBE",
        reasoning: "ambiguous",
        conflicts: [],
      })),
    };
    const svc = reviewerAgentService(db, fakeRetriever as any, weirdLlm as any);
    const result = await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    expect(result.pre_verdict).toBe("needs_human");
  });

  it("throws 404 when draft not found", async () => {
    const db = fakeDb();
    db.limit.mockResolvedValueOnce([]);
    const svc = reviewerAgentService(db, fakeRetriever as any, fakeLlm as any);
    await expect(
      svc.screenDraft({ companyId: "co-1", draftId: "missing" }),
    ).rejects.toThrow(/not found/i);
  });

  it("passes retriever Top-K similar nodes into LLM prompt", async () => {
    const db = fakeDb();
    const retriever2 = {
      search: vi.fn().mockResolvedValue({
        results: [
          { id: "node-A", title: "Singletons are evil", snippet: "...", similarity: 0.8 },
        ],
        search_type: "semantic",
        took_ms: 5,
      }),
    };
    const recordingLlm = {
      completeChat: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: "needs_human",
        reasoning: "duplicates existing node",
        conflicts: ["node-A"],
      })),
    };
    const svc = reviewerAgentService(db, retriever2 as any, recordingLlm as any);
    await svc.screenDraft({ companyId: "co-1", draftId: "draft-1" });
    // 验证 LLM 收到包含 "node-A" 的 prompt
    const prompt = recordingLlm.completeChat.mock.calls[0]?.[0];
    expect(JSON.stringify(prompt)).toContain("node-A");
  });
});
