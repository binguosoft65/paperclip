-- companies 表添加 pause_reason/paused_at 列：公司暂停机制
ALTER TABLE "companies" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "paused_at" timestamp with time zone;
