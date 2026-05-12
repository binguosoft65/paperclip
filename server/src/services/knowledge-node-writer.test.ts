import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeNodeWriterService } from "./knowledge-node-writer.js";

/**
 * 构造一个 FIFO 风格的 select mock：每次 .from().where() 链调用返回 queue 中下一个结果。
 * limit() 是 awaitable，where() 本身也是 thenable，覆盖 wikilink 反查（无 limit）和 draft 查询（有 limit）两种调用形式。
 */
function makeFlexibleSelectQueue(queue: Array<unknown[]>) {
  const fifo = [...queue];
  return vi.fn().mockImplementation(() => {
    const pop = () => fifo.shift() ?? [];
    const whereResult = {
      limit: vi.fn().mockImplementation(async () => pop()),
      then: (onFulfilled: (rows: unknown[]) => unknown) => Promise.resolve(pop()).then(onFulfilled),
    };
    return {
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereResult) }),
    };
  });
}

/**
 * 构造 db mock + tx mock 的工厂。selectQueue 同时驱动顶层 db.select 和 tx.select（
 * 顺序消费），insertReturns 驱动事务里所有 insert/update 的 .returning() 调用。
 */
function makeTxMock(selectQueue: Array<unknown[]>, insertReturns: Array<unknown[]>) {
  const sharedSelectFifo = [...selectQueue];
  const insertFifo = [...insertReturns];

  function makeSelect() {
    return vi.fn().mockImplementation(() => {
      const pop = () => sharedSelectFifo.shift() ?? [];
      const whereResult = {
        limit: vi.fn().mockImplementation(async () => pop()),
        then: (onFulfilled: (rows: unknown[]) => unknown) =>
          Promise.resolve(pop()).then(onFulfilled),
      };
      return {
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereResult) }),
      };
    });
  }

  const txInsert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockImplementation(async () => insertFifo.shift() ?? []),
    }),
  });
  const txUpdate = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(async () => insertFifo.shift() ?? []),
      }),
    }),
  });
  const txDelete = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  });
  const tx = { select: makeSelect(), insert: txInsert, update: txUpdate, delete: txDelete };

  return {
    db: {
      select: makeSelect(),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    } as any,
    spies: { txInsert, txUpdate, txDelete, tx },
  };
}

describe("knowledgeNodeWriterService.materialize", () => {
  beforeEach(() => vi.clearAllMocks());

  it("draft 不存在抛 404", async () => {
    const { db } = makeTxMock([[]], []); // 第一个 select（读 draft）返回空
    const svc = knowledgeNodeWriterService(db, {
      embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
    });
    await expect(
      svc.materialize({ companyId: "c-1", draftId: "d-1", reviewerUserId: "u-1" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("draft 状态非 approved 抛 409", async () => {
    const { db } = makeTxMock(
      [[{ id: "d-1", status: "pending", companyId: "c-1" }]],
      [],
    );
    const svc = knowledgeNodeWriterService(db, {
      embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
    });
    await expect(
      svc.materialize({ companyId: "c-1", draftId: "d-1", reviewerUserId: "u-1" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("新建路径：调用 embed(title+content) 并返回 nodeId", async () => {
    const { db } = makeTxMock(
      [
        // db.select 读 draft
        [
          {
            id: "d-1",
            status: "approved",
            companyId: "c-1",
            targetNodeId: null,
            proposedTitle: "t",
            proposedContent: "正文无 wikilink",
            proposedType: "lesson",
            proposedLevel: "project",
            proposedBusinessDomainId: "bd-1",
            proposedMetadata: {},
            proposedVolatility: "fast",
            proposedValidUntil: null,
            confidence: 0.7,
            sourceAgentId: null,
            sourceRunId: null,
            sourceIssueId: null,
            sourceUserId: "u-1",
          },
        ],
      ],
      [
        // 第 1 个 insert.returning：INSERT node
        [{ id: "node-1" }],
        // 第 2 个 insert.returning：INSERT event
        [],
      ],
    );
    const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));
    const svc = knowledgeNodeWriterService(db, { embed });
    const result = await svc.materialize({
      companyId: "c-1",
      draftId: "d-1",
      reviewerUserId: "u-1",
    });
    expect(result.nodeId).toBe("node-1");
    expect(result.isUpdate).toBe(false);
    expect(embed).toHaveBeenCalledWith("t\n\n正文无 wikilink");
  });
});
