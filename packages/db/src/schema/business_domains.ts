import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * business_domains 表 —— 业务条线维度（FR10，LLM-Wiki 知识引擎）。
 *
 * 每个公司有独立的业务域集合（多租户隔离），用于按业务条线对知识节点
 * 分类。用户可在 Web UI 自由增删改（不是硬编码枚举），新增业务线只
 * INSERT 一行不触发 migration。
 *
 * 公司初始化时自动 seed 一个 'general' 业务域作为兜底，由 SQL trigger
 * 实现（见 0084 migration）。
 *
 * 删除策略：knowledge_nodes 表通过 FK 引用此表（ON DELETE RESTRICT），
 * 因此业务域不能硬删，仅支持归档（archived=true）。
 */
export const businessDomains = pgTable(
  "business_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** slug 风格（小写字母数字+连字符），同公司内唯一。SQL 层有 CHECK 校验。 */
    name: text("name").notNull(),
    /** 人类可读显示名，如 "软件与 AI 工具" */
    displayLabel: text("display_label").notNull(),
    description: text("description"),
    /**
     * UI 配色：存 Tailwind 颜色名（"blue" / "cyan" / "violet" 等 12 种预设），
     * 不存 hex。前端按 statusBadge 模式查表生成完整 class 字符串。
     */
    color: text("color").notNull().default("neutral"),
    /** lucide 图标 key（如 "code" / "pen-tool"），可选 */
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** 软删除标记。归档后从新建/检索下拉隐藏，但已关联节点不动。 */
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 同公司内 name 唯一 */
    companyNameIdx: uniqueIndex("business_domains_company_name_idx").on(
      table.companyId,
      table.name,
    ),
    /** UI 列表查询：按公司 + 排序权重，只返回未归档 */
    activeIdx: index("business_domains_active_idx")
      .on(table.companyId, table.sortOrder)
      .where(sql`archived = false`),
  }),
);
