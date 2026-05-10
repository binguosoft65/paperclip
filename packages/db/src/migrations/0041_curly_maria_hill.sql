-- instance_settings 表添加 general 列：扩展实例配置能力
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "general" jsonb DEFAULT '{}'::jsonb NOT NULL;
