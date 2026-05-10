import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import { trackGoalCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";

// 注册 Goal（目标）相关的所有 RESTful 路由。
// 遵循 company-scoped 和 direct-id 两种寻址模式：
//   公司级路由 /companies/:companyId/goals 用于在某个公司下操作集合；
//   直接路由 /goals/:id 用于对单条记录操作（由路由中间件通过 id 反查 companyId 做鉴权）。
export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  // 列出该公司下的全部目标，不做分页——目标总数通常较少，前端一次性加载后构建树形结构。
  router.get("/companies/:companyId/goals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  // 查询单个目标的详细信息，用于详情页展示和编辑。
  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);
    res.json(goal);
  });

  // 创建目标：由 validate 中间件校验请求体（createGoalSchema），然后写入 DB。
  // 成功后记录操作日志（谁在何时做了什么事），并上报遥测事件（附带目标层级，用于产品分析）。
  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackGoalCreated(telemetryClient, { goalLevel: goal.level });
    }
    res.status(201).json(goal);
  });

  // 更新目标：支持部分更新（PATCH），只传需要修改的字段。
  // 先查目标是否存在，再校验公司访问权限，然后执行更新并记录操作日志。
  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const goal = await svc.update(id, req.body);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: req.body,
    });

    res.json(goal);
  });

  // 删除目标：硬删除，同时会级联删除 project_goals 中的关联记录（由 DB 外键 ON DELETE CASCADE 保证）。
  // 注意：子目标不会自动跟随删除，需要调用方自行处理层级清理或确认无子目标后再删除。
  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const goal = await svc.remove(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    res.json(goal);
  });

  return router;
}
