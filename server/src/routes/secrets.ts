import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";

export function secretRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  // 从环境变量读取默认 Provider，不合法则回退到本地加密。
  // 选择 "local_encrypted" 作为兜底是因为它零配置启动，适合开发和自托管场景。
  const configuredDefaultProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  // 列出当前部署支持的所有 Provider 描述信息（如 local_encrypted、aws_secrets_manager），
  // 供前端创建密钥时选择。结果不包含任何敏感配置，仅包含元数据。
  router.get("/companies/:companyId/secret-providers", (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(svc.listProviders());
  });

  // 查询公司下所有密钥列表。按创建时间倒序排列，最近的排最前。
  // 返回值不包含实际的密钥明文——明文只在运行时解析，不通过列表接口返回。
  router.get("/companies/:companyId/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const secrets = await svc.list(companyId);
    res.json(secrets);
  });

  // 创建新密钥。如果请求未指定 provider，使用部署级别的默认值。
  // 创建操作会同时写入 company_secrets 和 company_secret_versions 表（原子事务），
  // 确保密钥元数据和第一版本的数据在同一个事务内持久化。
  // 操作成功后记录审计日志，审计内容包括密钥名称和 Provider 信息，但不包括密文。
  router.post("/companies/:companyId/secrets", validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        provider: req.body.provider ?? defaultProvider,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
  });

  // 轮换（更新）密钥。先查询密钥是否存在并校验所属公司权限，
  // 然后递增版本号写入新版本数据。审计日志记录轮换后的版本号。
  // 轮换不删除旧版本——旧版本数据保留以支持回滚或延后消费切换。
  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    res.json(rotated);
  });

  // 更新密钥元数据（名称、描述、外部引用），不涉及密钥值本身。
  // 名称重命名时检查公司内是否已存在同名密钥，避免冲突。
  // 审计日志仅记录更新后的名称，不记录任何值信息。
  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const updated = await svc.update(id, {
      name: req.body.name,
      description: req.body.description,
      externalRef: req.body.externalRef,
    });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  // 删除密钥。仅删除 metadata 行（company_secrets），
  // version 行通过外键级联删除由数据库层面处理。
  // 返回 { ok: true } 而非被删除对象，避免无意中泄露敏感信息。
  // 注意：删除后已有绑定关系的运行时将在下次解析时失败。
  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  return router;
}
