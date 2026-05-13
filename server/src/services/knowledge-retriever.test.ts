import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeRetrieverService } from "./knowledge-retriever.js";

const mockEmbed = vi.fn();
const llmStub = { embed: mockEmbed, completeChat: vi.fn() };

function makeDbWithQueries(semanticRows: unknown[], experienceRows: unknown[]) {
  const execute = vi.fn();
  execute.mockResolvedValueOnce(semanticRows);
  execute.mockResolvedValueOnce(experienceRows);
  return { execute } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("knowledgeRetrieverService.search", () => {
  it("query 空时拒绝（zod 已挡在上层；service 防御也校验）", async () => {
    const svc = knowledgeRetrieverService(makeDbWithQueries([], []), llmStub as any);
    await expect(svc.search({ companyId: "c-1", query: "" } as any)).rejects.toThrow(/query/);
  });

  it("没 used_for 时跳过经验路径（只跑 1 个 execute）", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const db = makeDbWithQueries(
      [
        {
          id: "n-1",
          title: "Test node",
          content: "Some content here",
          type: "lesson",
          level: "company",
          confidence: 0.9,
          verified: true,
          trigger_count: 3,
          last_triggered: null,
          volatility: "stable",
          verified_at: null,
          valid_until: null,
          metadata: {},
          created_at: new Date(),
          similarity: 0.92,
          domain_name: "general",
          domain_display_label: "通用",
          domain_color: "#666",
        },
      ],
      [],
    );
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "find me" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe("n-1");
    expect(res.results[0].similarity).toBe(0.92);
    expect(res.results[0].experience_score).toBe(0);
    expect(res.results[0].freshness_label).toBe("fresh");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("有 used_for 时跑 2 路 + 合并去重", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const semanticRow = {
      id: "n-shared",
      title: "Shared",
      content: "x",
      type: "rule",
      level: "company",
      confidence: 0.8,
      verified: true,
      trigger_count: 5,
      last_triggered: new Date(Date.now() - 1 * 86400_000),
      volatility: "slow",
      verified_at: new Date(),
      valid_until: null,
      metadata: {},
      created_at: new Date(),
      similarity: 0.82,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    };
    const experienceRow = { ...semanticRow, similarity: null, exp_raw: 2.5 };
    const onlyExperience = { ...semanticRow, id: "n-exp-only", similarity: null, exp_raw: 1.0 };

    const db = makeDbWithQueries([semanticRow], [experienceRow, onlyExperience]);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({
      companyId: "c-1",
      query: "find",
      used_for: ["bug-fix"],
    });

    // 合并后 n-shared 应有 similarity 和 experience_score 都非 0
    const shared = res.results.find((r) => r.id === "n-shared");
    expect(shared).toBeDefined();
    expect(shared!.similarity).toBe(0.82);
    expect(shared!.experience_score).toBeGreaterThan(0);

    const expOnly = res.results.find((r) => r.id === "n-exp-only");
    expect(expOnly).toBeDefined();
    expect(expOnly!.similarity).toBe(0);
  });

  it("limit 限制结果数", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const semanticRows = Array.from({ length: 10 }, (_, i) => ({
      id: `n-${i}`,
      title: `T${i}`,
      content: "c",
      type: "lesson",
      level: "company",
      confidence: 0.5,
      verified: false,
      trigger_count: i,
      last_triggered: null,
      volatility: "stable",
      verified_at: null,
      valid_until: null,
      metadata: {},
      created_at: new Date(),
      similarity: 0.9 - i * 0.05,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    }));
    const db = makeDbWithQueries(semanticRows, []);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "f", limit: 3 });
    expect(res.results).toHaveLength(3);
  });

  it("outdated 节点在默认（include_outdated=false）下被排除", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const fresh = {
      id: "n-fresh",
      title: "fresh",
      content: "x",
      type: "lesson",
      level: "company",
      confidence: 0.9,
      verified: true,
      trigger_count: 2,
      last_triggered: null,
      volatility: "stable",
      verified_at: new Date(),
      valid_until: null,
      metadata: {},
      created_at: new Date(),
      similarity: 0.9,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    };
    const expired = {
      ...fresh,
      id: "n-expired",
      valid_until: new Date(Date.now() - 86400_000),
    };
    const db = makeDbWithQueries([fresh, expired], []);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "x" });
    expect(res.results.map((r) => r.id)).toEqual(["n-fresh"]);
  });

  it("include_outdated=true 时保留", async () => {
    mockEmbed.mockResolvedValueOnce(new Array(1536).fill(0.1));
    const expired = {
      id: "n-expired",
      title: "expired",
      content: "x",
      type: "fact",
      level: "company",
      confidence: 0.9,
      verified: true,
      trigger_count: 1,
      last_triggered: null,
      volatility: "fast",
      verified_at: null,
      valid_until: new Date(Date.now() - 86400_000),
      metadata: {},
      created_at: new Date(),
      similarity: 0.85,
      domain_name: "general",
      domain_display_label: "通用",
      domain_color: "#666",
    };
    const db = makeDbWithQueries([expired], []);
    const svc = knowledgeRetrieverService(db, llmStub as any);
    const res = await svc.search({ companyId: "c-1", query: "x", include_outdated: true });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].freshness_label).toBe("outdated");
  });
});
