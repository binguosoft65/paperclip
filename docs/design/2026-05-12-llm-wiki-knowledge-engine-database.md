# Paperclip × LLM-Wiki 知识引擎 — 数据库设计文档

**版本**: v2.0（DB-first）
**日期**: 2026-05-12
**数据库**: PostgreSQL 16 + pgvector 0.7+
**ORM**: Drizzle ORM (TypeScript)
**关联文档**: [PRD](../prd/2026-05-12-llm-wiki-knowledge-engine-prd.md) · [架构详设](./2026-05-12-llm-wiki-knowledge-engine-architecture.md) · [API 设计](./2026-05-12-llm-wiki-knowledge-engine-api.md) · [UI 设计](./2026-05-12-llm-wiki-knowledge-engine-ui.md)

---

## 目录

1. [设计原则](#1-设计原则)
2. [ER 图](#2-er-图)
3. [枚举类型](#3-枚举类型)
4. [表定义](#4-表定义)
5. [索引策略](#5-索引策略)
6. [典型查询模式](#6-典型查询模式)
7. [迁移方案](#7-迁移方案)
8. [性能基准](#8-性能基准)
9. [安全与备份](#9-安全与备份)
10. [Drizzle ORM Schema](#10-drizzle-orm-schema)
11. [pgvector 封装](#11-pgvector-封装)

---

## 1. 设计原则

### 1.1 存储分工

| 存储 | 内容 | 原因 |
|------|------|------|
| PostgreSQL（节点表） | 节点正文 + 元数据 + 向量 | 单一真实源，无文件系统同步 |
| pgvector HNSW 索引 | 向量近邻搜索 | 语义检索 |
| PostgreSQL（边表） | 节点关系一等公民 | 双链 / 反向引用 / 演化轨迹可查 |
| PostgreSQL（事件表） | 操作时间线 | 触发计数权威数据 + 自检 |

**核心原则**：知识就是 PG 行；备份 = pg_dump；版本历史 = revisions 表；事件 = events 表。不依赖任何文件系统。

### 1.2 命名规范

- 表名：`snake_case`，复数（`knowledge_nodes` 不是 `knowledge_node`）
- 列名：`snake_case`，不缩写（`business_domain_id` 不是 `bd_id`）
- 索引名：`{table}_{column(s)}_idx`
- 时间戳：一律 `TIMESTAMPTZ`（带时区）
- 外键删除策略：默认 `ON DELETE CASCADE`（公司删除清空所有数据）；business_domains 用 `ON DELETE RESTRICT`（不允许硬删）

### 1.3 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 节点正文存储 | TEXT in PG | 单一真实源，零文件 I/O |
| 节点类型 | pgEnum (5 值) | 类型有限且演化慢，枚举安全 |
| 业务域 | 独立表 + FK | 用户可扩展，每公司独立集合 |
| 边 | 一等公民独立表 | 双链 / 反向 / 演化关系都需要查询 |
| 修改历史 | revisions 表全快照 | 简单可靠，存储略大但查询直接 |
| 操作时间线 | events 表 | trigger_count 是缓存，权威数据在 events |
| 健康指标 | metrics 缓存表 | 每日自检后缓存，Dashboard 不现算 |
| 向量索引 | HNSW（m=16, ef_construction=200） | 百万级以下性能最优 |
| Embedding 维度 | 1536（text-embedding-3-small） | 性价比；后续可换模型 |

### 1.4 多租户隔离

- 几乎所有业务表都带 `company_id` 列且必有索引
- 所有查询强制 `WHERE company_id = $current_company`
- 边表通过 `from_node_id` / `to_node_id` 间接受 company 隔离
- 不引入 PostgreSQL Row-Level Security（暂时由应用层强制；后续可考虑）

---

## 2. ER 图

```
                      ┌────────────────┐
                      │   companies    │ (Paperclip 现有表)
                      └────────┬───────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ business_domains │  │ knowledge_drafts │  │ knowledge_sources│
├──────────────────┤  ├──────────────────┤  ├──────────────────┤
│ id (PK)          │  │ id (PK)          │  │ id (PK)          │
│ company_id (FK)  │  │ target_node_id   │  │ company_id (FK)  │
│ name (UQ/co)     │  │ proposed_*       │  │ name             │
│ display_label    │  │ source           │  │ url              │
│ color / icon     │  │ source_*_id      │  │ source_type      │
│ sort_order       │  │ confidence       │  │ collector_name   │
│ archived         │  │ status           │  │ crawl_frequency  │
└─────────┬────────┘  │ pre_verdict      │  │ trust_weight     │
          │           │ pre_verdict_*    │  │ ...              │
          │           │ reviewed_by      │  └──────────────────┘
          │ FK        │ company_id (FK)  │
          ▼           └────────┬─────────┘
┌──────────────────┐           │
│ knowledge_nodes  │ ←─────────┘ (target_node_id, optional)
├──────────────────┤
│ id (PK)          │
│ title / content  │
│ type / status    │ ←─── revisions / events 都引用 node_id
│ level            │
│ business_domain_id (FK RESTRICT)
│ company_id (FK)  │
│ project_id (FK)  │
│ embedding        │
│ confidence       │
│ verified         │
│ volatility       │
│ valid_until      │
│ verified_at      │
│ source_url       │
│ external_version │
│ trigger_count    │
│ used_for[]       │
│ prevention_score │
│ metadata (JSONB) │
│ ...              │
└─────────┬────────┘
          │
          ├───────────────┬──────────────────┬─────────────────┐
          │               │                  │                 │
          ▼               ▼                  ▼                 ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│ knowledge_edges  │  │ knowledge_   │  │ knowledge_   │  │ knowledge_metrics│
├──────────────────┤  │ node_        │  │ node_events  │  ├──────────────────┤
│ id (PK)          │  │ revisions    │  ├──────────────┤  │ id (PK)          │
│ from_node_id     │  ├──────────────┤  │ id (PK)      │  │ company_id (FK)  │
│ to_node_id       │  │ id (PK)      │  │ node_id (FK) │  │ metric_name      │
│ edge_type        │  │ node_id (FK) │  │ event_type   │  │ metric_value     │
│ auto_generated   │  │ title/content│  │ agent_id     │  │ status           │
│ created_by_*     │  │ type/level   │  │ run_id       │  │ computed_at      │
│ metadata         │  │ metadata     │  │ issue_id     │  │ details (JSONB)  │
└──────────────────┘  │ editor_*     │  │ user_id      │  └──────────────────┘
                      │ draft_id (FK)│  │ feedback     │
                      └──────────────┘  │ metadata     │
                                        └──────────────┘
```

---

## 3. 枚举类型

```sql
CREATE TYPE knowledge_node_type AS ENUM (
  'concept',   -- 抽象概念
  'lesson',    -- 教训（症状/根因/下次怎么做）
  'rule',      -- 强制规则
  'decision',  -- 决策记录
  'fact'       -- 事实陈述
);

CREATE TYPE knowledge_level AS ENUM (
  'personal',  -- 个人级，仅创建者可见
  'project',   -- 项目级，项目成员 + Agent 可见
  'company'    -- 公司级，全员可见
);

CREATE TYPE knowledge_status AS ENUM (
  'active',     -- 正常使用
  'archived',   -- 长期未触发，搜索池排除
  'outdated',   -- 已过期但保留作历史
  'revoked'    -- 完全错误/已删除
);

CREATE TYPE knowledge_volatility AS ENUM (
  'stable',  -- 不变（数学/算法）
  'slow',    -- 缓慢（流程/选型）— 半衰期 365 天
  'fast'     -- 频繁（平台规则/API）— 半衰期 90 天
);

-- NOTE: business_domain 不用枚举，改用独立表 business_domains（见 §4.1）以支持用户扩展

CREATE TYPE knowledge_edge_type AS ENUM (
  'references',      -- 一般引用，[[wikilink]] 自动产生
  'supersedes',      -- 新节点推翻旧节点
  'merged_from',     -- 新节点合并自多个旧节点
  'derived_from',    -- lesson → rule 升级派生
  'conflicts_with',  -- 冲突，待人审裁决
  'promoted_to'      -- 层级提升记录
);

CREATE TYPE knowledge_draft_source AS ENUM (
  'agent_self_review',  -- Agent 任务收尾自评
  'failure_signal',     -- 失败信号自动提取
  'manual'              -- 人工或显式 API
);

CREATE TYPE knowledge_draft_status AS ENUM (
  'pending',              -- 待审
  'approved',             -- 已通过
  'rejected',             -- 已驳回
  'revision_requested'   -- 已要求修改
);

CREATE TYPE knowledge_event_type AS ENUM (
  'created', 'updated', 'triggered', 'feedback',
  'verified', 'superseded', 'archived', 'promoted', 'revoked'
);

CREATE TYPE knowledge_pre_verdict AS ENUM (
  'recommend_approve',
  'recommend_reject',
  'needs_human'
);
```

合计 **9 个枚举**。

---

## 4. 表定义

### 4.1 `business_domains` — 业务域（用户可扩展）

```sql
CREATE TABLE business_domains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- 标识
  name            TEXT NOT NULL,                          -- slug 风格：小写、字母数字、连字符；同公司唯一
  display_label   TEXT NOT NULL,                          -- 人类可读，如 "软件与 AI 工具"
  description     TEXT,

  -- UI 配色
  color           TEXT NOT NULL DEFAULT '#6B7280',        -- hex 格式
  icon            TEXT,                                   -- lucide 图标 key

  -- 排序与状态
  sort_order      INTEGER NOT NULL DEFAULT 0,
  archived        BOOLEAN NOT NULL DEFAULT false,

  -- 时间戳
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 约束：name 在公司内唯一
  CONSTRAINT business_domains_name_format
    CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$')              -- slug 校验
);

CREATE UNIQUE INDEX business_domains_company_name_idx
  ON business_domains (company_id, name);

CREATE INDEX business_domains_active_idx
  ON business_domains (company_id, sort_order)
  WHERE archived = false;
```

**列设计说明**：

| 列 | 设计 |
|----|------|
| `name` | slug 风格（如 `software` / `ai-education`），用于 API 参数和 URL；同公司内唯一 |
| `display_label` | 中英文均可，用于 UI 显示 |
| `color` | hex 字符串，UI 自由选取，默认中性灰 `#6B7280` |
| `archived` | 软删标记，archived 项从新建下拉里隐藏，但已关联节点不受影响 |
| 删除策略 | ON DELETE RESTRICT（节点 FK 引用此表，禁止硬删；删除走 archived 软删） |

**初始化 seed**：

每个新 company 创建时自动 INSERT 一条 `general` 业务域（兜底，保证节点必有归属）：

```sql
-- 由 Paperclip company 创建钩子触发，伪代码：
INSERT INTO business_domains (company_id, name, display_label, color, sort_order)
VALUES ($new_company_id, 'general', '通用', '#6B7280', 0);
```

缤果场景可选 seed 当前 5 条业务作为示例（`software` / `content` / `distribution` / `community` + `general`），但这是初始化策略，不是 schema 约束。

---

### 4.2 `knowledge_nodes` — 节点本体

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 内容
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,                          -- Markdown，含 [[node-id]] 互链
  type            knowledge_node_type NOT NULL,
  embedding       vector(1536),                           -- text-embedding-3-small

  -- 归属
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,

  -- 业务域（FK 到 business_domains，ON DELETE RESTRICT 保护）
  business_domain_id UUID NOT NULL
                    REFERENCES business_domains(id) ON DELETE RESTRICT,

  -- 层级与状态
  level           knowledge_level NOT NULL DEFAULT 'project',
  status          knowledge_status NOT NULL DEFAULT 'active',

  -- 质量
  confidence      REAL NOT NULL DEFAULT 0.5
                    CHECK (confidence >= 0 AND confidence <= 1),
  verified        BOOLEAN NOT NULL DEFAULT false,

  -- 时效性 profile
  volatility      knowledge_volatility NOT NULL DEFAULT 'slow',
  valid_until     TIMESTAMPTZ,
  verified_at     TIMESTAMPTZ,
  source_url      TEXT,
  external_version JSONB,                                 -- 如 {"platform":"douyin","policy_version":"2024-Q3"}

  -- 使用统计（events 是权威数据，此处为缓存）
  trigger_count   INTEGER NOT NULL DEFAULT 0,
  last_triggered  TIMESTAMPTZ,
  used_for        TEXT[] NOT NULL DEFAULT '{}',
  prevention_score REAL NOT NULL DEFAULT 0.0
                    CHECK (prevention_score >= 0 AND prevention_score <= 1),

  -- 类型特有字段（按 type 不同携带不同 JSON 结构）
  metadata        JSONB NOT NULL DEFAULT '{}',

  -- 来源
  created_by_agent UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user  UUID REFERENCES users(id) ON DELETE SET NULL,

  -- 时间戳
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 内容长度软约束（强约束写在 Zod 校验层，此处仅 sanity check）
  CONSTRAINT knowledge_nodes_content_length
    CHECK (length(content) <= 8192)
);
```

**`metadata` JSONB 按 type 携带不同字段**（写入前 Zod 校验，详见功能设计文档 §3.1）：

```jsonc
// type=lesson
{ "symptom": "...", "root_cause": "...", "next_time": "..." }

// type=rule
{ "enforcement": "soft" | "hard", "applies_when": "..." }

// type=decision
{
  "options_considered": [{ "name": "X", "tradeoffs": "..." }, ...],
  "chosen": "X",
  "rationale": "..."
}

// type=fact
{ "subject": "...", "predicate": "...", "object": "..." }

// type=concept
{ "definition": "...", "examples": [...] }

// 模式涌现产生的 concept：额外携带 is_pattern + 派生 lesson 列表
{ "definition": "...", "is_pattern": true, "derived_from_lessons": ["uuid1", "uuid2", ...] }
```

---

### 4.3 `knowledge_edges` — 节点关系（一等公民）

```sql
CREATE TABLE knowledge_edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  from_node_id    UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  to_node_id      UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  edge_type       knowledge_edge_type NOT NULL,

  -- 来源
  created_by_agent UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user  UUID REFERENCES users(id) ON DELETE SET NULL,
  auto_generated  BOOLEAN NOT NULL DEFAULT false,         -- true：来自 [[node-id]] 自动解析

  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 自指禁止
  CONSTRAINT knowledge_edges_no_self
    CHECK (from_node_id <> to_node_id),

  -- 同方向同类型边唯一
  CONSTRAINT knowledge_edges_unique_directed
    UNIQUE (from_node_id, to_node_id, edge_type)
);
```

**约束说明**：

- 自指禁止（A→A 无意义）
- (from, to, edge_type) UNIQUE — 同方向同类型只能一条
- 不同类型可共存：A→B 同时 `references` 和 `supersedes` 合法（前者实际被后者淘汰）
- `auto_generated` 区分 `[[wikilink]]` 自动生成 vs 显式 API 加边，便于 UI 标识

---

### 4.4 `knowledge_drafts` — 审查队列

```sql
CREATE TABLE knowledge_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 目标：新建时 NULL，修改时指向已有节点
  target_node_id  UUID REFERENCES knowledge_nodes(id) ON DELETE CASCADE,

  -- 提议内容
  proposed_title    TEXT NOT NULL,
  proposed_content  TEXT NOT NULL,
  proposed_type     knowledge_node_type NOT NULL,
  proposed_level    knowledge_level NOT NULL,
  proposed_business_domain_id UUID NOT NULL
                    REFERENCES business_domains(id) ON DELETE RESTRICT,
  proposed_metadata JSONB NOT NULL DEFAULT '{}',
  proposed_volatility knowledge_volatility,
  proposed_valid_until TIMESTAMPTZ,

  -- 来源
  source          knowledge_draft_source NOT NULL,
  source_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  source_run_id   UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  source_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  source_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,

  confidence      REAL NOT NULL DEFAULT 0.5
                    CHECK (confidence >= 0 AND confidence <= 1),

  -- Reviewer Agent 初筛结果（FR4 梯度审查）
  pre_verdict     knowledge_pre_verdict,
  pre_verdict_reasoning TEXT,                             -- ≤ 200 字
  pre_verdict_at  TIMESTAMPTZ,
  detected_conflicts UUID[] NOT NULL DEFAULT '{}',        -- Reviewer 检测到的冲突节点 ID

  -- 审查
  status          knowledge_draft_status NOT NULL DEFAULT 'pending',
  reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  review_notes    TEXT,

  -- 归属
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- 时间戳
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ
);
```

---

### 4.5 `knowledge_node_revisions` — 修改历史

每次 `knowledge_nodes` UPDATE 前自动写一条 revision（应用层 middleware 实现，避免 PG trigger 复杂性）。

```sql
CREATE TABLE knowledge_node_revisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,

  -- 快照（修改前的状态）
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  type            knowledge_node_type NOT NULL,
  level           knowledge_level NOT NULL,
  metadata        JSONB NOT NULL,

  -- 变更描述
  changeset_summary TEXT,                                 -- 由 LLM 或人填的简短摘要

  -- 来源
  editor_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  editor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  draft_id        UUID REFERENCES knowledge_drafts(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 4.6 `knowledge_node_events` — 事件时间线

所有节点操作（包括只读触发）都记录一条。**演化引擎和健康自检读此表做统计**（trigger_count 是缓存，权威数据在此）。

```sql
CREATE TABLE knowledge_node_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  event_type      knowledge_event_type NOT NULL,

  -- 操作主体
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  run_id          UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  issue_id        UUID REFERENCES issues(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,

  -- 反馈值（仅当 event_type='feedback' 时填写）
  feedback        TEXT,                                   -- 'helped' | 'outdated' | 'wrong' | 'irrelevant'

  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 4.7 `knowledge_sources` — 外部源管理

```sql
CREATE TABLE knowledge_sources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- 标识
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'blog'
                    CHECK (source_type IN ('blog','docs','github','forum','paper','rss','slack','custom')),
  collector_name    TEXT NOT NULL DEFAULT 'WebCrawler',   -- 匹配 KnowledgeCollector.name

  -- 抓取控制
  crawl_frequency   TEXT NOT NULL DEFAULT 'weekly'
                    CHECK (crawl_frequency IN ('daily','weekly','monthly','manual')),
  trust_weight      REAL NOT NULL DEFAULT 0.5
                    CHECK (trust_weight >= 0 AND trust_weight <= 1),
  last_crawled      TIMESTAMPTZ,
  enabled           BOOLEAN NOT NULL DEFAULT true,

  -- 内容提取配置
  article_selector  TEXT,                                 -- CSS 选择器
  sitemap_url       TEXT,                                 -- RSS / Atom / sitemap.xml

  -- 分类与扩展配置
  tags              TEXT[] NOT NULL DEFAULT '{}',
  crawl_config      JSONB NOT NULL DEFAULT '{}',          -- 采集器特有配置

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX knowledge_sources_company_name_url_idx
  ON knowledge_sources (company_id, name, url);
```

`crawl_config` 示例：

```jsonc
{
  "concurrency": 1,
  "request_interval_ms": 5000,
  "max_pages_per_crawl": 20,
  "follow_external_links": false,
  "custom_headers": { "Accept-Language": "zh-CN" }
}
```

---

### 4.8 `knowledge_metrics` — 健康指标缓存

每日自检 Routine 计算后写入，Dashboard 读此表。

```sql
CREATE TABLE knowledge_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  metric_name     TEXT NOT NULL,                          -- 见 §7.5 六个指标
  metric_value    NUMERIC NOT NULL,
  status          TEXT NOT NULL                           -- 'healthy' | 'warning' | 'critical'
                  CHECK (status IN ('healthy', 'warning', 'critical')),

  computed_at     TIMESTAMPTZ NOT NULL,
  details         JSONB NOT NULL DEFAULT '{}'             -- 计算明细，便于 Dashboard 下钻
);

CREATE INDEX knowledge_metrics_company_metric_idx
  ON knowledge_metrics (company_id, metric_name, computed_at DESC);
```

**metric_name 枚举**（应用层校验，不入 DB 枚举以方便后续扩展）：

| metric_name | 计算口径 |
|-------------|---------|
| `weekly_new_drafts` | 过去 7 天新增 draft 数 |
| `review_backlog_hours_p50` | 当前 pending draft 等待时长的中位数（小时） |
| `helped_ratio` | 过去 30 天 events.feedback='helped' / events.event_type='triggered' 比例 |
| `avg_edges_per_node` | active 节点的平均出边数 |
| `unresolved_conflicts` | conflicts_with 边数 - 已解决数（解决标志为对应节点之一变 archived/revoked） |
| `stale_unchecked_fast` | volatility='fast' 且 verified_at < now - 90d 的节点数 |

---

## 5. 索引策略

### 5.1 节点表索引

```sql
-- HNSW 向量索引（最重要）
CREATE INDEX knowledge_nodes_embedding_idx ON knowledge_nodes
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 多租户 + 业务域过滤（最常用查询模式）
CREATE INDEX knowledge_nodes_company_domain_status_idx
  ON knowledge_nodes (company_id, business_domain_id, status)
  WHERE status = 'active';

-- 层级过滤
CREATE INDEX knowledge_nodes_company_level_status_idx
  ON knowledge_nodes (company_id, level, status)
  WHERE status = 'active';

-- used_for 标签查询（经验推荐）
CREATE INDEX knowledge_nodes_used_for_idx ON knowledge_nodes USING gin (used_for);

-- 类型过滤
CREATE INDEX knowledge_nodes_type_status_idx
  ON knowledge_nodes (type, status)
  WHERE status = 'active';

-- 时效性巡检（找过期节点）
CREATE INDEX knowledge_nodes_volatility_verified_idx
  ON knowledge_nodes (volatility, verified_at)
  WHERE status = 'active';

-- 显式过期时间扫描
CREATE INDEX knowledge_nodes_valid_until_idx
  ON knowledge_nodes (valid_until)
  WHERE valid_until IS NOT NULL AND status = 'active';
```

### 5.2 边表索引

```sql
-- 正向遍历（"我引用了谁"）
CREATE INDEX knowledge_edges_from_type_idx
  ON knowledge_edges (from_node_id, edge_type);

-- 反向遍历（"谁引用了我"）
CREATE INDEX knowledge_edges_to_type_idx
  ON knowledge_edges (to_node_id, edge_type);

-- 冲突类边专用（演化引擎用）
CREATE INDEX knowledge_edges_conflicts_idx
  ON knowledge_edges (from_node_id, to_node_id)
  WHERE edge_type = 'conflicts_with';
```

### 5.3 草稿表索引

```sql
-- 审查队列主索引（按公司过滤待审）
CREATE INDEX knowledge_drafts_company_pending_idx
  ON knowledge_drafts (company_id, status, created_at)
  WHERE status = 'pending';

-- Reviewer Agent 初筛索引（找尚未 pre_verdict 的 pending）
CREATE INDEX knowledge_drafts_unscreened_idx
  ON knowledge_drafts (company_id, created_at)
  WHERE status = 'pending' AND pre_verdict IS NULL;

-- 按来源过滤
CREATE INDEX knowledge_drafts_source_status_idx
  ON knowledge_drafts (source, status);
```

### 5.4 历史/事件表索引

```sql
-- 节点的修改历史时间线
CREATE INDEX knowledge_node_revisions_node_idx
  ON knowledge_node_revisions (node_id, created_at DESC);

-- 节点的事件时间线
CREATE INDEX knowledge_node_events_node_type_idx
  ON knowledge_node_events (node_id, event_type, created_at DESC);

-- 按 Issue 关联查事件（便于 Dashboard "本次任务用了什么知识"）
CREATE INDEX knowledge_node_events_issue_idx
  ON knowledge_node_events (issue_id)
  WHERE issue_id IS NOT NULL;

-- helped 比例计算（健康指标）
CREATE INDEX knowledge_node_events_feedback_idx
  ON knowledge_node_events (event_type, feedback, created_at)
  WHERE event_type IN ('triggered', 'feedback');
```

### 5.5 外部源 / 指标表索引

```sql
-- 按频率检查启用源
CREATE INDEX knowledge_sources_enabled_freq_idx
  ON knowledge_sources (company_id, crawl_frequency, last_crawled)
  WHERE enabled = true;

-- 健康指标按 metric 查最新值
CREATE INDEX knowledge_metrics_latest_idx
  ON knowledge_metrics (company_id, metric_name, computed_at DESC);
```

### 5.6 HNSW 参数说明

| 参数 | 值 | 含义 |
|------|----|------|
| `m` | 16 | 每节点最大连接数。默认值，适合百万级以下数据 |
| `ef_construction` | 200 | 构建时搜索深度。越高索引质量越好，构建越慢 |
| `ef_search`（运行时） | 40（默认） | 查询时搜索深度。10K 节点建议 100；100K 建议 200 |

**调优指引**：

```sql
-- 生产环境（10K+ 节点）
SET hnsw.ef_search = 100;

-- 监控索引大小
SELECT pg_size_pretty(pg_relation_size('knowledge_nodes_embedding_idx'));
```

---

## 6. 典型查询模式

### 6.1 语义搜索 + 多重过滤（最常用）

```sql
-- 查询参数：query_embedding, company_id, project_id (nullable), domain_names[], threshold=0.75, limit=10
WITH base AS (
  SELECT
    n.id,
    n.title,
    n.type,
    n.level,
    n.confidence,
    n.verified,
    n.trigger_count,
    n.used_for,
    n.volatility,
    n.valid_until,
    n.verified_at,
    n.status,
    d.name AS domain_name,
    d.display_label AS domain_label,
    d.color AS domain_color,
    1 - (n.embedding <=> $1::vector) AS similarity
  FROM knowledge_nodes n
  JOIN business_domains d ON d.id = n.business_domain_id
  WHERE n.company_id = $2
    AND n.status = 'active'
    AND (n.level = 'company'
         OR (n.level = 'project' AND n.project_id = $3))
    AND (d.name = ANY($4::text[])
         OR d.name = 'general'
         OR cardinality($4::text[]) = 0)               -- 空数组 = 不过滤
    AND 1 - (n.embedding <=> $1::vector) > $5          -- 相似度阈值
  ORDER BY n.embedding <=> $1::vector
  LIMIT $6
)
SELECT *,
  -- 实时计算 freshness_score（不依赖列）
  CASE
    WHEN valid_until IS NOT NULL AND valid_until < now() THEN 0.0
    WHEN valid_until IS NOT NULL AND valid_until < now() + INTERVAL '30 days' THEN 0.3
    ELSE EXP(
      - EXTRACT(EPOCH FROM (now() - COALESCE(verified_at, created_at))) / 86400.0
      / CASE volatility
          WHEN 'stable' THEN 36500.0   -- ~∞
          WHEN 'slow'   THEN 365.0
          WHEN 'fast'   THEN 90.0
        END
    )
  END AS freshness_score
FROM base;
```

### 6.2 经验推荐（按 used_for 标签）

```sql
SELECT
  n.id,
  n.title,
  n.type,
  n.used_for,
  n.trigger_count,
  n.last_triggered,
  -- 经验得分：被引用越多 + 越近越高
  n.trigger_count *
    (1.0 / GREATEST(1, EXTRACT(DAY FROM (now() - n.last_triggered)))) AS experience_score
FROM knowledge_nodes n
JOIN business_domains d ON d.id = n.business_domain_id
WHERE n.company_id = $1
  AND n.status = 'active'
  AND n.used_for && $2::text[]                       -- 标签数组有交集
  AND (n.level = 'company' OR (n.level = 'project' AND n.project_id = $3))
  AND (d.name = ANY($4::text[]) OR cardinality($4::text[]) = 0)
ORDER BY experience_score DESC
LIMIT 5;
```

### 6.3 双链查询（节点详情页）

```sql
-- 出边（"我引用了谁"）
SELECT
  e.edge_type,
  e.auto_generated,
  n2.id AS target_id,
  n2.title AS target_title,
  n2.type AS target_type,
  n2.status AS target_status
FROM knowledge_edges e
JOIN knowledge_nodes n2 ON n2.id = e.to_node_id
WHERE e.from_node_id = $1
ORDER BY e.edge_type, e.created_at;

-- 入边（"谁引用了我"）
SELECT
  e.edge_type,
  n2.id AS source_id,
  n2.title AS source_title,
  n2.type AS source_type
FROM knowledge_edges e
JOIN knowledge_nodes n2 ON n2.id = e.from_node_id
WHERE e.to_node_id = $1
ORDER BY e.edge_type, e.created_at;
```

### 6.4 时效性巡检（找需要验证的节点）

```sql
SELECT
  n.id,
  n.title,
  n.volatility,
  n.verified_at,
  n.valid_until,
  EXTRACT(DAY FROM (now() - n.verified_at)) AS days_since_verified
FROM knowledge_nodes n
WHERE n.company_id = $1
  AND n.status = 'active'
  AND (
    -- 显式过期临近
    (n.valid_until IS NOT NULL AND n.valid_until < now() + INTERVAL '7 days')
    OR
    -- fast 类 90 天未验证
    (n.volatility = 'fast' AND n.verified_at < now() - INTERVAL '90 days')
    OR
    -- slow 类 365 天未验证
    (n.volatility = 'slow' AND n.verified_at < now() - INTERVAL '365 days')
  )
ORDER BY n.verified_at ASC NULLS FIRST;
```

### 6.5 演化：升规则候选

```sql
-- 找符合升规则条件的 lesson 节点
SELECT
  n.id,
  n.title,
  n.trigger_count,
  n.prevention_score,
  array_agg(DISTINCT e.issue_id) FILTER (WHERE e.issue_id IS NOT NULL) AS triggered_in_issues
FROM knowledge_nodes n
LEFT JOIN knowledge_node_events e ON e.node_id = n.id AND e.event_type = 'triggered'
WHERE n.company_id = $1
  AND n.type = 'lesson'
  AND n.status = 'active'
  AND n.trigger_count >= 3
  AND n.prevention_score >= 0.7
GROUP BY n.id;
```

### 6.6 演化：合并候选检测

```sql
-- 找出每对相似度 > 0.9 的节点（按公司分块查询，避免全表 NxN）
WITH candidates AS (
  SELECT
    a.id AS id_a,
    b.id AS id_b,
    1 - (a.embedding <=> b.embedding) AS similarity
  FROM knowledge_nodes a
  JOIN knowledge_nodes b ON b.company_id = a.company_id
                         AND b.id > a.id              -- 避免重复对
                         AND b.status = 'active'
                         AND b.type = a.type
  WHERE a.company_id = $1
    AND a.status = 'active'
    AND 1 - (a.embedding <=> b.embedding) > 0.9
)
SELECT * FROM candidates
ORDER BY similarity DESC
LIMIT 20;
```

### 6.7 演化：模式涌现聚类输入

```sql
-- 按 (used_for, business_domain_id) 分组找候选簇
SELECT
  used_for_tag,
  business_domain_id,
  array_agg(id) AS lesson_ids,
  count(*) AS cluster_size
FROM (
  SELECT id, business_domain_id, unnest(used_for) AS used_for_tag
  FROM knowledge_nodes
  WHERE company_id = $1
    AND type = 'lesson'
    AND status = 'active'
) AS expanded
GROUP BY used_for_tag, business_domain_id
HAVING count(*) >= 5;
-- 后续应用层对每个簇内的 embeddings 跑 HDBSCAN 聚类，再调 LLM 抽共性
```

### 6.8 审查队列（梯度排序）

```sql
SELECT
  d.id,
  d.proposed_title,
  d.source,
  d.confidence,
  d.pre_verdict,
  d.pre_verdict_reasoning,
  d.detected_conflicts,
  EXTRACT(EPOCH FROM (now() - d.created_at)) / 3600.0 AS waiting_hours,
  -- 优先级评分：needs_human 最优先；其次按 confidence × waiting
  CASE
    WHEN d.pre_verdict = 'needs_human' THEN 1000
    WHEN cardinality(d.detected_conflicts) > 0 THEN 900
    ELSE d.confidence * EXTRACT(EPOCH FROM (now() - d.created_at)) / 3600.0
  END AS priority_score
FROM knowledge_drafts d
WHERE d.company_id = $1
  AND d.status = 'pending'
ORDER BY priority_score DESC
LIMIT 50;
```

### 6.9 健康指标计算（每日自检）

```sql
-- 周新增 draft 数
SELECT count(*) AS metric_value
FROM knowledge_drafts
WHERE company_id = $1
  AND created_at > now() - INTERVAL '7 days';

-- 审查 backlog 中位数（小时）
SELECT percentile_cont(0.5) WITHIN GROUP (
  ORDER BY EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0
) AS metric_value
FROM knowledge_drafts
WHERE company_id = $1
  AND status = 'pending';

-- helped 比例
SELECT
  COALESCE(
    SUM(CASE WHEN event_type = 'feedback' AND feedback = 'helped' THEN 1 ELSE 0 END)::float /
    NULLIF(SUM(CASE WHEN event_type = 'triggered' THEN 1 ELSE 0 END), 0),
    0
  ) AS metric_value
FROM knowledge_node_events e
JOIN knowledge_nodes n ON n.id = e.node_id
WHERE n.company_id = $1
  AND e.created_at > now() - INTERVAL '30 days';

-- 平均节点引用密度
SELECT
  COALESCE(
    (SELECT count(*) FROM knowledge_edges e
     JOIN knowledge_nodes n ON n.id = e.from_node_id
     WHERE n.company_id = $1 AND n.status = 'active')::float /
    NULLIF(
      (SELECT count(*) FROM knowledge_nodes WHERE company_id = $1 AND status = 'active'),
      0
    ),
    0
  ) AS metric_value;

-- 冲突未决数
SELECT count(*) AS metric_value
FROM knowledge_edges e
JOIN knowledge_nodes a ON a.id = e.from_node_id
JOIN knowledge_nodes b ON b.id = e.to_node_id
WHERE a.company_id = $1
  AND e.edge_type = 'conflicts_with'
  AND a.status = 'active'
  AND b.status = 'active';

-- 过期未巡检（fast + > 90d）
SELECT count(*) AS metric_value
FROM knowledge_nodes
WHERE company_id = $1
  AND status = 'active'
  AND volatility = 'fast'
  AND (verified_at IS NULL OR verified_at < now() - INTERVAL '90 days');
```

---

## 7. 迁移方案

### 7.1 首次部署

迁移文件位置：`packages/db/src/migrations/0084_llm_wiki_engine.sql`

执行顺序：

```sql
-- 1. 启用扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 创建枚举（9 个）
CREATE TYPE knowledge_node_type AS ENUM (...);
-- ... 其余 8 个枚举

-- 3. 创建表（顺序很重要：依赖在前）
CREATE TABLE business_domains (...);              -- 节点 FK 依赖
CREATE TABLE knowledge_nodes (...);
CREATE TABLE knowledge_edges (...);
CREATE TABLE knowledge_drafts (...);
CREATE TABLE knowledge_node_revisions (...);
CREATE TABLE knowledge_node_events (...);
CREATE TABLE knowledge_sources (...);
CREATE TABLE knowledge_metrics (...);

-- 4. 创建索引
-- (按 §5 全部索引)

-- 5. 公司初始化触发器：新建 company 时自动 INSERT general business_domain
CREATE OR REPLACE FUNCTION seed_default_business_domain()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO business_domains (company_id, name, display_label, color, sort_order)
  VALUES (NEW.id, 'general', '通用', '#6B7280', 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_after_insert_seed_domain
  AFTER INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION seed_default_business_domain();
```

### 7.2 已有 company 的回填

迁移后，已存在的 company 没有 `general` 业务域。需要执行：

```sql
INSERT INTO business_domains (company_id, name, display_label, color, sort_order)
SELECT id, 'general', '通用', '#6B7280', 0
FROM companies
WHERE NOT EXISTS (
  SELECT 1 FROM business_domains bd
  WHERE bd.company_id = companies.id AND bd.name = 'general'
);
```

### 7.3 现有 Docker 镜像升级

```yaml
# docker-compose.yml 或 docker-compose.selfhost.yml
db:
  image: pgvector/pgvector:pg16     # 原: postgres:16-alpine
  # 其他配置不变
```

### 7.4 v1 数据迁移（如果有 obsidian-wiki 数据）

v1 数据存在 vault 中（Markdown 文件），需要写一次性迁移脚本：

```typescript
// scripts/migrate-v1-vault-to-db.ts
async function migrate(vaultRoot: string, companyId: string, db: Db) {
  const files = await glob('wiki/**/*.md', { cwd: vaultRoot });
  for (const file of files) {
    const { content, data: fm } = matter(await fs.readFile(file, 'utf-8'));
    const embedding = await generateEmbedding(content);
    await db.insert(knowledgeNodes).values({
      title: path.basename(file, '.md'),
      content,
      type: fm.type ?? 'concept',
      level: fm.level ?? 'project',
      businessDomainId: await resolveDomainId(fm.domain ?? 'general', companyId, db),
      companyId,
      embedding,
      confidence: fm.confidence ?? 0.5,
      verified: fm.verified ?? false,
      // ... 其他字段
    });
  }
}
```

---

## 8. 性能基准

### 8.1 数据量预估

| 规模 | 节点数 | 边数（~3/节点） | 事件数（~50/节点） | 总存储 |
|------|--------|----------------|-------------------|--------|
| 缤果初期 | 100-500 | 300-1.5K | 5K-25K | ~10 MB |
| 缤果稳态 | 1K-5K | 3K-15K | 50K-250K | ~50 MB |
| 增长后 | 10K-50K | 30K-150K | 500K-2.5M | ~500 MB |
| 极限 | 100K+ | 300K+ | 5M+ | ~5 GB |

### 8.2 索引存储预估

| 节点数 | HNSW 索引 | 其他索引 | 总开销 |
|--------|-----------|---------|--------|
| 1K | ~6 MB | ~1 MB | ~7 MB |
| 10K | ~60 MB | ~10 MB | ~70 MB |
| 100K | ~600 MB | ~100 MB | ~700 MB |

计算公式：`1536 维 × 4 字节 × 节点数 × ~1.5 HNSW 开销 ≈ 9.2 KB/节点`

### 8.3 查询延迟目标（10K 节点，HNSW ef_search=100）

| 查询 | 目标 P95 | 备注 |
|------|---------|------|
| 语义搜索 Top 5 + freshness | < 50 ms | HNSW 搜索 + freshness 实时计算 |
| 语义搜索 + 权限过滤 + domain | < 80 ms | HNSW → JOIN filter |
| 经验推荐（GIN 数组） | < 30 ms | used_for 数组索引 |
| 双链查询 | < 10 ms | 边表两个索引各一次查询 |
| 时效性巡检全表扫描 | < 200 ms | 部分索引 (volatility, verified_at) |
| 演化合并候选检测 | < 500 ms | 自连接 + HNSW pruning |
| 健康指标 6 项全算 | < 1 s | 6 个独立 SQL，每日跑一次可接受 |

### 8.4 写入性能

| 操作 | 目标 |
|------|------|
| Draft 写入（含 embedding 生成） | < 2 s（embedding 是瓶颈） |
| 节点 UPDATE（含 revision 写入） | < 50 ms |
| 事件写入 | < 20 ms |
| 边批量解析（[[id]] 自动落边） | < 100 ms/节点 |

---

## 9. 安全与备份

### 9.1 行级安全（RLS）

MVP 不启用 PG 的 RLS（行级安全），原因：
- 单人公司场景下额外复杂度无收益
- 应用层 SQL WHERE 强制过滤足够
- RLS 调试成本高

后续扩展到多公司协作场景时可考虑启用 RLS。

### 9.2 SQL 注入

- **强制参数化查询**，所有用户输入走 Drizzle ORM 的 `sql` 模板或 Drizzle 查询构造器
- 绝不字符串拼接 SQL
- 特殊场景（如动态 GIN 数组）通过 Drizzle 的 `inArray` / `arrayContains` 操作符

### 9.3 多租户隔离

- 应用层每个查询强制 `WHERE company_id = $current_user.company_id`
- MCP 服务端二次过滤（不信任客户端声明的 company_id）
- 测试覆盖：单测验证用 A 公司 key 查 B 公司数据返回空

### 9.4 备份

```bash
# 完整备份（所有 LLM-Wiki 表 + companies + business_domains 等关联）
pg_dump -h ... -U ... -d paperclip \
  -t knowledge_nodes -t knowledge_edges -t knowledge_drafts \
  -t knowledge_node_revisions -t knowledge_node_events \
  -t knowledge_sources -t knowledge_metrics -t business_domains \
  > llm-wiki-backup-$(date +%Y%m%d).sql
```

复用 Paperclip 现有的 `pnpm db:backup` 流程，加入这 8 张表。

### 9.5 灾难恢复

| 场景 | 恢复策略 |
|------|---------|
| HNSW 索引损坏 | `REINDEX INDEX knowledge_nodes_embedding_idx` 重建（10K 节点约 30s） |
| 节点数据丢失 | 从 pg_dump 备份恢复 |
| 单条节点错改 | 从 revisions 表回滚（应用层提供 "rollback to revision" API） |
| 公司被误删 | ON DELETE CASCADE 会清空全部数据，建议改为软删 + 30 天硬删延迟 |

---

## 10. Drizzle ORM Schema

```typescript
// packages/db/src/schema/llm-wiki.ts

import {
  pgTable, uuid, text, real, boolean, integer, numeric,
  timestamp, jsonb, uniqueIndex, index, pgEnum, customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies, projects, agents, users, issues, heartbeatRuns } from "./paperclip-core";

// 自定义 vector 类型（Drizzle 不原生支持 pgvector）
const vector = (name: string, dim: number) => customType<{ data: number[]; driverData: string }>({
  dataType() { return `vector(${dim})`; },
  toDriver(value: number[]) { return `[${value.join(',')}]`; },
})(name);

// === 枚举 ===
export const knowledgeNodeTypeEnum = pgEnum("knowledge_node_type",
  ["concept", "lesson", "rule", "decision", "fact"]);
export const knowledgeLevelEnum = pgEnum("knowledge_level",
  ["personal", "project", "company"]);
export const knowledgeStatusEnum = pgEnum("knowledge_status",
  ["active", "archived", "outdated", "revoked"]);
export const knowledgeVolatilityEnum = pgEnum("knowledge_volatility",
  ["stable", "slow", "fast"]);
export const knowledgeEdgeTypeEnum = pgEnum("knowledge_edge_type",
  ["references", "supersedes", "merged_from", "derived_from", "conflicts_with", "promoted_to"]);
export const knowledgeDraftSourceEnum = pgEnum("knowledge_draft_source",
  ["agent_self_review", "failure_signal", "manual"]);
export const knowledgeDraftStatusEnum = pgEnum("knowledge_draft_status",
  ["pending", "approved", "rejected", "revision_requested"]);
export const knowledgeEventTypeEnum = pgEnum("knowledge_event_type",
  ["created", "updated", "triggered", "feedback", "verified",
   "superseded", "archived", "promoted", "revoked"]);
export const knowledgePreVerdictEnum = pgEnum("knowledge_pre_verdict",
  ["recommend_approve", "recommend_reject", "needs_human"]);

// === 表 1：business_domains ===
export const businessDomains = pgTable("business_domains", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  displayLabel: text("display_label").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#6B7280"),
  icon: text("icon"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyNameIdx: uniqueIndex("business_domains_company_name_idx").on(t.companyId, t.name),
  activeIdx: index("business_domains_active_idx")
    .on(t.companyId, t.sortOrder)
    .where(sql`archived = false`),
}));

// === 表 2：knowledge_nodes ===
export const knowledgeNodes = pgTable("knowledge_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  type: knowledgeNodeTypeEnum("type").notNull(),
  embedding: vector("embedding", 1536),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  businessDomainId: uuid("business_domain_id").notNull()
    .references(() => businessDomains.id, { onDelete: "restrict" }),
  level: knowledgeLevelEnum("level").notNull().default("project"),
  status: knowledgeStatusEnum("status").notNull().default("active"),
  confidence: real("confidence").notNull().default(0.5),
  verified: boolean("verified").notNull().default(false),
  volatility: knowledgeVolatilityEnum("volatility").notNull().default("slow"),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  sourceUrl: text("source_url"),
  externalVersion: jsonb("external_version"),
  triggerCount: integer("trigger_count").notNull().default(0),
  lastTriggered: timestamp("last_triggered", { withTimezone: true }),
  usedFor: text("used_for").array().notNull().default(sql`'{}'::text[]`),
  preventionScore: real("prevention_score").notNull().default(0),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdByAgent: uuid("created_by_agent").references(() => agents.id, { onDelete: "set null" }),
  createdByUser: uuid("created_by_user").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  embeddingIdx: index("knowledge_nodes_embedding_idx")
    .using("hnsw", sql`embedding vector_cosine_ops`),
  companyDomainStatusIdx: index("knowledge_nodes_company_domain_status_idx")
    .on(t.companyId, t.businessDomainId, t.status)
    .where(sql`status = 'active'`),
  companyLevelStatusIdx: index("knowledge_nodes_company_level_status_idx")
    .on(t.companyId, t.level, t.status)
    .where(sql`status = 'active'`),
  usedForGinIdx: index("knowledge_nodes_used_for_idx").using("gin", t.usedFor),
  volatilityVerifiedIdx: index("knowledge_nodes_volatility_verified_idx")
    .on(t.volatility, t.verifiedAt)
    .where(sql`status = 'active'`),
  validUntilIdx: index("knowledge_nodes_valid_until_idx")
    .on(t.validUntil)
    .where(sql`valid_until IS NOT NULL AND status = 'active'`),
}));

// === 表 3：knowledge_edges ===
export const knowledgeEdges = pgTable("knowledge_edges", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromNodeId: uuid("from_node_id").notNull()
    .references(() => knowledgeNodes.id, { onDelete: "cascade" }),
  toNodeId: uuid("to_node_id").notNull()
    .references(() => knowledgeNodes.id, { onDelete: "cascade" }),
  edgeType: knowledgeEdgeTypeEnum("edge_type").notNull(),
  createdByAgent: uuid("created_by_agent").references(() => agents.id, { onDelete: "set null" }),
  createdByUser: uuid("created_by_user").references(() => users.id, { onDelete: "set null" }),
  autoGenerated: boolean("auto_generated").notNull().default(false),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fromTypeIdx: index("knowledge_edges_from_type_idx").on(t.fromNodeId, t.edgeType),
  toTypeIdx: index("knowledge_edges_to_type_idx").on(t.toNodeId, t.edgeType),
  uniqueDirected: uniqueIndex("knowledge_edges_unique_directed")
    .on(t.fromNodeId, t.toNodeId, t.edgeType),
}));

// === 表 4：knowledge_drafts ===
export const knowledgeDrafts = pgTable("knowledge_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  targetNodeId: uuid("target_node_id").references(() => knowledgeNodes.id, { onDelete: "cascade" }),
  proposedTitle: text("proposed_title").notNull(),
  proposedContent: text("proposed_content").notNull(),
  proposedType: knowledgeNodeTypeEnum("proposed_type").notNull(),
  proposedLevel: knowledgeLevelEnum("proposed_level").notNull(),
  proposedBusinessDomainId: uuid("proposed_business_domain_id").notNull()
    .references(() => businessDomains.id, { onDelete: "restrict" }),
  proposedMetadata: jsonb("proposed_metadata").notNull().default(sql`'{}'::jsonb`),
  proposedVolatility: knowledgeVolatilityEnum("proposed_volatility"),
  proposedValidUntil: timestamp("proposed_valid_until", { withTimezone: true }),
  source: knowledgeDraftSourceEnum("source").notNull(),
  sourceAgentId: uuid("source_agent_id").references(() => agents.id, { onDelete: "set null" }),
  sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
  sourceUserId: uuid("source_user_id").references(() => users.id, { onDelete: "set null" }),
  confidence: real("confidence").notNull().default(0.5),
  preVerdict: knowledgePreVerdictEnum("pre_verdict"),
  preVerdictReasoning: text("pre_verdict_reasoning"),
  preVerdictAt: timestamp("pre_verdict_at", { withTimezone: true }),
  detectedConflicts: uuid("detected_conflicts").array().notNull().default(sql`'{}'::uuid[]`),
  status: knowledgeDraftStatusEnum("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewNotes: text("review_notes"),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (t) => ({
  companyPendingIdx: index("knowledge_drafts_company_pending_idx")
    .on(t.companyId, t.status, t.createdAt)
    .where(sql`status = 'pending'`),
  unscreenedIdx: index("knowledge_drafts_unscreened_idx")
    .on(t.companyId, t.createdAt)
    .where(sql`status = 'pending' AND pre_verdict IS NULL`),
  sourceStatusIdx: index("knowledge_drafts_source_status_idx").on(t.source, t.status),
}));

// === 表 5：knowledge_node_revisions ===
export const knowledgeNodeRevisions = pgTable("knowledge_node_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").notNull().references(() => knowledgeNodes.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  type: knowledgeNodeTypeEnum("type").notNull(),
  level: knowledgeLevelEnum("level").notNull(),
  metadata: jsonb("metadata").notNull(),
  changesetSummary: text("changeset_summary"),
  editorAgentId: uuid("editor_agent_id").references(() => agents.id, { onDelete: "set null" }),
  editorUserId: uuid("editor_user_id").references(() => users.id, { onDelete: "set null" }),
  draftId: uuid("draft_id").references(() => knowledgeDrafts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nodeCreatedIdx: index("knowledge_node_revisions_node_idx").on(t.nodeId, t.createdAt),
}));

// === 表 6：knowledge_node_events ===
export const knowledgeNodeEvents = pgTable("knowledge_node_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").notNull().references(() => knowledgeNodes.id, { onDelete: "cascade" }),
  eventType: knowledgeEventTypeEnum("event_type").notNull(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  feedback: text("feedback"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nodeTypeCreatedIdx: index("knowledge_node_events_node_type_idx").on(t.nodeId, t.eventType, t.createdAt),
  issueIdx: index("knowledge_node_events_issue_idx")
    .on(t.issueId)
    .where(sql`issue_id IS NOT NULL`),
  feedbackIdx: index("knowledge_node_events_feedback_idx")
    .on(t.eventType, t.feedback, t.createdAt)
    .where(sql`event_type IN ('triggered', 'feedback')`),
}));

// === 表 7：knowledge_sources ===
export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  sourceType: text("source_type").notNull().default("blog"),
  collectorName: text("collector_name").notNull().default("WebCrawler"),
  crawlFrequency: text("crawl_frequency").notNull().default("weekly"),
  trustWeight: real("trust_weight").notNull().default(0.5),
  lastCrawled: timestamp("last_crawled", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  articleSelector: text("article_selector"),
  sitemapUrl: text("sitemap_url"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  crawlConfig: jsonb("crawl_config").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyNameUrlIdx: uniqueIndex("knowledge_sources_company_name_url_idx")
    .on(t.companyId, t.name, t.url),
}));

