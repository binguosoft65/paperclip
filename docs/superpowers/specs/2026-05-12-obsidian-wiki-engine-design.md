# Obsidian LLM-Wiki 知识引擎 设计规格

## 概述

将 Paperclip Agent 从"任务执行者"升级为"知识编辑者"。以本地 Obsidian vault 为唯一真实源，pgvector 为语义索引，Agent 在工作流中自动检索、引用、维护知识库。零散笔记 → 结构化互联百科，知识随使用不断进化。

## 需求总览

| # | 需求 | 决策 |
|---|------|------|
| 1 | 实体存储 | Obsidian vault（本地目录），Markdown + YAML frontmatter。pgvector 仅存向量不存原文 |
| 2 | 处理模式 | 一入一出——每次处理一个新文件+一个已有实体，避免 token 爆炸 |
| 3 | 触发时机 | 自动归档（任务完成写入 inbox）+ 定期巡检（Routine 触发审计）+ 手动 Issue |
| 4 | 知识消费 | Obsidian 深度编辑 + Paperclip Web UI 快速查阅 |
| 5 | 知识层级 | 个人级 / 项目级 / 公司级，三层权限隔离 |
| 6 | 写入审核 | Agent 自评可信度（低→`## 争议/待核实`）+ 人工"已验证"标签 |
| 7 | 新鲜度管理 | 巡检标记过期实体 + 引用时评估时效 |
| 8 | 知识生命周期 | 提升（项目→公司）、分裂（过大→拆分）、合并（相似→去重） |
| 9 | 版本回滚 | Obsidian Git 插件管理，本系统不介入 |
| 10 | 技术栈 | TypeScript，集成 `server/src/services/obsidian-wiki/`，复用 Paperclip 的 DB/LLM/logger |
| 11 | Agent 自动检索 | 任务开始时语义搜索，结果注入 Agent 上下文。受知识层级权限限制 |
| 12 | 检索反馈闭环 | 用后评价→权重升降→驱动刷新 |
| 13 | 引证溯源 | Agent 输出附 `[[实体名]]` 链接，决策可追溯 |
| 14 | 知识热度统计 | Dashboard 展示引用频次、未使用实体、过期实体，驱动巡检优先级 |
| 15 | 用途标签与推荐 | 任务类型→知识映射。下次同类任务自动推荐历史上最常用的知识项 |
| 16 | 爬虫与知识采集 | 源管理系统 + 三层采集策略（种子源→外链扩展→按需搜索）+ HTML→MD 管道 + 质量过滤 |
| 17 | 知识审查队列 | 统一审查 UI —— Agent 写入和爬虫采集的内容汇聚到审查队列；支持批准/驳回/批量审批 |
| 18 | 知识模板系统 | 5 种模板（概念/工具/流程/故障/决策），LLM 按内容类型自动匹配；用户可扩展 |
| 19 | 外部源集成接口 | `KnowledgeCollector` 可插拔接口：WebCrawler、RSS、GitHub、arXiv，Plugin 系统可注册自定义采集器 |

## 架构

```
Paperclip Agent（心跳驱动）
       │
       ▼
┌──────────────────────────────────────────────┐
│          obsidian-wiki 知识引擎               │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ 合成管道  │ │ 双链引擎  │ │ 用途推荐引擎 │  │
│  │ extract  │ │ forward  │ │ labelTask   │  │
│  │ +dedup   │ │ +backref │ │ +recommend  │  │
│  │ +merge   │ │          │ │             │  │
│  └──────────┘ └──────────┘ └─────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ 检索服务  │ │ 新鲜度    │ │ 生命周期     │  │
│  │ semantic │ │ freshness│ │ lifecycle   │  │
│  │ search   │ │ check    │ │ manage      │  │
│  └──────────┘ └──────────┘ └─────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ 爬虫采集  │ │ 审查队列  │ │ 模板引擎     │  │
│  │ crawler  │ │ review   │ │ templates   │  │
│  │ +quality │ │ queue    │ │ +match      │  │
│  └──────────┘ └──────────┘ └─────────────┘  │
│  ┌──────────────────────────────────────┐   │
│  │  外部源集成 (KnowledgeCollector)      │   │
│  │  WebCrawler │ RSS │ GitHub │ arXiv   │   │
│  └──────────────────────────────────────┘   │
└──────────────┬───────────────────────────────┘
               │
     ┌─────────┴─────────┐
     ▼                   ▼
┌─────────┐      ┌──────────┐
│Obsidian │      │ pgvector │
│  Vault  │      │ Postgres │
│ (.md)   │      │ (向量索引)│
└─────────┘      └──────────┘
```

Obsidian vault 是唯一真实源。pgvector 仅存向量索引，不存原文。所有内容以 Markdown 文件为准，Agent 直接读写 `.md`。

