-- 重建 budget_incidents 唯一索引：排除已关闭的违规记录
DROP INDEX "budget_incidents_policy_window_threshold_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "budget_incidents_policy_window_threshold_idx" ON "budget_incidents" USING btree ("policy_id","window_start","threshold_type") WHERE "budget_incidents"."status" <> 'dismissed';