// === 表 8：knowledge_metrics ===
export const knowledgeMetrics = pgTable("knowledge_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  metricName: text("metric_name").notNull(),
  metricValue: numeric("metric_value").notNull(),
  status: text("status").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
}, (t) => ({
  companyMetricIdx: index("knowledge_metrics_company_metric_idx")
    .on(t.companyId, t.metricName, t.computedAt),
}));
```

---

## 11. pgvector 封装

```typescript
// server/src/services/llm-wiki/utils/vector.ts

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

const EMBEDDING_DIM = 1536;

/**
 * 把 number[] 转成 pgvector 文字格式
 */
export function vectorLiteral(v: number[]): string {
  if (v.length !== EMBEDDING_DIM) {
    throw new Error(`Expected ${EMBEDDING_DIM} dims, got ${v.length}`);
  }
  return `[${v.join(",")}]`;
}

/**
 * 语义搜索 + 权限过滤 + 业务域过滤
 */
export interface SemanticSearchOpts {
  embedding: number[];
  companyId: string;
  projectId?: string | null;
  domainNames?: string[];           // 空数组 = 不过滤
  threshold?: number;               // 默认 0.75
  limit?: number;                   // 默认 10
}

export async function semanticSearch(db: Db, opts: SemanticSearchOpts) {
  const {
    embedding, companyId, projectId,
    domainNames = [], threshold = 0.75, limit = 10
  } = opts;

  const embLit = vectorLiteral(embedding);
  const rows = await db.execute<SearchResultRow>(sql`
    WITH base AS (
      SELECT
        n.id, n.title, n.type, n.level, n.confidence, n.verified,
        n.trigger_count, n.used_for, n.volatility, n.valid_until,
        n.verified_at, n.status, n.metadata,
        d.name AS domain_name, d.display_label AS domain_label, d.color AS domain_color,
        1 - (n.embedding <=> ${sql.raw(embLit)}::vector) AS similarity
      FROM knowledge_nodes n
      JOIN business_domains d ON d.id = n.business_domain_id
      WHERE n.company_id = ${companyId}::uuid
        AND n.status = 'active'
        AND (n.level = 'company'
             OR (n.level = 'project' AND n.project_id = ${projectId}::uuid))
        AND (
          cardinality(${domainNames}::text[]) = 0
          OR d.name = ANY(${domainNames}::text[])
          OR d.name = 'general'
        )
        AND 1 - (n.embedding <=> ${sql.raw(embLit)}::vector) > ${threshold}
      ORDER BY n.embedding <=> ${sql.raw(embLit)}::vector
      LIMIT ${limit}
    )
    SELECT *,
      CASE
        WHEN valid_until IS NOT NULL AND valid_until < now() THEN 0.0
        WHEN valid_until IS NOT NULL AND valid_until < now() + INTERVAL '30 days' THEN 0.3
        ELSE EXP(
          - EXTRACT(EPOCH FROM (now() - COALESCE(verified_at, created_at))) / 86400.0
          / CASE volatility
              WHEN 'stable' THEN 36500.0
              WHEN 'slow'   THEN 365.0
              WHEN 'fast'   THEN 90.0
            END
        )
      END AS freshness_score
    FROM base
  `);

  return rows;
}

/**
 * Upsert embedding（节点创建/更新时调）
 */
export async function upsertEmbedding(
  db: Db,
  nodeId: string,
  embedding: number[]
): Promise<void> {
  const lit = vectorLiteral(embedding);
  await db.execute(sql`
    UPDATE knowledge_nodes
    SET embedding = ${sql.raw(lit)}::vector,
        updated_at = now()
    WHERE id = ${nodeId}::uuid
  `);
}

/**
 * 调用 OpenAI embedding API
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const truncated = text.slice(0, 8000);             // text-embedding-3-small 上限
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: truncated,
  });
  return resp.data[0].embedding;
}
```

---

**结束** — 数据库设计完整覆盖 8 表 + 9 枚举 + 索引策略 + 典型查询 + Drizzle Schema + pgvector 封装。
