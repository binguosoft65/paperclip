-- project_workspaces 允许 cwd 为空：支持无本地目录的工作空间
ALTER TABLE "project_workspaces" ALTER COLUMN "cwd" DROP NOT NULL;