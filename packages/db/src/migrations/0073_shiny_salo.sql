-- companies 表添加 attachment_max_bytes 列：附件大小上限可配置
ALTER TABLE "companies" ADD COLUMN "attachment_max_bytes" integer DEFAULT 10485760 NOT NULL;
