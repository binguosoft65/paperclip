import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, knowledgeMetrics } from "@paperclipai/db";
import { KNOWLEDGE_METRIC_NAMES } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgeHealthcheckService } from "../services/knowledge-healthcheck.ts";

/**
 * 回归测试：runHealthcheck 必须能跑通真实 Postgres。
 *
 * 既有 55 个单测用 fakeDb mock 掉 db，route 测试 mock 掉整个 service，
 * 因此 runHealthcheck 第 505-509 行「查上一次 status」里把 JS Date
 * (`computed_at < ${computedAt}`) 当绑定参数传给 postgres-js 驱动这一路径
 * 从未被任何自动化测试覆盖——线上每次调用 healthcheck/run 都 500
 * (ERR_INVALID_ARG_TYPE: Received an instance of Date)。
 *
 * 本测试注入真实 embedded Postgres 的 db，复现并防回归。
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres knowledge healthcheck tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("knowledgeHealthcheckService.runHealthcheck (real Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // getEmbeddedPostgresTestSupport() 只验证二进制能否启动，检测不到「迁移
  // 需要 vector 扩展但内嵌 PG 二进制没有」的情况（如本 WSL 主机）。此处
  // 兜底捕获启动失败并跳过，保证该回归在 CI / 有 pgvector 的主机上 RED→GREEN，
  // 在缺扩展的主机上干净跳过而非报错。
  let unsupportedReason: string | null = null;
  const companyId = randomUUID();

  beforeAll(async () => {
    try {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-knowledge-healthcheck-");
      db = createDb(tempDb.connectionString);
      // knowledge_metrics.company_id 有外键引用 companies.id，必须先建公司
      await db.insert(companies).values({ id: companyId, name: "Healthcheck Co" });
    } catch (err) {
      unsupportedReason = err instanceof Error ? err.message : String(err);
      console.warn(
        `Skipping knowledge healthcheck real-Postgres test: ${unsupportedReason}`,
      );
    }
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("completes without throwing on the Date-bound previous-status query and writes metric rows", async (ctx) => {
    if (unsupportedReason) ctx.skip();
    const svc = knowledgeHealthcheckService(db);

    // RED: 当前 runHealthcheck 第 509 行把 Date 当绑定参数 → 驱动抛
    // TypeError [ERR_INVALID_ARG_TYPE]: Received an instance of Date
    const result = await svc.runHealthcheck(companyId);

    expect(result.metricsComputed).toBe(KNOWLEDGE_METRIC_NAMES.length);
    expect(result.alarmsCreated).toBe(0); // 未注入 issueSvc，告警跳过

    const rows = await db
      .select({ metricName: knowledgeMetrics.metricName })
      .from(knowledgeMetrics)
      .where(eq(knowledgeMetrics.companyId, companyId));
    expect(rows.length).toBe(KNOWLEDGE_METRIC_NAMES.length);
  });
});
