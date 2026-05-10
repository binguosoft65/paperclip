-- issues 表添加 execution_workspace_settings 列：执行工作空间高级配置
ALTER TABLE "issues" ADD COLUMN "execution_workspace_settings" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "execution_workspace_policy" jsonb;