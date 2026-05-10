-- issue_comments 添加 author_type 列：区分 Agent 和用户作者
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "author_type" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "presentation" jsonb;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
