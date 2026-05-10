-- 添加健康检查升级 Issue 去重索引：防止同一故障创建多个告警 Issue
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_liveness_recovery_incident_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'harness_liveness_escalation'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_liveness_recovery_leaf_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_fingerprint")
  WHERE "origin_kind" = 'harness_liveness_escalation'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
