# Obsidian LLM-Wiki 引擎 数据库设计文档

**版本**: v1.0
**日期**: 2026-05-12
**数据库**: PostgreSQL 16 + pgvector 0.7
**ORM**: Drizzle ORM (TypeScript)

---

## 目录

1. [设计原则](#1-设计原则)
2. [ER 图](#2-er-图)
3. [表定义](#3-表定义)
4. [索引策略](#4-索引策略)
5. [查询模式](#5-查询模式)
6. [迁移方案](#6-迁移方案)
7. [性能基准](#7-性能基准)
8. [安全与备份](#8-安全与备份)

---

## 1. 设计原则

### 1.1 存储分离

| 存储 | 内容 | 原因 |
|------|------|------|
| Obsidian vault（文件系统） | Markdown 原文 | 人类可直接读写、Git 版本管理、Obsidian 原生支持 |
| PostgreSQL `wiki_entities` | 元数据 + 向量索引 | 语义搜索、统计、权限过滤 |
| PostgreSQL `knowledge_sources` | 爬虫源配置 | URL、频率、健康状态 |
| PostgreSQL `knowledge_reviews` | 审查队列 | 变更审核流程 |

**核心原则**: vault 是唯一真实源，PostgreSQL 是索引和元数据层。vault 挂了可以重建向量索引；PG 挂了可以从 vault 重建。

### 1.2 命名规范

- 表名: `snake_case`，复数形式（`wiki_entities` 不是 `wiki_entity`）
- 列名: `snake_case`，不使用缩写（`entity_name` 不是 `en`）
- 索引名: `{table}_{column(s)}_idx`
- 外键名: `fk_{table}_{column}`
- 时间戳: 一律 `TIMESTAMPTZ`（带时区）

### 1.3 关键决策

- **向量索引不存原文** — `wiki_entities` 的 `file_path` 指向 vault 中的 `.md` 文件，读取时动态加载
- **HNSW 索引** — pgvector 0.7 支持 HNSW，百万级以下比 IVFFlat 更优
- **JSONB 放采集器特有配置** — `knowledge_sources.crawl_config` 放非通用字段，避免频繁变更 schema
- **审查队列独立表** — 不耦合到 `wiki_entities`，审核通过后才写入实体/文件

---

## 2. ER 图

```
┌──────────────────┐       ┌──────────────────┐
│  wiki_entities   │       │ knowledge_sources│
├──────────────────┤       ├──────────────────┤
│ id (PK)          │       │ id (PK)          │
│ entity_name      │       │ name             │
│ file_path (UQ)   │       │ url              │
│ level (FK→enum)  │       │ source_type      │
│ project_id (FK)  │◇──────│ collector_name   │
│ created_by (FK)  │       │ crawl_frequency  │
│ embedding        │       │ trust_weight     │
│ confidence       │       │ last_crawled     │
│ freshness_score  │       │ article_selector │
│ use_count        │       │ sitemap_url      │
│ used_for[]       │       │ tags[]           │
│ file_updated     │       │ crawl_config     │
└──────────────────┘       └──────────────────┘

┌──────────────────┐
│knowledge_reviews │
├──────────────────┤
│ id (PK)          │
│ entity_name      │──────◇ 审核通过后写入 wiki_entities
│ source_type      │
│ source_id        │
│ content          │
│ existing_content │
│ confidence       │
│ level            │
│ status           │──────◇ pending → approved → 写入 vault
│ reviewed_by      │
│ review_notes     │
└──────────────────┘

◇ = 逻辑关联，非数据库外键
```

---

## 3. 表定义

### 3.1 `wiki_entities` — 知识实体索引

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- 知识层级枚举
CREATE TYPE entity_level AS ENUM ('personal', 'project', 'company');

CREATE TABLE wiki_entities (
  -- 主键
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 实体标识
  entity_name     TEXT NOT NULL,                        -- 规范化实体名
  file_path       TEXT NOT NULL UNIQUE,                 -- vault 内相对路径，如 "wiki/PostgreSQL-死锁排查.md"

  -- 层级与归属
  level           entity_level NOT NULL DEFAULT 'project',
  project_id      UUID REFERENCES projects(id)
                    ON DELETE SET NULL,                 -- 项目级知识关联；公司级为 NULL
  created_by      UUID REFERENCES agents(id)
                    ON DELETE SET NULL,                 -- 个人级知识的创建者；项目/公司级为 NULL

  -- 向量索引（1536 维 = text-embedding-3-small）
  embedding       vector(1536),

  -- 质量元数据
  confidence      REAL NOT NULL DEFAULT 0.5
                    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  verified        BOOLEAN NOT NULL DEFAULT false,
  freshness_score REAL NOT NULL DEFAULT 1.0
                    CHECK (freshness_score >= 0.0 AND freshness_score <= 1.0),

  -- 使用统计
  use_count       INTEGER NOT NULL DEFAULT 0,
  used_for        TEXT[] NOT NULL DEFAULT '{}',         -- 用途标签数组
  last_used       TIMESTAMPTZ,                          -- 最近被引用时间

  -- 时间戳
  file_updated    TIMESTAMPTZ NOT NULL,                 -- vault 文件最后修改时间（从 fs.stat 获取）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**列设计说明**:

| 列 | 设计决策 |
|----|----------|
| `entity_name` | 不是 UNIQUE——同一实体可能因大小写/命名习惯在不同文件路径下。去重靠 `file_path` UNIQUE + 语义搜索 |
| `file_path` | UNIQUE 约束保证一个实体只有一个文件。路径是 vault 内的相对路径，与系统绝对路径解耦 |
| `level` | 枚举而非字符串。后续新增层级（如 `team`）只需 `ALTER TYPE ... ADD VALUE` |
| `project_id` | 项目级知识关联项目表。ON DELETE SET NULL——项目删除后知识不删除，变为孤儿知识（巡检时会发现并提示处理）|
| `created_by` | 个人级知识关联 Agent。Agent 删除后知识变孤儿 |
| `embedding` | vector(1536) 对应 text-embedding-3-small。如果后续切换到 text-embedding-3-large（3072 维），需要 `ALTER COLUMN TYPE` 和重建索引 |
| `confidence` | 0-1 实数。Agent 自评；人类审核后可能被覆盖 |
| `freshness_score` | 1.0 = 刚更新，线性衰减到 0.0 = 完全过期。衰减速率可配置（默认 90 天 → 0.0）|
| `used_for` | PostgreSQL 数组。GIN 索引支持 `@>` (包含) 和 `&&` (相交) 操作符 |
| `file_updated` | 从文件系统的 mtime 获取，定期同步。与 `updated_at`（数据库行更新时间）分开 |

### 3.2 `knowledge_sources` — 知识源管理

```sql
-- 源类型枚举
CREATE TYPE source_type AS ENUM (
  'blog', 'docs', 'github', 'forum', 'paper', 'rss', 'slack', 'custom'
);

-- 爬取频率枚举
CREATE TYPE crawl_frequency AS ENUM ('daily', 'weekly', 'monthly', 'manual');

CREATE TABLE knowledge_sources (
  -- 主键
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 源标识
  name              TEXT NOT NULL,                        -- 人类可读名称
  url               TEXT NOT NULL,                        -- 源根 URL
  source_type       source_type NOT NULL DEFAULT 'blog',
  collector_name    TEXT NOT NULL DEFAULT 'WebCrawler',   -- 匹配 KnowledgeCollector.name

  -- 抓取控制
  crawl_frequency   crawl_frequency NOT NULL DEFAULT 'weekly',
  trust_weight      REAL NOT NULL DEFAULT 0.5
                      CHECK (trust_weight >= 0.0 AND trust_weight <= 1.0),
  last_crawled      TIMESTAMPTZ,                          -- 上次爬取完成时间
  enabled           BOOLEAN NOT NULL DEFAULT true,

  -- 内容提取配置
  article_selector  TEXT,                                 -- CSS 选择器（如 "article.post"），可选；为空则用 Readability 自动提取
  sitemap_url       TEXT,                                 -- RSS/Atom feed URL 或 sitemap.xml

  -- 分类
  tags              TEXT[] NOT NULL DEFAULT '{}',         -- 该源的知识标签

  -- 采集器特有配置（JSONB）——避免频繁改 schema
  crawl_config      JSONB NOT NULL DEFAULT '{}',          -- 如 {"concurrency":1, "request_interval_ms":5000}

  -- 时间戳
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (name, url) 联合唯一索引 —— 防止重复添加同一源
CREATE UNIQUE INDEX knowledge_sources_name_url_idx ON knowledge_sources (name, url);
```

**`crawl_config` JSONB 示例**:

```json
{
  "concurrency": 1,
  "request_interval_ms": 5000,
  "max_pages_per_crawl": 20,
  "follow_external_links": false,
  "extract_images": false,
  "custom_headers": {
    "Accept-Language": "en-US"
  }
}
```

### 3.3 `knowledge_reviews` — 知识审查队列

```sql
-- 审查来源类型
CREATE TYPE review_source_type AS ENUM ('agent', 'crawler', 'manual');

-- 审查状态
CREATE TYPE review_status AS ENUM (
  'pending', 'approved', 'rejected', 'revision_requested'
);

CREATE TABLE knowledge_reviews (
  -- 主键
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 实体信息
  entity_name       TEXT NOT NULL,                        -- 目标实体名
  file_path         TEXT NOT NULL,                        -- 目标文件路径

  -- 来源
  source_type       review_source_type NOT NULL,
  source_id         TEXT,                                 -- Agent ID / Source name / User ID

  -- 内容
  content           TEXT NOT NULL,                        -- 待审核的新/修改 Markdown 内容
  existing_content  TEXT,                                 -- 已有内容（如果是更新），用于 diff 展示

  -- 质量标记
  confidence        REAL NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0.0 AND confidence <= 1.0),
  level             entity_level NOT NULL DEFAULT 'project',

  -- 审查状态
  status            review_status NOT NULL DEFAULT 'pending',
  reviewed_by       UUID,                                 -- 审核人 ID
  review_notes      TEXT,                                 -- 审核意见/驳回原因

  -- 时间戳
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at       TIMESTAMPTZ                           -- 审核完成时间
);
```

**审查生命周期**:

```
Agent/爬虫写入 → status='pending'
  → 人类审核:
      ✓ approve → status='approved' → content 写入 wiki/ → 索引更新
      ✗ reject  → status='rejected' → 保留记录，不写文件
      ↩ revision → status='revision_requested' → 创建 Issue 分配回写入者
```

---

## 4. 索引策略

### 4.1 主索引

```sql
-- wiki_entities: HNSW 向量索引（支持高效 ANN 搜索）
-- m=16: 每个节点最大连接数（默认值，适合百万级数据）
-- ef_construction=200: 构建时搜索深度（越高索引质量越好，构建越慢）
CREATE INDEX wiki_entities_embedding_idx ON wiki_entities
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- wiki_entities: 按项目过滤 + 按新鲜度排序
CREATE INDEX wiki_entities_project_level_idx ON wiki_entities (project_id, level)
  WHERE level = 'project';

-- wiki_entities: 按公司级 + 新鲜度排序
CREATE INDEX wiki_entities_company_level_idx ON wiki_entities (freshness_score)
  WHERE level = 'company';

-- wiki_entities: GIN 索引用于 used_for 数组查询
-- gin__int_ops 支持以下操作符:
--   @> ARRAY['bug-fix']  -- used_for 包含 bug-fix
--   && ARRAY['bug-fix','deployment']  -- used_for 与给定数组有交集
CREATE INDEX wiki_entities_used_for_idx ON wiki_entities USING gin (used_for);

-- wiki_entities: 文件同步时间索引（用于检测需要重新索引的文件）
CREATE INDEX wiki_entities_file_updated_idx ON wiki_entities (file_updated);

-- knowledge_sources: 按频率查询启用的源
CREATE INDEX knowledge_sources_frequency_idx ON knowledge_sources (crawl_frequency, enabled)
  WHERE enabled = true;

-- knowledge_reviews: 按状态查询待审核项
CREATE INDEX knowledge_reviews_status_idx ON knowledge_reviews (status, created_at)
  WHERE status IN ('pending', 'revision_requested');

-- knowledge_reviews: 按来源类型查询
CREATE INDEX knowledge_reviews_source_idx ON knowledge_reviews (source_type, status);
```

### 4.2 索引优化说明

| 索引 | 类型 | 覆盖的查询 |
|------|------|-----------|
| `embedding_idx` | HNSW | 语义搜索: `ORDER BY embedding <=> $1 LIMIT 5` |
| `project_level_idx` | 部分索引 | 按项目过滤: `WHERE level='project' AND project_id=$1` |
| `company_level_idx` | 部分索引 | 公司级知识排序: `WHERE level='company' ORDER BY freshness_score` |
| `used_for_idx` | GIN | 经验推荐: `WHERE 'bug-fix' = ANY(used_for)` |
| `frequency_idx` | 部分索引 | 巡检任务: `WHERE enabled=true ORDER BY crawl_frequency` |
| `status_idx` | 部分索引 | 审查队列: `WHERE status='pending' ORDER BY created_at` |

### 4.3 HNSW 参数调优建议

```sql
-- 查看当前索引大小和性能
SELECT
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE indexrelname LIKE '%embedding%';

-- 生产环境调优（10万+ 实体时）
-- SET hnsw.ef_search = 100;  -- 查询时搜索深度（默认40，提高可改善召回率）
```

---

## 5. 查询模式

### 5.1 语义搜索 + 权限过滤

```sql
-- 最常用的查询：Agent 检索知识
SELECT
  entity_name,
  file_path,
  level,
  confidence,
  verified,
  use_count,
  used_for,
  1 - (embedding <=> $1::vector) AS similarity
FROM wiki_entities
WHERE
  1 - (embedding <=> $1::vector) > 0.75                    -- 相似度阈值
  AND (
    level = 'company'
    OR (level = 'project' AND project_id = $2::uuid)       -- 权限过滤
  )
  AND file_path IS NOT NULL                                -- 排除已删除的文件
ORDER BY embedding <=> $1::vector
LIMIT 5;
```

### 5.2 经验推荐（按任务类型）

```sql
-- 按 used_for 标签 + 引用频次排序
SELECT
  entity_name,
  file_path,
  use_count,
  used_for,
  EXTRACT(DAY FROM (now() - last_used)) AS days_since_used,
  use_count * (1.0 / GREATEST(1, EXTRACT(DAY FROM (now() - last_used)))) AS experience_score
FROM wiki_entities
WHERE
  used_for && $1::text[]                                    -- 标签有交集
  AND (
    level = 'company'
    OR (level = 'project' AND project_id = $2::uuid)
  )
ORDER BY experience_score DESC
LIMIT 3;
```

### 5.3 去重检测（两路召回已合并为单查询）

```sql
-- 用 entity_name 模糊匹配 + 语义相似度联合去重
WITH name_match AS (
  SELECT id, entity_name, file_path, 1.0 AS score
  FROM wiki_entities
  WHERE lower(regexp_replace(entity_name, '[^a-zA-Z0-9一-鿿]', '', 'g'))
        = lower(regexp_replace($1, '[^a-zA-Z0-9一-鿿]', '', 'g'))
  LIMIT 1
),
semantic_match AS (
  SELECT id, entity_name, file_path,
         1 - (embedding <=> $2::vector) AS score
  FROM wiki_entities
  WHERE 1 - (embedding <=> $2::vector) > 0.85
  ORDER BY embedding <=> $2::vector
  LIMIT 1
)
SELECT * FROM name_match
UNION ALL
SELECT * FROM semantic_match
WHERE NOT EXISTS (SELECT 1 FROM name_match)
LIMIT 1;
```

### 5.4 新鲜度巡检

```sql
-- 查找超过 90 天未更新的实体
SELECT
  entity_name,
  file_path,
  file_updated,
  use_count,
  EXTRACT(DAY FROM (now() - file_updated)) AS days_stale
FROM wiki_entities
WHERE
  file_updated < now() - INTERVAL '90 days'
  AND level IN ('project', 'company')
ORDER BY days_stale DESC;
```

### 5.5 生命周期检测

```sql
-- 检测需要提升的项目级实体（被 3+ 项目引用）
SELECT
  e.entity_name,
  e.file_path,
  COUNT(DISTINCT e2.project_id) AS cross_project_refs,
  array_agg(DISTINCT e2.project_id) AS projects
FROM wiki_entities e
JOIN wiki_entities e2 ON e2.file_path = ANY(ARRAY(
  SELECT 'wiki/' || unnest(string_to_array(
    regexp_replace(
      pg_read_file(e.file_path),  -- 简化示例；实际通过应用层解析 [[链接]]
      '^.*\[\[([^\]]+)\]\].*$', '\1', 'g'
    ), ','
  )) || '.md'
))
WHERE e.level = 'project'
GROUP BY e.id, e.entity_name, e.file_path
HAVING COUNT(DISTINCT e2.project_id) >= 3;
```

### 5.6 审查队列排序

```sql
-- 待审核条目按"可信度 × 等待时间"排序
SELECT
  entity_name,
  source_type,
  confidence,
  EXTRACT(HOUR FROM (now() - created_at)) AS waiting_hours,
  confidence * EXTRACT(HOUR FROM (now() - created_at)) AS priority_score
FROM knowledge_reviews
WHERE status = 'pending'
ORDER BY priority_score DESC
LIMIT 20;
```

### 5.7 爬虫源健康检查

```sql
-- 查找本周应该爬但还没爬的源
SELECT
  name,
  url,
  crawl_frequency,
  last_crawled,
  CASE crawl_frequency
    WHEN 'daily' THEN last_crawled < now() - INTERVAL '1 day'
    WHEN 'weekly' THEN last_crawled < now() - INTERVAL '7 days'
    WHEN 'monthly' THEN last_crawled < now() - INTERVAL '30 days'
    ELSE false
  END AS overdue
FROM knowledge_sources
WHERE enabled = true;
```

---

## 6. 迁移方案

### 6.1 首次部署

```sql
-- 迁移文件: packages/db/src/migrations/0084_wiki_engine.sql

-- 1. 启用扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 创建枚举类型
CREATE TYPE entity_level AS ENUM ('personal', 'project', 'company');
CREATE TYPE source_type AS ENUM ('blog', 'docs', 'github', 'forum', 'paper', 'rss', 'slack', 'custom');
CREATE TYPE crawl_frequency AS ENUM ('daily', 'weekly', 'monthly', 'manual');
CREATE TYPE review_source_type AS ENUM ('agent', 'crawler', 'manual');
CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected', 'revision_requested');

-- 3. 创建表
-- (执行上面 §3.1 - §3.3 的 CREATE TABLE 语句)

-- 4. 创建索引
-- (执行上面 §4.1 的 CREATE INDEX 语句)
```

### 6.2 从现有环境升级

当前 Docker 容器是 `postgres:16-alpine`，需替换为 `pgvector/pgvector:pg16`：

```bash
# docker-compose.selfhost.yml 或 docker-compose.yml 中修改:
db:
  image: pgvector/pgvector:pg16  # 替换 postgres:16-alpine
  # 其他配置不变 ——端口、用户名、密码、数据卷
```

### 6.3 数据回填

首次部署后，需要将已有 vault 中的 `.md` 文件索引到 `wiki_entities`:

```typescript
// server/src/services/obsidian-wiki/utils/bootstrap.ts
export async function bootstrapVaultIndex(vaultRoot: string, db: Db): Promise<void> {
  const wikiDir = path.join(vaultRoot, 'wiki');
  const files = await glob('**/*.md', { cwd: wikiDir });

  for (const file of files) {
    const fullPath = path.join(wikiDir, file);
    const content = await fs.readFile(fullPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);

    // 生成 embedding
    const text = content.slice(0, 8000); // 截断到 embedding 模型上限
    const embedding = await generateEmbedding(text);

    await db.insert(wikiEntities).values({
      entity_name: path.basename(file, '.md'),
      file_path: `wiki/${file}`,
      level: frontmatter.level ?? 'project',
      project_id: frontmatter.project_id ?? null,
      embedding,
      confidence: frontmatter.confidence ?? 0.5,
      verified: frontmatter.verified ?? false,
      use_count: frontmatter.use_count ?? 0,
      used_for: frontmatter.used_for ?? [],
      file_updated: (await fs.stat(fullPath)).mtime,
    }).onConflictDoUpdate({
      target: wikiEntities.file_path,
      set: { embedding, file_updated: new Date() },
    });
  }
}
```

---

## 7. 性能基准

### 7.1 预估数据量

| 环境 | 实体数 | 源数 | 每实体平均大小 |
|------|--------|------|---------------|
| 小型团队 | 100-500 | 5-10 | 2KB |
| 中型团队 | 500-5,000 | 10-30 | 3KB |
| 大型团队 | 5,000-50,000 | 30-100 | 5KB |

### 7.2 索引存储预估

| 实体数 | embedding 索引 (HNSW) | 其他索引 | 总存储 |
|--------|----------------------|---------|--------|
| 1,000 | ~6MB | ~1MB | ~7MB |
| 10,000 | ~60MB | ~10MB | ~70MB |
| 100,000 | ~600MB | ~100MB | ~700MB |

**计算公式**: `1536 维 × 4 字节 × 实体数 × (1 + HNSW 开销 ~1.5×) ≈ 9.2KB/实体`

### 7.3 查询性能预估（10,000 实体、HNSW ef_search=40）

| 查询类型 | 预期延迟 | 说明 |
|----------|---------|------|
| 语义搜索 (Top 5) | < 20ms | 纯 HNSW 近似搜索 |
| 语义搜索 + 权限过滤 | < 50ms | HNSW → filter（PostgreSQL 自动优化） |
| 经验推荐 | < 10ms | GIN 数组索引 + 简单排序 |
| 去重检测 | < 30ms | CTE + 精确匹配（微秒）+ 语义搜索（毫秒） |
| 新鲜度巡检 | < 100ms | 部分索引 + WHERE file_updated < 阈值 |
| 审查队列 | < 10ms | 部分索引 + ORDER BY |

---

## 8. 安全与备份

### 8.1 行级安全（可选）

如果需要更强的层级隔离，可以启用 PostgreSQL 行级安全策略:

```sql
-- 为 Agent 检索启用 RLS
ALTER TABLE wiki_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_project_access ON wiki_entities
  FOR SELECT
  USING (
    level = 'company'
    OR (level = 'project' AND project_id = current_setting('app.current_project_id')::uuid)
  );
```

注: RLS 需要每个查询前设置 `app.current_project_id` 参数，增加复杂度。当前设计通过应用层 WHERE 子句实现过滤，暂不启用 RLS。  # SQL 注入注意避开

### 8.2 备份策略

```bash
# 备份 PG 数据（含向量索引）
pg_dump -h 127.0.0.1 -p 5433 -U binguo -d paperclip \
  --table=wiki_entities \
  --table=knowledge_sources \
  --table=knowledge_reviews \
  > wiki-engine-backup-$(date +%Y%m%d).sql

# 备份 vault 文件（由 Obsidian Git 插件自动处理）
# vault 和 PG 备份同时进行，确保一致性
```

### 8.3 灾难恢复

```
场景 1: PG 数据丢失，vault 完好
  → bootstrapVaultIndex() 重建全部索引

场景 2: vault 文件丢失，PG 完好
  → git restore vault/
  → pgvector 索引自动与 file_updated 比对，增量重建

场景 3: 全部丢失
  → 恢复 PG 备份
  → git clone vault
  → bootstrapVaultIndex() 完整性修复
```

---

## 附录 A: Drizzle ORM Schema 定义

```typescript
// packages/db/src/schema/wiki-engine.ts

import {
  pgTable, uuid, text, real, boolean, integer,
  timestamp, jsonb, uniqueIndex, index, pgEnum,
} from "drizzle-orm/pg-core";

// 枚举
export const entityLevelEnum = pgEnum("entity_level", ["personal", "project", "company"]);
export const sourceTypeEnum = pgEnum("source_type", ["blog", "docs", "github", "forum", "paper", "rss", "slack", "custom"]);
export const crawlFrequencyEnum = pgEnum("crawl_frequency", ["daily", "weekly", "monthly", "manual"]);
export const reviewSourceTypeEnum = pgEnum("review_source_type", ["agent", "crawler", "manual"]);
export const reviewStatusEnum = pgEnum("review_status", ["pending", "approved", "rejected", "revision_requested"]);

// wiki_entities
export const wikiEntities = pgTable("wiki_entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityName: text("entity_name").notNull(),
  filePath: text("file_path").notNull().unique(),
  level: entityLevelEnum("level").notNull().default("project"),
  projectId: uuid("project_id"),
  createdBy: uuid("created_by"),
  embedding: text("embedding"),  // Drizzle 不原生支持 pgvector，用 text + raw SQL
  confidence: real("confidence").notNull().default(0.5),
  verified: boolean("verified").notNull().default(false),
  freshnessScore: real("freshness_score").notNull().default(1.0),
  useCount: integer("use_count").notNull().default(0),
  usedFor: text("used_for").array().notNull().default(sql`'{}'`),
  lastUsed: timestamp("last_used", { withTimezone: true }),
  fileUpdated: timestamp("file_updated", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// knowledge_sources
export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  sourceType: sourceTypeEnum("source_type").notNull().default("blog"),
  collectorName: text("collector_name").notNull().default("WebCrawler"),
  crawlFrequency: crawlFrequencyEnum("crawl_frequency").notNull().default("weekly"),
  trustWeight: real("trust_weight").notNull().default(0.5),
  lastCrawled: timestamp("last_crawled", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  articleSelector: text("article_selector"),
  sitemapUrl: text("sitemap_url"),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  crawlConfig: jsonb("crawl_config").notNull().default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  nameUrlIdx: uniqueIndex("knowledge_sources_name_url_idx").on(table.name, table.url),
}));

// knowledge_reviews
export const knowledgeReviews = pgTable("knowledge_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityName: text("entity_name").notNull(),
  filePath: text("file_path").notNull(),
  sourceType: reviewSourceTypeEnum("source_type").notNull(),
  sourceId: text("source_id"),
  content: text("content").notNull(),
  existingContent: text("existing_content"),
  confidence: real("confidence").notNull().default(0.5),
  level: entityLevelEnum("level").notNull().default("project"),
  status: reviewStatusEnum("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by"),
  reviewNotes: text("review_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});
```

## 附录 B: pgvector 原始 SQL 封装

```typescript
// server/src/services/obsidian-wiki/utils/embed.ts

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

const EMBEDDING_DIM = 1536;

/** 语义搜索 */
export async function semanticSearch(
  db: Db,
  embedding: number[],
  opts: { limit?: number; threshold?: number; projectId?: string },
) {
  const limit = opts.limit ?? 5;
  const threshold = opts.threshold ?? 0.75;
  const embeddingStr = `[${embedding.join(",")}]`;

  const rows = await db.execute<{
    entity_name: string;
    file_path: string;
    similarity: number;
    confidence: number;
    verified: boolean;
    use_count: number;
    used_for: string[];
  }>(sql`
    SELECT entity_name, file_path,
           1 - (embedding <=> ${sql.raw(embeddingStr)}::vector) AS similarity,
           confidence, verified, use_count, used_for
    FROM wiki_entities
    WHERE 1 - (embedding <=> ${sql.raw(embeddingStr)}::vector) > ${threshold}
      AND file_path IS NOT NULL
      ${opts.projectId
        ? sql`AND (level = 'company' OR (level = 'project' AND project_id = ${opts.projectId}::uuid))`
        : sql`AND level = 'company'`}
    ORDER BY embedding <=> ${sql.raw(embeddingStr)}::vector
    LIMIT ${limit}
  `);

  return rows;
}

/** 插入或更新向量索引 */
export async function upsertEmbedding(
  db: Db,
  filePath: string,
  embedding: number[],
) {
  const embeddingStr = `[${embedding.join(",")}]`;
  await db.execute(sql`
    UPDATE wiki_entities
    SET embedding = ${sql.raw(embeddingStr)}::vector,
        file_updated = now(),
        updated_at = now()
    WHERE file_path = ${filePath}
  `);
}
```
