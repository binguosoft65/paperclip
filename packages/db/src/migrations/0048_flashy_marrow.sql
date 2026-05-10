-- routines 表添加 variables 列：支持运行时变量注入
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "variables" jsonb DEFAULT '[]'::jsonb NOT NULL;
