import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDraftService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  markApproved: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  batchMarkApproved: vi.fn(),
}));

const mockNodeWriter = vi.hoisted(() => ({
  materialize: vi.fn(),
}));

const mockRetriever = vi.hoisted(() => ({
  search: vi.fn(),
}));

const mockFeedback = vi.hoisted(() => ({
  record: vi.fn(),
}));

const mockReviewer = vi.hoisted(() => ({
  screenPendingDrafts: vi.fn(),
  screenDraft: vi.fn(),
}));

const mockHealthcheck = vi.hoisted(() => ({
  runHealthcheck: vi.fn(),
}));

const mockEvolution = vi.hoisted(() => ({
  runEvolution: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  knowledgeDraftService: () => mockDraftService,
  knowledgeNodeWriterService: () => mockNodeWriter,
  llmWikiService: () => ({ embed: vi.fn(), completeChat: vi.fn() }),
  knowledgeRetrieverService: () => mockRetriever,
  knowledgeFeedbackService: () => mockFeedback,
  reviewerAgentService: () => mockReviewer,
  knowledgeHealthcheckService: () => mockHealthcheck,
  knowledgeEvolutionService: () => mockEvolution,
  issueService: () => mockIssueService,
}));

async function createApp(actor: Record<string, unknown>) {
  vi.resetModules();
  const [{ errorHandler }, { knowledgeRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/knowledge.js") as Promise<typeof import("../routes/knowledge.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/knowledge", knowledgeRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/**
 * supertest 在 Windows 上若让 app.listen(0) 自动绑端口，会落到 IPv6 `::` 上，
 * Windows 拒绝在 ::1 上连接（EACCES）。统一改成手动 createServer + listen 在
 * 127.0.0.1，跟 activity-routes.test.ts 风格一致。
 */
async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

const boardActor = {
  type: "board",
  userId: "u-1",
  companyIds: ["c-1"],
  memberships: [{ companyId: "c-1", status: "active", membershipRole: "owner" }],
  source: "session",
  isInstanceAdmin: false,
};

describe.sequential("POST /api/knowledge/drafts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 当 body 校验失败（title 缺失）", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts?companyId=c-1")
        .send({ content: "x", type: "lesson", level: "project", business_domain_name: "general" }),
    );
    expect(res.status).toBe(400);
  });

  it("403 当 actor 没有公司访问权限", async () => {
    const app = await createApp({ ...boardActor, companyIds: ["other"] });
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts?companyId=c-1")
        .send({
          title: "t",
          content: "c",
          type: "lesson",
          level: "project",
          business_domain_name: "general",
        }),
    );
    expect(res.status).toBe(403);
  });

  it("201 + 返回 draft.id（普通路径，skip_review=false）", async () => {
    mockDraftService.create.mockResolvedValueOnce({ id: "d-1", status: "pending", preVerdict: null });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts?companyId=c-1")
        .send({
          title: "t",
          content: "c",
          type: "lesson",
          level: "project",
          business_domain_name: "general",
        }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: "d-1", status: "pending" });
    expect(mockDraftService.create).toHaveBeenCalledTimes(1);
  });

  it("201 + 立即物化（skip_review=true，admin）", async () => {
    mockDraftService.create.mockResolvedValueOnce({ id: "d-1", status: "pending", preVerdict: null });
    mockDraftService.markApproved.mockResolvedValueOnce({ id: "d-1", status: "approved" });
    mockNodeWriter.materialize.mockResolvedValueOnce({ nodeId: "n-1", isUpdate: false });
    const app = await createApp({ ...boardActor, isInstanceAdmin: true });
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts?companyId=c-1")
        .send({
          title: "t",
          content: "c",
          type: "lesson",
          level: "project",
          business_domain_name: "general",
          skip_review: true,
        }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: "d-1", node_id: "n-1" });
  });
});

describe.sequential("POST /api/knowledge/drafts/:id/approve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + 返回 node_id", async () => {
    mockDraftService.markApproved.mockResolvedValueOnce({ id: "d-1", status: "approved" });
    mockNodeWriter.materialize.mockResolvedValueOnce({ nodeId: "n-1", isUpdate: false });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts/d-1/approve?companyId=c-1")
        .send({ review_notes: "ok" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ node_id: "n-1" });
  });

  it("403 非 board actor（agent 即使能访问公司也不能审）", async () => {
    // agent 同公司可访问 → assertCompanyAccess 放行；但 assertBoard 拦住，
    // 这样确保 403 来自审查权限校验而不是跨公司隔离
    const app = await createApp({ type: "agent", agentId: "a-1", companyId: "c-1" });
    const res = await requestApp(app, (base) =>
      request(base).post("/api/knowledge/drafts/d-1/approve?companyId=c-1").send({}),
    );
    expect(res.status).toBe(403);
    // errorHandler 返回 { error: <message string> }；assertBoard 的消息含 "Board"
    expect(typeof res.body?.error === "string" ? res.body.error : "").toMatch(/board/i);
  });
});

