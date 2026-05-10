import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PluginDatabaseMigrationStatus,
  PluginDatabaseNamespaceMode,
  PluginDatabaseNamespaceStatus,
} from "@paperclipai/shared";
import { plugins } from "./plugins.js";

/**
 * plugin_database_namespaces 表 —— 插件分配的数据库命名空间。
 *
 * 每个安装的插件被分配一个独立的数据库命名空间（PostgreSQL schema），
 * 插件只能在其命名空间内创建和操作数据库对象。
 * 核心业务表对插件只读，通过运行时检查确保安全。
 *
 * namespace_mode 控制命名空间模式：
 * - 'schema'：使用 PostgreSQL schema 隔离
 * - 'prefix'：使用表名前缀隔离
 */
export const pluginDatabaseNamespaces = pgTable(
  "plugin_database_namespaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    namespaceName: text("namespace_name").notNull(),
    namespaceMode: text("namespace_mode").$type<PluginDatabaseNamespaceMode>().notNull().default("schema"),
    status: text("status").$type<PluginDatabaseNamespaceStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: uniqueIndex("plugin_database_namespaces_plugin_idx").on(table.pluginId),
    namespaceIdx: uniqueIndex("plugin_database_namespaces_namespace_idx").on(table.namespaceName),
    statusIdx: index("plugin_database_namespaces_status_idx").on(table.status),
  }),
);

/**
 * plugin_migrations 表 —— 插件迁移记录。
 *
 * 每个迁移文件在应用时记录其校验和（checksum）。
 * 如果已应用的迁移文件内容发生变更，在下次激活时会被拒绝，
 * 从而保证插件数据库迁移的不可变性和可追溯性。
 */
export const pluginMigrations = pgTable(
  "plugin_migrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    namespaceName: text("namespace_name").notNull(),
    migrationKey: text("migration_key").notNull(),
    checksum: text("checksum").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    status: text("status").$type<PluginDatabaseMigrationStatus>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    errorMessage: text("error_message"),
  },
  (table) => ({
    pluginMigrationIdx: uniqueIndex("plugin_migrations_plugin_key_idx").on(
      table.pluginId,
      table.migrationKey,
    ),
    pluginIdx: index("plugin_migrations_plugin_idx").on(table.pluginId),
    statusIdx: index("plugin_migrations_status_idx").on(table.status),
  }),
);
