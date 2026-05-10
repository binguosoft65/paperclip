-- issues 表添加 checkout_run_id 列：追踪 Agent 签出 Issue 的运行记录
ALTER TABLE "issues" ADD COLUMN "checkout_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_checkout_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("checkout_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;