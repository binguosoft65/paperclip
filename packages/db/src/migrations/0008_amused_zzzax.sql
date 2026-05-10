-- issues 表添加 hidden_at 列：支持软删除 Issue
ALTER TABLE "issues" ADD COLUMN "hidden_at" timestamp with time zone;