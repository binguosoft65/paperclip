import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { assets } from "./assets.js";

/**
 * company_logos 表 —— 公司 Logo 关联。
 *
 * 每个公司最多有一个 Logo，通过 assets 表存储实际图片文件。
 */
export const companyLogos = pgTable(
  "company_logos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_logos_company_uq").on(table.companyId),
    assetUq: uniqueIndex("company_logos_asset_uq").on(table.assetId),
  }),
);
