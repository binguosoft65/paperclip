-- 添加"滞留 Issue 恢复"去重索引：防止重复创建恢复任务
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_stranded_issue_recovery_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'stranded_issue_recovery'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
