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

vi.mock("../services/index.js", () => ({
  knowledgeDraftService: () => mockDraftService,
  knowledgeNodeWriterService: () => mockNodeWriter,
  llmWikiService: () => ({ embed: vi.fn() }),
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

  it("403 非 board actor（agent 也不能审）", async () => {
    const app = await createApp({ type: "agent", agentId: "a-1", companyId: "c-1" });
    const res = await requestApp(app, (base) =>
      request(base).post("/api/knowledge/drafts/d-1/approve?companyId=c-1").send({}),
    );
    expect(res.status).toBe(403);
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
