import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";

/**
 * plugin_logs 表 —— 插件日志存储。
 *
 * 存储插件 Worker 通过 `ctx.logger.info()` 等接口发出的结构化日志。
 * 支持按插件、级别和时间范围查询，用于操作员日志面板和调试。
 * 由宿主进程在处理 Worker 的 `log` 通知时写入。
 * 建议通过定时清理策略限制日志保留时间（如删除 7 天前的日志）。
 *
 * @see PLUGIN_SPEC.md §26 — Observability
 */
export const pluginLogs = pgTable(
  "plugin_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginTimeIdx: index("plugin_logs_plugin_time_idx").on(
      table.pluginId,
      table.createdAt,
    ),
    levelIdx: index("plugin_logs_level_idx").on(table.level),
  }),
);
