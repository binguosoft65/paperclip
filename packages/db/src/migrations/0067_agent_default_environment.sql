-- agents 表添加 default_environment_id 列：Agent 默认执行环境
ALTER TABLE "agents" ADD COLUMN "default_environment_id" uuid;
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "agents_company_default_environment_idx" ON "agents" USING btree ("company_id","default_environment_id");
