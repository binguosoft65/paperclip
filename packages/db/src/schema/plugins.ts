import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PluginCategory, PluginStatus, PaperclipPluginManifestV1 } from "@paperclipai/shared";

/**
 * plugins 表 —— 插件注册表。每个安装的插件对应一行。
 *
 * 插件通过 plugin_key 唯一标识（从 manifest id 派生）。
 * 完整的 manifest 以 JSONB 格式持久化在 manifest_json 中，
 * 宿主无需加载插件包即可重建其能力和 UI 插槽信息。
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginKey: text("plugin_key").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    apiVersion: integer("api_version").notNull().default(1),
    categories: jsonb("categories").$type<PluginCategory[]>().notNull().default([]),
    manifestJson: jsonb("manifest_json").$type<PaperclipPluginManifestV1>().notNull(),
    status: text("status").$type<PluginStatus>().notNull().default("installed"),
    installOrder: integer("install_order"),
    /** Resolved package path for local-path installs; used to find worker entrypoint. */
    packagePath: text("package_path"),
    lastError: text("last_error"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginKeyIdx: uniqueIndex("plugins_plugin_key_idx").on(table.pluginKey),
    statusIdx: index("plugins_status_idx").on(table.status),
  }),
);
