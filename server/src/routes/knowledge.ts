import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  approveKnowledgeDraftSchema,
  batchApproveKnowledgeDraftSchema,
  createKnowledgeDraftSchema,
  listKnowledgeDraftsQuerySchema,
  rejectKnowledgeDraftSchema,
  requestRevisionKnowledgeDraftSchema,
  knowledgeFeedbackSchema,
  knowledgeSearchQuerySchema,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  knowledgeDraftService,
  knowledgeNodeWriterService,
  llmWikiService,
  knowledgeRetrieverService,
  knowledgeFeedbackService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * LLM-Wiki 知识引擎 REST 路由（Phase 1a）。
 *
 * 路径：`/api/knowledge/drafts*`。所有路由通过 `?companyId=<uuid>` query
 * 显式带公司上下文，并经 assertCompanyAccess 多租户隔离。
 *
 * 审查决策（approve / reject / request-revision / batch-approve）当前
 * 限定 board user（人类）调用，agent 不能直接审。Phase 1b 加 Reviewer
 * Agent 时再放开 system actor 路径。
 */
export function knowledgeRoutes(db: Db) {
  const router = Router();
  const drafts = knowledgeDraftService(db);
  const llm = llmWikiService(db);
  const nodeWriter = knowledgeNodeWriterService(db, llm);
  const retriever = knowledgeRetrieverService(db, llm);
  const feedback = knowledgeFeedbackService(db);

  function requireCompanyId(req: Request): string {
    const raw = req.query.companyId;
    if (typeof raw !== "string" || raw.length === 0) {
      throw badRequest("companyId query parameter is required");
    }
    return raw;
  }

  // Express 5 把 req.params 字段类型变成 string | string[]；这里收敛
  function requireParamId(req: Request): string {
    const raw = (req.params as Record<string, unknown>).id;
    if (typeof raw !== "string" || raw.length === 0) {
      throw badRequest("missing :id path parameter");
    }
    return raw;
  }

  // 解析 actor 是否具备 admin 标志（仅 board 路径有 isInstanceAdmin）
  function isAdminActor(req: Request): boolean {
    return req.actor.type === "board" && req.actor.isInstanceAdmin === true;
  }

  // ============================================================
  // POST /api/knowledge/drafts
  // ============================================================
  router.post("/drafts", validate(createKnowledgeDraftSchema), async (req, res) => {
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const actor =
      req.actor.type === "agent"
        ? {
            type: "agent" as const,
            agentId: req.actor.agentId ?? "unknown-agent",
            runId: req.actor.runId ?? null,
          }
        : {
            type: "user" as const,
            userId: req.actor.userId ?? "unknown-user",
            isAdmin: isAdminActor(req),
          };

    const draft = await drafts.create({ companyId, actor, payload: req.body });

    // skip_review=true 路径：立即标 approved + 物化
    if (req.body.skip_review === true) {
      const reviewerUserId = actor.type === "user" ? actor.userId : "system";
      await drafts.markApproved({ companyId, id: draft.id, reviewerUserId });
      const { nodeId } = await nodeWriter.materialize({
        companyId,
        draftId: draft.id,
        reviewerUserId,
      });
      res.status(201).json({ data: { id: draft.id, status: "approved", node_id: nodeId } });
      return;
    }
    res.status(201).json({ data: draft });
  });

  // ============================================================
  // GET /api/knowledge/drafts
  // ============================================================
  router.get("/drafts", async (req, res) => {
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const parsed = listKnowledgeDraftsQuerySchema.safeParse({
      status: req.query.status,
      source: req.query.source,
      pre_verdict: req.query.pre_verdict,
      domain: req.query.domain,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    if (!parsed.success) {
      throw badRequest("invalid query", parsed.error.format());
    }
    const result = await drafts.list(companyId, parsed.data);
    res.json({ data: result.items, meta: { next_cursor: result.nextCursor } });
  });

  // ============================================================
  // GET /api/knowledge/drafts/:id
  // ============================================================
  router.get("/drafts/:id", async (req, res) => {
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const row = await drafts.getById(companyId, requireParamId(req));
    if (!row) throw notFound("draft not found");
    res.json({ data: row });
  });

  // ============================================================
  // POST /api/knowledge/drafts/:id/approve
  // ============================================================
  router.post(
    "/drafts/:id/approve",
    validate(approveKnowledgeDraftSchema),
    async (req, res) => {
      const companyId = requireCompanyId(req);
      assertCompanyAccess(req, companyId);
      assertBoard(req); // Phase 1a：仅人类可审查（Reviewer Agent 在 Phase 3 接入）
      const actor = getActorInfo(req);
      const reviewerUserId = actor.actorId;

      await drafts.markApproved({
        companyId,
        id: requireParamId(req),
        reviewerUserId,
        notes: req.body.review_notes,
      });
      const { nodeId } = await nodeWriter.materialize({
        companyId,
        draftId: requireParamId(req),
        reviewerUserId,
      });
      res.json({ data: { node_id: nodeId } });
    },
  );

  // ============================================================
  // POST /api/knowledge/drafts/:id/reject
  // ============================================================
  router.post(
    "/drafts/:id/reject",
    validate(rejectKnowledgeDraftSchema),
    async (req, res) => {
      const companyId = requireCompanyId(req);
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const actor = getActorInfo(req);
      await drafts.reject({
        companyId,
        id: requireParamId(req),
        reviewerUserId: actor.actorId,
        notes: req.body.review_notes,
      });
      res.status(204).end();
    },
  );

  // ============================================================
  // POST /api/knowledge/drafts/:id/request-revision
  // ============================================================
  router.post(
    "/drafts/:id/request-revision",
    validate(requestRevisionKnowledgeDraftSchema),
    async (req, res) => {
      const companyId = requireCompanyId(req);
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const actor = getActorInfo(req);
      const result = await drafts.requestRevision({
        companyId,
        id: requireParamId(req),
        reviewerUserId: actor.actorId,
        notes: req.body.review_notes,
      });
      res.json({ data: { issue_id: result.issueId } });
    },
  );

  // ============================================================
  // POST /api/knowledge/drafts/batch-approve
  // ============================================================
  router.post(
    "/drafts/batch-approve",
    validate(batchApproveKnowledgeDraftSchema),
    async (req, res) => {
      const companyId = requireCompanyId(req);
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const actor = getActorInfo(req);

      // 1. 串行标 approved
      const { approvedIds, failed } = await drafts.batchMarkApproved({
        companyId,
        ids: req.body.draft_ids,
        reviewerUserId: actor.actorId,
        notes: req.body.review_notes,
      });

      // 2. 串行物化（限制 OpenAI quota 突发）
      const materializeFailed: Array<{ id: string; reason: string }> = [];
      let approvedCount = 0;
      for (const id of approvedIds) {
        try {
          await nodeWriter.materialize({
            companyId,
            draftId: id,
            reviewerUserId: actor.actorId,
          });
          approvedCount += 1;
        } catch (err) {
          materializeFailed.push({
            id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      res.json({
        data: {
          approved_count: approvedCount,
          failed: [...failed, ...materializeFailed],
        },
      });
    },
  );

  // ============================================================
  // GET /api/knowledge/search
  // ============================================================
  router.get("/search", async (req, res) => {
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const parsed = knowledgeSearchQuerySchema.safeParse({
      q: req.query.q,
      type: req.query.type,
      domain: req.query.domain,
      used_for: req.query.used_for,
      project_id: req.query.project_id,
      include_outdated: req.query.include_outdated,
      limit: req.query.limit,
    });
    if (!parsed.success) {
      throw badRequest("invalid query", parsed.error.format());
    }
    const q = parsed.data;
    const result = await retriever.search({
      companyId,
      query: q.q,
      projectId: q.project_id ?? null,
      type: q.type ? q.type.split(",").map((s) => s.trim()).filter(Boolean) : null,
      domain: q.domain ? q.domain.split(",").map((s) => s.trim()).filter(Boolean) : null,
      used_for: q.used_for ? q.used_for.split(",").map((s) => s.trim()).filter(Boolean) : null,
      include_outdated: q.include_outdated,
      limit: q.limit,
    });
    res.json({ data: result, meta: { took_ms: result.took_ms } });
  });

  // ============================================================
  // POST /api/knowledge/nodes/:id/feedback
  // ============================================================
  router.post(
    "/nodes/:id/feedback",
    validate(knowledgeFeedbackSchema),
    async (req, res) => {
      const companyId = requireCompanyId(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      await feedback.record({
        companyId,
        nodeId: requireParamId(req),
        feedback: req.body.feedback,
        runId: req.body.run_id ?? actor.runId ?? null,
        issueId: req.body.issue_id ?? null,
        agentId: actor.actorType === "agent" ? actor.actorId : null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        comment: req.body.comment ?? null,
      });
      res.status(204).end();
    },
  );

  return router;
}
