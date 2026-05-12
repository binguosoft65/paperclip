# Obsidian LLM-Wiki 知识引擎 PRD

**产品名称**: Paperclip × Obsidian LLM-Wiki 知识引擎
**版本**: v1.0
**状态**: 设计中
**作者**: Paperclip 架构组
**日期**: 2026-05-12

---

## 目录

1. [产品愿景与目标](#1-产品愿景与目标)
2. [用户画像](#2-用户画像)
3. [用户故事](#3-用户故事)
4. [功能需求](#4-功能需求)
   - [F1: 知识合成管道](#f1-知识合成管道)
   - [F2: Agent 知识检索](#f2-agent-知识检索)
   - [F3: 用途标签与知识推荐](#f3-用途标签与知识推荐)
   - [F4: 新鲜度管理](#f4-新鲜度管理)
   - [F5: 知识生命周期](#f5-知识生命周期)
   - [F6: 知识消费（Web UI）](#f6-知识消费web-ui)
   - [F7: 知识层级与权限](#f7-知识层级与权限)
   - [F8: 触发时机](#f8-触发时机)
   - [F9: 爬虫与知识采集](#f9-爬虫与知识采集)
   - [F10: 知识审查队列](#f10-知识审查队列)
   - [F11: 知识模板系统](#f11-知识模板系统)
   - [F12: 外部源集成接口](#f12-外部源集成接口)
5. [非功能需求](#5-非功能需求)
6. [系统架构](#6-系统架构)
7. [数据模型](#7-数据模型)
8. [API 契约](#8-api-契约)
9. [UI/UX 规范](#9-uiux-规范)
10. [与 Paperclip 集成规范](#10-与-paperclip-集成规范)
11. [安全与权限模型](#11-安全与权限模型)
12. [分阶段实施计划](#12-分阶段实施计划)
13. [验收标准](#13-验收标准)
14. [附录](#14-附录)

---

## 1. 产品愿景与目标

### 1.1 愿景

将 Paperclip Agent 从"任务执行者"升级为"**组织的知识首席编辑**"。每个 Agent 完成任务后自动将经验沉淀为结构化的互联知识；每个 Agent 开始新任务前自动检索历史积累的智慧。知识不再是静态文档，而是在 Agent 的日常工作中**生长、演变、复用**的活体。

### 1.2 核心目标

| 目标 | 衡量标准 |
|------|----------|
| 知识沉淀自动化 | 任务完成后知识写入率 ≥ 80%（Agent 无需人工提醒即自动归档经验） |
| 知识复用效率 | 同类任务 Agent 首次解决时间缩短 ≥ 30%（靠历史知识推荐） |
| 知识质量 | 人工审核通过率 ≥ 70%（可信度自评 ≥ 0.8 的内容经审核后标记"已验证"的比例） |
| 知识覆盖面 | 每个活跃项目 ≥ 10 篇知识实体；公司级 ≥ 50 篇核心知识 |

### 1.3 核心原则

1. **Obsidian 是唯一真实源。** 所有知识以 `.md` 文件形式存储在 Obsidian vault。pgvector 只存向量索引。文件系统挂掉可以重建索引；索引丢了可以从文件重建。
2. **一入一出。** Agent 每次只处理一个实体，避免 token 爆炸。这是 LLM 能力边界内最可靠的处理粒度。
3. **知识靠用进废退。** 引用频次驱动权重，权重驱动巡检优先级。不靠人工逐一审查维持质量。
4. **可追溯是信任的基础。** Agent 的每个决策引用必须可追溯到来源知识实体。

---

## 2. 用户画像

### 2.1 核心用户

| 角色 | 描述 | 核心场景 |
|------|------|----------|
| **开发者 Agent** | Paperclip 任务执行者（Coder Agent 等） | 执行任务前搜索知识库；完成后写入经验 |
| **技术负责人** | 人类或 AI Manager | 审核知识质量；管理知识层级（提升/合并/分裂） |
| **知识管理员** | 可能是人类或专门的 Curator Agent | 定期巡检 vault；处理过期标记；维护知识结构 |
| **团队成员** | 人类开发者 | 在 Obsidian 中深度编辑知识；在 Paperclip Web UI 中快速查阅 |

### 2.2 用户痛点

| 痛点 | 当前状态 | 目标状态 |
|------|----------|----------|
| 每次遇到相同问题都要重新 Google/问 Agent | Agent 无记忆，每次从零开始 | Agent 自动检索历史经验，同类问题秒级定位 |
| 任务完成后经验流失 | Agent 做完就结束，不留下任何沉淀 | 自动提取、合入知识库 |
| 笔记越来越多但越来越乱 | Inbox 堆满零散笔记，无人整理 | AI 自动将零散笔记合成为结构化实体 |
| 知道某处有相关知识但找不到 | grep 全文搜索，精度低 | 语义搜索 + 用途标签双路推荐 |

---

## 3. 用户故事

### 3.1 Agent 执行视角

**US-01**: 作为 Coder Agent，我在 checkout 一个新 Issue 后，系统自动用 Issue 描述做语义搜索，将最相关的 3-5 篇知识实体注入我的上下文，这样我不需要主动去"搜"知识，知识自己来找我。

**US-02**: 作为 Coder Agent，当我完成任务后，我自动提取本次任务的关键经验（成功的模式、踩过的坑、学到的规则），将其写入 `inbox/` 目录。系统后台会把它合成到正确的实体中。

**US-03**: 作为 Coder Agent，当我引用某篇知识来解决当前问题时，我在 Issue comment 中用 `[[实体名]]` 标注引用来源，让人类能追溯我的决策依据。

**US-04**: 作为 Coder Agent，当我在执行过程中发现引用的知识已经过时（比如文档里记录的配置方式在最新版本不再有效），我会自动标记该实体需要刷新，并附上具体的过时原因。

### 3.2 知识管理视角

**US-05**: 作为知识管理员，我定期收到系统生成的"知识巡检报告"——哪些实体从未被使用、哪些正在过期、哪些需要拆分。我可以一键创建对应的整理 Issue 分配给 Curator Agent。

**US-06**: 作为技术负责人，当一篇项目级知识被 3 个以上的项目引用时，系统自动创建 Issue 建议我将其提升为公司级。我审核后一键确认。

**US-07**: 作为知识管理员，我在 Paperclip Web UI 中看到一个"热度 Dashboard"——按引用频次排序的实体列表，热度低且长期未更新的实体被高亮标记为需要审计。

### 3.3 团队协作视角

**US-08**: 作为团队成员，我在 Paperclip Web UI 中搜索"PostgreSQL 死锁"，系统返回语义匹配的知识条目，每条都标注了可信度评分和最后验证时间，我能快速判断哪条知识是可信的。

**US-09**: 作为团队成员，我在 Obsidian 中编辑一篇知识实体，修改后保存。下次 Agent 检索时自动使用最新版本。我不需要做任何额外操作，Obsidian 就是知识库的编辑器。

**US-10**: 作为团队新人，当我被分配第一个任务时，系统根据任务类型自动推荐了 5 篇相关知识——这些是之前完成同类任务的 Agent 最常引用的知识。我快速获得上下文而不需要去问老同事。

### 3.4 知识采集视角

**US-11**: 作为知识管理员，我在 Web UI 上添加一个博客源 `https://martinfowler.com`，系统自动检测到其 RSS feed，按我设定的频率每周抓取。新文章自动流入 inbox，经合成管道处理后成为可检索的实体。我不需要手动去"搬运"外部知识。

**US-12**: 作为 Curator Agent，我在每周巡检中自动扫描已配置的源，发现新内容后下载、清洗、转 Markdown、入 inbox。如果某篇文章与已有实体高度重复，我自动跳过；如果内容质量太低（评分 < 4），我丢弃并记录日志。

**US-13**: 作为技术负责人，我在审查队列中看到 5 条待审核的知识变更——3 条来自爬虫采集，2 条来自 Agent 任务归档。我快速查看每条的可信度和变更摘要，一键批量批准高质量条目，驳回一条低质量采集。

**US-14**: 作为第三方插件开发者，我实现了 `SlackThreadCollector`——一种新的知识采集器，自动将团队 Slack 频道中的技术讨论整理为知识笔记。通过 Paperclip 插件系统注册后，知识管理员就可以在源管理中添加 Slack 频道作为知识源。

---

## 4. 功能需求

### F1: 知识合成管道

#### F1.1 实体提取

**描述**: LLM 读取一篇新笔记（Markdown），提取其中包含的关键实体。

**输入**: 单篇 Markdown 笔记
**输出**: JSON 数组——每个实体包含 `name`、`type`、`claims`、`refs`

**类型枚举**:
- `concept` — 抽象概念（"CAP 定理"、"依赖注入"）
- `tool` — 工具/技术（"PostgreSQL"、"Kubernetes"）
- `person` — 人物（"某个关键贡献者"）
- `project` — 项目（"微服务 A 的遗留系统"）
- `process` — 流程/方法论（"部署流程"、"代码审查规范"）
- `rule` — 规则/教训（"端口 3100 不能和 nginx 冲突"）

#### F1.2 去重决策

**描述**: 判断新提取的实体是否已存在于 vault 中。

**算法**——双路召回:

```
路径 A（精确匹配）:
  entityName → 标准化（小写、去空格、去特殊字符）→
  查找 wiki/{normalized}.md 是否存在 → 命中则返回

路径 B（语义匹配）:
  entityName → embedding →
  SELECT * FROM wiki_entities
  WHERE 1 - (embedding <=> query_embedding) > 0.85
  ORDER BY embedding <=> query_embedding
  LIMIT 1 →
  命中则返回

决策:
  A 命中 → 直接 MERGE
  A 未命中 + B 命中 → 提示 Agent 判断（可能实体名不同但指同一事物）
  都未命中 → CREATE
```

#### F1.3 合成（Merge/Create）

**描述**: LLM 将新笔记中的信息合并到已有实体（或创建新实体）。

**输入**:
- 新笔记全文
- 已有实体全文（如果有）
- wiki/ 目录下所有实体名列表（用于双链）
- 编辑指南 prompt

**输出**: 更新后的 Markdown 实体文件

**冲突处理规则**:
1. 新旧信息冲突 → 不在正文中裁决，创建 `## 争议/待核实` 节，列出双方立场
2. 新信息补充旧信息 → 合并，保留旧内容的精华
3. 新信息覆盖旧信息 → 仅当旧信息明确"已过时/已废弃"时替换

**可信度自评**: Agent 在 frontmatter 写入 `confidence: 0.0～1.0`:
- 0.9+: 源自信任来源（如官方文档的直接引用）
- 0.7-0.9: 来自 Agent 自身的成功执行经验
- 0.5-0.7: 来自推断或间接证据
- < 0.5: 来自猜测或模糊回忆——不进知识库，写入 inbox 等待人工审核

#### F1.4 双链引擎

**正向链接**: 合成完成后，LLM 扫描正文，在 wiki/ 实体名列表中查找匹配项 → 包裹为 `[[实体名]]`。仅链接实际存在的实体。

**反向引用**: 纯文本操作（无需 LLM）:
1. 解析实体中的所有 `[[链接]]`
2. 对每个被链接的目标实体，检查是否包含回链
3. 缺失 → 在目标实体的 `## 相关` 节追加 `- [[源实体名]]`
4. 不触发递归：回链追加本身不触发新的链接检测

**死链检测**: 定期巡检任务（见 F4）→ 扫描所有实体的 `[[链接]]` → 对目标不存在的链接创建 Issue。

**实体改名**: 改名时自动维护 YAML `aliases` 保留旧名兼容。不自动改引用处——巡检时检测到别名引用再提示更新。

#### F1.5 编辑指南 Prompt

合成阶段 Phase 3 传给 LLM 的完整系统 prompt（内嵌到 `prompts/editor.ts`）:

```
## Role
你是 Obsidian 知识库的首席编辑。将新笔记合并到已有实体文件或创建新实体。

## Input
- 一篇新笔记（Markdown，可能零散、口语化）
- 一个现有实体文件（如果实体已存在），或者空
- wiki/ 目录下已有实体的文件名列表（用于创建 [[WikiLink]]）

## Rules

### YAML Frontmatter
每个文件顶部必须有 YAML frontmatter:
  tags: 1-3 个分类标签
  aliases: 其他常见名称列表
  created: 首次创建日期 (ISO)
  updated: 本次更新日期 (ISO)
  confidence: 可信度 0.0-1.0
  verified: false

### 合并逻辑
- 保留旧文件中仍正确的内容
- 新旧冲突 → ## 争议/待核实
- 更新过时内容时注明原因
- 正文不超过 2000 字，超出的折叠到子实体

### 结构规范
每个实体必须包含:
  ## 概述 — 1-2 句定义和重要性
  ## 核心要点 — 3-5 条子弹列表
  ## 细节 — 展开说明（如果存在）
  ## 相关 — 至少 2 个 [[WikiLink]]
  ## 来源 — 本次合并的来源笔记链接

### 双链规则
- 正文中识别已有实体 → 包裹 [[实体名]]
- 只链接实际存在的实体
- ## 相关 节至少 2 个已有实体链接

### 风格
- 简洁专业，中文撰写正文
- 专业术语保留英文原词
- 不用套话（"本文档将..."、"值得注意的是..."）
```

### F2: Agent 知识检索

#### F2.1 检索触发

**时机**: Agent checkout Issue 之后、执行任何动作之前。作为 `heartbeat-context` API 的一部分自动调用。

#### F2.2 检索算法——两路合并

**路径 A: 语义搜索**
```
Issue 标题 + 描述 → embedding(text-embedding-3-small) →
SELECT entity_name, file_path, level, confidence, verified,
       1 - (embedding <=> query_embedding) AS similarity
FROM wiki_entities
WHERE 1 - (embedding <=> query_embedding) > 0.75
  AND (level = 'company' OR (level = 'project' AND project_id = $current_project_id))
ORDER BY embedding <=> query_embedding
LIMIT 5
```

**路径 B: 经验推荐**
```
提取 Issue 的标签/类型（如 "bug-fix", "deployment"） →
SELECT entity_name, file_path, use_count, last_used,
       use_count * (1.0 / (1 + days_since_last_used)) AS experience_score
FROM wiki_entities
WHERE 'bug-fix' = ANY(used_for)
  AND (level = 'company' OR (level = 'project' AND project_id = $current_project_id))
ORDER BY experience_score DESC
LIMIT 3
```

**合并去重**: 两路结果按 `0.6 × similarity + 0.4 × experience_score` 加权排序，取 Top 5。

#### F2.3 上下文注入

检索结果格式化为 Markdown:

```markdown
## 知识库相关条目

- [[PostgreSQL 死锁排查]] (可信度: 0.9, 已验证) — 用于 bug-fix, database 场景，已引用 7 次
- [[数据库连接池配置]] (可信度: 0.8) — 用于 deployment, performance 场景，已引用 4 次
```

注入到 Agent 的 system prompt 末尾或作为工具 `search_knowledge_base` 的返回。

#### F2.4 检索反馈

Agent 完成任务时评估每条被引用的知识是否对本次任务有帮助:
- 有帮助 → 实体的 `use_count += 1`，`last_used = now`
- 无用 → 记录日志，降低该实体在该任务类型下的推荐权重
- 发现过时 → 触发 F4（新鲜度管理）

### F3: 用途标签与知识推荐

#### F3.1 标签体系

初始标签集（可扩展）:

| 类别 | 标签 |
|------|------|
| 开发 | `bug-fix`, `feature-dev`, `refactoring`, `code-review` |
| 运维 | `deployment`, `monitoring`, `incident-response`, `backup` |
| 数据 | `schema-migration`, `query-optimization`, `data-export` |
| 架构 | `system-design`, `api-design`, `security-review` |
| 协作 | `onboarding`, `documentation`, `knowledge-sharing` |

#### F3.2 标签自动标注

Agent 完成任务后:
1. 分析本次任务内容 + Issue 标签
2. 评估每条被引用的知识是否帮助了本次任务
3. 将任务类型标签追加到对应实体的 `used_for` 数组

标签可自动扩展——如果 Agent 发现当前任务类型不在现有标签中，可以提议新标签。

### F4: 新鲜度管理

#### F4.1 定时巡检

**触发**: Routine（cron `0 9 * * 1` — 每周一早上 9 点）
**执行 Agent**: Curator Agent（专用知识管理 Agent）

**巡检逻辑**:
1. 扫描所有实体，检查 `updated` 字段
2. 超过 90 天未更新 → 标记 `freshness_score -= 0.3`
3. 关联的技术栈有 breaking change → 标记 `## 争议/待核实`
4. 生成巡检报告 Issue，列出需要关注的实体

#### F4.2 引用时评估

Agent 在检索结果中发现某实体可能是过时的:
1. 在上下文中标注 "⚠ 此条目上次更新于 90 天前，内容可能已过时"
2. 任务完成后，Agent 可以标记该实体需要刷新
3. 刷新需求自动创建 Issue

### F5: 知识生命周期

#### F5.1 提升（Promote）

| 触发 | 条件 | 行为 |
|------|------|------|
| 跨项目引用 | 项目级实体被 ≥3 个不同项目引用 | 创建 Issue "建议将 [实体名] 提升为公司级"，附引用来源 |
| 手动提升 | 人类在 Web UI 点击"提升" | 直接提升 |
| 确认后 | Issue 被标记 done | 实体的 `level` 改为 `company`，索引更新 |

#### F5.2 分裂（Split）

| 触发 | 条件 | 行为 |
|------|------|------|
| 体积过大 | 实体正文 > 2000 字 | 创建 Issue "建议拆分 [实体名]"，附 LLM 建议的拆分方案 |
| 子话题 > 5 | 实体包含 ≥5 个独立子话题 | 同上 |
| 确认后 | 人工批准拆分方案 | Agent 执行拆分，创建子实体，原实体保留为"索引页" |

#### F5.3 合并（Merge）

| 触发 | 条件 | 行为 |
|------|------|------|
| 高度相似 | pgvector 检测两个实体相似度 > 0.9 | 创建 Issue "建议合并 [A] 和 [B]"，附 LLM 建议的合并方案 |
| 确认后 | 人工批准 | Agent 执行合并，保留主实体，备选实体添加重定向到主实体 |

### F6: 知识消费（Web UI）

#### F6.1 Paperclip Web UI 页面

- **知识搜索页** (`/knowledge/search`): 搜索框 + 语义搜索结果列表。每条结果展示标题、摘要、可信度、引用次数、关联标签
- **知识详情页** (`/knowledge/实体名`): 渲染 Markdown，展示完整 frontmatter 元数据，展示引用链（哪些实体引用了本实体），操作按钮（标记已验证、提升、创建整理 Issue）
- **知识 Dashboard** (`/knowledge/dashboard`): 热度排行、未使用实体列表、过期实体列表、统计概览
- **项目管理 → 知识库 Tab**: 项目设置中关联/解绑知识库

#### F6.2 搜索 API

```
GET /api/knowledge/search?q=postgresql+deadlock&project_id=xxx
→ { results: [{ entity_name, file_path, similarity, snippet, confidence, verified }] }
```

### F7: 知识层级与权限

#### F7.1 三层模型

| 层级 | YAML level | 可见范围 | 编辑权限 |
|------|-----------|----------|----------|
| personal | `personal` | 只有创建者可见 | 只有创建者可编辑 |
| project | `project` | 该项目的所有成员 + 该公司所有 Agent | 项目成员可编辑，Agent 可写入 |
| company | `company` | 全公司所有人 | 知识管理员 + Agent（需审核）|

#### F7.2 Agent 检索权限

```
Agent 检索时:
  WHERE level = 'company'
     OR (level = 'project' AND project_id IN agent_accessible_projects)
     OR (level = 'personal' AND created_by = agent_id)
```

### F8: 触发时机

| 触发 | 实现方式 | 频率 | Agent |
|------|----------|------|-------|
| 自动归档 | Issue status→done → afterTaskComplete hook → 调用 engine.process() | 每次任务完成 | 执行任务的 Agent |
| 定期巡检 | Routine: cron `0 9 * * 1` → Issue "每周知识巡检" | 每周 | Curator Agent |
| 手动整理 | Issue "整理 knowledge/微服务" → Agent checkout → 处理指定目录 | 按需 | 分配的 Agent |
| 爬虫采集 | Routine: cron 按源配置频率 → 发现新内容 → 入 inbox → 合成管道处理 | 按源配置 | Curator Agent |
| 手动爬取 | Issue "搜集 LLM Agent 的最新架构实践" → Agent 执行爬虫 → 入 inbox | 按需 | 分配的 Agent |

### F9: 爬虫与知识采集

#### F9.1 源管理系统

不是所有 URL 都值得爬。需要一个结构化的源管理模块。

**源定义**（`wiki/sources/` 目录下每个源一个 `.md` 文件）:

```yaml
---
name: "Martin Fowler 博客"
url: https://martinfowler.com
type: blog              # blog | docs | github | forum | paper | rss
crawl_frequency: weekly # daily | weekly | monthly | manual
trust_weight: 0.9       # 该源的可信度权重，后续影响 Agent 自评 confidence
last_crawled: 2026-05-12
tags: [architecture, microservices]
enabled: true
article_selector: "article.post"  # CSS 选择器提取正文
sitemap: https://martinfowler.com/feed.atom
---
```

**源管理操作**:
- Agent 在 Web UI 添加/编辑/禁用源
- 添加时自动检测 RSS/sitemap → 确认抓取频率
- 按频率检查源是否有新内容

#### F9.2 三层采集策略

| 层级 | 描述 | 触发 | 产出 |
|------|------|------|------|
| 种子源 | 用户手动配置的权威源 | Routine 按频率触发 | 新文章/页面 → inbox |
| 外链扩展 | 从种子源文章中的外链发现新源 | 每篇种子文章处理时 | 自动评估 → 建议加入白名单 |
| 按需搜索 | Issue 触发的定向搜集 | 手动触发 | 搜索引擎 → 候选页面列表 → 入 inbox |

**外链扩展的安全边界**:
- 只评估种子源正文中的外链（不跟随 sidebar/footer 导航）
- 每个外链域需人工确认后才加入白名单
- 单一域的外链数上限 20 条（防止深度爬取失控）

#### F9.3 HTML → Markdown 转换管道

```
网页 URL
  → robots.txt 检查
  → 下载 HTML（带 ETag/Last-Modified，增量）
  → 去除广告/导航/评论区/侧边栏（Readability 算法）
  → HTML → Markdown（turndown）
  → 内容质量过滤（LLM 判断: 有实质信息？与现有知识重复？内容农场？）
  → 通过 → 写入 inbox/{源名}-{日期}-{标题}.md
  → 不通过 → 丢弃 + 记录日志
```

**关键约束**: 不是整页进知识库——爬虫采集的是"候选笔记"，需要经过合成管道（F1）的实体提取和合并才能成为正式知识。

#### F9.4 内容质量过滤

入 inbox 前过一道 LLM 质量判断:

- 是否有实质信息（拒绝纯导航页、404 页、登录墙）？
- 是否与现有知识重复（标题 + 前 3 段做语义比对）？
- 是否来自低质量源（短文章、SEO 农场、纯广告）？
- 评分 0-10，< 4 分自动丢弃

#### F9.5 爬虫礼貌策略

| 规则 | 值 |
|------|-----|
| User-Agent | `Paperclip-Knowledge-Crawler/1.0` |
| robots.txt | 强制遵守 |
| 请求间隔 | 默认 5s，根据源类型可调 |
| 速率限制 | 单域并发 1，全局并发 3 |
| 重试策略 | 429/503 → 指数退避（1s, 2s, 4s, 8s），最多 3 次 |
| 不爬内容 | 需登录页面、付费墙、API 端点 |

### F10: 知识审查队列

#### F10.1 审查视图

所有 Agent 写入的待审核内容汇聚到统一审查队列:

```
Paperclip Web UI: /knowledge/review

┌─────────────────────────────────────────────────┐
│  待审核 (5)   已通过 (23)   已驳回 (2)           │
├─────────────────────────────────────────────────┤
│                                                 │
│  ☐ Kubernetes HPA 配置指南                      │
│    来源: Coder Agent (任务 PAP-231 完成后写入)   │
│    可信度: 0.85  │  层级: company               │
│    变更: 新增 "minReplicas 配置建议" 节          │
│    待审核时间: 2 小时前                          │
│    [查看变更] [批准] [驳回] [请求修改]            │
│                                                 │
│  ☐ PostgreSQL 死锁排查                           │
│    来源: 爬虫 (来自 pgdocs.io 采集)              │
│    可信度: 0.9  │  层级: company                │
│    变更: 新增 "死锁检测日志" 段                  │
│    待审核时间: 5 小时前                          │
│    [查看变更] [批准] [驳回] [请求修改]            │
│                                                 │
└─────────────────────────────────────────────────┘
```

#### F10.2 审查队列排序规则

- 默认按"可信度 × 等待时间"排序——高可信且等得久的优先审
- 低可信度（< 0.5）内容单独分组，需更高优先级处理
- 同一来源（同一 Agent 或同一爬虫源）的批量审核支持

#### F10.3 审查操作

| 操作 | 效果 |
|------|------|
| 批准 | content → wiki/ 正式发布，`verified: true` |
| 驳回 | 标记 `status: rejected`，从队列移除，不删除原始文件 |
| 请求修改 | 创建 Issue 分配给写入者，附修改意见 |
| 批量批准 | 同源、相似可信度的内容一键批量通过 |

### F11: 知识模板系统

#### F11.1 模板定义

不同领域的知识需要不同的结构。定义可扩展模板:

**技术概念模板** (`templates/concept-template.md`):
```markdown
---
tags: []
created: {{date}}
---

# {{title}}

## 概述
1-2 句定义该概念及为什么重要。

## 核心原理
- 

## 使用场景
- 

## 相关技术
- [[ ]]
```

**工具模板** (`templates/tool-template.md`):
```markdown
---
tags: [tool]
created: {{date}}
---

# {{title}}

## 是什么


## 安装/接入
```bash
```

## 常用操作
- 

## 踩坑记录
- 
```

**故障处理模板** (`templates/incident-template.md`):
```markdown
---
tags: [incident]
created: {{date}}
---

# {{title}}

## 症状
- 

## 根因


## 修复步骤
1. 
2. 

## 预防措施
- 
```

#### F11.2 模板自动匹配

Agent 或爬虫在处理新笔记时:

```
内容类型识别（LLM） →
  概念型 → concept-template.md
  工具型 → tool-template.md
  流程型 → process-template.md
  故障型 → incident-template.md
  决策型 → decision-template.md
```

模板匹配结果会传给合成阶段的 LLM，指导其按对应结构组织内容。

#### F11.3 模板扩展

- 用户可在 Obsidian `templates/` 目录下创建自定义模板
- 模板也是 Markdown 文件，使用 `{{变量}}` 占位符
- 新模板创建后自动被系统发现（chokidar 监控 `templates/` 目录）

### F12: 外部源集成接口

#### F12.1 可插拔采集器

核心设计: 把"知识从哪里来"抽象为统一接口，爬虫只是其中一个实现:

```typescript
interface KnowledgeCollector {
  /** 采集器唯一标识 */
  name: string;
  
  /** 采集并返回原始笔记列表 */
  collect(config: CollectorConfig): Promise<RawNote[]>;
  
  /** 检查源是否有新内容（用于增量抓取） */
  checkForUpdates(source: KnowledgeSource): Promise<boolean>;
  
  /** 采集器支持的源类型 */
  supportedSourceTypes: SourceType[];
}

interface RawNote {
  title: string;
  content: string;        // Markdown 格式
  source: string;         // 来源 URL 或标识
  sourceType: SourceType;
  collectedAt: Date;
  metadata: Record<string, unknown>;  // 采集器特有元数据
}
```

#### F12.2 内置采集器

| 采集器 | 类型 | 用途 |
|--------|------|------|
| `WebCrawler` | 内置 | Web 页面爬取（HTML→MD，F9 的爬虫功能） |
| `RSSCollector` | 内置 | RSS/Atom feed 订阅 |
| `GitHubCollector` | 内置 | GitHub Discussions/Issues/README |
| `arXivCollector` | 可选 | arXiv API 论文摘要 |
| `DocsWatcher` | 内置 | 本地文件系统监控（已配置的 docs 目录）|

#### F12.3 注册新采集器

通过 Paperclip Plugin 系统的扩展点注册:

```typescript
// 第三方插件可以注册自定义采集器
pluginContext.registerCollector({
  name: "SlackThreadCollector",
  supportedSourceTypes: ["slack"],
  collect: async (config) => { /* Slack API 调用 */ },
  checkForUpdates: async (source) => { /* 检查新消息 */ },
});
```

#### F12.4 采集器执行模型

```
Routine/Cron 触发
  → 遍历所有已启用的 Source
    → 匹配对应的 Collector（按 sourceType）
    → Collector.checkForUpdates(source)
    → 有新内容 → Collector.collect(config)
    → RawNote[] → 质量过滤 → 写入 inbox
    → 合成管道（F1）处理
```

---

## 5. 非功能需求

### 5.1 性能

| 指标 | 目标 |
|------|------|
| 语义搜索延迟 | < 500ms (P95) |
| 实体合成耗时 | < 30s（含 LLM 调用） |
| 文件监控响应 | 新文件进入 inbox/ 后 5s 内触发处理 |
| pgvector HNSW 索引构建 | 全量重建 < 30s（10000 实体以内） |

### 5.2 可靠性

| 指标 | 目标 |
|------|------|
| 合成失败率 | < 5%（失败时保留原始 inbox 文件，不丢失数据） |
| 向量索引一致性 | 每次文件变更后自动 re-index，超过 1 小时未索引触发告警 |
| 数据持久性 | 全依赖 Obsidian vault 的 Git 备份策略 |

### 5.3 安全

| 约束 | 实现 |
|------|------|
| 路径沙箱 | vault 路径白名单，拒绝访问根目录外的任何路径 |
| SQL 注入 | 使用参数化查询，不拼接用户输入到 SQL |
| 知识层级隔离 | SQL 查询强制添加 level 过滤条件 |
| 敏感内容 | vault 中的 `.env`、`.secret` 类文件不索引 |

### 5.4 可扩展性

- 标签体系可扩展：新的任务类型标签可由 Agent 提议、人类批准后加入
- 实体类型可扩展：`entity_type` 枚举可以追加新值
- Embedding 模型可替换：抽象 `embed()` 接口，支持切换不同模型

---

## 6. 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Paperclip Application                      │
│                                                               │
│  ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Heartbeat│  │ Routines│  │   Web UI │  │  API Routes  │ │
│  │  Engine  │  │  (Cron) │  │ (React)  │  │  (Express)   │ │
│  └────┬─────┘  └────┬────┘  └────┬─────┘  └──────┬───────┘ │
│       │              │            │               │         │
│       └──────────────┼────────────┼───────────────┘         │
│                      │            │                          │
│              ┌───────┴────────────┴────────┐                 │
│              │   obsidian-wiki 服务层       │                 │
│              │                              │                 │
│  ┌───────────┴───────────┐  ┌──────────────┴──────────────┐ │
│  │     写入管道            │  │       读取管道              │ │
│  │  extractor → dedup    │  │  retriever (semantic)      │ │
│  │  → synthesizer        │  │  + retriever (experience)  │ │
│  │  → linker             │  │  → merge → inject_context  │ │
│  └───────────────────────┘  └─────────────────────────────┘ │
│  ┌──────────────────────┐  ┌──────────────────────────────┐ │
│  │    维护任务            │  │      数据访问层               │ │
│  │  freshness (cron)    │  │  wiki_entities (Drizzle)    │ │
│  │  lifecycle (promote  │  │  + pgvector raw SQL         │ │
│  │   /split/merge)      │  │  + gray-matter (YAML)       │ │
│  └──────────────────────┘  └──────────────────────────────┘ │
│                                                               │
└──────────────────────────┬────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                 ▼
   ┌──────────┐   ┌──────────────┐   ┌──────────────┐
   │ Obsidian │   │  PostgreSQL   │   │  LLM Client  │
   │  Vault   │   │  + pgvector   │   │  (Anthropic) │
   │  (.md)   │   │               │   │              │
   └──────────┘   └──────────────┘   └──────────────┘
```

---

## 7. 数据模型

### 7.1 PostgreSQL 表: `wiki_entities`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE wiki_entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_name   TEXT NOT NULL,
  file_path     TEXT NOT NULL UNIQUE,           -- vault 内相对路径
  level         TEXT NOT NULL DEFAULT 'project'  -- personal | project | company
                CHECK (level IN ('personal', 'project', 'company')),
  project_id    UUID REFERENCES projects(id),   -- 项目级/公司级关联
  created_by    UUID REFERENCES agents(id),     -- 创建者（个人级用）
  embedding     vector(1536),                   -- OpenAI text-embedding-3-small

  -- 质量元数据
  confidence    REAL DEFAULT 0.5,               -- Agent 自评 0-1
  verified      BOOLEAN DEFAULT false,          -- 人工已验证
  freshness_score REAL DEFAULT 1.0,             -- 1.0=最新, 0.0=完全过期

  -- 使用统计
  use_count     INTEGER DEFAULT 0,              -- 被引用次数
  used_for      TEXT[] DEFAULT '{}',            -- 用途标签数组
  last_used     TIMESTAMPTZ,                    -- 最近被引用时间

  -- 时间戳
  file_updated  TIMESTAMPTZ NOT NULL,           -- 文件最后修改时间
  updated_at    TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- HNSW 向量索引
CREATE INDEX wiki_entities_embedding_idx ON wiki_entities
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 知识源管理
CREATE TABLE knowledge_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'blog'
                CHECK (source_type IN ('blog','docs','github','forum','paper','rss','slack','custom')),
  collector_name TEXT NOT NULL DEFAULT 'WebCrawler',  -- 匹配 KnowledgeCollector.name
  crawl_frequency TEXT NOT NULL DEFAULT 'weekly'
                CHECK (crawl_frequency IN ('daily','weekly','monthly','manual')),
  trust_weight  REAL DEFAULT 0.5,
  last_crawled  TIMESTAMPTZ,
  article_selector TEXT,          -- CSS 选择器提取正文
  sitemap_url   TEXT,             -- RSS/sitemap URL
  tags          TEXT[] DEFAULT '{}',
  enabled       BOOLEAN DEFAULT true,
  crawl_config  JSONB DEFAULT '{}',  -- 采集器特有配置
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 审查队列
CREATE TABLE knowledge_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_name   TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  source_type   TEXT NOT NULL       -- 'agent' | 'crawler' | 'manual'
                CHECK (source_type IN ('agent','crawler','manual')),
  source_id     TEXT,               -- Agent ID / Source name / User ID
  content       TEXT NOT NULL,      -- 待审核的 Markdown 内容
  existing_content TEXT,            -- 已有内容（如果是更新）
  confidence    REAL DEFAULT 0.5,
  level         TEXT NOT NULL DEFAULT 'project'
                CHECK (level IN ('personal','project','company')),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','revision_requested')),
  reviewed_by   UUID,              -- 审核人 ID
  review_notes  TEXT,              -- 审核意见
  created_at    TIMESTAMPTZ DEFAULT now(),
  reviewed_at   TIMESTAMPTZ
);
```

### 7.2 Markdown YAML Frontmatter 规范

```yaml
---
tags: [deployment, kubernetes]
aliases: [k8s-deploy, deploy-flow]
created: 2026-05-01
updated: 2026-05-12
confidence: 0.9
verified: false
level: company
project_id: null
used_for: [deployment, infrastructure]
use_count: 4
---

# 实体标题

正文内容...
```

### 7.3 目录结构规范

```
vault/
├── inbox/                  # Agent 写入的待处理笔记
│   └── 2026-05-12-xxx.md
├── wiki/                   # 经过合成的正式知识实体
│   ├── PostgreSQL-死锁排查.md
│   ├── K8s-部署流程.md
│   └── ...
├── personal/               # 个人级（人类和 Agent 不可见他人内容）
│   └── ...
├── templates/              # 实体模板文件
│   └── entity-template.md
└── .obsidian/              # Obsidian 配置（不纳入索引）
```

---

## 8. API 契约

### 8.1 知识搜索

```
GET /api/knowledge/search?q=<query>&project_id=<pid>&limit=5

Response:
{
  "results": [
    {
      "entity_name": "PostgreSQL 死锁排查",
      "file_path": "wiki/PostgreSQL-死锁排查.md",
      "similarity": 0.92,
      "snippet": "PostgreSQL 死锁通常由并发事务持有互斥锁导致...",
      "confidence": 0.9,
      "verified": true,
      "used_for": ["bug-fix", "database"],
      "use_count": 7,
      "last_used": "2026-05-10T...",
      "level": "company",
      "project_id": null
    }
  ],
  "search_type": "semantic + experience",
  "took_ms": 120
}
```

### 8.2 知识写入（手动）

```
POST /api/knowledge/entities
{
  "file_path": "wiki/新实体名.md",
  "content": "# 标题\n\n正文...",
  "level": "project",
  "project_id": "uuid"
}

Response: { "entity_name": "新实体名", "file_path": "wiki/新实体名.md" }
```

### 8.3 知识更新

```
PATCH /api/knowledge/entities/{entity_name}
{
  "verified": true,
  "level": "company"
}
```

### 8.4 触发合成（手动）

```
POST /api/knowledge/synthesize
{
  "inbox_file": "inbox/2026-05-12-部署踩坑.md"
}

Response: { "output_path": "wiki/K8s-部署流程.md", "synthesized": true }
```

### 8.5 获取统计

```
GET /api/knowledge/stats

Response:
{
  "total_entities": 150,
  "by_level": { "personal": 30, "project": 80, "company": 40 },
  "verified_rate": 0.65,
  "avg_confidence": 0.82,
  "most_used": [{ "entity_name": "...", "use_count": 12 }],
  "stale_count": 8,
  "unused_count": 25
}
```

---

## 9. UI/UX 规范

### 9.1 Paperclip Web UI

#### 知识搜索页

- 搜索框居中，支持输入后自动补全实体名
- 搜索结果左侧显示实体列表（标题 + 摘要 + 标签）
- 右侧展示选中实体的完整 Markdown 渲染
- 每条搜索结果显示可信度徽章（绿色=已验证，黄色=高可信，灰色=待验证）

#### 知识详情页

- 上半部分：Markdown 渲染的正文
- 侧边栏：元数据面板（标签、层级、可信度、最后更新、引用次数）
- 底部：引用链（哪些实体引用了本实体）和反向引用（本实体引用了哪些实体）
- 操作按钮：标记已验证 / 提升到公司级 / 创建整理 Issue

#### 知识 Dashboard

- 顶部：概览卡片（总实体数、已验证比例、平均可信度、待处理数）
- 中部：热度 Top 10（水平柱状图）
- 底部左：未使用实体列表（红色警告）
- 底部右：即将过期实体列表（黄色警告）

### 9.2 Obsidian 端

- 使用 Obsidian Dataview 插件展示知识索引
- Agent 修改过的文件在 Obsidian Git 面板中显示 diff
- 无需额外插件——纯 Markdown + 标准 Obsidian 功能

---

## 10. 与 Paperclip 集成规范

### 10.1 Agent 工具注册

Agent 通过 Paperclip Plugin 系统的 Tool Dispatcher 注册以下工具:

```typescript
tools: [
  { name: "search_knowledge_base",  description: "搜索知识库", ... },
  { name: "write_to_wiki",          description: "将经验写入 wiki/inbox", ... },
  { name: "mark_entity_stale",      description: "标记实体可能过时", ... },
  { name: "propose_new_tag",        description: "提议新的用途标签", ... },
]
```

### 10.2 心跳集成

```
Agent checkout Issue
  → heartbeat-context API
    → retriever.search(issue.title + issue.description)
    → 结果注入 context.knowledge_entries
  → Agent 执行任务（可随时调用 search_knowledge_base）
  → 任务完成
    → afterTaskComplete hook
      → engine.process(extracted_experience)
```

### 10.3 Routine 注册

```
Routine: weekly-knowledge-audit
  触发: cron "0 9 * * 1"
  Agent: curator-agent
  Action: freshness.audit() + lifecycle.check()
  Output: 巡检报告 Issue
```

---

## 11. 安全与权限模型

### 11.1 知识层级访问控制矩阵

| 角色 | personal（他人） | project（本项目） | project（他项目） | company |
|------|------------------|-------------------|-------------------|---------|
| Agent（本项目） | ✗ | ✓ | ✗ | ✓ |
| Agent（其他项目） | ✗ | ✗ | ✓（同company） | ✓ |
| 人类（本项目成员） | ✗ | ✓ | ✗ | ✓ |
| 人类（知识管理员） | ✗ | ✓ | ✓ | ✓ |

### 11.2 写入保护

- Agent 写入 personal 级别 → 拒绝（Agent 不能写入人类个人空间）
- Agent 写入 project/company 级别 → 允许，但 confidence < 0.7 的内容自动进入 `## 争议/待核实`
- 人类 Web UI 写入 → 直接通过（不设审核门控）

### 11.3 路径沙箱

```typescript
const VAULT_ROOT = "/home/admin/obsidian-vault";
const ALLOWED_DIRS = ["inbox", "wiki", "personal", "templates"];

function validatePath(filePath: string): void {
  const resolved = path.resolve(VAULT_ROOT, filePath);
  if (!resolved.startsWith(VAULT_ROOT)) {
    throw new Error("Path traversal detected");
  }
  const relative = path.relative(VAULT_ROOT, resolved);
  const topDir = relative.split(path.sep)[0];
  if (!ALLOWED_DIRS.includes(topDir)) {
    throw new Error(`Directory not allowed: ${topDir}`);
  }
}
```

---

## 12. 分阶段实施计划

### Phase 0: 基础设施（Week 1）

- [ ] Docker 环境升级：`postgres:16-alpine` → `pgvector/pgvector:pg16`
- [ ] 创建 `wiki_entities` 表和 HNSW 索引
- [ ] 创建 `server/src/services/obsidian-wiki/` 目录结构
- [ ] 实现 `utils/fs.ts`（gray-matter 读写 YAML frontmatter）
- [ ] 实现 `utils/embed.ts`（embedding 生成 + pgvector CRUD）

**验收**:
- pgvector 扩展已加载
- 可以写入/读取 Markdown 文件的 YAML frontmatter
- 可以生成 embedding 并存到 pgvector 表

### Phase 1: 合成管道（Week 2-3）

- [ ] 实现 `extractor.ts`（LLM 实体提取 + JSON 输出）
- [ ] 实现 `dedup.ts`（双路召回去重）
- [ ] 实现 `synthesizer.ts`（LLM 合成 Merge/Create）
- [ ] 实现 `linker.ts`（正向链接 + 反向引用）
- [ ] 实现 `engine.ts`（主入口 process()）
- [ ] 编写 `prompts/editor.ts` 和 `prompts/extractor.ts`

**验收**:
- 向 inbox/ 放一篇测试笔记 → engine.process() → wiki/ 输出正确的实体文件
- 向 inbox/ 放第二篇相关笔记 → 正确合并到已有实体而非创建新文件
- 实体文件包含正确的 YAML frontmatter 和 [[双链]]
- 反向引用自动追加

### Phase 2: Agent 检索（Week 3-4）

- [ ] 实现 `retriever.ts`（语义搜索 + 经验推荐两路合并）
- [ ] 集成到 `heartbeat-context` API
- [ ] 实现检索反馈闭环（use_count、last_used 更新）
- [ ] 注册 `search_knowledge_base` Agent tool

**验收**:
- Agent checkout Issue → heartbeat-context 返回相关知识条目
- 搜索结果受层级权限正确过滤
- 完成任务后 use_count 自动递增

### Phase 3: 维护与生命周期（Week 4-5）

- [ ] 实现 `freshness.ts`（巡检 + 引用评估）
- [ ] 实现 `lifecycle.ts`（提升/分裂/合并检测）
- [ ] 注册 Curator Agent 和 weekly-knowledge-audit Routine
- [ ] 实现用途标签自动标注

**验收**:
- 每周自动生成巡检报告
- 跨项目引用触发提升建议
- 超大实体触发拆分建议
- 高相似度实体触发合并建议

### Phase 4: Web UI + 审查队列（Week 5-6）

- [ ] 知识搜索页（`/knowledge/search`）
- [ ] 知识详情页（`/knowledge/实体名`）
- [ ] 知识 Dashboard（`/knowledge/dashboard`）
- [ ] 审查队列页（`/knowledge/review`）: 待审核/已通过/已驳回 三 Tab
- [ ] 审查操作 API（批准/驳回/请求修改/批量批准）
- [ ] API 路由实现（搜索、CRUD、合成触发、统计、审查）

**验收**:
- 搜索框输入 → 返回语义匹配结果
- 详情页正确渲染 Markdown + 元数据
- Dashboard 展示统计数据
- 审查队列正常展示 Agent 写入和爬虫采集的待审核内容
- 一键批准/驳回功能正常

### Phase 5: 爬虫 + 采集器 + 模板（Week 7-8）

- [ ] 实现 `KnowledgeCollector` 接口
- [ ] 实现 `WebCrawler`（HTML→MD、质量过滤、礼貌策略）
- [ ] 实现 `RSSCollector`
- [ ] 实现源管理系统（Web UI + API）
- [ ] 实现模板系统（自动匹配、模板发现）
- [ ] 实现外链扩展检测（种子源→发现新源→建议加入白名单）

**验收**:
- 添加源 → 自动检测 RSS → 按频率抓取
- 新文章入 inbox → 合成管道正常处理
- 质量过滤正确丢弃低质量内容
- 模板根据内容类型自动匹配
- 插件系统可注册自定义 Collector

### Phase 6: 上线与调优（Week 8-9）

- [ ] 全链路测试（写入 → 检索 → 反馈 → 维护 闭环）
- [ ] 性能优化（pgvector 查询调优、HNSW 参数调优）
- [ ] 安全审计（路径沙箱、SQL 注入、权限隔离）
- [ ] 文档上线（开发者指南、用户指南）

---

## 13. 验收标准

### 13.1 功能验收

| 验收项 | 标准 |
|--------|------|
| 知识写入 | Agent 完成任务后，经验自动写入 inbox 并合成到 wiki/ |
| 知识检索 | Agent checkout 任务后，上下文包含 ≤5 条相关知识和 ≤3 条经验推荐 |
| 双链完整性 | 实体创建后，所有被引用实体包含回链 |
| 可信度 | confidence < 0.5 的内容在 inbox 等待审核，不进 wiki/ |
| 新鲜度 | 超过 90 天未更新实体被巡检标记 |
| 层级隔离 | 项目 A 的 Agent 搜不到项目 B 的项目级知识 |
| 生命周期 | 满足条件的实体自动生成提升/分裂/合并 Issue |

### 13.2 性能验收

| 验收项 | 标准 |
|--------|------|
| 搜索延迟 | P95 < 500ms |
| 合成耗时 | 单实体 < 30s |
| 文件监控 | inbox 新文件 5s 内触发处理 |

### 13.3 安全验收

| 验收项 | 标准 |
|--------|------|
| 路径沙箱 | 任何 `../` 或绝对路径无法逃逸 vault 根目录 |
| SQL 注入 | 参数化查询，无法拼接 SQL |
| 层级权限 | SQL WHERE 子句强制过滤 |


## 14. 附录

### 14.1 术语表

| 术语 | 定义 |
|------|------|
| Vault | Obsidian 知识库的根目录 |
| 实体 (Entity) | wiki/ 下的一篇 Markdown 文件，代表一个独立的知识条目 |
| 一入一出 | 每次处理一个新文件 + 一个已有实体的原子化操作模式 |
| 正向链接 | 在正文中识别已有实体名并包裹 `[[WikiLink]]` |
| 反向引用 | 在目标实体中追加指向源实体的链接 |
| 自适应检查 | 检查实体 A 引用 B 时，B 是否也包含对 A 的引用 |
| 新鲜度评分 | freshness_score: 1.0 = 最新，0.0 = 完全过期 |
| 爬虫 | 自动从配置的外部源采集知识内容的程序，遵守 robots.txt 和礼貌策略 |
| 采集器 (Collector) | 实现 `KnowledgeCollector` 接口的插件，可接入不同的知识来源（Web、RSS、GitHub 等）|
| 源 (Source) | 爬虫/采集器的数据来源，是 URL、RSS feed、GitHub 仓库等 |
| 审查队列 | 所有待审核知识变更的统一管理界面，支持批量审批 |
| 知识模板 | 针对不同知识类型（概念/工具/流程/故障）的 Markdown 结构模板 |

### 14.2 技术依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| pgvector | 0.7+ | 向量存储和检索 |
| gray-matter | 4.x | Markdown frontmatter 解析 |
| chokidar | 3.x | 文件系统监控 |
| @anthropic-ai/sdk | 复用 Paperclip 现有 | LLM 调用（合成、提取） |
| drizzle-orm | 复用 Paperclip 现有 | wiki_entities 表操作 |

### 14.3 参考资料

- Karpathy "LLM-Wiki" 范式: 一种让 LLM 主动维护结构化知识库的方法论
- pgvector HNSW 索引: https://github.com/pgvector/pgvector#hnsw
- Obsidian YAML frontmatter: https://help.obsidian.md/Editing+and+formatting/Properties
