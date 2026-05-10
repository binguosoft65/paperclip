-- routines 表允许 project_id 为空：支持全局例行任务（不绑定项目）
ALTER TABLE "routines" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "routines" ALTER COLUMN "assignee_agent_id" DROP NOT NULL;
