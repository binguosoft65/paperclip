import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

// 仪表盘路由 — 提供公司级聚合数据（Agent、任务、预算、运行活动等）。
// 这是一个只读快照接口，用于仪表盘概览页展示。前端通过轮询刷新。
export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  // GET /companies/:companyId/dashboard — 返回该公司的仪表盘聚合摘要。
  // 调用者必须有该公司的访问权限（assertCompanyAccess）。
  // 聚合包含：Agent 状态计数、任务统计、月度费用、运行活动时间序列、审批和预算概览。
  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  return router;
}
