# Paperclip × LLM-Wiki 知识引擎 PRD

**产品名称**: Paperclip × LLM-Wiki 知识引擎
**版本**: v2.0（DB-first 设计）
**状态**: 设计中
**作者**: Paperclip 架构组
**日期**: 2026-05-12

---

## 版本说明

| 版本 | 主要变化 |
|------|---------|
| v1.0 (2026-05-12, archived in git) | 基于 Obsidian vault + pgvector 的双载体方案 |
| **v2.0 (本版本)** | 改为 **DB-first**（PG + pgvector，节点即表行）；新增时效性 profile、节点类型扩展为 5 种、边作为一等公民（6 种）、业务域维度、MCP 服务暴露 |

v1.0 的 Obsidian 双载体思路在文件系统同步、并发写、多租户路径、Agent 读写效率上有显著成本，且主要消费者是 Agent 而非人。v2.0 切换为 DB-first 以最大化对 Agent 的友好度，同时保留 Karpathy LLM-Wiki 范式的核心特征（原子节点、互联、演化、活体）。

---

## 目录

1. [产品愿景与目标](#1-产品愿景与目标)
2. [用户画像](#2-用户画像)
3. [用户故事](#3-用户故事)
4. [核心概念与设计原则](#4-核心概念与设计原则)
5. [功能需求总览（FR1-FR14）](#5-功能需求总览fr1-fr14)
6. [详细功能规格](#6-详细功能规格)
7. [非功能需求](#7-非功能需求)
8. [系统架构](#8-系统架构)
9. [数据模型](#9-数据模型)
10. [API 契约](#10-api-契约)
11. [UI/UX 规范](#11-uiux-规范)
12. [MCP 服务暴露规范](#12-mcp-服务暴露规范)
13. [与 Paperclip 集成规范](#13-与-paperclip-集成规范)
14. [安全与权限模型](#14-安全与权限模型)
15. [分阶段实施计划](#15-分阶段实施计划)
16. [验收标准](#16-验收标准)
17. [附录](#17-附录)

---

## 1. 产品愿景与目标

### 1.1 业务背景：缤果软件

缤果软件是一家由 AI 驱动的微型软件公司——"一个人 + 一群智能体"的运营模式。业务矩阵按权重排序：

| 权重 | 业务条线 | 知识形态 |
|------|----------|---------|
| 1 | **软件与 AI 工具**（SaaS、效率插件、智能体、小程序、独立 App、定制开发） | 技术教训、架构决策、外包客户档案、bug 复盘 |
| 2 | **数字产品**（提示词包、Notion/Obsidian 模板、行业报告、付费专栏） | 选题档案、定价策略历史、用户反馈复盘 |
| 3 | **自媒体内容矩阵**（图文 + 短视频，软件/AI/效率三关键词） | 平台规则、爆款选题、标题/封面/脚本套路 |
| 4 | **短视频带货 / 联盟分销**（仅推软件/效率/AI 调性） | 选品标准、平台合规、转化数据档案 |
| 5 | **知识付费与社群**（训练营、陪跑、咨询） | 客户问题档案、答疑话术 |

LLM-Wiki 知识引擎要服务这五条业务线在 AI 时代的协同沉淀——**让一个人 + 一群智能体跑出公司级的知识复利**。

> **业务条线的可扩展性**：上述 5 类是当前业务，但缤果作为 AI 时代的微型公司形态会持续演进，未来可能拓展到更多业务条线（如咨询、付费会员、AI 教育、独立开发者市场等）。知识库的业务域维度因此设计为**用户可扩展资源**——加一条新业务线只是在 Web UI INSERT 一行 `business_domains` 表的事，不应触发 DB schema migration。详见 §4.5 / §9.8。

### 1.2 知识库在 Paperclip 中的定位

知识库是 Paperclip 平台的"组织记忆层"——独立于 Issues / Activity / Agents 等运营数据，专门承载"被复用、被演化、有时效性"的知识资产。

- 主要消费者：**Paperclip 智能体**（执行任务前自动检索、执行后自动沉淀）
- 次要消费者：**人类**（Web UI 审查 / 编辑 / 查阅 / 看演化轨迹）
- 第三方消费者：**外部 Agent**（Claude Code / Codex / Cursor 通过 MCP 接入）

### 1.3 核心原则

1. **DB-first，零文件系统**：知识就是 PG 表行，无 vault 同步、无文件锁、无路径沙箱。Agent 读写都走 REST API；备份走 pg_dump；版本走 `knowledge_node_revisions` 表。
2. **原子节点 + 一等公民边**：每个知识单元独立可索引，节点间关系作为单独的表，不只藏在 Markdown 文本里。
3. **三路写入 + 统一审查**：Agent 自评 + 失败信号自动提取 + 人工提交，三路都走 draft 队列，可控性优先于自动化。
4. **活体演化**：6 条自动行为（升规则 / 衰减 / 合并 / 冲突 / 时效巡检 / 模式涌现）让知识自然生长与新陈代谢。
5. **可追溯**：所有变更都有 revision + event，Agent 引用必须落 edge，决策链可还原。
6. **时效感知**：volatility + valid_until + verified_at 三件套，让"几年前的平台规则"在检索时自动降权或带警示。

### 1.4 核心目标

| 目标 | 衡量标准 |
|------|---------|
| 知识沉淀自动化 | Agent 完成任务后知识写入率 ≥ 80% |
| 知识复用效率 | 同类任务首解时间缩短 ≥ 30% |
| 知识时效性 | volatility=fast 节点 ≥ 90% 在 90 天内被验证或归档 |
| 知识质量 | 审查通过率 ≥ 70%；冲突节点 < 5% |
| 跨业务覆盖 | 每条业务线（缤果 5 业务）≥ 20 篇核心节点 |

---

## 2. 用户画像

> **主场景：单操作者 + 多代理**
> 缤果是 AI 时代的微型公司形态——1 个人 + 一群智能体协同。下表虽列出"团队成员"等多人协作角色，但 MVP 默认场景是单操作者：所有"管理员 / 审查者 / Curator"角色由同一个人扮演（或代理 Manager Agent），所有 Agent 在同一公司下共享 company 级知识。这让权限模型可激进简化、审查门控可适度放松——见 §6.4 梯度审查策略。

### 2.1 核心用户

| 角色 | 描述 | 核心场景 |
|------|------|---------|
| 开发者 Agent | Paperclip 任务执行者（Coder / Curator 等） | checkout 任务前检索；完成后写入 |
| 内容/带货 Agent | 选题、写稿、选品 Agent | 决策前查平台规则 + 历史成败 |
| 技术/业务负责人 | 缤果创始人本人，或代理 Manager Agent | 审核知识质量；管理层级提升/合并 |
| 团队成员/合作者 | 偶尔参与的人类协作者 | Web UI 查阅、编辑、补充 |
| 外部 Agent | Claude Code / Codex / Cursor | 通过 MCP 接入查询知识库 |

### 2.2 用户痛点

| 痛点 | 现状 | 目标状态 |
|------|------|---------|
| 同样的坑反复踩 | 教训散落在记忆和聊天记录 | Agent 工作前自动检索相关教训 |
| 平台规则变了不知道 | 几年前学的抖音规则用到现在 | 时效性 profile 自动降权 + 巡检验证 |
| 决策反复争论 | 不记得"为什么我们当初选了 X" | decision 类型节点 + supersedes 边维持时间线 |
| 知识只在脑子里 | 缤果一个人扛多业务，记忆爆炸 | 三路写入将业务知识沉淀到 DB |
| 笔记软件不为 Agent 设计 | Obsidian/Notion 是人类工具 | DB-first + REST API + MCP，Agent 一等公民 |

---

## 3. 用户故事

### 3.1 Agent 执行视角

**US-01**: 作为 Coder Agent，checkout Issue 后系统自动注入相关知识节点到我的 context，包括相关教训（lesson）、规则（rule）、过往决策（decision），每条都带 freshness 标签。

**US-02**: 作为 Coder Agent，完成 Issue 后系统问"本次有什么经验/教训需要记录吗？"，我输出 draft 节点（可能是多种类型）进入审查队列。

**US-03**: 作为内容 Agent，我要写一篇关于直播带货的文章，检索时输入"抖音直播带货规则"，返回结果按 freshness 自动排序，最新的（2025-Q2 验证）排在前面，2023 年的版本被标记为 outdated 但仍可查。

**US-04**: 作为 Curator Agent，我每周触发一次时效性巡检：扫所有 volatility=fast 节点，90 天未验证的创建验证 Issue。

### 3.2 知识管理视角

**US-05**: 作为缤果创始人，每周收到知识审查队列摘要，可在 Web UI 一键批准/驳回；高可信度（≥0.9）批量批准。

**US-06**: 作为缤果创始人，看 `/knowledge/dashboard` 知道哪些节点最热、哪些过期、哪些孤儿、各业务域分布。

**US-07**: 作为缤果创始人，看 `/knowledge/graph` 直观看到"软件 A → 内容选题 B → 带货商品 C"的引用链路。

### 3.3 外部接入视角

**US-08**: 作为 Claude Code 用户（在另一个项目里），通过 MCP 接入缤果知识库，写代码时让 Claude 查"我们公司的 Postgres schema 规范"，秒级返回。

**US-09**: 作为团队新人，看 `/knowledge/search` 输入"为什么我们用 PG 不用 MySQL"，返回 decision 类型节点，能看到当年讨论的 options_considered。

---

## 3.4 非目标（明确不做什么）

边界声明，避免后续无序膨胀：

- **不是 Notion / Confluence 替代品**：单节点 content ≤ 2000 字硬约束；长文档应拆为多节点
- **不做同节点实时协作编辑**：最后写入者覆盖；并发冲突场景留给版本回滚（revisions 表）
- **不做 git-like 分支**：版本演化线性化（supersedes 时间线），不引入 branch / merge / rebase 概念
- **不引入细粒度 RBAC/DAC**：权限只走 level 三档（personal/project/company）+ 创建者归属，不做"按节点 ACL"
- **不做章节式大纲**：节点是原子知识单元，不维护层级目录结构（章节式组织诉求由 edges 网络替代）
- **MVP 不做节点 i18n**：同一节点只有一种语言；翻译诉求走"新建节点 + references 边"
- **不做匿名 / 公开分享**：所有知识严格在 company 内；跨公司流转留给后续显式 export 工具
- **不做实时图谱编辑器**：图视图（FR14）是只读浏览器，编辑仍走详情页

---

## 4. 核心概念与设计原则

### 4.1 三种核心实体

#### Node（节点）— 原子知识单元

- 必有字段：`title` / `content`(Markdown) / `type` / `embedding` / `level` / `company_id`
- 体积约束：单节点 content ≤ 2000 字
- 互链方式：content 里写 `[[node-id]]`，后端解析时自动落 `knowledge_edges` 行（也可显式 API 加边）

#### Edge（边）— 节点间有向关系，一等公民

- 必有字段：`from_node_id` / `to_node_id` / `edge_type`
- 支持双向遍历（"谁引用了我" / "我引用了谁"）
- 同方向同类型唯一（A→B references 仅一条）

#### Draft（草稿）— 待审查的节点变更

- 三路写入（FR4）统一进 draft
- 状态：pending / approved / rejected / revision_requested
- 通过后才落到 `knowledge_nodes`，并自动生成 revision 记录

### 4.2 节点类型枚举（5 种）

| type | 含义 | 典型来源 | 缤果业务场景 |
|------|------|---------|-------------|
| `concept` | 抽象概念 | 人工 / 外部源 | "幂等性"、"乐观锁" |
| `lesson` | 教训（症状/根因/下次怎么做） | Agent 自评、失败信号 | "v0.2.3 发布误删 docs" |
| `rule` | 强制规则（升自反复触发的 lesson） | 演化引擎升级 | "禁止内联 API key 到 agent config" |
| `decision` | 决策记录（Why we chose X） | Approval 通过派生 | "选 PG 不选 MySQL 的理由" |
| `fact` | 事实陈述 | 人工 / 自动同步 / 爬虫 | "抖音直播带货规则-2024-Q3" |

### 4.3 边类型枚举（6 种）

| edge_type | 含义 |
|-----------|------|
| `references` | 一般引用（[[wikilink]] 自动产生） |
| `supersedes` | 推翻（新节点取代旧节点，维持时间线） |
| `merged_from` | 合并自（多节点合并为新节点） |
| `derived_from` | 派生自（lesson → rule 升级时记录） |
| `conflicts_with` | 冲突（待人审裁决） |
| `promoted_to` | 提升记录（project 级 → company 级） |

### 4.4 时效性模型（FR7）

节点必有 `volatility` 字段：

| volatility | 含义 | 半衰期（验证有效期） | 典型 |
|------------|------|-------------------|------|
| `stable` | 几乎不变 | ∞ | 数学定理、设计模式、CAP |
| `slow` | 缓慢变化 | 365 天 | 公司流程、技术选型理由 |
| `fast` | 频繁变化 | 90 天 | 平台规则、API、价格、政策 |

可选字段：

- `valid_until`：显式有效截止时间
- `verified_at`：上次人工/权威源验证时间
- `source_url`：外部原文 URL
- `external_version`：外部依赖快照 JSONB（如 `{"platform":"douyin","policy_version":"2024-Q3"}`）

#### 检索时 freshness_score（实时算，不存）

```
freshness_score =
  if valid_until 已过期: 0.0
  elif valid_until 30 天内: 0.3
  else:
    age = days_since(verified_at)
    half_life = { stable: ∞, slow: 365, fast: 90 }[volatility]
    score = exp(-age / half_life)
```

检索权重：`相似度 × 0.5 + experience_score × 0.3 + freshness_score × 0.2`

freshness 标签：

| 标签 | 范围 | 行为 |
|------|------|------|
| `fresh` | ≥ 0.7 | 正常使用 |
| `stale_warning` | 0.3 - 0.7 | 检索仍命中，但带警告 |
| `outdated` | < 0.3 | 默认排除主搜索，可显式 include 查史 |

### 4.5 业务域维度（FR10）—— 动态可扩展

业务域**不是硬编码枚举**，而是用户管理的资源。每个公司有自己的一套业务域集合（多租户隔离），可在 Web UI 自由增删改。

#### 4.5.1 设计要点

- 独立表 `business_domains`（详见 §9.8）
- 节点持外键 `business_domain_id` NOT NULL（删除走 RESTRICT，关联节点保护）
- 公司初始化时**自动 seed** `general` 业务域（兜底，保证节点必有归属）
- 缤果场景可选择性 seed 当前 5 条业务作为示例：`software` / `content` / `distribution` / `community` + `general`
- 用户后续可在 `/knowledge/domains` 增加业务（如 `consulting` / `ai-education` / `paid-membership`），仅前端操作，无 DB migration
- 每个 domain 记录：name（slug 格式，URL 友好）/ display_label（人类可读，如"软件与 AI 工具"）/ color / icon / description / sort_order / archived

#### 4.5.2 检索过滤

检索 API `domain` 参数从枚举值改为字符串数组（按 name 匹配，按 company 隔离）：

```
GET /api/knowledge/search?q=...&domain=software,content
```

#### 4.5.3 归档保护

业务域不允许硬删除（删除会破坏关联节点引用）。归档操作（`archived=true`）将该 domain 从新建下拉和 UI 选择器中隐藏，但已关联节点不动、详情页仍能显示原 domain。

#### 4.5.4 配色与图标

每个 domain 在创建时由用户自配 color（hex）和 icon（lucide 图标 key）。设计令牌不再硬编码（详见 §11.1 调整）。

---

## 5. 功能需求总览（FR1-FR14）

### A. 核心机制

- **FR1** DB-first 载体
- **FR2** 5 种节点类型
- **FR3** 6 种边类型
- **FR4** 三路写入 + 审查队列
- **FR5** 两路检索（语义 + 经验推荐）

### B. 演化与时效

- **FR6** 演化 6 条（升规则 / 衰减 / 合并 / 冲突 / 时效巡检 / 模式涌现）
- **FR7** 时效性 profile
- **FR8** 历史可查（outdated 保留）
- **FR9** 反馈四值（helped / outdated / wrong / irrelevant）

### C. 业务集成

- **FR10** 动态业务域管理（business_domains 表 + 节点关联）

### D. 外部接入

- **FR11** 外部源采集（爬虫 / RSS / GitHub / KnowledgeCollector 可插拔接口）
- **FR12** Web UI（search / detail / review / dashboard / graph）
- **FR13** MCP 服务暴露
- **FR14** 图谱可视化

---

## 6. 详细功能规格

### FR1: DB-first 载体

- 所有知识为 PG 行，无文件系统
- 8 张表：`business_domains` / `knowledge_nodes` / `knowledge_edges` / `knowledge_drafts` / `knowledge_node_revisions` / `knowledge_node_events` / `knowledge_sources` / `knowledge_metrics`（详见 §9）
- 向量索引走 pgvector HNSW
- Agent 通过 REST API 读写（详见 §10）
- 备份：pg_dump；版本：revisions 表；历史：events 表

### FR2: 节点类型

详见 §4.2。MVP 实现 5 种类型，枚举可扩展（后续可增 `pattern` / `playbook` 等）。

### FR3: 边类型

详见 §4.3。MVP 实现 6 种边类型。content 内 `[[node-id]]` 在节点保存时自动解析为 `references` 边；其他边类型由演化引擎或显式 API 产生。

### FR4: 三路写入 + 审查队列

#### 4.1 路径 A：Agent 任务收尾自评

- 触发：`afterTaskComplete` hook（Paperclip 现有钩子）
- 流程：
  1. Issue 状态 → done
  2. 系统 prompt 追加："本次任务有什么需要记录的教训/规则/决策吗？"
  3. Agent 输出 JSON：`{ nodes: [{ type, title, content, confidence, volatility, used_for, references_issue_ids }] }`
  4. 每条 node 写入 `knowledge_drafts`，source=`agent_self_review`

#### 4.2 路径 B：失败信号自动提取

订阅 Paperclip 事件总线，触发以下事件时自动跑 LLM 提取：

| 事件 | 触发器 |
|------|--------|
| Issue 被 reopened | Issues 状态机 |
| Approval rejected | Approvals 服务 |
| Run cancelled / timeout | Heartbeat 引擎 |
| commit reverted | Git 事件（外部 webhook） |

- Curator Agent 读相关 Run logs / Comments / Diff → LLM 输出 draft
- 写入 `knowledge_drafts`，source=`failure_signal`

#### 4.3 路径 C：人工写入

- Web UI 编辑器 `/knowledge/editor`
- Agent 显式工具 `propose_knowledge_node(...)`
- 管理员可选 `skip_review=true`（高信任来源直接落地）
- 写入 source=`manual`

#### 4.4 审查队列（梯度审查 + Reviewer Agent）

**为什么需要梯度**：三路写入 + 爬虫开起来，一周可能产出上百条 draft。缤果作为单操作者公司，单人审不过来。必须靠分层削减人工审查负担。

**梯度策略**（draft 落地时分流）：

| 档位 | 判定条件 | 行为 |
|------|---------|------|
| 自动通过 | `source=manual` 且 `confidence ≥ 0.9`；或 `created_by_user.is_admin=true` 且 `skip_review=true` | 直接写 nodes，不进队列 |
| Reviewer Agent 初筛 | 其他所有 draft | 进队列后由 **Reviewer Agent** 先读，标 `pre_verdict ∈ {recommend_approve, recommend_reject, needs_human}` 和 reasoning |
| 人审优先 | `pre_verdict=needs_human` 或检测到 `conflicts_with` 关系 | 队列顶部高亮 |
| 人审默认 | `pre_verdict=recommend_approve/reject` | 队列下方，可一键应用 Reviewer 建议 |

**Reviewer Agent 职责**：
- 输入：draft 内容 + 既有相关节点（语义近邻 Top 5）+ 业务域上下文
- 输出：pre_verdict + 简短理由（≤ 100 字）+ 检测到的潜在冲突节点 ID 列表
- 实现：单独的 Agent 配置（type=`reviewer`），跑在高频 Routine `hourly-draft-pre-review`（见 §13.3）
- 落库：写入 `knowledge_drafts.pre_verdict` 和 `pre_verdict_reasoning` 两个新字段（见 §9.4）

**审查 UI 配套**（FR12 §12.4 详述）：
- 队列界面 `/knowledge/review`
- 默认排序：人审优先 → 按 `confidence × waiting_hours` 降序
- 过滤：source / domain / volatility / pre_verdict
- 批量操作："同源同类型一键应用"、"一键接受 Reviewer 所有 recommend_approve"

**预期效果**：单人审查带宽放大 5-10 倍——只需关注 needs_human + 冲突类，其他用一键确认 Reviewer 建议。

### FR5: 两路检索

#### 5.1 触发时机

- Agent checkout Issue 后，自动作为 `heartbeat-context` 一部分
- Agent 显式调 `search_knowledge_base(query, opts)` 工具
- Web UI 搜索框
- MCP 工具 `search`（FR13）

#### 5.2 检索算法（两路加权合并）

**路径 A — 语义搜索**：
```
SELECT n.*, 1 - (n.embedding <=> $query_embedding) AS similarity
FROM knowledge_nodes n
JOIN business_domains d ON d.id = n.business_domain_id
WHERE 1 - (n.embedding <=> $query_embedding) > 0.75
  AND n.status = 'active'
  AND (n.level = 'company' OR (n.level = 'project' AND n.project_id = $current))
  AND (d.name = ANY($domain_names) OR d.name = 'general')   -- 业务域按 name 字符串数组过滤；general 永远兜底命中
  AND n.company_id = $company_id
ORDER BY n.embedding <=> $query_embedding
LIMIT 10
```

**路径 B — 经验推荐**：
```
SELECT ... trigger_count * (1 / GREATEST(1, days_since_last_triggered)) AS exp_score
WHERE used_for && $tags
  AND status = 'active'
  AND (level/domain 过滤同上)
ORDER BY exp_score DESC
LIMIT 5
```

**合并**：
```
final_score = similarity × 0.5 + exp_score × 0.3 + freshness_score × 0.2
取 Top 5
```

#### 5.3 上下文注入格式

```markdown
## 知识库相关条目

- [[a3f1...8c2e]] **PG 死锁排查** (fresh, lesson, confidence=0.9, 已防止 7 次)
- [[b7d2...91ff]] **抖音直播带货规则** (⚠ stale_warning, fact, 验证于 2024-08, volatility=fast)
- [[c1e9...44a0]] **选 PG 不选 MySQL 的理由** (fresh, decision, used_for=architecture)
```

### FR6: 演化 6 条

| # | 名称 | 触发条件 | 行为 |
|---|------|---------|------|
| 1 | 升规则 | lesson 节点 trigger_count ≥ 3 且 prevention_score ≥ 0.7 | 创建 Issue "建议升级为 rule" 待人审；通过后改 type=rule + 加 derived_from 边 |
| 2 | 衰减归档 | active 节点 180 天未被触发 | status=archived（搜索池排除） |
| 3 | 合并提案 | 任两节点 cosine ≥ 0.9 | 创建合并 Issue 待人审；通过后写新节点 + merged_from 边 + 原节点 status=archived |
| 4 | 冲突审查 | 新 draft 与既有 rule 经 LLM 判断为冲突 | 进入"冲突分组"审查队列 + conflicts_with 边 |
| 5 | 时效性巡检 | valid_until 临近 7 天 / fast 90 天未验证 / slow 365 天未验证 | 创建"请验证 [节点]" Issue 给 Curator Agent |
| 6 | **模式涌现** | 同 used_for + 同 domain 下 ≥ 5 条 lesson 经 LLM 聚类发现共性 | 创建 Issue "建议生成模式总结节点"；通过后写 `concept` 类节点（metadata.is_pattern=true），原 lesson 用 `references` 边连过来 |

**关于第 6 条"模式涌现"的细节**：

这是 Karpathy 范式中"活体"最关键的一环——不只是被动积累，而是主动抽象，让知识库从"档案"长成"理论"。

- **触发频次**：每周一次（在 `weekly-knowledge-evolution` 内），避免聚类噪音
- **算法草案**：
  1. 按 `(used_for_tag, business_domain_id)` 二维分组
  2. 组内对 lesson 节点做 embedding 聚类（建议 HDBSCAN，密度敏感且不需预设 k）
  3. 簇大小 ≥ 5 的调 LLM：给定该簇所有 lesson 的 title + content + metadata，提取"共性模式"
  4. LLM 输出含 `pattern_name / pattern_summary / pattern_conditions / source_lesson_ids` 的 JSON
  5. 写入 draft（type=concept, metadata.is_pattern=true, metadata.derived_from_lessons=[...]），走梯度审查
- **失败模式**：LLM 抽不出有意义共性 → 标记此簇 cooldown=30 天，避免反复打扰
- **预期效果**：3-6 个月后，company 级 concept 节点中应有 ≥ 10 个 is_pattern=true 的"理论性"节点，反映出企业真实积累的方法论

演化引擎落地为 Routine：`weekly-knowledge-evolution`（cron `0 9 * * 1`），详见 §13.3。

### FR7: 时效性 profile

详见 §4.4。

### FR8: 历史可查

- `outdated` 节点不进默认搜索，但：
  - 详情页可访问
  - 通过 `supersedes` 边可从新节点回溯到旧节点
  - API `?include_outdated=true` 显式包含
- 例：搜"抖音规则"默认得最新；显式带 outdated 得 2023/2024/2025 三版按时间线呈现

### FR9: 反馈四值

Agent 完成任务后对被检索过的每条节点反馈：

| 反馈 | 行为 |
|------|------|
| `helped` | trigger_count +1；last_triggered=now；写 `triggered` 事件 |
| `outdated` | freshness_score 强制降到 ≤ 0.3；自动创建验证 Issue |
| `wrong` | 进冲突审查队列；写 `feedback` 事件 |
| `irrelevant` | 降低该 used_for 标签下的推荐权重（写 `feedback` 事件，统计层处理） |

### FR10: 动态业务域管理

详见 §4.5。要点：

- 业务域是用户可扩展资源（独立表 `business_domains`，按 company 隔离），不是硬编码枚举
- 节点持 `business_domain_id` 外键 NOT NULL；公司初始化自动 seed `general`
- 检索时可按 domain name 字符串数组过滤（`?domain=software,content`）
- Dashboard 显示各 domain 的节点数和热度分布
- Agent 在某 Issue 上工作时，domain_id 可由 Project 或 Issue 标签自动推断（如 Issue 标签含 "marketing" → 查找 name=`content` 的 domain）

CRUD 操作：

- 创建：`POST /api/knowledge/domains` { name, display_label, color, icon, description }
- 编辑：`PATCH /api/knowledge/domains/:id`
- 归档（软删）：`POST /api/knowledge/domains/:id/archive`，关联节点不动
- 恢复：`POST /api/knowledge/domains/:id/restore`
- 不允许硬删除（ON DELETE RESTRICT 保护关联节点）

### FR11: 外部源采集

保留原 PRD F9 + F12 的能力（与 v1 一致）：

#### 11.1 源管理

`knowledge_sources` 表（与 v1 兼容）：
- 字段：name / url / source_type / collector_name / crawl_frequency / trust_weight / last_crawled / article_selector / sitemap_url / enabled / crawl_config(JSONB)
- 源类型：`blog / docs / github / forum / paper / rss / slack / custom`

#### 11.2 KnowledgeCollector 可插拔接口

```typescript
interface KnowledgeCollector {
  name: string;
  collect(config: CollectorConfig): Promise<RawNote[]>;
  checkForUpdates(source: KnowledgeSource): Promise<boolean>;
  supportedSourceTypes: SourceType[];
}
```

内置实现：
- `WebCrawler`（HTML→MD + Readability + 质量过滤 + robots.txt）
- `RSSCollector`
- `GitHubCollector`（Issues / Discussions / README）

Plugin 系统可注册自定义 Collector（如 `SlackThreadCollector`）。

#### 11.3 三层采集策略

| 层级 | 描述 | 产出 |
|------|------|------|
| 种子源 | 用户手动配置的权威源 | 新文章 → draft |
| 外链扩展 | 从种子源文章正文外链发现新候选源 | 域级白名单提案 |
| 按需搜索 | Issue 触发的定向搜集 | 候选页面 → draft |

#### 11.4 HTML → Markdown → Draft 管道

```
URL → robots.txt 检查 → 下载 → Readability 抽正文 → turndown → LLM 质量评分 → < 4 丢弃，否则写入 draft（source=manual + source_url 标注）
```

#### 11.5 礼貌策略

- User-Agent: `Paperclip-LLMWiki-Crawler/1.0`
- 单域并发 1，全局并发 3
- 请求间隔 ≥ 5s
- 429/503 指数退避（1/2/4/8s，最多 3 次）

### FR12: Web UI

#### 12.1 页面清单

| 路径 | 用途 |
|------|------|
| `/knowledge/search` | 搜索框 + 结果列表（按 type / domain / volatility / freshness 过滤） |
| `/knowledge/:id` | 详情页（Markdown 渲染 + 正反向 edges + 事件时间线 + 元数据） |
| `/knowledge/review` | 审查队列（pending / approved / rejected / revision_requested 四 Tab） |
| `/knowledge/dashboard` | 热度 Top10 + 各 domain 分布 + 待审数 + outdated 数 + 即将过期 |
| `/knowledge/graph` | 节点+边图视图（FR14） |
| `/knowledge/editor` | Markdown 编辑器（手动写入入口） |
| `/knowledge/sources` | 外部源管理 |
| `/knowledge/domains` | 业务域管理（FR10：新增/编辑/归档业务条线） |

#### 12.2 搜索结果列表

每条卡片显示：
- 标题 + 类型徽章（concept/lesson/rule/decision/fact 不同颜色）
- 摘要片段（content 前 200 字）
- freshness 徽章（fresh 绿 / stale 黄 / outdated 灰）
- domain 徽章
- 元数据条：trigger_count / verified_at / level

#### 12.3 详情页

- 上：Markdown 渲染正文，`[[node-id]]` 渲染为可点链接
- 侧：元数据面板（type / level / domain / volatility / valid_until / verified_at / source_url / confidence / verified）
- 下：双链区（"引用了 X 个节点" + "被 Y 个节点引用"）+ 时间线（revisions + events 合并展示）
- 操作：标记已验证 / 提升到公司级 / 创建验证 Issue / 编辑

#### 12.4 Dashboard `/knowledge/dashboard`

布局自上而下：

1. **健康指标栏**（顶部一行 6 个卡片，对应 §7.5 六个指标）
   - 每卡片：数值 + 健康区间提示 + 状态点（绿/黄/红）
   - 点击卡片跳详情视图
2. **热度 Top 10**（横向条形图，按 trigger_count 排序，可按 domain 过滤）
3. **业务域分布**（饼图：按 business_domain 分组节点数）
4. **类型分布**（条形图：concept / lesson / rule / decision / fact 各多少）
5. **演化轨迹**（最近 30 天内：升规则数 / 归档数 / 合并数 / 冲突未决数 / 模式涌现数）
6. **待办栏**：审查待办数（按 pre_verdict 分类）+ 待验证数 + alarm Issue 链接

异常指标点击后跳到对应详情列表（如"过期未巡检"→ 列出所有 fast + > 90d 节点）。

#### 12.5 审查队列 `/knowledge/review`

- 4 Tab：Pending / Approved / Rejected / Revision-requested
- Pending 排序优先级：pre_verdict=needs_human → 检测到 conflicts_with → 高 confidence 等久 → 其余
- 列表卡片显示：标题 + source 徽章 + pre_verdict 徽章 + Reviewer reasoning（折叠 1 行，hover 展开）
- 批量勾选 → 一键应用："批准所有 recommend_approve" / "驳回所有 recommend_reject" / 自定义批量

#### 12.6 业务域管理 `/knowledge/domains` （FR10）

- 列表：表格展示所有业务域（含 archived），列字段 - 徽章预览 / display_label / name / 节点数 / sort_order / archived 状态 / 操作
- 默认排序：按 sort_order 升序，archived 项灰显在最下
- 顶部按钮："新增业务域"
- 单条操作：编辑 / 归档 / 恢复（不提供硬删除）
- 新增/编辑模态框字段：
  - `name`（slug 自动校验：小写、字母数字、连字符；同公司唯一）
  - `display_label`（中英文均可，必填）
  - `description`（可选，长描述）
  - `color`（color picker，默认灰色 `#6B7280`）
  - `icon`（lucide 图标选择器，可选）
  - `sort_order`（数字输入，默认 0）

### FR13: MCP 服务暴露

提供 Paperclip MCP Server，把知识库能力暴露给外部 Agent（Claude Code / Codex / Cursor 等）。

#### 13.1 MCP 工具清单

| Tool | 用途 |
|------|------|
| `search_knowledge` | 语义+经验两路检索 |
| `get_node` | 按 ID 取详情（含 edges） |
| `propose_node` | 提交 draft 节点 |
| `record_feedback` | 反馈四值 |
| `list_recent_lessons` | 拉取最近 N 条 lesson（供 Agent 启动时初始化用） |
| `list_domains` | 列出当前 company 的所有可用业务域（name + display_label），供外部 Agent 在 propose_node 时选择 |

#### 13.2 MCP 鉴权

- 复用 Paperclip API Key 体系
- 每个外部 Agent 对应一个 API Key + level 权限映射
- 知识层级过滤强制在 MCP 服务端做（不信任客户端）

### FR14: 图谱可视化

`/knowledge/graph` 页面，技术栈选 Cytoscape.js 或 Sigma.js。

#### 14.1 视图模式

- **关系图**：节点为圆，边按 edge_type 上色（references 灰 / supersedes 红 / conflicts_with 橙 / merged_from 蓝）
- **时间线图**：按 created_at 横轴排列，supersedes 边表示版本更替
- **业务域聚类**：按 business_domain 着色，自然形成 4-5 个集群

#### 14.2 交互

- 点击节点 → 跳详情页
- hover → 显示 title + 类型 + freshness
- 过滤：domain / type / status / freshness
- 搜索高亮：输入关键词，匹配的节点高亮，其他变灰

#### 14.3 性能

- 节点 ≤ 500 → 全量渲染
- 节点 > 500 → 默认只显示种子节点（trigger_count Top 50），按需展开邻居

---

## 7. 非功能需求

### 7.1 性能

| 指标 | 目标 |
|------|------|
| 语义搜索延迟 | P95 < 500ms（含 freshness 计算） |
| Draft 写入 | < 100ms（不含 embedding 生成） |
| Embedding 生成 | < 2s（OpenAI text-embedding-3-small） |
| 图视图首屏渲染 | < 1s（500 节点以内） |
| MCP 工具调用 | P95 < 800ms（含跨网络） |

### 7.2 可靠性

| 指标 | 目标 |
|------|------|
| Draft 落库失败率 | < 0.1% |
| 向量索引一致性 | 节点写入后 5s 内可被检索 |
| 演化 Routine 失败重试 | 3 次指数退避 |

### 7.3 安全

| 约束 | 实现 |
|------|------|
| 层级权限 | SQL WHERE 强制过滤；MCP 服务端二次过滤 |
| SQL 注入 | 参数化查询，绝不拼接用户输入 |
| 内容审查 | LLM 在 draft 阶段过滤敏感内容（信用卡号、密钥等） |
| API 鉴权 | 复用 Paperclip API Key + Run JWT 体系 |

### 7.4 可扩展性

- 节点类型枚举可扩展（pgEnum + migration）
- 边类型枚举可扩展
- business_domain 可扩展
- KnowledgeCollector 可插拔（FR11）
- Embedding 模型可替换（抽象 `embed()` 接口）

### 7.5 可观测性与健康指标

系统健康用以下 6 个核心指标度量，在 Dashboard 顶部展示，超阈值时由"每日自检 Routine"创建 alarm Issue：

| 指标 | 健康区间 | 异常含义 |
|------|---------|---------|
| 周新增 draft 数 | > 0 | 写入路径阻塞 / Agent 不再自评 |
| 审查 backlog 时长（中位） | < 24h | 审查瓶颈，需调梯度策略或加 Reviewer Agent 频率 |
| 检索命中后 helped 比例 | > 0.5 | 推荐质量差，检索算法或语料需调 |
| 平均节点引用密度 | > 1.5 边/节点 | 知识"孤岛化"，未形成网络 |
| 冲突未决数 | < 10 | 冲突堆积，质量管理失效 |
| 过期未巡检数（fast + > 90d） | < 5 | 时效性巡检 Routine 失败或 Curator Agent 异常 |

每日自检 Routine `daily-knowledge-healthcheck` 见 §13.3。

---

## 8. 系统架构

```
┌────────────────────────────────────────────────────────────────┐
│                      Paperclip Application                      │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐ │
│  │Heartbeat │  │ Routines │  │  Web UI  │  │  REST + MCP    │ │
│  │  Engine  │  │  (Cron)  │  │ (React)  │  │   Server       │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬───────┘ │
│       │             │              │                  │         │
│       └─────────────┼──────────────┼──────────────────┘         │
│                     │              │                            │
│            ┌────────┴──────────────┴────────┐                   │
│            │     llm-wiki 服务层             │                   │
│            │                                 │                   │
│  ┌─────────┴──────────┐  ┌──────────────────┴────────────────┐ │
│  │      写入管道           │  │          读取管道                │ │
│  │ drafter → reviewer-agent│  │ retriever (semantic+experience │ │
│  │ → node-writer           │  │   +freshness) → context-inject │ │
│  │ → edge-resolver         │  │                                │ │
│  └────────────────────────┘  └────────────────────────────────┘ │
│  ┌──────────────────────┐  ┌────────────────────────────────┐  │
│  │    演化引擎(6 条)     │  │     外部源采集                  │  │
│  │ promote/decay/merge/ │  │ sources-manager + collectors   │  │
│  │ conflict/freshness/  │  │ (WebCrawler/RSS/GitHub/...)    │  │
│  │ pattern-emergence    │  │                                │  │
│  └──────────────────────┘  └────────────────────────────────┘  │
│  ┌──────────────────────┐  ┌────────────────────────────────┐  │
│  │   健康自检 + 业务域   │  │       MCP Server               │  │
│  │ daily-healthcheck +  │  │ search/get/propose/feedback/   │  │
│  │ business-domains svc │  │ list_recent_lessons/list_domains│ │
│  └──────────────────────┘  └────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  数据访问层                                │  │
│  │  Drizzle ORM (8 tables: business_domains / nodes /       │  │
│  │   edges / drafts / revisions / events / sources / metrics)│  │
│  │  + pgvector raw SQL (HNSW search)                         │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼               ▼
     ┌─────────────┐  ┌──────────┐  ┌──────────────┐
     │ PostgreSQL  │  │   LLM    │  │  外部站点     │
     │ + pgvector  │  │  Client  │  │ (RSS/HTML/   │
     │ (8张表+索引)│  │(Anthropic)│  │  GitHub API) │
     └─────────────┘  └──────────┘  └──────────────┘
```

---

## 9. 数据模型

### 9.1 枚举类型

```sql
CREATE TYPE knowledge_node_type AS ENUM ('concept', 'lesson', 'rule', 'decision', 'fact');
CREATE TYPE knowledge_level AS ENUM ('personal', 'project', 'company');
CREATE TYPE knowledge_status AS ENUM ('active', 'archived', 'outdated', 'revoked');
CREATE TYPE knowledge_volatility AS ENUM ('stable', 'slow', 'fast');
-- NOTE: business_domain 不用枚举，改用独立表 business_domains（见 §9.8）以支持用户扩展

CREATE TYPE knowledge_edge_type AS ENUM (
  'references', 'supersedes', 'merged_from',
  'derived_from', 'conflicts_with', 'promoted_to'
);

CREATE TYPE knowledge_draft_source AS ENUM ('agent_self_review', 'failure_signal', 'manual');
CREATE TYPE knowledge_draft_status AS ENUM ('pending', 'approved', 'rejected', 'revision_requested');

CREATE TYPE knowledge_event_type AS ENUM (
  'created', 'updated', 'triggered', 'feedback',
  'verified', 'superseded', 'archived', 'promoted', 'revoked'
);

CREATE TYPE knowledge_pre_verdict AS ENUM (
  'recommend_approve', 'recommend_reject', 'needs_human'
);
```

### 9.2 表 1: `knowledge_nodes`

详细字段：
- 标识：`id` UUID PK，`title` TEXT，`content` TEXT
- 类型：`type` (5 枚举)，`status` (4 枚举)，`level` (3 枚举)
- 业务域：`business_domain_id` UUID NOT NULL REFERENCES business_domains(id) ON DELETE RESTRICT（不允许硬删，保护关联节点）
- 归属：`company_id` FK NOT NULL，`project_id` FK NULL
- 向量：`embedding` vector(1536)
- 质量：`confidence` REAL，`verified` BOOL
- 时效：`volatility` (3 枚举)，`valid_until` TIMESTAMPTZ，`verified_at` TIMESTAMPTZ，`source_url` TEXT，`external_version` JSONB
- 统计：`trigger_count` INT，`last_triggered` TIMESTAMPTZ，`used_for` TEXT[]，`prevention_score` REAL
- 元数据：`metadata` JSONB（按 type 携带不同字段，如 lesson 的 symptom/root_cause/next_time）
- 来源：`created_by_agent` FK，`created_by_user` FK
- 时间：`created_at`，`updated_at`

索引：
- HNSW on embedding
- (company_id, business_domain_id, status) WHERE status='active'
- (company_id, level, status) WHERE status='active'
- GIN on used_for
- (type, status), (volatility, verified_at), (valid_until)

### 9.3 表 2: `knowledge_edges`

字段：`id` / `from_node_id` / `to_node_id` / `edge_type` / `created_by_agent` / `created_by_user` / `auto_generated` BOOL / `metadata` JSONB / `created_at`

约束：自指禁止；(from, to, edge_type) UNIQUE

索引：(from_node_id, edge_type)，(to_node_id, edge_type)

### 9.4 表 3: `knowledge_drafts`

字段：`id` / `target_node_id`(可空，新建为空) / `proposed_*`(title/content/type/level/metadata/volatility/valid_until) / `source` / `source_*`(agent_id/run_id/issue_id/user_id) / `confidence` / `status` / `reviewed_by` / `review_notes` / `company_id` / `created_at` / `reviewed_at`

**Reviewer Agent 初筛字段**（FR4 §6.4 梯度审查）：
- `pre_verdict` knowledge_pre_verdict ENUM（`recommend_approve` / `recommend_reject` / `needs_human` / NULL 未筛）
- `pre_verdict_reasoning` TEXT —— Reviewer 输出的简短理由（≤ 200 字）
- `pre_verdict_at` TIMESTAMPTZ —— Reviewer 完成初筛时间
- `detected_conflicts` UUID[] —— Reviewer 检测到的可能冲突节点 ID 数组

索引：(company_id, status, created_at) WHERE status='pending'，(source, status)，(status, pre_verdict) WHERE status='pending'

### 9.5 表 4: `knowledge_node_revisions`

字段：`id` / `node_id` / `title` / `content` / `type` / `level` / `metadata`（修改前快照） / `changeset_summary` / `editor_agent_id` / `editor_user_id` / `draft_id` / `created_at`

索引：(node_id, created_at DESC)

### 9.6 表 5: `knowledge_node_events`

字段：`id` / `node_id` / `event_type` / `agent_id` / `run_id` / `issue_id` / `user_id` / `feedback`(反馈值) / `metadata` / `created_at`

索引：(node_id, event_type, created_at DESC)，(issue_id) WHERE issue_id IS NOT NULL

### 9.7 表 6: `knowledge_sources`（FR11 复用 v1 设计）

字段：name / url / source_type / collector_name / crawl_frequency / trust_weight / last_crawled / article_selector / sitemap_url / tags[] / enabled / crawl_config(JSONB) / company_id / created_at / updated_at

### 9.8 表 7: `business_domains`（FR10 动态业务域）

承载 §4.5 的可扩展业务域。每个公司有独立的 domain 集合。

字段：
- `id` UUID PK
- `company_id` UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE
- `name` TEXT NOT NULL —— slug 风格（小写、连字符），如 `software` / `ai-education`，作 API 参数和 URL 用
- `display_label` TEXT NOT NULL —— 人类可读名，如 "软件与 AI 工具"
- `description` TEXT —— 业务域简介，可选
- `color` TEXT NOT NULL DEFAULT '#6B7280' —— UI 徽章颜色（hex 格式）
- `icon` TEXT —— 可选 lucide 图标 key
- `sort_order` INTEGER NOT NULL DEFAULT 0 —— UI 列表排序权重
- `archived` BOOLEAN NOT NULL DEFAULT false —— 软删标记，archived=true 时新建/检索下拉不出现，已关联节点不动
- `created_at` / `updated_at` TIMESTAMPTZ

索引：
- UNIQUE (company_id, name) —— 同公司内 name 唯一
- (company_id, sort_order) WHERE archived = false —— UI 列表查询主索引

公司初始化 seed：每个新 company 自动 INSERT `general`（兜底）。缤果场景可选 seed 当前 5 条业务作为示例（`software` / `content` / `distribution` / `community` 各一条）。

### 9.9 表 8: `knowledge_metrics`（健康指标缓存，§7.5 + §13.3 Routine 3）

每日自检 Routine 计算 §7.5 六个健康指标后写入本表，Dashboard 读本表展示，避免每次请求都现算。

字段：
- `id` UUID PK
- `company_id` UUID FK NOT NULL
- `metric_name` TEXT NOT NULL —— 如 `weekly_new_drafts` / `review_backlog_hours_p50` / `helped_ratio` / `avg_edges_per_node` / `unresolved_conflicts` / `stale_unchecked_fast`
- `metric_value` NUMERIC NOT NULL
- `status` TEXT —— `healthy` / `warning` / `critical`（按 §7.5 阈值判定）
- `computed_at` TIMESTAMPTZ NOT NULL
- `details` JSONB —— 计算明细（如哪些节点过期、哪些 draft 等待最久），便于 Dashboard 点击下钻

索引：(company_id, metric_name, computed_at DESC)

只保留每个 (company, metric) 的最新一条 + 90 天历史用于趋势图。超过 90 天的自动归档清理。

### 9.10 表关系

```
companies ──┬─< business_domains ←─┐
            │                       │
            ├─< knowledge_nodes ────┴ ──┬──< knowledge_edges (from/to)
            │   (business_domain_id FK) ├──< knowledge_node_revisions
            │                           └──< knowledge_node_events
            ├─< knowledge_drafts ──→ knowledge_nodes (target)
            │           ↓
            │           └─→ knowledge_node_revisions (via draft_id)
            ├─< knowledge_sources
            └─< knowledge_metrics
```

完整 SQL DDL 见附录 A。

---

## 10. API 契约

**详细规范请见 [API 设计文档](../design/2026-05-12-llm-wiki-knowledge-engine-api.md)**。本节仅列资源概要：

### 10.1 资源清单

| 资源前缀 | 主要操作 | 详细参见 |
|---------|---------|---------|
| `/api/knowledge/nodes` | GET / POST / PATCH / DELETE | API 文档 §4.1 |
| `/api/knowledge/search` | GET 语义+经验检索 | API 文档 §4.2 |
| `/api/knowledge/edges` | POST / DELETE 边管理 | API 文档 §4.3 |
| `/api/knowledge/drafts` | POST / approve / reject / request-revision / batch-approve | API 文档 §4.4 |
| `/api/knowledge/nodes/:id/feedback` | POST 反馈四值 | API 文档 §4.5 |
| `/api/knowledge/nodes/:id/promote-to-rule` 等 | 人工演化触发 | API 文档 §4.6 |
| `/api/knowledge/domains` | 业务域 CRUD + 归档（FR10） | API 文档 §4.7 |
| `/api/knowledge/sources` | 外部源管理 | API 文档 §4.8 |
| `/api/knowledge/stats` | 总览统计 | API 文档 §4.9 |

### 10.2 鉴权

三种方式：Session Cookie（Web UI）/ API Key（Agent 与脚本）/ Run JWT（Paperclip 内部 Agent）。详见 API 文档 §2。

### 10.3 错误码与通用约定

参数校验 / metadata schema 校验 / 跨公司隔离 / 速率限制等。详见 API 文档 §3、§7。

---

## 11. UI/UX 规范

**详细规范请见 [UI / 交互设计文档](../design/2026-05-12-llm-wiki-knowledge-engine-ui.md)**。本节仅列要点：

### 11.1 页面清单（8 个）

`/knowledge/search` · `/knowledge/:id` · `/knowledge/review` · `/knowledge/dashboard` · `/knowledge/editor` · `/knowledge/sources` · `/knowledge/domains` · `/knowledge/graph`

### 11.2 设计令牌

- 节点类型徽章（5 色，固定）、freshness 标签（4 色，固定）、边类型（6 种，固定）
- **业务域配色**：用户自配（创建 business_domain 时选 color/icon），全站徽章读 `business_domains.color`，详见 UI 文档 §2.4

### 11.3 关键交互

- 搜索：`type:lesson domain:content` 快捷过滤语法
- 编辑器：`[[` 触发节点自动补全 + 实时预览
- 详情页：`[[id]]` 可点 + hover 预览小卡
- 审查队列：Reviewer Agent 初筛结果 + 一键批量
- 图谱：Cytoscape 三种视图（关系/时间线/域聚类）

### 11.4 移动端

MVP 不针对移动端优化，≥768px 屏幕保证可用。详见 UI 文档 §7。

---

## 12. MCP 服务暴露规范

**详细规范请见 [API 设计文档 §5](../design/2026-05-12-llm-wiki-knowledge-engine-api.md#5-mcp-协议规范)**。本节仅列要点：

### 12.1 工具清单（6 个）

| Tool | 用途 |
|------|------|
| `search_knowledge` | 语义+经验检索 |
| `get_node` | 按 ID 取详情（含 edges） |
| `propose_node` | 提交 draft 节点 |
| `record_feedback` | 反馈四值 |
| `list_recent_lessons` | 拉取最近 N 条 lesson |
| `list_domains` | 列出当前 company 业务域（供 propose_node 选 domain） |

### 12.2 鉴权

API Key 绑定 `company_id` + `level`，服务端强制 SQL WHERE 过滤，绝不信任客户端声明。详见 API 文档 §5.

### 12.3 部署形态

- 内嵌 Paperclip Server 提供 HTTP/SSE 端点：`/mcp/v1/sse`
- 独立 stdio 模式：`paperclipai mcp --api-key=<key>`

---

## 13. 与 Paperclip 集成规范

### 13.1 Agent 工具注册

通过 Paperclip Plugin Tool Dispatcher 注册：

```typescript
tools: [
  { name: "search_knowledge_base", description: "搜索 Paperclip 知识库" },
  { name: "propose_knowledge_node", description: "提交知识节点到审查队列" },
  { name: "record_knowledge_feedback", description: "对已检索节点反馈" },
  { name: "mark_node_outdated", description: "标记节点过时" },
]
```

### 13.2 心跳集成

```
Agent checkout Issue
  → heartbeat-context API
    → retriever.search(issue.title + issue.description, domain=infer(issue.tags))
    → 结果注入 context.knowledge_entries
  → Agent 执行
    → 可随时调 search_knowledge_base
  → 任务完成
    → afterTaskComplete hook
      → "本次有教训吗" 提问 → drafter.create()
```

### 13.3 Routine 注册

需要注册 3 个 Routine：

```
Routine 1: weekly-knowledge-evolution
  Cron: "0 9 * * 1"               # 每周一 9:00
  Agent: Curator Agent
  Actions:
    - promotion-check()             # 演化第 1 条：升规则
    - decay-scan()                  # 演化第 2 条：衰减归档
    - merge-candidate-detect()      # 演化第 3 条：合并提案
    - conflict-detect()             # 演化第 4 条：冲突审查
    - freshness-audit()             # 演化第 5 条：时效性巡检
    - pattern-emergence()           # 演化第 6 条：模式涌现
  Output: 各类提案 Issue + 巡检报告 Issue

Routine 2: hourly-draft-pre-review
  Cron: "0 * * * *"                 # 每小时
  Agent: Reviewer Agent
  Actions:
    - 拉取所有 status=pending 且 pre_verdict IS NULL 的 draft
    - 对每条 draft 跑 LLM 初筛 → 输出 pre_verdict + reasoning + conflicts[]
    - 写回 knowledge_drafts.pre_verdict / pre_verdict_reasoning / detected_conflicts
  Output: 审查队列的优先级和初筛建议

Routine 3: daily-knowledge-healthcheck
  Cron: "0 8 * * *"                 # 每日 8:00
  Agent: Curator Agent
  Actions:
    - 计算 §7.5 六个健康指标，写入 knowledge_metrics 缓存表
    - 与阈值对比，超阈值生成 alarm Issue
    - 检测系统是否"沉默"：24h 无 draft / 7d 无审查通过 / embedding 队列堆积
    - 检测 Routine 1 和 Routine 2 是否按预期执行（失败重试 3 次后告警）
  Output: 异常时创建 alarm Issue 分配给管理员
```

### 13.4 失败信号订阅

`server/src/services/llm-wiki/listeners.ts` 订阅：
- `issue.reopened`
- `approval.rejected`
- `run.cancelled` / `run.timeout`
- `commit.reverted`（来自 git webhook）

每个监听器调用 `failure-signal-extractor.extract(event)` → 写入 draft。

---

## 14. 安全与权限模型

### 14.1 层级访问控制

| 角色 | personal | project | company |
|------|----------|---------|---------|
| Agent（本项目） | ✗ | ✓ | ✓ |
| Agent（他项目，同公司） | ✗ | ✗ | ✓ |
| 人类（本项目成员） | ✗ | ✓ | ✓ |
| 人类（公司管理员） | ✗ | ✓ | ✓ |
| 个人节点创建者 | ✓（自己的） | — | — |
| 外部 MCP Agent | 按 API Key 权限 | 按 API Key 权限 | 按 API Key 权限 |

### 14.2 写入门控

- Agent 写入 → 强制走 draft，不能直接落 nodes
- 人类管理员可 `skip_review=true` 直接写入
- confidence < 0.5 的内容自动进入"低可信度审查队列"

### 14.3 跨公司隔离

- 所有查询强制 `company_id = current_company`
- MCP API Key 绑定单一 company_id，不可跨公司

### 14.4 敏感内容过滤

- Draft 写入前过一遍正则 + LLM 过滤：信用卡号、API Key、密码、个人身份信息
- 命中后阻断写入并记录事件

---

## 15. 分阶段实施计划

> **关于 implementation plan 的拆分**：本 PRD 涵盖 8 个 Phase（约 10 周）。**每个 Phase 应独立产出一份 implementation plan**（走 `writing-plans` 流程），避免把整套系统压到一份巨型 plan。Phase 之间有依赖（Phase 1 依赖 Phase 0；Phase 2 依赖 Phase 1；其他 Phase 大部分并行可行），建议串行交付以验证每个 Phase 的稳态后再开启下一个。

### Phase 0: 基础设施（Week 1）

- [ ] PG 替换为 `pgvector/pgvector:pg16`（或确认现有镜像已含扩展）
- [ ] 创建 9 个枚举 + 8 张表 + 索引（migration `0084_llm_wiki_engine.sql`）
- [ ] **`business_domains` 表先于 `knowledge_nodes` 创建**（节点 FK 依赖）
- [ ] **公司初始化 seed 逻辑**：新 company 创建时自动 INSERT `general` 业务域；缤果场景可选 seed 当前 5 条业务作为示例数据
- [ ] Drizzle schema 定义
- [ ] embedding 服务封装（OpenAI text-embedding-3-small）

**验收**：
- pgvector 已加载
- 8 张表（business_domains / nodes / edges / drafts / revisions / events / sources / metrics）可正常 CRUD
- 新建 company 时 `general` 业务域自动落地
- 节点写入时 `business_domain_id` FK 约束生效（指向不存在的 domain → 报错）
- 可生成 embedding 并 upsert 到 nodes

### Phase 1: 三路写入 + 审查（Week 2-3）

- [ ] Draft 服务：`POST /api/knowledge/drafts`
- [ ] 审查 API：approve / reject / request-revision / batch
- [ ] Path A：afterTaskComplete hook + LLM 自评 prompt
- [ ] Path B：事件监听器（issue.reopened, approval.rejected, run.cancelled, commit.reverted）
- [ ] Path C：Web UI 编辑器 + Agent tool `propose_knowledge_node`
- [ ] Draft 通过后自动落 nodes + 解析 [[id]] 生成 edges

**验收**：
- 三路都能产出 draft
- 审查通过后正确写 nodes + edges + revisions + events
- 路径 C 跳审查可直接写入（管理员权限）

### Phase 2: 检索 + Agent 集成（Week 3-4）

- [ ] Retriever：语义 + 经验两路 + freshness 加权
- [ ] `GET /api/knowledge/search`
- [ ] heartbeat-context 集成
- [ ] Agent tool `search_knowledge_base`
- [ ] 反馈 API `POST /api/knowledge/nodes/:id/feedback`

**验收**：
- Agent checkout 后 context 注入 Top-5 节点
- freshness 标签正确（fresh / stale / outdated）
- 反馈写入正确驱动统计变化

### Phase 3: 演化引擎 + Reviewer + 自检（Week 4-5）

- [ ] Routine 1 `weekly-knowledge-evolution`
- [ ] **6 条自动行为**：升规则 / 衰减 / 合并 / 冲突 / 时效巡检 / **模式涌现**
- [ ] Curator Agent 配置
- [ ] **Reviewer Agent 配置 + Routine 2 `hourly-draft-pre-review`**（梯度审查）
- [ ] **Routine 3 `daily-knowledge-healthcheck`** + 6 个健康指标计算 + `knowledge_metrics` 缓存表
- [ ] 演化产生的 Issue 自动指派

**验收**：
- 模拟数据触发 6 条行为，分别正确产生 Issue
- 升规则后 type 改 + derived_from 边生成
- outdated 节点正确从主搜索池排除
- 模式涌现：5+ 条同主题 lesson → 产出 `concept`（is_pattern=true）节点 + references 边
- Reviewer Agent 对所有 pending draft 写入 pre_verdict
- 自检 Routine 在异常时正确开 alarm Issue（沉默检测 + 阈值检测）

### Phase 4: Web UI + 审查队列（Week 5-6）

- [ ] `/knowledge/search` + `/knowledge/:id`
- [ ] `/knowledge/review`（4 Tab + 批量审批）
- [ ] `/knowledge/dashboard`
- [ ] `/knowledge/editor`
- [ ] `/knowledge/sources`

**验收**：
- 搜索 / 详情 / 审查 / Dashboard 端到端可用
- 编辑器支持 `[[id]]` 自动补全
- 审查支持批量勾选

### Phase 5: 外部源采集 + 模板（Week 7-8）

- [ ] KnowledgeCollector 接口
- [ ] WebCrawler / RSSCollector / GitHubCollector 三个内置
- [ ] 源管理 UI
- [ ] 三层采集策略
- [ ] 质量过滤（LLM 评分 < 4 丢弃）
- [ ] 礼貌策略（robots.txt / 速率限制）

**验收**：
- 添加源 → 自动按频率抓 → 入 draft → 审查 → 落 nodes
- 质量过滤正确丢弃低质内容
- 单域并发/全局并发约束生效

### Phase 6: MCP 暴露（Week 8-9）

- [ ] Paperclip MCP Server（HTTP/SSE + stdio）
- [ ] 5 个 MCP 工具实现
- [ ] API Key 鉴权与多租户隔离
- [ ] CLI 子命令 `paperclipai mcp`

**验收**：
- Claude Code 通过 MCP 可成功 search / propose / feedback
- 跨公司隔离严格（用 A 公司 key 查不到 B 公司知识）

### Phase 7: 图谱可视化（Week 9-10）

- [ ] `/knowledge/graph` 页面（Cytoscape.js）
- [ ] 三种视图（关系图 / 时间线 / 业务域聚类）
- [ ] 节点 > 500 时的种子节点 + 按需展开

**验收**：
- 500 节点以内首屏渲染 < 1s
- 三种视图正确呈现
- 搜索高亮与跳转正常

---

## 16. 验收标准

### 16.1 功能验收

| 验收项 | 标准 |
|--------|------|
| 知识写入 | 三路都能产出 draft 并经审查落地 |
| 知识检索 | 任务上下文包含 Top-5 节点，带 freshness 标签 |
| 双链完整 | content 内 `[[id]]` 自动落 edge，反向引用可查 |
| 时效降权 | volatility=fast 节点 90 天未验证后 freshness < 0.7 |
| 演化触发 | 6 条自动行为分别能正确产生 Issue（含模式涌现） |
| 层级隔离 | 项目 A 的 Agent 无法搜到项目 B 的 project 级节点 |
| MCP 接入 | Claude Code 通过 MCP 能正常工作 |
| 图谱可视 | 500 节点以内图视图流畅 |
| Reviewer Agent | 所有 pending draft 都被打上 pre_verdict；人审带宽放大 ≥ 5 倍 |
| 健康自检 | 6 项健康指标在 Dashboard 显示；任一异常时自动开 alarm Issue |
| 模式涌现 | 同主题 ≥ 5 条 lesson 能涌现出 concept 节点（is_pattern=true） |

### 16.2 性能验收

| 指标 | 标准 |
|------|------|
| 语义搜索 P95 | < 500ms |
| Draft 写入 | < 100ms |
| MCP 工具调用 P95 | < 800ms |
| 图谱首屏 | < 1s（500 节点） |

### 16.3 安全验收

| 项 | 标准 |
|----|------|
| 层级权限 | SQL WHERE 强制过滤，MCP 服务端二次过滤 |
| 跨公司隔离 | API Key 绑定 company_id，跨公司查询返回空 |
| 敏感内容 | 信用卡 / API Key / 密码模式被阻断 |

---

## 17. 附录

### 17.1 术语表

| 术语 | 定义 |
|------|------|
| Node | 知识库的原子单元，对应 `knowledge_nodes` 表一行 |
| Edge | 节点间有向关系，对应 `knowledge_edges` 表一行 |
| Draft | 待审查的节点变更草稿 |
| Revision | 节点修改快照（每次 UPDATE 前自动写） |
| Freshness | 节点时效评分（实时算，基于 volatility + verified_at + valid_until） |
| Volatility | 节点变化速率（stable / slow / fast） |
| Business Domain | 业务条线维度，由用户在 `business_domains` 表中自由定义（每公司独立集合）；系统默认 seed `general` 兜底；不是固定枚举 |
| Curator Agent | 专职维护知识库的 Agent，跑演化 Routine |
| Reviewer Agent | 专职初筛 draft 的 Agent，输出 pre_verdict 给人审参考（见 §6.4） |
| KnowledgeCollector | 外部源采集器可插拔接口 |
| MCP | Model Context Protocol，外部 Agent 接入协议 |

### 17.2 技术依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| pgvector | 0.7+ | 向量存储与 HNSW 检索 |
| Drizzle ORM | 复用 | 全部 8 张表（business_domains / nodes / edges / drafts / revisions / events / sources / metrics）操作 |
| @anthropic-ai/sdk | 复用 | LLM 调用（自评、合成、冲突检测） |
| OpenAI Embedding API | — | text-embedding-3-small（1536 维） |
| Cytoscape.js | 3.x | 图谱可视化 |
| @modelcontextprotocol/sdk | latest | MCP Server 实现 |
| turndown + readability | — | HTML → Markdown 转换（FR11 爬虫） |

### 17.3 参考资料

- Karpathy "LLM-friendly Wiki" 范式
- pgvector HNSW: <https://github.com/pgvector/pgvector#hnsw>
- Model Context Protocol: <https://modelcontextprotocol.io>
- 前置设计：[2026-05-12-obsidian-wiki-engine-design.md](./2026-05-12-obsidian-wiki-engine-design.md)（v1 精简设计版，保留）
- 前置设计：[2026-05-12-obsidian-wiki-database-design.md](./2026-05-12-obsidian-wiki-database-design.md)（v1 数据库设计版，部分内容复用）

### 17.4 SQL DDL 完整定义

完整 8 张表 + 9 个枚举的 DDL 见后续 migration 文件 `packages/db/src/migrations/0084_llm_wiki_engine.sql`（实现阶段产出，不在 PRD 内嵌）。本 PRD §9 已给出字段级描述。

---

**结束**
