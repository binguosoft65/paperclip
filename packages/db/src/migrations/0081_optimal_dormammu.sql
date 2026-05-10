-- issues 表添加 work_mode 列：支持标准/监工/恢复等工作模式
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "work_mode" text DEFAULT 'standard' NOT NULL;