describe.sequential("POST /api/knowledge/drafts/:id/reject", () => {
  beforeEach(() => vi.clearAllMocks());

  it("204", async () => {
    mockDraftService.reject.mockResolvedValueOnce({ id: "d-1", status: "rejected" });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts/d-1/reject?companyId=c-1")
        .send({ review_notes: "no" }),
    );
    expect(res.status).toBe(204);
  });
});

describe.sequential("POST /api/knowledge/drafts/batch-approve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + approved_count + failed[]", async () => {
    const u1 = "11111111-1111-1111-1111-111111111111";
    const u2 = "22222222-2222-2222-2222-222222222222";
    const u3 = "33333333-3333-3333-3333-333333333333";
    mockDraftService.batchMarkApproved.mockResolvedValueOnce({
      approvedIds: [u1, u2],
      failed: [{ id: u3, reason: "conflict" }],
    });
    mockNodeWriter.materialize
      .mockResolvedValueOnce({ nodeId: "n-1", isUpdate: false })
      .mockResolvedValueOnce({ nodeId: "n-2", isUpdate: false });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts/batch-approve?companyId=c-1")
        .send({ draft_ids: [u1, u2, u3] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      approved_count: 2,
      failed: [{ id: u3, reason: "conflict" }],
    });
  });
});

describe.sequential("GET /api/knowledge/drafts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + items + next_cursor", async () => {
    mockDraftService.list.mockResolvedValueOnce({
      items: [{ id: "d-1" }, { id: "d-2" }],
      nextCursor: "abc",
    });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).get("/api/knowledge/drafts?companyId=c-1"),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.next_cursor).toBe("abc");
  });
});

describe.sequential("GET /api/knowledge/search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 返回 retriever 结果", async () => {
    mockRetriever.search.mockResolvedValueOnce({
      results: [
        {
          id: "n-1",
          title: "T",
          snippet: "S",
          type: "lesson",
          level: "company",
          domain: { name: "general", display_label: "通用", color: "#666" },
          confidence: 0.9,
          verified: true,
          trigger_count: 5,
          similarity: 0.88,
          experience_score: 0.0,
          freshness_score: 0.95,
          freshness_label: "fresh",
          final_score: 0.63,
          verified_at: null,
          volatility: "stable",
        },
      ],
      search_type: "semantic",
      took_ms: 120,
    });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).get("/api/knowledge/search?companyId=c-1&q=hello"),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.results[0].id).toBe("n-1");
    expect(mockRetriever.search).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "c-1", query: "hello" }),
    );
  });

  it("400 缺 q", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).get("/api/knowledge/search?companyId=c-1"),
    );
    expect(res.status).toBe(400);
  });

  it("csv 参数被拆为数组传给 retriever", async () => {
    mockRetriever.search.mockResolvedValueOnce({ results: [], search_type: "semantic", took_ms: 1 });
    const app = await createApp(boardActor);
    await requestApp(app, (base) =>
      request(base).get("/api/knowledge/search?companyId=c-1&q=x&domain=software,content&used_for=bug-fix"),
    );
    expect(mockRetriever.search).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: ["software", "content"],
        used_for: ["bug-fix"],
      }),
    );
  });
});

describe.sequential("POST /api/knowledge/nodes/:id/feedback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("204 + 调 feedback service", async () => {
    mockFeedback.record.mockResolvedValueOnce({ nodeId: "n-1", eventId: "e-1" });
    const app = await createApp(boardActor);
    const nodeId = "11111111-1111-1111-1111-111111111111";
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/knowledge/nodes/${nodeId}/feedback?companyId=c-1`)
        .send({ feedback: "helped" }),
    );
    expect(res.status).toBe(204);
    expect(mockFeedback.record).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId, companyId: "c-1", feedback: "helped" }),
    );
  });

  it("400 非法 feedback enum", async () => {
    const app = await createApp(boardActor);
    const nodeId = "11111111-1111-1111-1111-111111111111";
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/knowledge/nodes/${nodeId}/feedback?companyId=c-1`)
        .send({ feedback: "bogus" }),
    );
    expect(res.status).toBe(400);
  });
});

describe.sequential("POST /api/knowledge/reviewer/run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + processed count after screening", async () => {
    mockReviewer.screenPendingDrafts.mockResolvedValueOnce({ processed: 3, errors: [] });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/reviewer/run?companyId=c-1")
        .send({}),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(3);
    expect(res.body.data.errors).toEqual([]);
  });

  it("400 when companyId missing", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).post("/api/knowledge/reviewer/run").send({}),
    );
    expect(res.status).toBe(400);
  });
});

