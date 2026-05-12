import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeDraftService } from "./knowledge-drafts.js";

// 最小 Drizzle mock：链式 select / insert / update / delete
function makeMockDb(opts: {
  domainLookup?: Array<{ id: string }>;
  insertReturn?: Array<Record<string, unknown>>;
}) {
  const domainSelect = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(opts.domainLookup ?? []),
      }),
    }),
  });
  const insertReturning = vi.fn().mockResolvedValue(opts.insertReturn ?? []);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  return {
    db: { select: domainSelect, insert } as any,
    spies: { domainSelect, insert, insertValues, insertReturning },
  };
}

describe("knowledgeDraftService.create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("当 business_domain_name 不存在时抛 422", async () => {
    const { db } = makeMockDb({ domainLookup: [] });
    const svc = knowledgeDraftService(db);
    await expect(
      svc.create({
        companyId: "c-1",
        actor: { type: "user", userId: "u-1", isAdmin: false },
        payload: {
          title: "t",
          content: "c",
          type: "lesson",
          level: "project",
          business_domain_name: "nonexistent",
          metadata: {},
          confidence: 0.5,
          source: "manual",
          skip_review: false,
        },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("非 admin 用 skip_review=true 时抛 403", async () => {
    const { db } = makeMockDb({ domainLookup: [{ id: "d-1" }] });
    const svc = knowledgeDraftService(db);
    await expect(
      svc.create({
        companyId: "c-1",
        actor: { type: "user", userId: "u-1", isAdmin: false },
        payload: {
          title: "t",
          content: "c",
          type: "lesson",
          level: "project",
          business_domain_name: "general",
          metadata: {},
          confidence: 0.5,
          source: "manual",
          skip_review: true,
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("正常路径写入 pending draft 并返回 id + status", async () => {
    const { db, spies } = makeMockDb({
      domainLookup: [{ id: "d-1" }],
      insertReturn: [{ id: "draft-1", status: "pending", preVerdict: null }],
    });
    const svc = knowledgeDraftService(db);
    const result = await svc.create({
      companyId: "c-1",
      actor: { type: "user", userId: "u-1", isAdmin: false },
      payload: {
        title: "t",
        content: "c",
        type: "lesson",
        level: "project",
        business_domain_name: "general",
        metadata: {},
        confidence: 0.5,
        source: "manual",
        skip_review: false,
      },
    });
    expect(result).toEqual({ id: "draft-1", status: "pending", preVerdict: null });
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedTitle: "t",
        proposedContent: "c",
        proposedType: "lesson",
        proposedLevel: "project",
        proposedBusinessDomainId: "d-1",
        source: "manual",
        sourceUserId: "u-1",
        companyId: "c-1",
        status: "pending",
      }),
    );
  });
});

// ============================================================
// 审查决策方法测试
// ============================================================
function makeUpdateMockDb(opts: {
  draftRow?: Record<string, unknown> | null;
  updateReturn?: Array<Record<string, unknown>>;
}) {
  const draftSelect = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(opts.draftRow ? [opts.draftRow] : []),
      }),
    }),
  });
  const updateReturning = vi.fn().mockResolvedValue(opts.updateReturn ?? []);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return {
    db: { select: draftSelect, update } as any,
    spies: { draftSelect, update, updateSet, updateWhere, updateReturning },
  };
}

describe("knowledgeDraftService.markApproved", () => {
  beforeEach(() => vi.clearAllMocks());

  it("draft 不存在抛 404", async () => {
    const { db } = makeUpdateMockDb({ draftRow: null });
    const svc = knowledgeDraftService(db);
    await expect(
      svc.markApproved({ companyId: "c-1", id: "d-1", reviewerUserId: "u-1", notes: undefined }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("draft 状态非 pending 抛 409", async () => {
    const { db } = makeUpdateMockDb({
      draftRow: { id: "d-1", status: "approved", companyId: "c-1" },
    });
    const svc = knowledgeDraftService(db);
    await expect(
      svc.markApproved({ companyId: "c-1", id: "d-1", reviewerUserId: "u-1", notes: undefined }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("正常路径将 status 改为 approved 并返回 draft", async () => {
    const draftRow = {
      id: "d-1",
      status: "pending",
      companyId: "c-1",
      proposedTitle: "t",
    };
    const { db, spies } = makeUpdateMockDb({
      draftRow,
      updateReturn: [{ ...draftRow, status: "approved", reviewedBy: "u-1" }],
    });
    const svc = knowledgeDraftService(db);
    const result = await svc.markApproved({
      companyId: "c-1",
      id: "d-1",
      reviewerUserId: "u-1",
      notes: "ok",
    });
    expect(result.status).toBe("approved");
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", reviewedBy: "u-1", reviewNotes: "ok" }),
    );
  });
});

describe("knowledgeDraftService.reject", () => {
  it("正常路径写 rejected + notes", async () => {
    const draftRow = { id: "d-1", status: "pending", companyId: "c-1" };
    const { db, spies } = makeUpdateMockDb({
      draftRow,
      updateReturn: [{ ...draftRow, status: "rejected" }],
    });
    const svc = knowledgeDraftService(db);
    await svc.reject({ companyId: "c-1", id: "d-1", reviewerUserId: "u-1", notes: "low quality" });
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected", reviewNotes: "low quality" }),
    );
  });
});

describe("knowledgeDraftService.requestRevision", () => {
  it("正常路径写 revision_requested + notes，issueId 占位 null", async () => {
    const draftRow = { id: "d-1", status: "pending", companyId: "c-1" };
    const { db, spies } = makeUpdateMockDb({
      draftRow,
      updateReturn: [{ ...draftRow, status: "revision_requested" }],
    });
    const svc = knowledgeDraftService(db);
    const result = await svc.requestRevision({
      companyId: "c-1",
      id: "d-1",
      reviewerUserId: "u-1",
      notes: "请补充 root_cause",
    });
    expect(result.issueId).toBeNull();
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "revision_requested" }),
    );
  });
});
