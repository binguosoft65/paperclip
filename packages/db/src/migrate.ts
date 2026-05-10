/**
 * migrate.ts —— 数据库迁移 CLI 入口。
 *
 * 从配置文件或环境变量解析数据库连接，
 * 检查迁移状态并自动应用所有待处理的迁移。
 * 可独立运行：node migrate.ts
 */
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();

  console.log(`Migrating database via ${resolved.source}`);

  try {
    const before = await inspectMigrations(resolved.connectionString);
    if (before.status === "upToDate") {
      console.log("No pending migrations");
      return;
    }

    console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
    await applyPendingMigrations(resolved.connectionString);

    const after = await inspectMigrations(resolved.connectionString);
    if (after.status !== "upToDate") {
      throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
    }
    console.log("Migrations complete");
  } finally {
    await resolved.stop();
  }
}

await main();
