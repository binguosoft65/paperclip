-- projects 表添加 color 列和 archived_at 列：项目颜色标识和归档支持
ALTER TABLE "projects" ADD COLUMN "color" text;
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;
