-- heartbeat_runs 添加 process_group_id 列：支持进程组管理
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_group_id" integer;--> statement-breakpoint
