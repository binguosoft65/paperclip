import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

/**
 * agents 表 —— AI Agent 定义。
 *
 * 每行代表一个独立的 AI Agent 实体。Agent 是 Paperclip 的核心执行单元，
 * 由 adapter（适配器）驱动，可以执行任务、接收心跳、维护运行时状态。
 * Agent 之间存在汇报关系（reports_to），构成树形组织架构。
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    /** 角色分类：general（通用）、ceo、engineer、reviewer 等，决定行为模板 */
    role: text("role").notNull().default("general"),
    /** 展示头衔，如 "首席技术官" */
    title: text("title"),
    /** Agent 图标标识 */
    icon: text("icon"),
    /** idle=空闲, busy=忙碌, paused=暂停, error=错误 */
    status: text("status").notNull().default("idle"),
    /** 上级 Agent ID，形成树形组织架构（如 CEO -> Engineer） */
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    /** 以逗号分隔的能力声明，如 "code_review,deployment" */
    capabilities: text("capabilities"),
    /** 适配器类型：process（本地进程）、docker、remote 等 */
    adapterType: text("adapter_type").notNull().default("process"),
    /** 适配器配置，如进程启动命令、Docker 镜像等 */
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    /** 运行时配置（非持久性，由 adapter 管理） */
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    /** 默认执行环境 ID，Agent 任务默认在此环境运行 */
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    /** Agent 级月度预算上限（美分），覆盖公司级默认值 */
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    /** 本月花费（美分） */
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    /** 暂停原因 */
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /** 细粒度权限控制（JSON 格式） */
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    /** 上次心跳时间戳，用于健康监控 */
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyDefaultEnvironmentIdx: index("agents_company_default_environment_idx").on(table.companyId, table.defaultEnvironmentId),
  }),
);
