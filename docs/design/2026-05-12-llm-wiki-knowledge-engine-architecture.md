# Paperclip × LLM-Wiki 知识引擎 — 功能设计说明文档

**版本**: v2.0（DB-first）
**日期**: 2026-05-12
**关联文档**: [PRD](./2026-05-12-llm-wiki-knowledge-engine-prd.md) · [数据库设计](./2026-05-12-llm-wiki-knowledge-engine-database-design.md)

---

## 目录

1. [概述与设计原则](#1-概述与设计原则)
2. [系统架构总览](#2-系统架构总览)
3. [核心组件设计](#3-核心组件设计)
   - 3.1 [Drafter — 写入器（三路写入）](#31-drafter--写入器三路写入)
   - 3.2 [Reviewer Agent — 初筛代理](#32-reviewer-agent--初筛代理)
   - 3.3 [NodeWriter + EdgeResolver — 节点落地 + 双链解析](#33-nodewriter--edgeresolver)
   - 3.4 [Retriever — 检索器](#34-retriever--检索器)
   - 3.5 [Freshness Computer — 时效性计算](#35-freshness-computer)
   - 3.6 [Evolution Engine — 演化引擎（6 条）](#36-evolution-engine--演化引擎6-条)
   - 3.7 [Failure Signal Listener — 失败信号监听](#37-failure-signal-listener)
   - 3.8 [KnowledgeCollector — 外部源采集](#38-knowledgecollector--外部源采集)
   - 3.9 [MCP Server — 外部 Agent 接入](#39-mcp-server--外部-agent-接入)
   - 3.10 [Web UI — 人类界面](#310-web-ui--人类界面)
4. [关键流程时序](#4-关键流程时序)
5. [状态机](#5-状态机)
6. [错误处理与重试](#6-错误处理与重试)
7. [性能与可扩展性](#7-性能与可扩展性)
8. [测试策略](#8-测试策略)
9. [代码目录结构](#9-代码目录结构)

---

## 1. 概述与设计原则

### 1.1 文档定位

本文档描述 **LLM-Wiki 知识引擎的功能设计**——每个组件做什么、怎么做、边界条件、依赖关系。

文档边界：
- PRD（What/Why）：用户故事、需求清单、验收标准
- **本文档（How，functional level）**：组件职责、关键算法、流程时序、状态机
- 数据库设计（How，data level）：表结构、索引、查询、Schema

### 1.2 设计原则

继承 PRD §1.3 的 6 条核心原则：

1. **DB-first，零文件系统**
2. **原子节点 + 一等公民边**
3. **三路写入 + 统一审查**
4. **活体演化**
5. **可追溯**
6. **时效感知**

功能设计层面额外强调：

7. **组件单一职责**：每个组件做一件事，职责清晰，可独立测试
8. **明确接口边界**：组件之间通过明确的 TypeScript interface 交互，不直接共享内部状态
9. **状态机优先**：所有有状态对象（Draft、Node、Crawl Job 等）显式定义状态机
10. **可观测性内建**：每个组件关键动作都写 events 表，便于后续诊断和健康自检

---

## 2. 系统架构总览

### 2.1 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│                   外部消费者层 (External Consumers)               │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │  Web UI      │  │  Paperclip      │  │  外部 Agent         │  │
│  │  (React)     │  │  Agents         │  │  (Claude/Codex/...) │  │
│  └──────┬───────┘  └────────┬────────┘  └─────────┬──────────┘  │
└─────────┼─────────────────────┼──────────────────────┼───────────┘
          │                     │                      │
          │ REST                │ REST + Hook          │ MCP
          ▼                     ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                  接入层 (Access Layer)                           │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │ REST Router  │  │ Heartbeat Hook  │  │ MCP Server         │  │
│  │ + Auth       │  │ (afterTask...)  │  │ (HTTP/SSE + stdio) │  │
│  └──────┬───────┘  └────────┬────────┘  └─────────┬──────────┘  │
└─────────┼─────────────────────┼──────────────────────┼───────────┘
          │                     │                      │
          └─────────────────────┼──────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                  服务层 (Service Layer) — 本文档主体              │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │  Drafter     │  │  Retriever      │  │ Evolution Engine   │  │
│  │ (3 paths)    │  │ (semantic+exp+  │  │ (6 actions)        │  │
│  │              │  │  freshness)     │  │                    │  │
│  └──────┬───────┘  └────────┬────────┘  └─────────┬──────────┘  │
│         │                   │                      │              │
│  ┌──────▼───────┐  ┌────────▼────────┐  ┌─────────▼──────────┐  │
│  │ Reviewer     │  │ Freshness       │  │ Failure Signal     │  │
│  │ Agent        │  │ Computer        │  │ Listener           │  │
│  └──────┬───────┘  └─────────────────┘  └────────────────────┘  │
│         │                                                         │
│  ┌──────▼───────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │ NodeWriter + │  │ Knowledge       │  │ Health Check       │  │
│  │ EdgeResolver │  │ Collectors      │  │ (daily routine)    │  │
│  └──────────────┘  └─────────────────┘  └────────────────────┘  │
└────────────────────────────┬──────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│            数据访问层 (Data Access Layer)                         │
│  Drizzle ORM (8 tables) + pgvector raw SQL                       │
└────────────────────────────┬──────────────────────────────────────┘
                             ▼
                  ┌─────────────────────┐
                  │ PostgreSQL+pgvector │
                  └─────────────────────┘
```

### 2.2 组件依赖关系

```
Drafter (写入)
   │
   ├──→ Reviewer Agent (初筛)
   │        │
   │        └──→ Retriever (相邻节点查询)
   │
   └──→ NodeWriter ───→ EdgeResolver ───→ DB
                                              ↑
Retriever (读取) ──→ Freshness Computer ─────┘

Evolution Engine (维护)
   ├──→ Retriever (查相似节点)
   ├──→ NodeWriter (创建模式 concept)
   └──→ DB (查 lessons / 算冲突)

Failure Signal Listener (订阅)
   └──→ Drafter (产 draft)

Knowledge Collectors (爬取)
   └──→ Drafter (产 draft)

MCP Server (对外)
   ├──→ Retriever
   ├──→ Drafter
   └──→ Feedback API
```

依赖原则：**单向依赖**。Retriever / NodeWriter / EdgeResolver 是"低层组件"，Drafter / Evolution / Reviewer 等是"高层组件"。低层不知道高层存在。

---

## 3. 核心组件设计

### 3.1 Drafter — 写入器（三路写入）

#### 3.1.1 职责

接收来自三路输入的"知识候选"，统一归一化为 draft 行，写入 `knowledge_drafts` 表。

#### 3.1.2 接口

```typescript
interface Drafter {
  /**
   * 主入口：提交一个 draft
   * @returns 新创建的 draft ID
   */
  create(input: DraftInput): Promise<string>;

  /**
   * 批量提交（爬虫批量入库时用）
   */
  createBatch(inputs: DraftInput[]): Promise<string[]>;
}

interface DraftInput {
  // 内容
  title: string;
  content: string;                                    // Markdown
  type: NodeType;                                     // concept | lesson | rule | decision | fact
  level: NodeLevel;
  businessDomainName: string;                         // 业务域 name（按 name 查 FK）
  metadata: Record<string, unknown>;                  // 按 type 不同结构

  // 时效性（可选）
  volatility?: Volatility;
  validUntil?: Date;
  sourceUrl?: string;
  externalVersion?: Record<string, unknown>;

  // 自评可信度
  confidence?: number;                                // 0-1，默认 0.5

  // 目标节点（修改时填）
  targetNodeId?: string;

  // 来源
  source: 'agent_self_review' | 'failure_signal' | 'manual';
  sourceContext: {
    agentId?: string;
    runId?: string;
    issueId?: string;
    userId?: string;
  };

  // 跳审查标记（仅管理员手动写入时为 true）
  skipReview?: boolean;

  // 公司
  companyId: string;
}
```

#### 3.1.3 处理流程

```typescript
async create(input: DraftInput): Promise<string> {
  // 1. 输入校验
  this.validateInput(input);                          // 必填字段、长度限制

  // 2. metadata Zod 校验（按 type 不同 schema）
  this.validateMetadataByType(input.type, input.metadata);

  // 3. 业务域 name 解析为 ID
  const domainId = await this.resolveDomainId(input.businessDomainName, input.companyId);

  // 4. volatility 推断（如未指定）
  const volatility = input.volatility ?? await this.inferVolatility(input.content);

  // 5. 敏感内容过滤（信用卡 / API Key / 密码模式）
  this.checkSensitiveContent(input.content);

  // 6. 写入 drafts 表
  const draftId = await this.db.insert(knowledgeDrafts).values({
    ...input,
    proposedBusinessDomainId: domainId,
    proposedVolatility: volatility,
    status: input.skipReview ? 'approved' : 'pending',
    // ... 其他字段
  }).returning({ id: knowledgeDrafts.id });

  // 7. 如果 skip_review：立即写入 nodes（走 NodeWriter）
  if (input.skipReview) {
    await this.nodeWriter.materialize(draftId);
  }

  // 8. 写入 event
  await this.eventLogger.log({
    type: 'created',
    metadata: { draft_id: draftId, source: input.source },
  });

  return draftId;
}
```

#### 3.1.4 三路写入的差异化处理

**Path A — Agent 任务收尾自评**：

通过 Paperclip `afterTaskComplete` hook 触发，调 LLM 自评：

```typescript
async onTaskComplete(runId: string, issueId: string) {
  const ctx = await this.buildContextForSelfReview(runId, issueId);
  const llmOutput = await this.llm.complete({
    system: SELF_REVIEW_PROMPT,                       // 见 §3.1.6 prompt
    user: ctx.serialize(),
  });

  // LLM 输出 JSON: { nodes: [{...}], references_issue_ids: [...] }
  const parsed = parseSelfReviewJson(llmOutput);

  for (const node of parsed.nodes) {
    await this.drafter.create({
      ...node,
      source: 'agent_self_review',
      sourceContext: { agentId: ctx.agentId, runId, issueId },
      companyId: ctx.companyId,
    });
  }
}
```

**Path B — 失败信号自动提取**：

由 `Failure Signal Listener`（§3.7）触发，根据事件类型选合适的 LLM prompt：

```typescript
async onFailureSignal(event: FailureSignalEvent) {
  const ctx = await this.gatherEvidence(event);       // Run logs / Comments / Diff
  const llmOutput = await this.llm.complete({
    system: FAILURE_EXTRACTION_PROMPT(event.type),
    user: ctx.serialize(),
  });
  const parsed = parseFailureExtractionJson(llmOutput);

  for (const node of parsed.nodes) {
    await this.drafter.create({
      ...node,
      source: 'failure_signal',
      sourceContext: { issueId: event.issueId, runId: event.runId },
      companyId: event.companyId,
    });
  }
}
```

**Path C — 人工写入**：

直接走 REST API 或 Agent tool `propose_knowledge_node(...)`，无 LLM 参与，直接调 `drafter.create()`。

#### 3.1.5 metadata Zod schema（按 type）

```typescript
const lessonMetadataSchema = z.object({
  symptom: z.string().min(5).max(500),
  root_cause: z.string().min(5).max(1000),
  next_time: z.string().min(5).max(500),
});

const ruleMetadataSchema = z.object({
  enforcement: z.enum(['soft', 'hard']),
  applies_when: z.string().max(500),
});

const decisionMetadataSchema = z.object({
  options_considered: z.array(z.object({
    name: z.string(),
    tradeoffs: z.string(),
  })).min(2),
  chosen: z.string(),
  rationale: z.string().min(10),
});

const factMetadataSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
});

const conceptMetadataSchema = z.object({
  definition: z.string(),
  examples: z.array(z.string()).optional(),
  is_pattern: z.boolean().optional(),                 // 演化产生时为 true
  derived_from_lessons: z.array(z.string().uuid()).optional(),
});

function validateMetadataByType(type: NodeType, metadata: unknown) {
  const schema = METADATA_SCHEMAS[type];              // 上述 5 个之一
  const result = schema.safeParse(metadata);
  if (!result.success) {
    throw new ValidationError(`metadata schema mismatch for type=${type}: ${result.error}`);
  }
}
```

#### 3.1.6 LLM Prompts

**SELF_REVIEW_PROMPT**（伪代码）：

```
你是 Paperclip 公司知识库的 Agent 自评助理。任务完成后，从以下信息提取
值得沉淀的知识节点：

[Run 摘要]
[Issue 描述]
[本次产生的关键决策 / 教训 / 规则]

按以下 JSON schema 输出。如本次无值得记的内容，输出 { nodes: [] }。

输出 schema:
{
  nodes: [{
    type: "concept" | "lesson" | "rule" | "decision" | "fact",
    title: string (≤ 80 字),
    content: string (Markdown, ≤ 2000 字),
    confidence: number (0-1, 你对此条的自评),
    volatility: "stable" | "slow" | "fast",
    business_domain_name: string (从可用业务域名中选；查询: list_domains),
    used_for: string[] (任务类型标签),
    metadata: object (按 type 不同 schema),
    why_worth_remembering: string (≤ 100 字, 评审参考)
  }],
  references_issue_ids: string[]
}

约束：
- 每条 nodes 必须有非显而易见的洞察；不要"凑数"
- 失败任务也产出（教训）；成功任务也产出（成功模式）
- confidence < 0.5 的内容不要输出
- 涉及外部平台（抖音/小红书等）规则的，volatility=fast
```

**FAILURE_EXTRACTION_PROMPT**（按事件类型不同）：

```
[issue.reopened 版]
任务被重新打开。从以下证据提取教训：
- 原任务描述
- Run 日志 (最后 N 行)
- 重新打开的原因 comment
- 任务期间的所有 comment

输出格式同上，但 type 限制为 lesson。
```

#### 3.1.7 边界条件

| 场景 | 处理 |
|------|------|
| metadata 校验失败 | 抛 ValidationError，HTTP 400；draft 不写 |
| 业务域 name 不存在 | 抛 NotFoundError，HTTP 404 |
| LLM 输出格式错误 | 重试 1 次；仍失败则记录到 `agent_drafting_failures` event，不阻塞主任务 |
| content 含敏感模式 | 阻断写入，记 `sensitive_content_blocked` event |
| 同一 Issue 短时间内多次自评（< 5min） | 去重：取最新一次结果 |

---

### 3.2 Reviewer Agent — 初筛代理

#### 3.2.1 职责

对所有 pending draft 做 LLM 初筛，输出 `pre_verdict`（recommend_approve / recommend_reject / needs_human）+ reasoning + 冲突检测，写回 `knowledge_drafts`。

#### 3.2.2 触发方式

Routine `hourly-draft-pre-review`（cron `0 * * * *`），每小时拉一批待初筛的 draft。

```typescript
async runHourly() {
  const drafts = await this.db
    .select()
    .from(knowledgeDrafts)
    .where(and(
      eq(knowledgeDrafts.status, 'pending'),
      isNull(knowledgeDrafts.preVerdict),
    ))
    .limit(50);                                       // 单次最多处理 50 条

  for (const draft of drafts) {
    await this.review(draft).catch(err => {
      this.logger.error('reviewer failed', { draftId: draft.id, err });
      // 不阻塞其他 draft 的初筛
    });
  }
}
```

#### 3.2.3 单条初筛流程

```typescript
async review(draft: Draft): Promise<void> {
  // 1. 查相关节点（用 draft.proposed_content 做语义搜索 Top 5）
  const embedding = await embed(draft.proposedContent);
  const neighbors = await this.retriever.semanticSearch({
    embedding,
    companyId: draft.companyId,
    threshold: 0.6,                                   // 较宽容
    limit: 5,
  });

  // 2. 检测潜在冲突（neighbors 中的 rule 类节点）
  const conflictCandidates = neighbors
    .filter(n => n.type === 'rule')
    .map(n => n.id);

  // 3. 调 LLM 给出 verdict
  const llmOutput = await this.llm.complete({
    system: REVIEWER_PROMPT,
    user: this.formatReviewInput(draft, neighbors),
  });

  const verdict = parseReviewVerdict(llmOutput);     // { pre_verdict, reasoning, conflicts[] }

  // 4. 写回 draft
  await this.db.update(knowledgeDrafts)
    .set({
      preVerdict: verdict.preVerdict,
      preVerdictReasoning: verdict.reasoning.slice(0, 200),  // 截断
      preVerdictAt: new Date(),
      detectedConflicts: verdict.conflicts,
    })
    .where(eq(knowledgeDrafts.id, draft.id));
}
```

#### 3.2.4 REVIEWER_PROMPT

```
你是 Paperclip 知识库的初筛代理。对以下待审 draft 给出建议。

[Draft]
- 类型: lesson
- 标题: ...
- 内容: ...
- 来源: agent_self_review (Agent X 在 Issue Y 完成后产出)
- 可信度自评: 0.85
- 已有相关节点 (Top 5):
  1. [[uuid1]] "..." (类型: rule, confidence: 0.9, verified: true)
  2. [[uuid2]] "..." (类型: lesson, ...)
  ...

[判断维度]
1. 内容是否有实质信息？(不要："本次没问题"、"按计划完成"这种)
2. 是否与既有节点重复？(语义相似 > 0.8 的视为重复)
3. 是否与既有 rule 冲突？(如新 lesson 主张某做法，但已有 rule 禁止)
4. metadata 是否完整？

[输出 JSON]
{
  pre_verdict: "recommend_approve" | "recommend_reject" | "needs_human",
  reasoning: string (≤ 200 字, 说明为什么),
  conflicts: string[] (UUID 数组，若有冲突的节点 ID)
}

判定规则：
- recommend_approve: 有实质信息 + 无明显重复 + 无冲突 + metadata 完整
- recommend_reject: 内容空洞 / 明显重复 / 与既有 rule 矛盾且不合理
- needs_human: 内容有价值但需人工判断（如和已有 rule 有 nuanced 关系）
```

#### 3.2.5 边界条件

| 场景 | 处理 |
|------|------|
| LLM 调用失败 | 重试 1 次；再失败则保留 pre_verdict=NULL，下个小时再试 |
| Reviewer 自己产出与既有 rule 冲突的判断 | 强制设 needs_human，不能自动通过 |
| 单次执行有 draft 已被人审过（status 不是 pending） | 跳过 |
| 极端高频写入（爬虫大批量） | 单次最多 50 条；其余下小时处理 |

---

### 3.3 NodeWriter + EdgeResolver

#### 3.3.1 NodeWriter 职责

将 approved 的 draft 物化为 `knowledge_nodes` 行，触发 EdgeResolver 解析双链。

#### 3.3.2 接口

```typescript
interface NodeWriter {
  /**
   * 从 draft 物化节点（新建或更新）
   */
  materialize(draftId: string): Promise<{
    nodeId: string;
    isNew: boolean;
  }>;
}
```

#### 3.3.3 流程

```typescript
async materialize(draftId: string): Promise<{ nodeId, isNew }> {
  return await this.db.transaction(async tx => {
    // 1. 读 draft
    const draft = await tx.select().from(knowledgeDrafts)
      .where(eq(knowledgeDrafts.id, draftId)).then(rs => rs[0]);

    // 2. 生成 embedding
    const embedding = await this.embedSvc.generate(draft.proposedContent);

    // 3. 分新建 vs 更新
    let nodeId: string;
    let isNew: boolean;
    if (draft.targetNodeId) {
      // 更新：先写 revision 快照
      const oldNode = await tx.select().from(knowledgeNodes)
        .where(eq(knowledgeNodes.id, draft.targetNodeId)).then(rs => rs[0]);

      await tx.insert(knowledgeNodeRevisions).values({
        nodeId: oldNode.id,
        title: oldNode.title,
        content: oldNode.content,
        type: oldNode.type,
        level: oldNode.level,
        metadata: oldNode.metadata,
        draftId,
        editorAgentId: draft.sourceAgentId,
        editorUserId: draft.sourceUserId ?? draft.reviewedBy,
      });

      // 再 UPDATE
      await tx.update(knowledgeNodes).set({
        title: draft.proposedTitle,
        content: draft.proposedContent,
        type: draft.proposedType,
        level: draft.proposedLevel,
        businessDomainId: draft.proposedBusinessDomainId,
        metadata: draft.proposedMetadata,
        volatility: draft.proposedVolatility ?? oldNode.volatility,
        validUntil: draft.proposedValidUntil ?? oldNode.validUntil,
        embedding,
        updatedAt: new Date(),
      }).where(eq(knowledgeNodes.id, draft.targetNodeId));

      nodeId = draft.targetNodeId;
      isNew = false;
    } else {
      // 新建
      const inserted = await tx.insert(knowledgeNodes).values({
        title: draft.proposedTitle,
        content: draft.proposedContent,
        type: draft.proposedType,
        level: draft.proposedLevel,
        businessDomainId: draft.proposedBusinessDomainId,
        companyId: draft.companyId,
        embedding,
        metadata: draft.proposedMetadata,
        volatility: draft.proposedVolatility ?? 'slow',
        validUntil: draft.proposedValidUntil,
        confidence: draft.confidence,
        verifiedAt: new Date(),                       // 刚审过 = 已验证
        createdByAgent: draft.sourceAgentId,
        createdByUser: draft.sourceUserId,
        // ... 其他字段
      }).returning({ id: knowledgeNodes.id });

      nodeId = inserted[0].id;
      isNew = true;
    }

    // 4. 解析双链（EdgeResolver）
    await this.edgeResolver.resolveContent(nodeId, draft.proposedContent, tx);

    // 5. 写 event
    await this.eventLogger.log({
      nodeId,
      eventType: isNew ? 'created' : 'updated',
      metadata: { draftId },
    }, tx);

    // 6. 标记 draft 已 materialized
    await tx.update(knowledgeDrafts).set({
      status: 'approved',
      reviewedAt: new Date(),
    }).where(eq(knowledgeDrafts.id, draftId));

    return { nodeId, isNew };
  });
}
```

#### 3.3.4 EdgeResolver 职责

扫描节点 content 中的 `[[node-id]]` 形式互链，落 `knowledge_edges` 表（edge_type = `references`）。

```typescript
interface EdgeResolver {
  /**
   * 解析 content，自动落 references 边
   */
  resolveContent(fromNodeId: string, content: string, tx?: Tx): Promise<void>;

  /**
   * 显式加边（API 暴露）
   */
  addEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    edgeType: EdgeType;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * 删除特定边
   */
  removeEdge(edgeId: string): Promise<void>;
}
```

#### 3.3.5 resolveContent 算法

```typescript
async resolveContent(fromNodeId: string, content: string, tx: Tx) {
  // 1. 用正则提取所有 [[uuid]] 形式
  const matches = Array.from(content.matchAll(/\[\[([0-9a-f-]{36})\]\]/gi));
  const targetIds = [...new Set(matches.map(m => m[1]))];     // 去重

  if (targetIds.length === 0) return;

  // 2. 验证目标节点存在且属于同公司
  const validTargets = await tx.select({ id: knowledgeNodes.id })
    .from(knowledgeNodes)
    .where(and(
      inArray(knowledgeNodes.id, targetIds),
      eq(knowledgeNodes.companyId, await this.getCompanyId(fromNodeId, tx)),
    ));
  const validIds = new Set(validTargets.map(t => t.id));

  // 3. 删除旧的 auto_generated references 边（重新解析）
  await tx.delete(knowledgeEdges).where(and(
    eq(knowledgeEdges.fromNodeId, fromNodeId),
    eq(knowledgeEdges.edgeType, 'references'),
    eq(knowledgeEdges.autoGenerated, true),
  ));

  // 4. 批量 INSERT 新边（去重靠 UNIQUE 约束）
  if (validIds.size > 0) {
    await tx.insert(knowledgeEdges).values(
      [...validIds].map(toId => ({
        fromNodeId,
        toNodeId: toId,
        edgeType: 'references' as const,
        autoGenerated: true,
      }))
    ).onConflictDoNothing();
  }

  // 5. 记录无效引用（[[id]] 指向不存在节点）
  const invalid = targetIds.filter(id => !validIds.has(id));
  if (invalid.length > 0) {
    this.logger.warn('invalid wikilinks', { fromNodeId, invalid });
    // 可选：开 Issue "节点 X 引用了不存在的节点 [Y...]"
  }
}
```

#### 3.3.6 边界条件

| 场景 | 处理 |
|------|------|
| 同节点被多个并发 UPDATE | DB 事务保证，按时间序最后写入者胜出 |
| `[[id]]` 指向已 revoked 节点 | 仍然落边（保留历史），UI 显示为灰色不可点 |
| `[[id]]` 指向其他公司节点 | 跳过，记录告警 |
| 自指 `[[自己 id]]` | DB CHECK 约束阻断，回滚事务 |

---

### 3.4 Retriever — 检索器

#### 3.4.1 职责

接收检索请求，返回 Top-N 节点，带 freshness 标签和域信息。

#### 3.4.2 接口

```typescript
interface Retriever {
  /**
   * 完整两路检索 + freshness 加权
   */
  search(opts: RetrieveOpts): Promise<RetrieveResult[]>;

  /**
   * 仅语义搜索（不用经验推荐）
   */
  semanticSearch(opts: SemanticSearchOpts): Promise<NodeWithSimilarity[]>;
}

interface RetrieveOpts {
  query: string;                                       // 原文，Retriever 内部生成 embedding
  companyId: string;
  projectId?: string | null;
  domainNames?: string[];                              // 空数组或 undefined = 不过滤
  usedForTags?: string[];                              // 经验推荐用
  types?: NodeType[];
  includeOutdated?: boolean;                           // 默认 false
  limit?: number;                                      // 默认 5
}

interface RetrieveResult {
  id: string;
  title: string;
  snippet: string;
  type: NodeType;
  level: NodeLevel;
  domain: { id: string; name: string; label: string; color: string };
  confidence: number;
  verified: boolean;
  triggerCount: number;
  // 评分细分
  similarity: number;
  experienceScore: number;
  freshnessScore: number;
  freshnessLabel: 'fresh' | 'stale_warning' | 'outdated';
  finalScore: number;
}
```

#### 3.4.3 search 流程

```typescript
async search(opts: RetrieveOpts): Promise<RetrieveResult[]> {
  // 1. 生成查询 embedding
  const queryEmbedding = await this.embedSvc.generate(opts.query);

  // 2. 路径 A：语义搜索（取 Top 10，后续会过滤合并）
  const semanticResults = await this.semanticSearch({
    embedding: queryEmbedding,
    companyId: opts.companyId,
    projectId: opts.projectId,
    domainNames: opts.domainNames,
    threshold: 0.75,
    limit: 10,
    includeOutdated: opts.includeOutdated,
  });

  // 3. 路径 B：经验推荐（如有 usedForTags）
  let experienceResults: NodeWithExperienceScore[] = [];
  if (opts.usedForTags && opts.usedForTags.length > 0) {
    experienceResults = await this.experienceSearch({
      tags: opts.usedForTags,
      companyId: opts.companyId,
      projectId: opts.projectId,
      domainNames: opts.domainNames,
      limit: 5,
    });
  }

  // 4. 合并去重
  const merged = this.mergeAndDedupe(semanticResults, experienceResults);

  // 5. 计算 finalScore 并排序
  const scored = merged.map(node => ({
    ...node,
    freshnessScore: this.freshness.compute(node),
    freshnessLabel: this.freshness.label(this.freshness.compute(node)),
    finalScore:
      (node.similarity ?? 0) * 0.5 +
      (node.experienceScore ?? 0) * 0.3 +
      this.freshness.compute(node) * 0.2,
  }));

  // 6. 排除 outdated 标签（除非 includeOutdated）
  const filtered = opts.includeOutdated
    ? scored
    : scored.filter(n => n.freshnessLabel !== 'outdated');

  // 7. 按 finalScore 降序，取 Top limit
  filtered.sort((a, b) => b.finalScore - a.finalScore);
  return filtered.slice(0, opts.limit ?? 5);
}
```

#### 3.4.4 mergeAndDedupe 算法

```typescript
private mergeAndDedupe(
  semantic: NodeWithSimilarity[],
  experience: NodeWithExperienceScore[],
): Array<Node & Partial<{ similarity, experienceScore }>> {
  const map = new Map<string, any>();
  for (const n of semantic) map.set(n.id, { ...n, similarity: n.similarity });
  for (const n of experience) {
    if (map.has(n.id)) {
      map.get(n.id).experienceScore = n.experienceScore;
    } else {
      map.set(n.id, { ...n, experienceScore: n.experienceScore });
    }
  }
  return [...map.values()];
}
```

#### 3.4.5 上下文注入格式化

Retriever 提供一个辅助方法把结果格式化为 Markdown，供 Agent context 注入：

```typescript
formatForAgentContext(results: RetrieveResult[]): string {
  if (results.length === 0) return '';
  const lines = results.map(r => {
    const freshLabel =
      r.freshnessLabel === 'fresh' ? '' :
      r.freshnessLabel === 'stale_warning' ? '⚠ stale_warning, ' : '';
    return `- [[${r.id}]] **${r.title}** (${freshLabel}${r.type}, confidence=${r.confidence}, 已防止 ${r.triggerCount} 次)`;
  });
  return `## 知识库相关条目\n\n${lines.join('\n')}\n`;
}
```

#### 3.4.6 边界条件

| 场景 | 处理 |
|------|------|
| query 为空字符串 | 拒绝（HTTP 400） |
| companyId 不存在 | 返回空数组（不抛错，避免泄露存在性） |
| 业务域 name 不存在 | 视为"该公司无此 domain"，跳过过滤 |
| Top 10 结果为空 | 返回空数组，不降阈值重试 |
| embedding 生成失败 | 重试 1 次；再失败抛 503 |

---

### 3.5 Freshness Computer

#### 3.5.1 职责

按节点的 volatility / verified_at / valid_until 实时计算 freshness_score，给出标签。

#### 3.5.2 接口

```typescript
interface FreshnessComputer {
  compute(node: Pick<Node, 'volatility' | 'verifiedAt' | 'validUntil' | 'createdAt'>): number;
  label(score: number): 'fresh' | 'stale_warning' | 'outdated';
}
```

#### 3.5.3 算法

```typescript
compute(node): number {
  // 1. 显式过期
  if (node.validUntil && node.validUntil < new Date()) return 0.0;

  // 2. 临近显式过期
  if (node.validUntil) {
    const daysUntil = (node.validUntil.getTime() - Date.now()) / 86400000;
    if (daysUntil < 30) return 0.3;
  }

  // 3. 按 volatility 指数衰减
  const verifiedAt = node.verifiedAt ?? node.createdAt;
  const ageDays = (Date.now() - verifiedAt.getTime()) / 86400000;
  const halfLife = {
    stable: Infinity,
    slow: 365,
    fast: 90,
  }[node.volatility];

  if (!isFinite(halfLife)) return 1.0;                // stable 永远 fresh
  return Math.exp(-ageDays / halfLife);
}

label(score): 'fresh' | 'stale_warning' | 'outdated' {
  if (score >= 0.7) return 'fresh';
  if (score >= 0.3) return 'stale_warning';
  return 'outdated';
}
```

#### 3.5.4 为什么实时计算不存

- 时间是连续变化的，存储会立刻过期
- 每次查询时随 SQL 一并算（见数据库设计 §6.1）
- 应用层独立函数仅供单体节点查询时调用

---

### 3.6 Evolution Engine — 演化引擎（6 条）

#### 3.6.1 职责

由 Routine `weekly-knowledge-evolution`（cron `0 9 * * 1`）驱动，每周执行 6 条自动行为。

#### 3.6.2 接口

```typescript
interface EvolutionEngine {
  runWeekly(companyId: string): Promise<EvolutionReport>;
}

interface EvolutionReport {
  promotionCandidates: Promotion[];                   // 升规则候选
  decayed: string[];                                  // 已归档的节点 ID
  mergeCandidates: MergePair[];                       // 合并候选
  conflicts: Conflict[];                              // 冲突检测
  freshnessCheck: StaleNode[];                        // 待验证节点
  patternsEmerged: EmergedPattern[];                  // 涌现的模式
}
```

#### 3.6.3 整体执行流程

```typescript
async runWeekly(companyId: string): Promise<EvolutionReport> {
  // 6 个动作顺序执行（每个内部异常被捕获，不阻塞其他）
  const promotions = await this.checkPromotions(companyId).catch(handle);
  const decayed = await this.scanDecay(companyId).catch(handle);
  const merges = await this.detectMergeCandidates(companyId).catch(handle);
  const conflicts = await this.detectConflicts(companyId).catch(handle);
  const stale = await this.auditFreshness(companyId).catch(handle);
  const patterns = await this.emergePatterns(companyId).catch(handle);

  // 生成提案 Issue
  for (const p of promotions) await this.openIssue(p, 'promote');
  for (const m of merges) await this.openIssue(m, 'merge');
  for (const c of conflicts) await this.openIssue(c, 'conflict');
  for (const s of stale) await this.openIssue(s, 'verify');
  for (const e of patterns) await this.openIssue(e, 'pattern');

  return { promotionCandidates: promotions, decayed, mergeCandidates: merges,
           conflicts, freshnessCheck: stale, patternsEmerged: patterns };
}
```

#### 3.6.4 第 1 条：升规则

```typescript
async checkPromotions(companyId): Promise<Promotion[]> {
  // SQL 见数据库设计 §6.5
  const candidates = await this.db.execute(/* ... */);
  return candidates.map(c => ({
    nodeId: c.id,
    triggerCount: c.trigger_count,
    preventionScore: c.prevention_score,
    suggestedRuleContent: this.draftRuleFromLesson(c),  // LLM 转写为 rule 风格
  }));
}
```

通过 Issue 申报后人工批准，则：

1. 节点 `type` 改为 `rule`
2. 创建一个 `derived_from` 边指向原 lesson 节点
3. 原 lesson 节点的 `status` 改为 `archived`（已"升级")
4. 写 `promoted` 事件

#### 3.6.5 第 2 条：衰减归档

```typescript
async scanDecay(companyId): Promise<string[]> {
  const decayed = await this.db.update(knowledgeNodes)
    .set({ status: 'archived' })
    .where(and(
      eq(knowledgeNodes.companyId, companyId),
      eq(knowledgeNodes.status, 'active'),
      lte(knowledgeNodes.lastTriggered, subDays(new Date(), 180)),
    ))
    .returning({ id: knowledgeNodes.id });

  // 写 events
  for (const { id } of decayed) {
    await this.eventLogger.log({ nodeId: id, eventType: 'archived' });
  }
  return decayed.map(d => d.id);
}
```

#### 3.6.6 第 3 条：合并候选

```typescript
async detectMergeCandidates(companyId): Promise<MergePair[]> {
  // SQL 见数据库设计 §6.6
  const pairs = await this.db.execute(/* ... */);
  // 每对调 LLM 出合并建议
  return Promise.all(pairs.map(async p => ({
    nodeA: p.id_a,
    nodeB: p.id_b,
    similarity: p.similarity,
    mergeSuggestion: await this.draftMergeSuggestion(p.id_a, p.id_b),
  })));
}
```

#### 3.6.7 第 4 条：冲突检测

冲突检测发生在 Reviewer Agent（§3.2）的 draft 阶段。Evolution Engine 这一条主要做"扫描尚未标记的存量冲突"：

```typescript
async detectConflicts(companyId): Promise<Conflict[]> {
  // 找近 30 天新增的 rule 节点
  const newRules = await this.findRecentNodes(companyId, 'rule', 30);
  const conflicts: Conflict[] = [];

  for (const rule of newRules) {
    // 用 rule.content 检索 Top 10 近邻
    const neighbors = await this.retriever.semanticSearch({
      embedding: rule.embedding,
      companyId,
      threshold: 0.6,
      limit: 10,
    });

    // LLM 判断每对是否冲突
    for (const n of neighbors) {
      if (n.id === rule.id) continue;
      const verdict = await this.llmConflictCheck(rule, n);
      if (verdict.isConflict) {
        conflicts.push({ fromId: rule.id, toId: n.id, reason: verdict.reason });
        // 落 conflicts_with 边
        await this.edgeResolver.addEdge({
          fromNodeId: rule.id,
          toNodeId: n.id,
          edgeType: 'conflicts_with',
          metadata: { reason: verdict.reason, detected_by: 'evolution' },
        });
      }
    }
  }
  return conflicts;
}
```

#### 3.6.8 第 5 条：时效性巡检

```typescript
async auditFreshness(companyId): Promise<StaleNode[]> {
  // SQL 见数据库设计 §6.4
  return this.db.execute(/* ... */);
}
```

输出后批量开 Issue 给 Curator Agent。

#### 3.6.9 第 6 条：模式涌现

```typescript
async emergePatterns(companyId): Promise<EmergedPattern[]> {
  // 1. 按 (used_for, business_domain) 分组，找簇 size >= 5
  const clusters = await this.db.execute(/* 数据库设计 §6.7 */);

  const patterns: EmergedPattern[] = [];

  for (const cluster of clusters) {
    // 2. 取簇内所有 lesson 的 embedding，跑 HDBSCAN
    const embeddings = await this.fetchEmbeddings(cluster.lesson_ids);
    const subClusters = this.hdbscan(embeddings, { minClusterSize: 5 });

    for (const subCluster of subClusters) {
      // 3. cooldown 检查（避免反复打扰）
      if (await this.isInCooldown(cluster.used_for_tag, cluster.business_domain_id)) continue;

      // 4. 调 LLM 抽共性
      const lessons = await this.fetchLessons(subCluster.memberIds);
      const llmOutput = await this.llm.complete({
        system: PATTERN_EMERGENCE_PROMPT,
        user: this.formatLessonsForPattern(lessons),
      });
      const result = parsePatternJson(llmOutput);

      if (!result.hasPattern) {
        await this.markCooldown(cluster.used_for_tag, cluster.business_domain_id, 30);
        continue;
      }

      // 5. 产出 draft (type=concept, is_pattern=true)
      await this.drafter.create({
        title: result.patternName,
        content: result.patternSummary,
        type: 'concept',
        metadata: {
          definition: result.patternSummary,
          is_pattern: true,
          derived_from_lessons: subCluster.memberIds,
        },
        confidence: result.confidence,
        // ... 其他字段
        source: 'manual',                             // 系统派生，走人审
      });

      patterns.push({
        patternName: result.patternName,
        derivedFrom: subCluster.memberIds,
      });
    }
  }
  return patterns;
}
```

**PATTERN_EMERGENCE_PROMPT**：

```
你是知识库的模式抽取助理。下面是同一(任务类型, 业务域)下的多条 lesson，
请判断它们是否揭示某个共性模式（"X 类问题应该用 Y 方式处理"）。

[Lessons]
1. [[uuid1]] 标题: ... 内容: ...
2. [[uuid2]] 标题: ... 内容: ...
...

[判断标准]
- 至少 3 条 lesson 揭示同一模式才算有意义
- 模式应是可复用的方法论，不是巧合
- 不要硬找模式；如真没有，输出 hasPattern: false

[输出 JSON]
{
  "hasPattern": boolean,
  "patternName": string (≤ 30 字, 名词性短语),
  "patternSummary": string (Markdown, 200-500 字),
  "confidence": number (0-1)
}
```

---

### 3.7 Failure Signal Listener

#### 3.7.1 职责

订阅 Paperclip 事件总线上的失败信号，触发 Drafter Path B 产生 draft。

#### 3.7.2 接口

```typescript
interface FailureSignalListener {
  start(): void;                                       // 注册订阅
  stop(): void;
}

interface FailureSignalDetector {
  name: string;
  eventType: string;                                   // Paperclip event bus 上的事件名
  extract(event: PaperclipEvent): Promise<DraftInput[] | null>;
}
```

#### 3.7.3 内置 Detectors（FR11 设计成可扩展 registry）

```typescript
class IssueReopenedDetector implements FailureSignalDetector {
  name = 'issue_reopened';
  eventType = 'issue.reopened';

  async extract(event: IssueReopenedEvent): Promise<DraftInput[]> {
    const issue = await this.fetchIssue(event.issueId);
    const runs = await this.fetchRecentRuns(event.issueId, 5);
    const ctx = { issue, runs, reopenComment: event.comment };

    const llmOutput = await this.llm.complete({
      system: FAILURE_EXTRACTION_PROMPT('issue_reopened'),
      user: JSON.stringify(ctx),
    });
    return parseDraftJson(llmOutput);
  }
}

class ApprovalRejectedDetector implements FailureSignalDetector { /* ... */ }
class RunCancelledDetector implements FailureSignalDetector { /* ... */ }
class CommitRevertedDetector implements FailureSignalDetector { /* ... */ }
```

#### 3.7.4 注册中心

```typescript
class FailureSignalRegistry {
  private detectors: FailureSignalDetector[] = [];

  register(d: FailureSignalDetector) {
    this.detectors.push(d);
    this.eventBus.subscribe(d.eventType, ev => this.handle(d, ev));
  }

  // Plugin 系统可注册自定义 detector
  registerFromPlugin(plugin: Plugin) {
    for (const d of plugin.failureSignalDetectors ?? []) {
      this.register(d);
    }
  }

  private async handle(d: FailureSignalDetector, ev: PaperclipEvent) {
    try {
      const drafts = await d.extract(ev);
      if (drafts) {
        for (const draft of drafts) {
          await this.drafter.create(draft);
        }
      }
    } catch (err) {
      this.logger.error('failure signal extraction failed', { detector: d.name, err });
    }
  }
}
```

#### 3.7.5 启动时注册

```typescript
// server/src/services/llm-wiki/bootstrap.ts
export function bootstrapFailureSignals(registry: FailureSignalRegistry) {
  registry.register(new IssueReopenedDetector());
  registry.register(new ApprovalRejectedDetector());
  registry.register(new RunCancelledDetector());
  registry.register(new CommitRevertedDetector());
  // Plugin 系统的会通过 plugin loader 注册
}
```

---

### 3.8 KnowledgeCollector — 外部源采集

#### 3.8.1 职责

从外部源（Web / RSS / GitHub）抓取候选笔记，过质量过滤后入 draft。

#### 3.8.2 可插拔接口

```typescript
interface KnowledgeCollector {
  name: string;                                        // 唯一标识，如 'WebCrawler'
  supportedSourceTypes: SourceType[];

  /**
   * 检查源是否有新内容
   */
  checkForUpdates(source: KnowledgeSource): Promise<boolean>;

  /**
   * 采集源，返回原始笔记列表
   */
  collect(source: KnowledgeSource): Promise<RawNote[]>;
}

interface RawNote {
  title: string;
  content: string;                                     // Markdown
  source: string;                                      // 来源 URL 或标识
  collectedAt: Date;
  metadata: Record<string, unknown>;                   // 采集器特有
}
```

#### 3.8.3 内置 WebCrawler 流程

```typescript
class WebCrawler implements KnowledgeCollector {
  name = 'WebCrawler';
  supportedSourceTypes = ['blog', 'docs', 'forum', 'custom'];

  async collect(source: KnowledgeSource): Promise<RawNote[]> {
    // 1. 礼貌策略
    await this.checkRobotsTxt(source.url);
    await this.rateLimiter.acquire(new URL(source.url).hostname);

    // 2. 下载（增量：用 ETag / Last-Modified）
    const resp = await fetch(source.url, {
      headers: {
        'User-Agent': 'Paperclip-LLMWiki-Crawler/1.0',
        ...(source.crawl_config.custom_headers ?? {}),
        ...(source.last_etag ? { 'If-None-Match': source.last_etag } : {}),
      },
    });
    if (resp.status === 304) return [];                // 无变化

    // 3. 解析
    const html = await resp.text();
    const article = source.article_selector
      ? cheerio.load(html)(source.article_selector).html()
      : readability(html);
    const markdown = turndown(article);

    // 4. 质量过滤（LLM 评分 < 4 丢弃）
    const score = await this.qualityScore(markdown);
    if (score < 4) {
      this.logger.info('low-quality content dropped', { url: source.url, score });
      return [];
    }

    // 5. 返回 RawNote
    return [{
      title: this.extractTitle(html),
      content: markdown,
      source: source.url,
      collectedAt: new Date(),
      metadata: { quality_score: score },
    }];
  }
}
```

#### 3.8.4 Routine 调度

```typescript
class KnowledgeCollectorRunner {
  async run() {
    // 找所有 enabled + 到期 source
    const dueSources = await this.fetchDueSources();
    for (const source of dueSources) {
      const collector = this.registry.get(source.collector_name);
      if (!collector) continue;

      try {
        const notes = await collector.collect(source);
        for (const note of notes) {
          await this.drafter.create({
            title: note.title,
            content: note.content,
            type: this.inferType(note),                // LLM 推断
            level: source.level ?? 'project',
            businessDomainName: source.business_domain_name ?? 'general',
            metadata: { source_url: note.source, ...note.metadata },
            confidence: source.trust_weight,
            volatility: this.inferVolatility(note),
            source: 'manual',                          // 爬虫产出走人审
            sourceContext: { },
            companyId: source.company_id,
          });
        }
        await this.markCrawled(source.id);
      } catch (err) {
        this.logger.error('collector failed', { source: source.id, err });
      }
    }
  }
}
```

#### 3.8.5 三层采集策略

| 层级 | 触发 | 流程 |
|------|------|------|
| 种子源 | Routine 按 source.crawl_frequency | 上述 WebCrawler.collect |
| 外链扩展 | 处理种子源文章时扫正文外链 | 提取外链域 → 白名单提案 Issue |
| 按需搜索 | Issue 触发 | 调搜索 API → 候选页面 → 爬取 → 入 draft |

#### 3.8.6 边界条件

| 场景 | 处理 |
|------|------|
| robots.txt 不允许 | 跳过该源，记 event |
| 429 / 503 | 指数退避（1s/2s/4s/8s），最多 3 次 |
| 解析失败 | 跳过该页，记录到 source.last_error |
| 内容重复（与既有节点 cosine > 0.95） | 不入 draft，记录"重复跳过" |

---

### 3.9 MCP Server — 外部 Agent 接入

#### 3.9.1 职责

将知识库能力通过 MCP 协议暴露给外部 Agent。

#### 3.9.2 工具清单

| Tool | 说明 |
|------|------|
| `search_knowledge` | 语义+经验检索 |
| `get_node` | 按 ID 取详情（含 edges） |
| `propose_node` | 提交 draft 节点 |
| `record_feedback` | 反馈四值 |
| `list_recent_lessons` | 拉最近 N 条 lesson |
| `list_domains` | 列出当前 company 的业务域 |

#### 3.9.3 启动与鉴权

```typescript
class PaperclipMCPServer extends McpServer {
  async start(opts: { mode: 'stdio' | 'http+sse'; port?: number }) {
    this.registerTool('search_knowledge', this.searchHandler);
    this.registerTool('get_node', this.getNodeHandler);
    // ... 其他工具

    if (opts.mode === 'stdio') {
      await this.connect(new StdioServerTransport());
    } else {
      const transport = new SSEServerTransport('/mcp/v1/sse', opts.port);
      transport.use(this.authMiddleware);              // API Key 鉴权
      await this.connect(transport);
    }
  }

  private authMiddleware(req: Request, next: NextFunction) {
    const apiKey = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!apiKey) return reject(401);
    const ctx = this.apiKeyService.verify(apiKey);
    if (!ctx) return reject(403);
    req.companyId = ctx.companyId;                     // 注入请求上下文
    req.level = ctx.level;
    next();
  }
}
```

#### 3.9.4 search_knowledge handler

```typescript
async searchHandler(args: McpArgs, ctx: McpContext): Promise<McpToolResult> {
  // 鉴权：API Key 已经过中间件验证，ctx.companyId 可信
  const results = await this.retriever.search({
    query: args.query,
    companyId: ctx.companyId,                          // ← 强制隔离
    projectId: null,
    domainNames: args.domain ?? [],
    types: args.type ? [args.type] : undefined,
    includeOutdated: args.include_outdated ?? false,
    limit: 5,
  });

  // 转 MCP content 格式
  return {
    content: [{
      type: 'text',
      text: this.retriever.formatForAgentContext(results),
    }],
    metadata: {
      results: results.map(r => ({ id: r.id, title: r.title, freshness: r.freshnessLabel })),
    },
  };
}
```

#### 3.9.5 propose_node handler

```typescript
async proposeNodeHandler(args, ctx): Promise<McpToolResult> {
  const draftId = await this.drafter.create({
    title: args.title,
    content: args.content,
    type: args.type,
    level: 'project',                                  // 外部 Agent 写入默认 project 级
    businessDomainName: args.domain ?? 'general',
    metadata: args.metadata ?? {},
    volatility: args.volatility,
    validUntil: args.valid_until ? new Date(args.valid_until) : undefined,
    source: 'manual',
    sourceContext: { },                                // 外部 Agent 无 agent_id / run_id
    companyId: ctx.companyId,
  });

  return {
    content: [{
      type: 'text',
      text: `Draft proposed: ${draftId}\nStatus: pending review`,
    }],
  };
}
```

---

### 3.10 Web UI — 人类界面

**详细规范请见 [UI / 交互设计文档](./2026-05-12-llm-wiki-knowledge-engine-ui.md)**。本节仅给架构定位：

- **技术栈**：React + Vite + react-query，复用 Paperclip 现有 UI 栈和 design-guide 设计系统
- **8 个页面**：search / `:id` / review / dashboard / editor / sources / domains / graph
- **关键组件**：NodeCard / FreshnessIndicator / MarkdownEditor（CodeMirror + `[[ ]]` 补全） / DomainPicker / HealthMetricCard / GraphCanvas（Cytoscape 封装）
- **状态管理**：react-query 缓存 + WebSocket 推送实时更新（频道 `knowledge:<company-id>:*`）
- **可访问层**：仅服务人类（Agent 不消费 UI），单操作者优化数据密度

完整页面布局、设计令牌、组件 API、交互流程、性能策略详见 UI 文档。

---

## 4. 关键流程时序

### 4.1 写入流程（Path A：Agent 自评）

```
Agent → Paperclip Heartbeat: 完成 Issue
                │
                ▼
   afterTaskComplete hook
                │
                ▼
Drafter.create(Path A LLM 自评)
                │
                ▼
        write drafts (status=pending)
                │
                ▼
       (waiting for hourly reviewer)
                │
                ▼
Reviewer Agent (hourly Routine)
   - semantic search neighbors
   - LLM verdict
   - update drafts.pre_verdict
                │
                ▼
        (Web UI 审查队列)
                │
                ▼
管理员人审 (一键应用 pre_verdict 或 needs_human 单独处理)
                │
                ▼
NodeWriter.materialize(draftId)
   - INSERT/UPDATE knowledge_nodes
   - EdgeResolver.resolveContent (parse [[ ]] → edges)
   - INSERT events (created/updated)
   - UPDATE drafts.status = approved
                │
                ▼
       节点可被检索
```

### 4.2 读取流程（Agent checkout Issue）

```
Agent → Paperclip: checkout Issue
                │
                ▼
        heartbeat-context API
                │
                ▼
Retriever.search({
  query: issue.title + issue.description,
  companyId, projectId, domainNames: inferFromTags(issue.tags),
  usedForTags: issue.tags,
})
                │
                ├─→ Embedding API (generate query embedding)
                │
                ├─→ DB: semantic search Top 10
                │
                ├─→ DB: experience search Top 5 (by used_for)
                │
                ├─→ FreshnessComputer.compute(each)
                │
                └─→ merge + sort by finalScore + filter outdated
                │
                ▼
        formatForAgentContext → Markdown
                │
                ▼
   Inject into Agent system prompt
                │
                ▼
        Agent 执行任务（可随时调 search_knowledge_base tool）
                │
                ▼
        Agent 命中节点时调 record_feedback (helped / outdated / ...)
                │
                ▼
        write events (triggered / feedback)
        update knowledge_nodes.trigger_count + last_triggered (cache)
```

### 4.3 演化流程（每周一）

```
Routine cron 0 9 * * 1
        │
        ▼
Curator Agent invoked
        │
        ▼
EvolutionEngine.runWeekly(companyId)
        │
        ├─→ checkPromotions()        ──→ open Issue "建议升规则"
        ├─→ scanDecay()              ──→ UPDATE status=archived
        ├─→ detectMergeCandidates()  ──→ open Issue "建议合并"
        ├─→ detectConflicts()        ──→ open Issue "冲突待裁决" + 落 conflicts_with 边
        ├─→ auditFreshness()         ──→ open Issue "请验证 [节点]"
        └─→ emergePatterns()         ──→ Drafter.create (concept + is_pattern=true)
        │
        ▼
   生成本周演化报告 Issue (汇总所有动作)
```

### 4.4 MCP 调用流程（外部 Agent）

```
Claude Code 配置 .mcp.json:
{ "paperclip": { "command": "paperclipai mcp --api-key=$KEY" } }
        │
        ▼
Claude Code 启动 → 拉起 stdio MCP Server
        │
        ▼
Claude 请求 list_tools → 返回 6 个工具
        │
        ▼
Claude 决定调 search_knowledge({ query: "PG 死锁排查" })
        │
        ▼
MCP Server.searchHandler
   - auth: 验证 API Key → 解析 companyId
   - 调 Retriever.search (companyId 强制注入)
   - formatForAgentContext → text 结果
        │
        ▼
Claude 收到 Top-5 节点摘要 + 引用
        │
        ▼
Claude 决定调 get_node({ id: "..." }) 拿详情
        │
        ▼
Claude 用知识完成任务
        │
        ▼
Claude 调 record_feedback({ node_id, feedback: "helped" })
        │
        ▼
events 表写入
```

---

## 5. 状态机

### 5.1 Draft 状态机

```
                            create
                              │
                              ▼
                       ┌──────────────┐
                       │   pending    │ ◄────┐
                       └──────┬───────┘      │
                              │              │
              Reviewer Agent 跑过/未跑都可    │
                              │              │ revision submitted
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        │ approve             │ reject              │ request_revision
        ▼                     ▼                     │
   ┌──────────┐         ┌──────────┐         ┌─────┴──────────────┐
   │ approved │         │ rejected │         │ revision_requested │
   └────┬─────┘         └──────────┘         └────────────────────┘
        │
        ▼
   NodeWriter.materialize
        │
        ▼
    write to nodes
```

**关键转换**：
- pending → approved：人审通过，NodeWriter 物化
- pending → rejected：人审驳回，draft 保留作记录
- pending → revision_requested：人审要求修改，开 Issue 给原写入者
- revision_requested → pending：原写入者提交修订后回到 pending

### 5.2 Node 状态机

```
                       create
                          │
                          ▼
                    ┌──────────┐
                    │  active  │
                    └────┬─────┘
                         │
        ┌────────────────┼────────────────┬────────────────┐
        │                │                │                │
   180d 未触发           被 supersede     被人工标记         严重错误
        ▼                ▼                ▼                ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐     ┌──────────┐
   │ archived │    │ outdated │    │ outdated │     │ revoked  │
   └────┬─────┘    └──────────┘    └──────────┘     └──────────┘
        │
   人审"恢复"
        │
        ▼
    ┌──────────┐
    │  active  │
    └──────────┘
```

**关键转换**：
- active → archived：自动衰减，可手动恢复
- active → outdated：被新节点 supersede，仍可查不可搜
- active → revoked：人工标记严重错误（如内容违法），从检索池彻底排除

### 5.3 Crawl Job 状态机（KnowledgeCollector）

```
   scheduled → running → success → idle (until next cron)
                 │
                 ├─→ rate_limited → retry (exp backoff) → running
                 │
                 ├─→ http_error → retry → running
                 │
                 └─→ failed (after 3 retries) → idle + alarm
```

---

## 6. 错误处理与重试

### 6.1 总体策略

| 错误类型 | 策略 |
|---------|------|
| 用户输入校验失败 | 立即返回 4xx，无重试 |
| LLM 调用失败 | 重试 1 次（指数退避 2s），仍失败记 event，继续 |
| 网络超时 | 重试 3 次（1/2/4s） |
| DB 唯一约束冲突 | 不重试，返回 409 |
| DB 死锁 | 重试 3 次（随机抖动 50-200ms） |
| pgvector 索引未 ready | 退化为顺序扫描（短期；告警） |
| Embedding API 超限额度 | 进入退避模式（5min），告警 |

### 6.2 关键场景

**Embedding 服务挂掉**：
- Drafter.create 暂存到 `embedding_pending` 队列（Redis）
- 每 5min 重试一次
- 6h 仍失败开 alarm Issue

**LLM 调用速率限制**：
- Reviewer Agent 减半频率（hourly → biweekly）
- 等限额恢复后回到 hourly

**Routine 失败**：
- 自动重试 3 次（每次间隔 1h）
- 仍失败开 alarm Issue 给管理员

---

## 7. 性能与可扩展性

### 7.1 性能目标

| 指标 | 目标 P95 |
|------|---------|
| 语义搜索 | < 500 ms |
| Draft 写入（不含 embedding） | < 100 ms |
| Embedding 生成 | < 2 s |
| MCP 工具调用 | < 800 ms |
| 图视图首屏（500 节点） | < 1 s |
| 演化 Routine 全量 | < 5 min（10K 节点） |
| Reviewer Agent 单条 | < 10 s |
| 每日自检 Routine | < 30 s |

### 7.2 可扩展性钩子

| 维度 | 扩展方式 |
|------|---------|
| 节点类型 | pgEnum + migration（5 → N） |
| 边类型 | 同上 |
| 业务域 | 用户在 UI 添加，无 schema 变更 |
| KnowledgeCollector | Plugin 系统注册新 collector |
| FailureSignalDetector | Plugin 系统注册新 detector |
| Embedding 模型 | 抽象 `EmbeddingService` 接口；切换需重 embed |
| 演化条数 | 演化引擎注册器（注入新 EvolutionAction） |

### 7.3 横向扩展

- **读操作**（检索）：PG 读副本 + pgvector 索引复制
- **写操作**（Drafter / NodeWriter）：单写主库，事务隔离已经保证一致性
- **Routine 多实例**：通过分布式锁（PG advisory lock）保证同一 company 同一 Routine 不并发

---

## 8. 测试策略

### 8.1 单元测试

每个组件独立测试，重点：

- Drafter：metadata 校验、敏感内容过滤、业务域解析
- Reviewer Agent：LLM mock，verdict 解析
- NodeWriter：事务原子性、revision 写入
- EdgeResolver：`[[id]]` 解析、自指拒绝、跨公司拒绝
- Retriever：合并去重逻辑、freshness 加权排序
- FreshnessComputer：三种 volatility 衰减曲线、临界值
- EvolutionEngine：每条单独 mock 数据触发

### 8.2 集成测试

- 完整 Path A 流程：从 hook 触发到 node 落地
- 完整检索流程：从 query 到 context injection
- 演化 6 条 e2e：模拟数据触发各条件
- MCP 鉴权：A 公司 key 查 B 公司返回空
- 时效性变化：mock 时间推移看 freshness 标签变化

### 8.3 性能测试

- 10K 节点下语义搜索 P95
- 演化 Routine 在 50K 节点下的执行时间
- 图视图渲染 500 / 1000 / 5000 节点的性能差

### 8.4 测试数据生成

```typescript
// test fixtures
function generateNodes(count: number, opts: { type?, domain?, daysAgoCreated? }): Node[] {
  // 生成带真实 embedding 的测试节点
  // 用于演化引擎、检索的回归测试
}
```

---

## 9. 代码目录结构

```
server/src/services/llm-wiki/
├── drafter/
│   ├── drafter.ts                       # Drafter 主类
│   ├── path-agent-self-review.ts        # Path A 实现
│   ├── path-failure-signal.ts           # Path B 实现
│   ├── path-manual.ts                   # Path C 实现
│   └── metadata-schemas.ts              # 5 种 type 的 Zod schema
├── reviewer-agent/
│   ├── reviewer-agent.ts                # Reviewer Agent 主类
│   ├── reviewer-prompt.ts               # LLM prompt 字符串
│   └── verdict-parser.ts                # LLM 输出 JSON 解析
├── writer/
│   ├── node-writer.ts                   # NodeWriter
│   ├── edge-resolver.ts                 # EdgeResolver
│   └── revision-snapshot.ts             # 修订快照逻辑
├── retriever/
│   ├── retriever.ts                     # Retriever 主类
│   ├── semantic-search.ts               # 语义搜索
│   ├── experience-search.ts             # 经验推荐
│   ├── freshness.ts                     # FreshnessComputer
│   └── context-formatter.ts             # Agent context 格式化
├── evolution/
│   ├── evolution-engine.ts              # 主引擎
│   ├── actions/
│   │   ├── promotion-check.ts           # 升规则
│   │   ├── decay-scan.ts                # 衰减
│   │   ├── merge-candidate.ts           # 合并
│   │   ├── conflict-detect.ts           # 冲突
│   │   ├── freshness-audit.ts           # 时效巡检
│   │   └── pattern-emergence.ts         # 模式涌现
│   └── hdbscan.ts                       # 聚类算法封装
├── failure-signals/
│   ├── registry.ts                      # FailureSignalRegistry
│   ├── listener.ts                      # 事件订阅
│   └── detectors/
│       ├── issue-reopened.ts
│       ├── approval-rejected.ts
│       ├── run-cancelled.ts
│       └── commit-reverted.ts
├── collectors/
│   ├── registry.ts                      # KnowledgeCollectorRegistry
│   ├── runner.ts                        # Routine 调度器
│   ├── interface.ts                     # KnowledgeCollector interface
│   ├── web-crawler.ts                   # WebCrawler
│   ├── rss-collector.ts                 # RSSCollector
│   ├── github-collector.ts              # GitHubCollector
│   └── quality-scorer.ts                # 质量过滤
├── mcp/
│   ├── server.ts                        # MCP Server 入口
│   ├── auth.ts                          # API Key 鉴权中间件
│   └── tools/
│       ├── search-knowledge.ts
│       ├── get-node.ts
│       ├── propose-node.ts
│       ├── record-feedback.ts
│       ├── list-recent-lessons.ts
│       └── list-domains.ts
├── healthcheck/
│   ├── runner.ts                        # daily-knowledge-healthcheck Routine
│   ├── metrics.ts                       # 6 个指标计算
│   └── alarms.ts                        # 异常 Issue 开启
├── api/
│   ├── routes.ts                        # REST 路由汇总
│   ├── nodes.ts                         # /api/knowledge/nodes/*
│   ├── search.ts                        # /api/knowledge/search
│   ├── drafts.ts                        # /api/knowledge/drafts/*
│   ├── domains.ts                       # /api/knowledge/domains/*
│   ├── sources.ts                       # /api/knowledge/sources/*
│   ├── feedback.ts                      # /api/knowledge/nodes/:id/feedback
│   └── stats.ts                         # /api/knowledge/stats
├── prompts/
│   ├── self-review.ts
│   ├── failure-extraction.ts
│   ├── reviewer.ts
│   ├── pattern-emergence.ts
│   ├── conflict-check.ts
│   └── quality-score.ts
├── utils/
│   ├── vector.ts                        # pgvector 封装
│   ├── embedding-service.ts             # OpenAI embedding API
│   ├── event-logger.ts                  # 写 events 表辅助
│   ├── sensitive-content.ts             # 敏感内容过滤
│   └── domain-resolver.ts               # business_domain name → ID
├── bootstrap.ts                         # 启动注册（detectors, collectors, routines）
└── __tests__/                           # 单测 + 集成测试
```

UI 部分：

```
ui/src/pages/knowledge/
├── search.tsx
├── node-detail.tsx
├── review.tsx
├── dashboard.tsx
├── editor.tsx
├── sources.tsx
├── domains.tsx
└── graph.tsx

ui/src/components/knowledge/
├── node-card.tsx
├── edge-badge.tsx
├── freshness-indicator.tsx
├── domain-picker.tsx
├── type-picker.tsx
├── markdown-editor.tsx                  # CodeMirror + [[ ]] 补全
├── health-metric-card.tsx
└── graph-canvas.tsx                     # Cytoscape 封装

ui/src/hooks/knowledge/
├── use-search.ts
├── use-node.ts
├── use-draft-review.ts
└── use-health-metrics.ts
```

---

**结束** — 功能设计覆盖 10 个核心组件 + 关键流程时序 + 状态机 + 错误处理 + 性能 + 测试 + 完整代码目录结构。
