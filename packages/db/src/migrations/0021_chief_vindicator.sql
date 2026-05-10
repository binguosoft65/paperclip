-- issues 表添加 assignee_adapter_overrides 列：Agent 适配器级别覆盖配置
ALTER TABLE "issues" ADD COLUMN "assignee_adapter_overrides" jsonb;