## 核心组件

### 1. 合成管道

```
inbox/新笔记.md [+ wiki/目标实体.md(如果存在)]
  → Phase 1: LLM 实体提取（JSON 输出）
  → Phase 2: 去重决策（精确文件名 + pgvector 语义相似度>0.85）
  → Phase 3: LLM 合成（遵循编辑指南 prompt）
  → Phase 4: 双链 + 反向引用 + pgvector 索引更新
  → 输出: wiki/实体.md
```

**一入一出原则**: 每次只处理一个新文件+一个已有实体（如果有），不批量处理。Token 开销可控，合并逻辑简单。

**去重双路召回**:
- 精确路径：实体名标准化（小写、去空格、去特殊符号）→ 文件名匹配
- 语义路径：pgvector `cosine_similarity > 0.85`
- 精确命中优先；语义命中时提示 Agent 判断是否合并

**可信度模型**:
- Agent 写入时自评可信度（0.0~1.0），写入 YAML `confidence:` 字段
- 低于阈值（默认 0.7）的内容自动进入 `## 争议/待核实`
- 人类可通过 Obsidian 或 Paperclip Web UI 添加 `verified: true`

### 2. 双链引擎

**正向链接**: 合成后由 LLM 扫描正文，匹配 `wiki/` 目录下的实体名，包裹 `[[WikiLink]]`。只链接实际存在的实体。

**反向引用**: 解析 `[[链接]]` → 检查目标文件是否含有回链 → 缺失则在 `## 相关` 节追加。纯文本处理，无需 LLM。

**死链检测**: 定期巡检时扫描死链 → 创建 Issue 提示人工决策（删除/重建/重命名）。

### 3. Agent 知识检索

**触发**: Agent checkout 任务后、执行动作前。

**检索策略**——两路召回合并:
1. **语义搜索**: 任务描述 → embedding → pgvector 余弦搜索
2. **经验推荐**: 任务标签匹配知识实体的 `used_for` 字段，按"被引用次数 × 最近引用时间"加权

**检索范围**: 受知识层级权限控制——项目级 Agent 只能搜公司级 + 所属项目级知识。

**上下文注入**: 检索结果格式化为 Markdown 片段，注入 Agent 的 system prompt 或工具返回中。

### 4. 用途标签与推荐

每个知识实体的 YAML frontmatter 新增:
```yaml
used_for:
  - deployment
  - database-migration
last_used: 2026-05-12
use_count: 7
```

Agent 完成任务后评估哪些知识项对本次任务有帮助，更新对应实体的 `used_for` 和 `use_count`。

### 5. 新鲜度管理

| 机制 | 触发 | 动作 |
|------|------|------|
| 定时巡检 | Routine 每周触发 | 扫描 `updated` 超过 N 天的实体，生成审计 Issue |
| 引用评估 | Agent 每次检索时 | 判断检索结果时效性；过期则标记并降低本次排序权重 |
| 过期信号 | `freshness_score < threshold` | `## 争议/待核实` 追加"此条目可能已过时"标记 |

### 6. 知识生命周期

| 操作 | 触发条件 | 行为 |
|------|----------|------|
| 提升（Promote） | 项目级知识被 ≥3 个项目引用 | Agent 建议提升到公司级，创建 Issue 待人工确认 |
| 分裂（Split） | 实体超过 2000 字或含 ≥5 个独立子话题 | Agent 建议拆分为多个子实体 |
| 合并（Merge） | pgvector 检测到两个实体相似度 > 0.9 | Agent 建议合并去重 |

### 7. 触发时机在 Paperclip 中的落地

| 触发 | Paperclip 实现 |
|------|---------------|
| 自动归档 | Issue status→done → Agent 调用 `write_to_wiki` tool → 写入 inbox → 扫描器处理 |
| 定期巡检 | Routine (cron 每周) → 创建 Issue → Agent checkout → 审计 vault → 标记过期/死链 |
| 手动触发 | 用户创建 Issue "整理 knowledge/微服务" → Agent checkout → 处理指定目录 → commit |

## 编辑指南（AI Editor Prompt）

合成阶段 Phase 3 传给 LLM 的系统 prompt。核心约束:
- 每个文件必须有 YAML frontmatter（tags, aliases, created, updated, confidence, verified, used_for）
- 保留旧文件中有价值的内容，不覆盖式删除
- 冲突不进正文，放入 `## 争议/待核实`
- 必须包含 `## 概述`、`## 核心要点`、`## 细节`、`## 相关`、`## 来源`
- `## 相关` 至少 2 个已有实体的 [[WikiLink]]
- 正文用中文，专业术语保留英文

完整 prompt 见 `prompts/editor.ts`。

## 数据模型

### wiki_entities（pgvector）

