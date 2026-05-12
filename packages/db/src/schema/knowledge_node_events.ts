import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { knowledgeNodes } from "./knowledge_nodes.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { authUsers } from "./auth.js";

/**
 * knowledge_node_events 表 —— 节点操作时间线。
 *
 * 所有对节点的操作（创建、更新、触发、反馈、验证、归档等）都记一条事件。
 * 是 trigger_count / prevention_score 等统计的权威数据源（knowledge_nodes
 * 表的对应字段是缓存）。
 *
 * 演化引擎和健康自检 Routine 读此表做统计和异常检测。
 *
 * 事件类型（text + CHECK）：
 * created / updated / triggered / feedback / verified / superseded /
 * archived / promoted / revoked
 */
export const knowledgeNodeEvents = pgTable(
  "knowledge_node_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => knowledgeNodes.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),

    // 操作主体
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => authUsers.id, { onDelete: "set null" }),

    /** 反馈值（仅当 event_type='feedback' 时填）: helped | outdated | wrong | irrelevant */
    feedback: text("feedback"),

    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 节点事件时间线 */
    nodeTypeCreatedIdx: index("knowledge_node_events_node_type_idx").on(
      table.nodeId,
      table.eventType,
      table.createdAt,
    ),
    /** 按 Issue 查事件（"本次任务用了什么知识"） */
    issueIdx: index("knowledge_node_events_issue_idx")
      .on(table.issueId)
      .where(sql`issue_id IS NOT NULL`),
    /** helped 比例计算（健康指标） */
    feedbackIdx: index("knowledge_node_events_feedback_idx")
      .on(table.eventType, table.feedback, table.createdAt)
      .where(sql`event_type IN ('triggered', 'feedback')`),
  }),
);