describe.sequential("POST /api/knowledge/healthcheck/run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + { metricsComputed, alarmsCreated } summary", async () => {
    mockHealthcheck.runHealthcheck.mockResolvedValueOnce({
      metricsComputed: 6,
      alarmsCreated: 2,
    });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/healthcheck/run?companyId=c-1")
        .send({}),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ metricsComputed: 6, alarmsCreated: 2 });
    expect(mockHealthcheck.runHealthcheck).toHaveBeenCalledWith("c-1", {
      metrics: expect.arrayContaining([
        "weekly_new_drafts",
        "review_backlog_hours_p50",
        "helped_ratio",
        "avg_edges_per_node",
        "unresolved_conflicts",
        "stale_unchecked_fast",
      ]),
    });
  });

  it("passes opts.metrics subset to service", async () => {
    mockHealthcheck.runHealthcheck.mockResolvedValueOnce({
      metricsComputed: 2,
      alarmsCreated: 0,
    });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/healthcheck/run?companyId=c-1")
        .send({ metrics: ["weekly_new_drafts", "helped_ratio"] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.metricsComputed).toBe(2);
    expect(mockHealthcheck.runHealthcheck).toHaveBeenCalledWith("c-1", {
      metrics: ["weekly_new_drafts", "helped_ratio"],
    });
  });

  it("400 when companyId query is missing", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).post("/api/knowledge/healthcheck/run").send({}),
    );
    expect(res.status).toBe(400);
  });

  it("400 when metrics array contains an unknown name", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/healthcheck/run?companyId=c-1")
        .send({ metrics: ["bogus_metric"] }),
    );
    expect(res.status).toBe(400);
    expect(mockHealthcheck.runHealthcheck).not.toHaveBeenCalled();
  });
});

describe.sequential("POST /api/knowledge/evolution/run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + aggregate summary (defaults to all 6 behaviors)", async () => {
    mockEvolution.runEvolution.mockResolvedValueOnce({
      behaviorsRun: 6,
      issuesCreated: 3,
      draftsCreated: 1,
      nodesModified: 5,
      perBehavior: [],
    });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/evolution/run?companyId=c-1")
        .send({}),
    );
    if (res.status !== 200) {
      console.log("DEBUG status:", res.status, "body:", JSON.stringify(res.body), "text:", res.text);
    }
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      behaviorsRun: 6,
      issuesCreated: 3,
      draftsCreated: 1,
      nodesModified: 5,
    });
    expect(mockEvolution.runEvolution).toHaveBeenCalledWith("c-1", {
      behaviors: expect.arrayContaining([
        "promotion_check",
        "decay_scan",
        "merge_candidate_detect",
        "conflict_detect",
        "freshness_audit",
        "pattern_emergence",
      ]),
    });
  });

  it("passes opts.behaviors subset to service", async () => {
    mockEvolution.runEvolution.mockResolvedValueOnce({
      behaviorsRun: 2,
      issuesCreated: 0,
      draftsCreated: 0,
      nodesModified: 0,
      perBehavior: [],
    });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/evolution/run?companyId=c-1")
        .send({ behaviors: ["decay_scan", "freshness_audit"] }),
    );
    expect(res.status).toBe(200);
    expect(mockEvolution.runEvolution).toHaveBeenCalledWith("c-1", {
      behaviors: ["decay_scan", "freshness_audit"],
    });
  });

  it("400 when companyId query is missing", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).post("/api/knowledge/evolution/run").send({}),
    );
    expect(res.status).toBe(400);
  });

  it("400 when behaviors array contains an unknown name", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/evolution/run?companyId=c-1")
        .send({ behaviors: ["bogus_behavior"] }),
    );
    expect(res.status).toBe(400);
    expect(mockEvolution.runEvolution).not.toHaveBeenCalled();
  });
});

describe.sequential("POST /api/knowledge/drafts/batch-apply-verdict", () => {
  beforeEach(() => vi.clearAllMocks());

  const u1 = "11111111-1111-1111-1111-111111111111";
  const u2 = "22222222-2222-2222-2222-222222222222";

  it("200 + approved_count when verdict=recommend_approve", async () => {
    mockDraftService.batchMarkApproved.mockResolvedValueOnce({ approvedIds: [u1, u2], failed: [] });
    mockNodeWriter.materialize
      .mockResolvedValueOnce({ nodeId: "n-1" })
      .mockResolvedValueOnce({ nodeId: "n-2" });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts/batch-apply-verdict?companyId=c-1")
        .send({ verdict: "recommend_approve", draft_ids: [u1, u2] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.approved_count).toBe(2);
    expect(res.body.data.failed).toEqual([]);
  });

  it("200 + rejected_count when verdict=recommend_reject", async () => {
    mockDraftService.reject.mockResolvedValue({});
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/knowledge/drafts/batch-apply-verdict?companyId=c-1")
        .send({ verdict: "recommend_reject", draft_ids: [u1, u2] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.rejected_count).toBe(2);
    expect(res.body.data.failed).toEqual([]);
  });
});
