import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/** instance_settings 表 —— 实例级全局配置（单行模式，通过 singleton_key 唯一约束保证） */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 单例键，唯一索引保证只有一行是 "default" */
    singletonKey: text("singleton_key").notNull().default("default"),
    /** 通用配置（主题、语言、默认值等），JSONB 类型支持按字段部分更新 */
    general: jsonb("general").$type<Record<string, unknown>>().notNull().default({}),
    /** 实验性功能开关配置，与 general 分离的设计便于区分稳定功能与测试中功能 */
    experimental: jsonb("experimental").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("instance_settings_singleton_key_idx").on(table.singletonKey),
  }),
);
