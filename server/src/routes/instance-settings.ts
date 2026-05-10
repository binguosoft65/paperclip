import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  issueGraphLivenessAutoRecoveryRequestSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { heartbeatService, instanceSettingsService, logActivity } from "../services/index.js";
import { assertBoardOrgAccess, getActorInfo } from "./authz.js";

/**
 * 校验当前请求是否有权管理实例设置。
 * 业务规则：仅 board 类型主体可操作实例设置；其中本地隐式信任模式（local_implicit）
 * 或显式标记为 Instance Admin 的用户通过校验，其余 board 主体（如 Agent API Key）拒绝。
 * 这样设计是为了在本地开发环境（local_trusted 模式）下免除额外管理员配置，
 * 同时在正式部署中保证只有显式授权的管理员可修改全局配置。
 */
function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);
  const heartbeat = heartbeatService(db);

  // GET 可读无需管理员权限，因为通用设置（如键盘快捷键开关）是前端展示偏好，
  // 所有已认证的组织成员都应有权限读取；仅写入（PATCH）才需要 Instance Admin 权限。
  router.get("/instance/settings/general", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await svc.getGeneral());
  });

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateGeneral(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.general);
    },
  );

  // 实验性设置同样采用"可读不鉴权、可写鉴权"的策略，兼顾浏览可用性与安全管控。
  router.get("/instance/settings/experimental", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await svc.getExperimental());
  });

  router.patch(
    "/instance/settings/experimental",
    validate(patchInstanceExperimentalSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateExperimental(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      // 实验性设置变更同样需要向所有公司广播审计日志，
      // 因为这些功能（如环境管理、独立工作空间等）会影响所有组织的运行时行为。
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.experimental_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              experimental: updated.experimental,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.experimental);
    },
  );

  // 预览接口不产生实际变更，仅查询指定回看窗口内的问题活性检测结果，
  // 让管理员在开启自动恢复前了解将会影响哪些 Issue。这是一个安全的只读操作。
  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
    validate(issueGraphLivenessAutoRecoveryRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      res.json(await heartbeat.buildIssueGraphLivenessAutoRecoveryPreview({
        lookbackHours: req.body.lookbackHours,
      }));
    },
  );

  // 执行自动恢复会创建升级 Issue（escalation issue），涉及跨公司数据变更。
  // force=true 表示管理员手动触发（而非定时器自动调度），绕过"仅处理未处理"的限制，
  // 允许对已处理过的 Issue 再次执行恢复扫描。
  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
    validate(issueGraphLivenessAutoRecoveryRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const actor = getActorInfo(req);
      const result = await heartbeat.reconcileIssueGraphLiveness({
        runId: actor.runId,
        force: true,
        lookbackHours: req.body.lookbackHours,
      });
      // 自动恢复执行的结果需要向所有公司写入审计日志，包含创建的升级数量、跳过数等，
      // 以便管理员追踪每次自动恢复操作的影响范围。
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.issue_graph_liveness_auto_recovery_run",
            entityType: "instance_settings",
            entityId: "default",
            details: {
              lookbackHours: result.lookbackHours,
              escalationsCreated: result.escalationsCreated,
              existingEscalations: result.existingEscalations,
              skippedOutsideLookback: result.skippedOutsideLookback,
              escalationIssueIds: result.escalationIssueIds,
            },
          }),
        ),
      );
      res.json(result);
    },
  );

  return router;
}