| 列 | 类型 | 说明 |
|----|------|------|
| id | uuid | 主键 |
| entity_name | text | 规范化实体名 |
| file_path | text | vault 内相对路径 |
| embedding | vector(1536) | OpenAI text-embedding-3-small |
| level | enum | personal / project / company |
| project_id | uuid? | 项目级/公司级关联 |
| confidence | float | Agent 自评可信度 0-1 |
| verified | boolean | 人工已验证 |
| freshness_score | float | 新鲜度评分 |
| use_count | integer | 被引用次数 |
| used_for | text[] | 用途标签数组 |
| updated_at | timestamptz | 文件最后修改时间 |
| created_at | timestamptz | 首次创建时间 |

### knowledge_sources（知识源）

| 列 | 类型 | 说明 |
|----|------|------|
| id | uuid | 主键 |
| name | text | 源名称 |
| url | text | 源 URL |
| source_type | enum | blog / docs / github / forum / paper / rss / slack / custom |
| collector_name | text | 匹配 KnowledgeCollector.name |
| crawl_frequency | enum | daily / weekly / monthly / manual |
| trust_weight | real | 该源的可信度权重 |
| last_crawled | timestamptz | 上次爬取时间 |
| article_selector | text | CSS 选择器提取正文 |
| sitemap_url | text | RSS/sitemap URL |
| enabled | boolean | 是否启用 |

### knowledge_reviews（审查队列）

| 列 | 类型 | 说明 |
|----|------|------|
| id | uuid | 主键 |
| entity_name | text | 实体名 |
| source_type | enum | agent / crawler / manual |
| content | text | 待审核的 Markdown |
| confidence | real | Agent 自评可信度 |
| status | enum | pending / approved / rejected / revision_requested |
| reviewed_by | uuid | 审核人 |

### Markdown YAML Frontmatter

```yaml
tags: [deployment, kubernetes]
aliases: [k8s-deploy, deploy-flow]
created: 2026-05-01
updated: 2026-05-12
confidence: 0.9
verified: false
used_for: [deployment, infrastructure]
use_count: 4
```

## 文件结构

```
server/src/services/obsidian-wiki/
├── engine.ts          # process(inboxFile) → outputPath 主入口
├── scanner.ts         # chokidar 文件监控（inbox/ 变更触发处理）
├── extractor.ts       # Phase 1: LLM 实体提取
├── dedup.ts           # Phase 2: pgvector 去重决策
├── synthesizer.ts     # Phase 3: LLM 合成（注入编辑指南 prompt）
├── linker.ts          # Phase 4: 双链 + 反向引用
├── retriever.ts       # Agent 知识检索（语义搜索 + 经验推荐，两路合并）
├── freshness.ts       # 新鲜度巡检 + 引用评估
├── lifecycle.ts       # 提升/分裂/合并生命周期管理
├── templates.ts       # 内容类型识别 + 模板匹配
├── review.ts          # 审查队列管理
├── sources.ts         # 源管理（CRUD + 检测 RSS/sitemap + 频率调度）
├── collectors/
│   ├── interface.ts   # KnowledgeCollector 接口定义
│   ├── registry.ts    # Collector 注册表（Plugin 系统集成）
│   ├── web-crawler.ts # WebCrawler: HTML→MD + 质量过滤 + 礼貌策略
│   ├── rss-collector.ts  # RSSCollector: Feed 订阅解析
│   └── github-collector.ts # GitHubCollector: Discussions/Issues
├── prompts/
│   ├── editor.ts      # 编辑指南 prompt（导出为字符串常量）
│   ├── extractor.ts   # 实体提取 prompt
│   └── quality.ts     # 内容质量过滤 prompt
├── utils/
│   ├── fs.ts          # gray-matter 解析/写入 YAML frontmatter
│   ├── embed.ts       # embedding 生成 + pgvector upsert/search
│   └── names.ts       # 实体名标准化
├── types.ts           # Entity, WikiFile, RawNote, CollectorConfig 等类型
└── __tests__/         # vitest 测试
```

## 关键技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| Embedding 模型 | OpenAI text-embedding-3-small | 1536 维，够用且成本低 |
| 向量存储 | pgvector (Docker pgvector/pgvector:pg16) | 零新服务，SQL+向量混查 |
| 向量索引 | HNSW | 百万级以内性能最优 |
| LLM 客户端 | 复用 Paperclip 已有的 Anthropic SDK | 不引入新依赖 |
| Markdown 解析 | gray-matter | 轻量（2KB），npm 成熟 |
| 文件监控 | chokidar | Node.js 生态标准 |

## 安全约束

- Agent 只能访问其知识层级及以下的内容（个人→项目→公司）
- 写入受可信度+审核流程双重门控
- vault 路径沙箱化——只允许在配置的根目录内读写
- 向量索引和生产数据库同实例但不同 schema
