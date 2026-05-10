import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  AGENT_ADAPTER_TYPES,
  createEnvironmentSchema,
  getEnvironmentCapabilities,
  probeEnvironmentConfigSchema,
  updateEnvironmentSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  issueService,
  logActivity,
  projectService,
} from "../services/index.js";
import {
  normalizeEnvironmentConfigForPersistence,
  normalizeEnvironmentConfigForProbe,
  parseEnvironmentDriverConfig,
  readSshEnvironmentPrivateKeySecretId,
  type ParsedEnvironmentConfig,
} from "../services/environment-config.js";
import { probeEnvironment } from "../services/environment-probe.js";
import { secretService } from "../services/secrets.js";
import { listReadyPluginEnvironmentDrivers } from "../services/plugin-environment-driver.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";

export function environmentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = environmentService(db);
  const executionWorkspaces = executionWorkspaceService(db);
  const issues = issueService(db);
  const projects = projectService(db);
  const secrets = secretService(db);

  // 防御性深拷贝：确保后续 config 合并不会突变原始引用
  function parseObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  // 旧版权限检查：部分 agent 通过 canCreateAgents 标志隐式获得环境管理权限。
  // 新版应走显式 grant，此函数只作为向后兼容的 fallback
  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  // 环境变更权限断言：三层降级——1) board local admin/instance admin 透传；
  // 2) 拥有 environments:manage 显式 grant 的用户；3) 拥有 canCreateAgents 旧权限的 agent
  async function assertCanMutateEnvironments(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "environments:manage");
      if (!allowed) {
        throw forbidden("Missing permission: environments:manage");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "environments:manage");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: environments:manage");
  }

  // 读权限检查（不同于写权限）：board 用户即使没有 manage 权限仍可看到环境列表，
  // 但 config 会被脱敏。agent 必须拥有 environments:manage 才能读取 config
  async function actorCanReadEnvironmentConfigurations(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      return access.canUser(companyId, req.actor.userId, "environments:manage");
    }

    if (!req.actor.agentId) return false;
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "environments:manage");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  // 对无权查看 config 的调用者返回脱敏数据：config 和 metadata 字段置空，
  // 并添加 configRedacted/metadataRedacted 标记以便前端区分"无配置"和"被脱敏"
  function redactEnvironmentForRestrictedView<T extends {
    config: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
  }>(environment: T): T & { configRedacted: true; metadataRedacted: true } {
    return {
      ...environment,
      config: {},
      metadata: null,
      configRedacted: true,
      metadataRedacted: true,
    };
  }

  // 构建环境变更的操作审计摘要，只记录变更字段的元信息（如 config 的顶级 key 数量），
  // 不记录敏感值本身，满足审计合规要求的同时避免暴露凭据
  function summarizeEnvironmentUpdate(
    patch: Record<string, unknown>,
    environment: {
      name: string;
      driver: string;
      status: string;
    },
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      changedFields: Object.keys(patch).sort(),
    };

    if (patch.name !== undefined) details.name = environment.name;
    if (patch.driver !== undefined) details.driver = environment.driver;
    if (patch.status !== undefined) details.status = environment.status;
    if (patch.description !== undefined) details.descriptionChanged = true;
    if (patch.config !== undefined) {
      details.configChanged = true;
      details.configTopLevelKeyCount =
        patch.config && typeof patch.config === "object" && !Array.isArray(patch.config)
          ? Object.keys(patch.config as Record<string, unknown>).length
          : 0;
    }
    if (patch.metadata !== undefined) {
      details.metadataChanged = true;
      details.metadataTopLevelKeyCount =
        patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)
          ? Object.keys(patch.metadata as Record<string, unknown>).length
          : 0;
    }

    return details;
  }

  // 列出公司所有环境。支持按 status/driver 过滤。
  // 无 manage 权限的用户仅能看到脱敏后的环境元信息
  router.get("/companies/:companyId/environments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      driver: req.query.driver as string | undefined,
    });
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, companyId);
    if (canReadConfigs) {
      res.json(rows);
      return;
    }
    res.json(rows.map((environment) => redactEnvironmentForRestrictedView(environment)));
  });

  // 返回当前环境能力的完整清单：所有 adapter 类型对每种 driver/provider 的支持状态，
  // 以及已注册插件沙箱 provider 的 schema 供前端渲染动态表单
  router.get("/companies/:companyId/environments/capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const pluginDrivers = await listReadyPluginEnvironmentDrivers({
      db,
      workerManager: options.pluginWorkerManager,
    });
    res.json(getEnvironmentCapabilities(
      AGENT_ADAPTER_TYPES,
      {
        sandboxProviders: Object.fromEntries(pluginDrivers.map((driver) => [
          driver.driverKey,
          {
            status: "supported" as const,
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: driver.displayName,
            description: driver.description,
            source: "plugin" as const,
            pluginKey: driver.pluginKey,
            pluginId: driver.pluginId,
            configSchema: driver.configSchema,
          },
        ])),
      },
    ));
  });

  // 创建环境。config 经过 normalizeEnvironmentConfigForPersistence 处理，
  // 将明文的 SSH 私钥自动转为 secret_ref 存储，避免凭据以明文落库
  router.post("/companies/:companyId/environments", validate(createEnvironmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanMutateEnvironments(req, companyId);
    const actor = getActorInfo(req);
    const input = {
      ...req.body,
      config: await normalizeEnvironmentConfigForPersistence({
        db,
        companyId,
        environmentName: req.body.name,
        driver: req.body.driver,
        config: req.body.config,
        actor: {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        pluginWorkerManager: options.pluginWorkerManager,
      }),
    };
    const environment = await svc.create(companyId, input);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.created",
      entityType: "environment",
      entityId: environment.id,
      details: {
        name: environment.name,
        driver: environment.driver,
        status: environment.status,
      },
    });
    res.status(201).json(environment);
  });

  // 按 ID 获取单个环境。脱敏规则同列表接口
  router.get("/environments/:id", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCompanyAccess(req, environment.companyId);
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, environment.companyId);
    if (canReadConfigs) {
      res.json(environment);
      return;
    }
    res.json(redactEnvironmentForRestrictedView(environment));
  });

  // 查询环境的所有租约。仅限有 manage 权限的调用者，
  // 因为租约中可能包含 provider 层面的敏感信息（如 providerLeaseId）
  router.get("/environments/:id/leases", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCompanyAccess(req, environment.companyId);
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, environment.companyId);
    if (!canReadConfigs) {
      throw forbidden("Missing permission: environments:manage");
    }
    const leases = await svc.listLeases(environment.id, {
      status: req.query.status as string | undefined,
    });
    res.json(leases);
  });

  // 查询单个租约。同上需要 manage 权限
  router.get("/environment-leases/:leaseId", async (req, res) => {
    const lease = await svc.getLeaseById(req.params.leaseId as string);
    if (!lease) {
      res.status(404).json({ error: "Environment lease not found" });
      return;
    }
    assertCompanyAccess(req, lease.companyId);
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, lease.companyId);
    if (!canReadConfigs) {
      throw forbidden("Missing permission: environments:manage");
    }
    res.json(lease);
  });

  // 更新环境。config 合并策略：
  // - 如果同时更改 driver，config 完全替换为新值（不同 driver 的 schema 不同）
  // - 如果仅更改 config 字段，做深层合并（partial update）
  // - 机密字段（SSH 私钥）自动转为 secret_ref
  router.patch("/environments/:id", validate(updateEnvironmentSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertCanMutateEnvironments(req, existing.companyId);
    const actor = getActorInfo(req);
    const nextDriver = req.body.driver ?? existing.driver;
    const nextName = req.body.name ?? existing.name;
    const configSource =
      req.body.config !== undefined
        ? req.body.driver !== undefined && req.body.driver !== existing.driver
          ? req.body.config
          : {
              ...parseObject(existing.config),
              ...parseObject(req.body.config),
            }
        : req.body.driver !== undefined && req.body.driver !== existing.driver
          ? {}
          : existing.config;
    const patch = {
      ...req.body,
      ...(req.body.config !== undefined || req.body.driver !== undefined
        ? {
            config: await normalizeEnvironmentConfigForPersistence({
              db,
              companyId: existing.companyId,
              environmentName: nextName,
              driver: nextDriver,
              config: configSource,
              actor: {
                agentId: actor.agentId,
                userId: actor.actorType === "user" ? actor.actorId : null,
              },
              pluginWorkerManager: options.pluginWorkerManager,
            }),
          }
        : {}),
    };
    const environment = await svc.update(existing.id, patch);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await logActivity(db, {
      companyId: environment.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.updated",
      entityType: "environment",
      entityId: environment.id,
      details: summarizeEnvironmentUpdate(patch as Record<string, unknown>, environment),
    });
    res.json(environment);
  });

  // 删除环境。级联清理三步：
  // 1) 清除所有执行工作空间对该环境的引用
  // 2) 清除 issue 和 project 的环境选择
  // 3) 如果该环境有 SSH 私钥 secret，一并删除以免残留凭据
  router.delete("/environments/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertCanMutateEnvironments(req, existing.companyId);
    await Promise.all([
      executionWorkspaces.clearEnvironmentSelection(existing.companyId, existing.id),
      issues.clearExecutionWorkspaceEnvironmentSelection(existing.companyId, existing.id),
      projects.clearExecutionWorkspaceEnvironmentSelection(existing.companyId, existing.id),
    ]);
    const removed = await svc.remove(existing.id);
    if (!removed) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    const secretId = readSshEnvironmentPrivateKeySecretId(existing);
    if (secretId) {
      await secrets.remove(secretId);
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.deleted",
      entityType: "environment",
      entityId: removed.id,
      details: {
        name: removed.name,
        driver: removed.driver,
        status: removed.status,
      },
    });
    res.json(removed);
  });

  // 探测已保存环境的连通性（probe）。
  // 用于 SSH 连接测试和沙箱 provider 状态检查
  router.post("/environments/:id/probe", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertCanMutateEnvironments(req, environment.companyId);
    const actor = getActorInfo(req);
    const probe = await probeEnvironment(db, environment, {
      pluginWorkerManager: options.pluginWorkerManager,
    });
    await logActivity(db, {
      companyId: environment.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.probed",
      entityType: "environment",
      entityId: environment.id,
      details: {
        driver: environment.driver,
        ok: probe.ok,
        summary: probe.summary,
      },
    });
    res.json(probe);
  });

  // 探测未保存的环境配置（probe-config），允许用户在保存前测试连接性。
  // 使用 ""unsaved"" 作为虚拟环境 ID，不持久化任何数据
  router.post(
    "/companies/:companyId/environments/probe-config",
    validate(probeEnvironmentConfigSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateEnvironments(req, companyId);
      const actor = getActorInfo(req);
      const normalizedConfig = await normalizeEnvironmentConfigForProbe({
        db,
        driver: req.body.driver,
        config: req.body.config,
        pluginWorkerManager: options.pluginWorkerManager,
      });
      const environment = {
        id: "unsaved",
        companyId,
        name: req.body.name?.trim() || "Unsaved environment",
        description: req.body.description ?? null,
        driver: req.body.driver,
        status: "active" as const,
        config: normalizedConfig,
        metadata: req.body.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const probe = await probeEnvironment(db, environment, {
        pluginWorkerManager: options.pluginWorkerManager,
        resolvedConfig: {
          driver: req.body.driver,
          config: normalizedConfig,
        } as ParsedEnvironmentConfig,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "environment.probed_unsaved",
        entityType: "environment",
        entityId: "unsaved",
        details: {
          driver: environment.driver,
          ok: probe.ok,
          summary: probe.summary,
          configTopLevelKeyCount: Object.keys(environment.config).length,
        },
      });
      res.json(probe);
    },
  );

  return router;
}
