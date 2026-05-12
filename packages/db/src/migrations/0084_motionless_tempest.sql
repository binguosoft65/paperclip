-- ============================================================================
-- LLM-Wiki 知识引擎 — Phase 0 基础设施
-- 见 docs/design/2026-05-12-llm-wiki-knowledge-engine-database.md
-- ============================================================================

-- pgvector 扩展（用于 knowledge_nodes.embedding 1536 维向量 + HNSW 近邻搜索）
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: business_domains —— 业务条线维度（用户可扩展，每公司独立集合）
-- ----------------------------------------------------------------------------
CREATE TABLE "business_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_label" text NOT NULL,
	"description" text,
	"color" text DEFAULT 'neutral' NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_domains_name_format" CHECK ("name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: knowledge_nodes —— 知识原子节点（含 vector(1536) embedding）
-- ----------------------------------------------------------------------------
CREATE TABLE "knowledge_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"type" text NOT NULL,
	"embedding" vector(1536),
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"business_domain_id" uuid NOT NULL,
	"level" text DEFAULT 'project' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"volatility" text DEFAULT 'slow' NOT NULL,
	"valid_until" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"source_url" text,
	"external_version" jsonb,
	"trigger_count" integer DEFAULT 0 NOT NULL,
	"last_triggered" timestamp with time zone,
	"used_for" text[] DEFAULT '{}'::text[] NOT NULL,
	"prevention_score" real DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent" uuid,
	"created_by_user" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_nodes_type_check" CHECK ("type" IN ('concept', 'lesson', 'rule', 'decision', 'fact')),
	CONSTRAINT "knowledge_nodes_level_check" CHECK ("level" IN ('personal', 'project', 'company')),
	CONSTRAINT "knowledge_nodes_status_check" CHECK ("status" IN ('active', 'archived', 'outdated', 'revoked')),
	CONSTRAINT "knowledge_nodes_volatility_check" CHECK ("volatility" IN ('stable', 'slow', 'fast')),
	CONSTRAINT "knowledge_nodes_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "knowledge_nodes_prevention_score_range" CHECK ("prevention_score" >= 0 AND "prevention_score" <= 1),
	CONSTRAINT "knowledge_nodes_content_length" CHECK (length("content") <= 8192)
);
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: knowledge_edges —— 节点间有向关系（一等公民）
-- ----------------------------------------------------------------------------
CREATE TABLE "knowledge_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"edge_type" text NOT NULL,
	"created_by_agent" uuid,
	"created_by_user" text,
	"auto_generated" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_edges_no_self" CHECK ("from_node_id" <> "to_node_id"),
	CONSTRAINT "knowledge_edges_type_check" CHECK ("edge_type" IN ('references', 'supersedes', 'merged_from', 'derived_from', 'conflicts_with', 'promoted_to'))
);
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: knowledge_drafts —— 三路写入的审查队列
-- ----------------------------------------------------------------------------
CREATE TABLE "knowledge_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_node_id" uuid,
	"proposed_title" text NOT NULL,
	"proposed_content" text NOT NULL,
	"proposed_type" text NOT NULL,
	"proposed_level" text NOT NULL,
	"proposed_business_domain_id" uuid NOT NULL,
	"proposed_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_volatility" text,
	"proposed_valid_until" timestamp with time zone,
	"source" text NOT NULL,
	"source_agent_id" uuid,
	"source_run_id" uuid,
	"source_issue_id" uuid,
	"source_user_id" text,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"pre_verdict" text,
	"pre_verdict_reasoning" text,
	"pre_verdict_at" timestamp with time zone,
	"detected_conflicts" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"review_notes" text,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "knowledge_drafts_source_check" CHECK ("source" IN ('agent_self_review', 'failure_signal', 'manual')),
	CONSTRAINT "knowledge_drafts_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'revision_requested')),
	CONSTRAINT "knowledge_drafts_pre_verdict_check" CHECK ("pre_verdict" IS NULL OR "pre_verdict" IN ('recommend_approve', 'recommend_reject', 'needs_human')),
	CONSTRAINT "knowledge_drafts_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "knowledge_drafts_reasoning_length" CHECK ("pre_verdict_reasoning" IS NULL OR length("pre_verdict_reasoning") <= 200)
);
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: knowledge_node_revisions —— 节点修改快照
-- ----------------------------------------------------------------------------
CREATE TABLE "knowledge_node_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"type" text NOT NULL,
	"level" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"changeset_summary" text,
	"editor_agent_id" uuid,
	"editor_user_id" text,
	"draft_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: knowledge_node_events —— 操作时间线（trigger_count 等统计权威源）
