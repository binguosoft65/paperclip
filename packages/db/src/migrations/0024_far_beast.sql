-- 添加 Issue 评论查询索引：优化公司+Issue+时间维度的评论查询
CREATE INDEX "issue_comments_company_issue_created_at_idx" ON "issue_comments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_comments_company_author_issue_created_at_idx" ON "issue_comments" USING btree ("company_id","author_user_id","issue_id","created_at");