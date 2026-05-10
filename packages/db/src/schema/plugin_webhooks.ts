import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";
import type { PluginWebhookDeliveryStatus } from "@paperclipai/shared";

/**
 * plugin_webhook_deliveries 表 —— 插件 Webhook 入站投递历史。
 *
 * 当外部系统向插件的注册 Webhook 端点发送 HTTP POST 时，
 * 服务器在处理前先创建此记录，提供可审计的投递日志。
 *
 * webhook_key 对应插件 manifest 中 `webhooks` 数组的声明键。
 * external_id 由外部系统提供（如 GitHub 投递 GUID），用于去重。
 *
 * 状态说明：
 * - pending：已接收，等待分发到 Worker
 * - processing：Worker 正在处理中
 * - succeeded：Worker 成功处理
 * - failed：Worker 返回错误或超时
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_webhook_deliveries`
 */
export const pluginWebhookDeliveries = pgTable(
  "plugin_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the owning plugin. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** Identifier matching the key in the plugin manifest's `webhooks` array. */
    webhookKey: text("webhook_key").notNull(),
    /** Optional de-duplication ID provided by the external system. */
    externalId: text("external_id"),
    /** Current delivery state. */
    status: text("status").$type<PluginWebhookDeliveryStatus>().notNull().default("pending"),
    /** Wall-clock processing duration in milliseconds. Null until delivery finishes. */
    durationMs: integer("duration_ms"),
    /** Error message if `status === "failed"`. */
    error: text("error"),
    /** Raw JSON body of the inbound HTTP request. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Relevant HTTP headers from the inbound request (e.g. signature headers). */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: index("plugin_webhook_deliveries_plugin_idx").on(table.pluginId),
    statusIdx: index("plugin_webhook_deliveries_status_idx").on(table.status),
    keyIdx: index("plugin_webhook_deliveries_key_idx").on(table.webhookKey),
  }),
);
