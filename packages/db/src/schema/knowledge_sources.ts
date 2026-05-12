import {
  pgTable,
  uuid,
  text,
  real,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * knowledge_sources 表 —— 外部源管理（FR11）。
 *
 * 配置爬虫 / RSS / GitHub 等外部源，按 crawl_frequency 自动采集内容
 * 入 draft 队列（KnowledgeCollector 接口实现）。
 *
 * source_type（text + CHECK）：blog | docs | github | forum | paper |
 * rss | slack | custom
 *
 * crawl_frequency：daily | weekly | monthly | manual
 *
 * Plugin 系统可注册自定义 collector（如 SlackThreadCollector），
 * collector_name 匹配 KnowledgeCollector.name。
 */
export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    url: text("url").notNull(),
    sourceType: text("source_type").notNull().default("blog"),
    /** 匹配实现 KnowledgeCollector 接口的类名 */
    collectorName: text("collector_name").notNull().default("WebCrawler"),

    // 抓取控制
    crawlFrequency: text("crawl_frequency").notNull().default("weekly"),
    /** 该源可信度权重（0-1），用于影响入 draft 时的 confidence */
    trustWeight: real("trust_weight").notNull().default(0.5),
    lastCrawled: timestamp("last_crawled", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),

    // 内容提取配置
    /** CSS 选择器，可选；空则用 Readability 自动提取 */
    articleSelector: text("article_selector"),
    /** RSS / Atom / sitemap.xml URL */
    sitemapUrl: text("sitemap_url"),

    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** 采集器特有配置（concurrency / request_interval_ms 等） */
    crawlConfig: jsonb("crawl_config").notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 同公司内 (name, url) 唯一，防止重复添加 */
    companyNameUrlIdx: uniqueIndex("knowledge_sources_company_name_url_idx").on(
      table.companyId,
      table.name,
      table.url,
    ),
  }),
);
