-- heartbeat_runs 添加进程相关列：支持进程 PID 追踪和信号处理
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_pid" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "retry_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_loss_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_retry_of_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;