-- ----------------------------------------------------------------------------
CREATE TABLE "knowledge_node_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"issue_id" uuid,
	"user_id" text,
	"feedback" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_node_events_type_check" CHECK ("event_type" IN ('created', 'updated', 'triggered', 'feedback', 'verified', 'superseded', 'archived', 'promoted', 'revoked')),
	CONSTRAINT "knowledge_node_events_feedback_check" CHECK ("feedback" IS NULL OR "feedback" IN ('helped', 'outdated', 'wrong', 'irrelevant'))
);
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: knowledge_sources —— 外部源管理（FR11）
-- ----------------------------------------------------------------------------
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"source_type" text DEFAULT 'blog' NOT NULL,
	"collector_name" text DEFAULT 'WebCrawler' NOT NULL,
	"crawl_frequency" text DEFAULT 'weekly' NOT NULL,
	"trust_weight" real DEFAULT 0.5 NOT NULL,
	"last_crawled" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"article_selector" text,
	"sitemap_url" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"crawl_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_type_check" CHECK ("source_type" IN ('blog', 'docs', 'github', 'forum', 'paper', 'rss', 'slack', 'custom')),
	CONSTRAINT "knowledge_sources_frequency_check" CHECK ("crawl_frequency" IN ('daily', 'weekly', 'monthly', 'manual')),
	CONSTRAINT "knowledge_sources_trust_weight_range" CHECK ("trust_weight" >= 0 AND "trust_weight" <= 1)
);
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: knowledge_metrics —— 健康指标缓存（每日自检 Routine 写入）
-- ----------------------------------------------------------------------------
CREATE TABLE "knowledge_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"metric_name" text NOT NULL,
	"metric_value" numeric NOT NULL,
	"status" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "knowledge_metrics_status_check" CHECK ("status" IN ('healthy', 'warning', 'critical'))
);
--> statement-breakpoint

