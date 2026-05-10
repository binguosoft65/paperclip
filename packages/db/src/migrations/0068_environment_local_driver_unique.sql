-- environments 表 local 驱动唯一约束优化：确保每公司只有一个 local 环境
DROP INDEX IF EXISTS "environments_company_driver_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver") WHERE "driver" = 'local';
