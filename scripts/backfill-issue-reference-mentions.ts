// 数据库连接、配置加载、issue 引用服务
import { companies, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { issueReferenceService } from "../server/src/services/issue-references.js";

// 解析命令行 --flag value 参数，避免依赖外部参数解析库
function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  // 优先用环境变量指定数据库地址，其次 config 文件，最后回退到本地嵌入式 Postgres
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const refs = issueReferenceService(db);
  const companyId = parseFlag("--company");
  // 指定 --company 则只处理单个公司，否则全量回填所有公司
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to backfill.");
    return;
  }

  console.log(`Backfilling issue reference mentions for ${companyRows.length} compan${companyRows.length === 1 ? "y" : "ies"}...`);
  // 逐公司遍历，逐个调用 syncAllForCompany 而非批量，避免单个失败影响全部
  for (const company of companyRows) {
    console.log(`- ${company.id}`);
    await refs.syncAllForCompany(company.id);
  }
  console.log("Issue reference backfill complete.");
}

// 顶级异步入口，统一错误处理避免未捕获的 Promise reject 导致静默失败
void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Issue reference backfill failed: ${message}`);
  process.exitCode = 1;
});
