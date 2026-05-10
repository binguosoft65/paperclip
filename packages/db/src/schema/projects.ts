import { pgTable, uuid, text, timestamp, date, index, jsonb } from "drizzle-orm/pg-core";
import type { AgentEnvConfig } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

/**
 * projects 表 —— 项目定义。
 *
 * 项目是对齐目标和 Issue 的业务容器。每个项目归属于一个公司，
 * 可选关联到一个目标（goal），并指定一名负责 Agent。
 * 项目可以包含执行环境变量（env）和执行工作空间策略。
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    /** backlog=待办, in_progress=进行中, done=完成, archived=归档 */
    status: text("status").notNull().default("backlog"),
    /** 项目负责人 Agent */
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
    /** 项目级环境变量注入 */
    env: jsonb("env").$type<AgentEnvConfig>(),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /** 执行工作空间创建策略（如分支命名规则、清理策略） */
    executionWorkspacePolicy: jsonb("execution_workspace_policy").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("projects_company_idx").on(table.companyId),
  }),
);
