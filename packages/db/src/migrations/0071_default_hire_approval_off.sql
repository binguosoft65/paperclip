-- 默认关闭新 Agent 入职审批：简化公司初始化流程
ALTER TABLE "companies" ALTER COLUMN "require_board_approval_for_new_agents" SET DEFAULT false;
