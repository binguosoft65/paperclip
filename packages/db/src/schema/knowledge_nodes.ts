import {
  pgTable,
  uuid,
  text,
  real,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { businessDomains } from "./business_domains.js";

/**
 * pgvector 向量类型自定义封装（Drizzle 无原生 vector 支持）。
 * 维度由参数决定，写入时把 number[] 转为 pgvector 文字格式 "[1,2,3]"。
 * 实际向量索引（HNSW）在 SQL migration 中手动 CREATE INDEX 创建。
 */
const vector = (name: string, dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]) {
      return `[${value.join(",")}]`;
    },
  })(name);

/**
 * knowledge_nodes 表 —— LLM-Wiki 知识引擎的原子节点。
 *
 * 每行是一个独立的知识单元，含 Markdown 正文、向量 embedding、时效性
 * profile 和使用统计。节点间关系（双链、推翻、合并等）由 knowledge_edges
 * 表承载，不内嵌到 content。
 *
 * 类型：concept（概念）/ lesson（教训）/ rule（规则）/ decision（决策）
 * / fact（事实）。MVP 5 种，枚举可扩展（用 text + CHECK 而非 pgEnum
 * 跟项目惯例）。
 *
 * 详细字段语义见 docs/specs/2026-05-12-llm-wiki-knowledge-engine-database.md §4.2。
 */
export const knowledgeNodes = pgTable(
  "knowledge_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // 内容
    title: text("title").notNull(),
    /** Markdown 正文，含 [[node-id]] 互链。SQL 层 CHECK length(content) <= 8192。 */
    content: text("content").notNull(),
    /** 节点类型：concept | lesson | rule | decision | fact */
    type: text("type").notNull(),
    /** 1536 维 embedding（OpenAI text-embedding-3-small） */
    embedding: vector("embedding", 1536),

    // 归属
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** 业务域 FK（ON DELETE RESTRICT，保护关联节点） */
    businessDomainId: uuid("business_domain_id")
      .notNull()
      .references(() => businessDomains.id, { onDelete: "restrict" }),

    // 层级与状态
    /** personal | project | company */
    level: text("level").notNull().default("project"),
    /** active | archived | outdated | revoked */
    status: text("status").notNull().default("active"),

    // 质量元数据
    confidence: real("confidence").notNull().default(0.5),
    verified: boolean("verified").notNull().default(false),

    // 时效性 profile
    /** stable | slow | fast；半衰期 ∞ / 365d / 90d */
    volatility: text("volatility").notNull().default("slow"),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** 外部原文 URL，用于"再去看看" */
    sourceUrl: text("source_url"),
    /** 外部依赖快照，如 {"platform":"douyin","policy_version":"2024-Q3"} */
    externalVersion: jsonb("external_version"),

    // 使用统计（events 表是权威数据，此处为缓存）
    triggerCount: integer("trigger_count").notNull().default(0),
    lastTriggered: timestamp("last_triggered", { withTimezone: true }),
    /** 任务类型标签数组，用于经验推荐检索 */
    usedFor: text("used_for")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Agent 反馈累积的"防住率"，0-1 */
    preventionScore: real("prevention_score").notNull().default(0),

    /** 类型特有字段（lesson 的 symptom/root_cause/next_time 等） */
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),

    // 来源溯源
    createdByAgent: uuid("created_by_agent").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUser: text("created_by_user").references(() => authUsers.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 多租户 + 业务域过滤（最常用查询） */
    companyDomainStatusIdx: index("knowledge_nodes_company_domain_status_idx")
      .on(table.companyId, table.businessDomainId, table.status)
      .where(sql`status = 'active'`),
    /** 层级过滤（按 company / project 隔离检索） */
    companyLevelStatusIdx: index("knowledge_nodes_company_level_status_idx")
      .on(table.companyId, table.level, table.status)
      .where(sql`status = 'active'`),
    /** used_for 数组查询（经验推荐） */
    usedForGinIdx: index("knowledge_nodes_used_for_idx").using("gin", table.usedFor),
    /** 类型过滤 */
    typeStatusIdx: index("knowledge_nodes_type_status_idx")
      .on(table.type, table.status)
      .where(sql`status = 'active'`),
    /** 时效性巡检：找过期节点 */
    volatilityVerifiedIdx: index("knowledge_nodes_volatility_verified_idx")
      .on(table.volatility, table.verifiedAt)
      .where(sql`status = 'active'`),
    /** 显式过期时间扫描 */
    validUntilIdx: index("knowledge_nodes_valid_until_idx")
      .on(table.validUntil)
      .where(sql`valid_until IS NOT NULL AND status = 'active'`),
    // NOTE: HNSW 向量索引在 SQL migration 中手动创建（Drizzle 不能完整描述 HNSW 参数）
  }),
);
