-- projects 表添加 env 列：项目级环境变量注入（Agent 运行时可用）
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "env" jsonb;
