import { Router } from "express";
import type { BackupRetentionPolicy, RunDatabaseBackupResult } from "@paperclipai/db";
import { assertInstanceAdmin } from "./authz.js";

// 备份触发来源区分：管理员手动触发 vs. 定时任务自动调度。
// 此标记用于审计和运维排障，区分两种触发方式的来源。
export type InstanceDatabaseBackupTrigger = "manual" | "scheduled";

// 备份执行结果聚合了数据库运行结果、触发方式、文件路径、保留策略及耗时，
// 供前端展示和历史审计使用。durationMs 可用于后续监控告警（过长备份可能表锁或磁盘慢）。
export type InstanceDatabaseBackupRunResult = RunDatabaseBackupResult & {
  trigger: InstanceDatabaseBackupTrigger;
  backupDir: string;
  retention: BackupRetentionPolicy;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type InstanceDatabaseBackupService = {
  runManualBackup(): Promise<InstanceDatabaseBackupRunResult>;
};

export function instanceDatabaseBackupRoutes(service: InstanceDatabaseBackupService) {
  const router = Router();

  // 手动触发数据库备份。返回 201 表示资源已创建（备份文件已写入磁盘）。
  // 操作仅限 Instance Admin，因为备份文件包含所有公司的全量数据。
  router.post("/instance/database-backups", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await service.runManualBackup();
    res.status(201).json(result);
  });

  return router;
}