-- ============================================================================
-- Foreign Keys
-- ============================================================================
ALTER TABLE "business_domains" ADD CONSTRAINT "business_domains_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_business_domain_id_business_domains_id_fk" FOREIGN KEY ("business_domain_id") REFERENCES "public"."business_domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_created_by_agent_agents_id_fk" FOREIGN KEY ("created_by_agent") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_created_by_user_user_id_fk" FOREIGN KEY ("created_by_user") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_from_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_to_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_created_by_agent_agents_id_fk" FOREIGN KEY ("created_by_agent") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_created_by_user_user_id_fk" FOREIGN KEY ("created_by_user") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_target_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_proposed_business_domain_id_business_domains_id_fk" FOREIGN KEY ("proposed_business_domain_id") REFERENCES "public"."business_domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_source_user_id_user_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_node_revisions" ADD CONSTRAINT "knowledge_node_revisions_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_revisions" ADD CONSTRAINT "knowledge_node_revisions_editor_agent_id_agents_id_fk" FOREIGN KEY ("editor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_revisions" ADD CONSTRAINT "knowledge_node_revisions_editor_user_id_user_id_fk" FOREIGN KEY ("editor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_revisions" ADD CONSTRAINT "knowledge_node_revisions_draft_id_knowledge_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."knowledge_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_node_events" ADD CONSTRAINT "knowledge_node_events_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_events" ADD CONSTRAINT "knowledge_node_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_events" ADD CONSTRAINT "knowledge_node_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_events" ADD CONSTRAINT "knowledge_node_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_events" ADD CONSTRAINT "knowledge_node_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_metrics" ADD CONSTRAINT "knowledge_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE UNIQUE INDEX "business_domains_company_name_idx" ON "business_domains" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "business_domains_active_idx" ON "business_domains" USING btree ("company_id","sort_order") WHERE archived = false;--> statement-breakpoint

CREATE INDEX "knowledge_nodes_company_domain_status_idx" ON "knowledge_nodes" USING btree ("company_id","business_domain_id","status") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "knowledge_nodes_company_level_status_idx" ON "knowledge_nodes" USING btree ("company_id","level","status") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "knowledge_nodes_used_for_idx" ON "knowledge_nodes" USING gin ("used_for");--> statement-breakpoint
CREATE INDEX "knowledge_nodes_type_status_idx" ON "knowledge_nodes" USING btree ("type","status") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "knowledge_nodes_volatility_verified_idx" ON "knowledge_nodes" USING btree ("volatility","verified_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "knowledge_nodes_valid_until_idx" ON "knowledge_nodes" USING btree ("valid_until") WHERE valid_until IS NOT NULL AND status = 'active';--> statement-breakpoint

-- HNSW 向量索引（pgvector cosine_ops，参数对齐 database 设计 §5.6）
CREATE INDEX "knowledge_nodes_embedding_idx" ON "knowledge_nodes"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);--> statement-breakpoint

CREATE INDEX "knowledge_edges_from_type_idx" ON "knowledge_edges" USING btree ("from_node_id","edge_type");--> statement-breakpoint
CREATE INDEX "knowledge_edges_to_type_idx" ON "knowledge_edges" USING btree ("to_node_id","edge_type");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_edges_unique_directed" ON "knowledge_edges" USING btree ("from_node_id","to_node_id","edge_type");--> statement-breakpoint

CREATE INDEX "knowledge_drafts_company_pending_idx" ON "knowledge_drafts" USING btree ("company_id","status","created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "knowledge_drafts_unscreened_idx" ON "knowledge_drafts" USING btree ("company_id","created_at") WHERE status = 'pending' AND pre_verdict IS NULL;--> statement-breakpoint
CREATE INDEX "knowledge_drafts_source_status_idx" ON "knowledge_drafts" USING btree ("source","status");--> statement-breakpoint

CREATE INDEX "knowledge_node_revisions_node_idx" ON "knowledge_node_revisions" USING btree ("node_id","created_at");--> statement-breakpoint

CREATE INDEX "knowledge_node_events_node_type_idx" ON "knowledge_node_events" USING btree ("node_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_node_events_issue_idx" ON "knowledge_node_events" USING btree ("issue_id") WHERE issue_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_node_events_feedback_idx" ON "knowledge_node_events" USING btree ("event_type","feedback","created_at") WHERE event_type IN ('triggered', 'feedback');--> statement-breakpoint

CREATE UNIQUE INDEX "knowledge_sources_company_name_url_idx" ON "knowledge_sources" USING btree ("company_id","name","url");--> statement-breakpoint

CREATE INDEX "knowledge_metrics_company_metric_idx" ON "knowledge_metrics" USING btree ("company_id","metric_name","computed_at");--> statement-breakpoint

-- ============================================================================
-- business_domains 自动 seed 触发器
-- 每个新 company 创建时自动 INSERT 一行 'general' 业务域作为兜底。
-- ============================================================================
CREATE OR REPLACE FUNCTION seed_default_business_domain()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "business_domains" ("company_id", "name", "display_label", "color", "sort_order")
  VALUES (NEW.id, 'general', '通用', 'neutral', 0)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "companies_after_insert_seed_business_domain"
  AFTER INSERT ON "companies"
  FOR EACH ROW EXECUTE FUNCTION seed_default_business_domain();
--> statement-breakpoint

-- ============================================================================
-- 已有 companies 回填：保证每个现存公司都有 'general' 业务域
-- ============================================================================
INSERT INTO "business_domains" ("company_id", "name", "display_label", "color", "sort_order")
SELECT c.id, 'general', '通用', 'neutral', 0
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "business_domains" bd
  WHERE bd.company_id = c.id AND bd.name = 'general'
);
