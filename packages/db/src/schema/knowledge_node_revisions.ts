import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { knowledgeNodes } from "./knowledge_nodes.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { knowledgeDrafts } from "./knowledge_drafts.js";

/**
 * knowledge_node_revisions 表 —— 节点修改历史快照。
 *
 * 每次 knowledge_nodes UPDATE（title / content / type / level / metadata）
 * 前由应用层 middleware（NodeWriter）自动写一条 revision，存修改前的
 * 完整快照。便于回滚和审计。
 *
 * 不用 PG trigger 是为了减少 DB 端复杂度——middleware 模式更易测试。
 */
export const knowledgeNodeRevisions = pgTable(
  "knowledge_node_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => knowledgeNodes.id, { onDelete: "cascade" }),

    // 修改前的快照
    title: text("title").notNull(),
    content: text("content").notNull(),
    type: text("type").notNull(),
    level: text("level").notNull(),
    metadata: jsonb("metadata").notNull(),

    /** 简短变更摘要（LLM 或人填写） */
    changesetSummary: text("changeset_summary"),

    // 编辑来源
    editorAgentId: uuid("editor_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    editorUserId: text("editor_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    /** 如果是审查通过的修改，记录原始 draft ID */
    draftId: uuid("draft_id").references(() => knowledgeDrafts.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 节点的修改历史时间线 */
    nodeCreatedIdx: index("knowledge_node_revisions_node_idx").on(table.nodeId, table.createdAt),
  }),
);
