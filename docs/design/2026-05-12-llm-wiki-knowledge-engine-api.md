# Paperclip × LLM-Wiki 知识引擎 — API 设计

**版本**: v2.0
**日期**: 2026-05-12
**关联文档**: [PRD](../prd/2026-05-12-llm-wiki-knowledge-engine-prd.md) · [架构详设](./2026-05-12-llm-wiki-knowledge-engine-architecture.md) · [数据库](./2026-05-12-llm-wiki-knowledge-engine-database.md)

---

## 目录

1. [概述](#1-概述)
2. [鉴权](#2-鉴权)
3. [通用约定](#3-通用约定)
4. [REST API 完整规范](#4-rest-api-完整规范)
5. [MCP 协议规范](#5-mcp-协议规范)
6. [请求/响应示例](#6-请求响应示例)
7. [错误码](#7-错误码)
8. [SDK 与集成示例](#8-sdk-与集成示例)

---

## 1. 概述

LLM-Wiki 知识引擎对外暴露两套接入：

| 接入 | 协议 | 主要消费者 |
|------|------|-----------|
| **REST API** | HTTP/JSON，复用 Paperclip 现有路由栈 | Paperclip Web UI、Paperclip 内部 Agent、第三方脚本 |
| **MCP Server** | Model Context Protocol（stdio + HTTP/SSE） | 外部 Agent（Claude Code / Codex / Cursor 等） |

两套接入共享同一服务层（Drafter / Retriever / NodeWriter 等），数据强一致，权限统一。

### 1.1 命名约定

- REST 资源路径：`/api/knowledge/<resource>`
- HTTP 动词：标准 RESTful（GET / POST / PATCH / DELETE）
- 资源 ID：UUID v4
- 时间字段：ISO 8601 (`2026-05-12T10:30:00Z`)
- 业务域参数：用 `name`（slug）而非 ID，对外更友好

### 1.2 设计原则

1. **强类型 schema**：所有请求/响应字段类型明确
2. **强制 company 隔离**：服务端强制按当前会话的 company_id 过滤，绝不信任客户端声明
3. **写操作走审查**：除管理员显式 `skip_review` 外，所有创建/修改先进 draft 队列
4. **可追溯**：所有写操作通过 `X-Paperclip-Run-Id` header 关联到来源 Run（如有）
5. **错误响应统一**：见 §7

---

## 2. 鉴权

### 2.1 REST API 鉴权

复用 Paperclip 现有的三种鉴权方式：

| 方式 | Header | 适用场景 |
|------|--------|----------|
| Session Cookie | `Cookie: paperclip-session=<jwt>` | Web UI 浏览器请求 |
| API Key | `Authorization: Bearer <api-key>` | Agent / 脚本 / 第三方集成 |
| Run JWT | `Authorization: Bearer <run-jwt>` + `X-Paperclip-Run-Id: <run-id>` | Paperclip 内部 Agent（短期 token） |

API Key 通过 Paperclip 控制台生成，绑定：
- `company_id` — 单一公司，跨公司请求一律返回空
- `level` — `admin` / `member`；admin 可调用 `skip_review` 接口

### 2.2 MCP 鉴权

外部 Agent 通过 MCP Server 接入时：

- **stdio 模式**：API Key 在启动命令传入（`paperclipai mcp --api-key=<key>`），后续 RPC 无需重复
- **HTTP/SSE 模式**：每次请求带 `Authorization: Bearer <api-key>` header

MCP 鉴权失败返回标准 MCP 错误（code: -32001），客户端会断开连接。

### 2.3 权限矩阵

| 操作 | session | api_key (member) | api_key (admin) | mcp |
|------|---------|-------------------|------------------|-----|
| 查 active 节点 | ✓ | ✓ | ✓ | ✓ |
| 查 archived / outdated | ✓ | ✓ | ✓ | ✓（带参） |
| 提交 draft | ✓ | ✓ | ✓ | ✓ |
| `skip_review=true` 直写 | ✓（仅管理员 session） | ✗ | ✓ | ✗ |
| approve / reject draft | ✓（仅管理员 session） | ✗ | ✓ | ✗ |
| 业务域 CRUD | ✓（仅管理员） | ✗ | ✓ | ✗（只读 list） |
| 演化人工触发 | ✓（仅管理员） | ✗ | ✓ | ✗ |
| feedback 反馈 | ✓ | ✓ | ✓ | ✓ |

---

## 3. 通用约定

### 3.1 标准请求 header

```
Authorization: Bearer <token>
Content-Type: application/json
X-Paperclip-Run-Id: <run-uuid>          # 可选，写操作时建议带（追溯到来源 Run）
Accept-Language: zh-CN | en-US           # 可选，影响 display_label
```

### 3.2 HTTP 状态码

| 状态码 | 含义 |
|--------|------|
| 200 OK | 成功 |
| 201 Created | 创建成功，响应含新资源 ID |
| 204 No Content | 操作成功无响应体（如 archive） |
| 400 Bad Request | 请求参数校验失败 |
| 401 Unauthorized | 鉴权缺失或失败 |
| 403 Forbidden | 权限不足 |
| 404 Not Found | 资源不存在 |
| 409 Conflict | 唯一约束冲突 / 状态冲突 |
| 422 Unprocessable Entity | 业务规则校验失败（如 metadata schema 错误） |
| 429 Too Many Requests | 速率限制 |
| 500 Internal Server Error | 服务端错误 |

### 3.3 响应格式

成功响应：

```json
{
  "data": { ... } | [ ... ],
  "meta": { "took_ms": 120, "total"?: 42 }
}
```

错误响应：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "metadata schema mismatch for type=lesson",
    "details": { ... }
  }
}
```

### 3.4 分页

列表接口支持游标分页：

```
GET /api/knowledge/nodes?limit=20&cursor=eyJjcmVhdGVkX2F0Ijoi...
```

响应：

```json
{
  "data": [...],
  "meta": {
    "next_cursor": "eyJj..." | null,
    "has_more": true
  }
}
```

### 3.5 速率限制

- REST API：每 API Key 默认 600 req/min；管理员 token 不限
- MCP API：每 API Key 默认 300 req/min（含所有工具调用）
- 超限返回 429，响应 header 含 `X-RateLimit-Remaining` / `X-RateLimit-Reset`

---

## 4. REST API 完整规范

### 4.1 节点（Node）CRUD

#### GET /api/knowledge/nodes/:id

获取节点详情（含正反向 edges）。

**Path 参数**：`id` UUID

**Response 200**：

```json
{
  "data": {
    "id": "a3f1...8c2e",
    "title": "PostgreSQL 死锁排查",
    "content": "...",
    "type": "lesson",
    "level": "company",
    "status": "active",
    "domain": {
      "id": "...", "name": "software",
      "display_label": "软件与 AI 工具", "color": "#3B82F6"
    },
    "confidence": 0.9,
    "verified": true,
    "volatility": "slow",
    "valid_until": null,
    "verified_at": "2026-04-15T10:00:00Z",
    "source_url": null,
    "trigger_count": 7,
    "last_triggered": "2026-05-10T09:23:00Z",
    "used_for": ["bug-fix", "database"],
    "prevention_score": 0.85,
    "metadata": { ... },
    "edges": {
      "out": [
        { "id": "...", "edge_type": "references", "to_node": { "id": "...", "title": "..." } }
      ],
      "in": [
        { "id": "...", "edge_type": "supersedes", "from_node": { "id": "...", "title": "..." } }
      ]
    },
    "created_at": "...",
    "updated_at": "..."
  }
}
```

错误：404 不存在 / 403 跨公司访问。

#### GET /api/knowledge/nodes

列表查询。

**Query 参数**：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `type` | csv | — | 类型过滤，如 `lesson,rule` |
| `level` | csv | — | 层级过滤 |
| `domain` | csv | — | 业务域 name 过滤 |
| `status` | csv | `active` | 状态过滤；显式传 `all` 包含全部 |
| `project_id` | uuid | — | 限定项目 |
| `verified` | bool | — | 仅返回已验证/未验证 |
| `volatility` | csv | — | 时效性过滤 |
| `limit` | int | 20 | 每页数量 |
| `cursor` | string | — | 游标分页 |
| `sort` | string | `-created_at` | 排序，前缀 `-` 表示降序 |

**Response 200**：同 GET /:id 但 data 是数组，每项不含 edges（节省载荷）。

#### POST /api/knowledge/nodes

直接创建节点（**需要 admin 权限**，且 `skip_review=true`）。常规创建走 `/drafts`。

**Request body**：

```json
{
  "title": "...",
  "content": "...",
  "type": "lesson",
  "level": "company",
  "business_domain_name": "software",
  "metadata": { ... },
  "volatility": "slow",
  "valid_until": null,
  "confidence": 0.95,
  "skip_review": true
}
```

**Response 201**：`{ "data": { "id": "..." } }`

错误：403 非 admin / 422 metadata schema 错误 / 404 业务域不存在。

#### PATCH /api/knowledge/nodes/:id

修改节点（自动产生 revision 快照）。

**Request body**：（所有字段可选）

```json
{
  "title": "...",
  "content": "...",
  "volatility": "fast",
  "valid_until": "2027-01-01T00:00:00Z",
  "metadata": { ... },
  "verified": true,
  "changeset_summary": "更新 2026-Q2 抖音规则"
}
```

**Response 200**：返回更新后的完整节点对象。

**注意**：`type` / `level` 修改受限：
- `lesson` → `rule` 必须走演化流程（`/promote-to-rule`），不能直接 PATCH
- `level` 提升必须走 `/promote`

#### DELETE /api/knowledge/nodes/:id

软删（`status = revoked`）。**需要 admin 权限**。

**Response 204**。

### 4.2 检索

#### GET /api/knowledge/search

语义 + 经验两路检索。

**Query 参数**：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `q` | string (required) | — | 查询文本（自然语言） |
| `type` | csv | — | 类型过滤 |
| `domain` | csv | — | 业务域 name 数组（按当前 company 隔离） |
| `used_for` | csv | — | 经验推荐标签 |
| `project_id` | uuid | — | 限定项目，影响 level=project 节点可见性 |
| `include_outdated` | bool | false | 是否包含 outdated 节点 |
| `limit` | int | 5 | 返回 Top N |

**Response 200**：

```json
{
  "data": {
    "results": [
      {
        "id": "...",
        "title": "...",
        "snippet": "...",                          // content 前 200 字
        "type": "lesson",
        "level": "company",
        "domain": { "name": "software", "display_label": "软件与 AI 工具", "color": "#3B82F6" },
        "confidence": 0.9,
        "verified": true,
        "trigger_count": 7,
        "similarity": 0.88,
        "experience_score": 0.45,
        "freshness_score": 0.92,
        "freshness_label": "fresh",
        "final_score": 0.74,
        "verified_at": "..."
      }
    ],
    "search_type": "semantic+experience",
    "took_ms": 120
  }
}
```

### 4.3 边（Edge）管理

#### POST /api/knowledge/edges

显式加边（手动建立特殊关系，如 supersedes / conflicts_with）。

**Request body**：

```json
{
  "from_node_id": "...",
  "to_node_id": "...",
  "edge_type": "supersedes",
  "metadata": { "reason": "2026-Q2 规则更新" }
}
```

**Response 201**：`{ "data": { "id": "..." } }`

错误：409 重复边 / 400 自指 / 403 跨公司。

#### DELETE /api/knowledge/edges/:id

删除边。

**Response 204**。

#### GET /api/knowledge/nodes/:id/edges

节点全部边（含正向反向）。响应同 GET /nodes/:id 的 edges 字段。

### 4.4 草稿（Draft）与审查

#### POST /api/knowledge/drafts

提交 draft（三路写入的统一入口）。

**Request body**：

```json
{
  "target_node_id": null,                            // 新建为 null；修改时填目标节点 ID
  "title": "...",
  "content": "...",
  "type": "lesson",
  "level": "project",
  "business_domain_name": "software",
  "metadata": { ... },
  "volatility": "fast",
  "valid_until": null,
  "confidence": 0.8,
  "source": "agent_self_review",
  "source_run_id": "...",
  "source_issue_id": "...",
  "skip_review": false                               // 仅 admin 可设 true
}
```

**Response 201**：

```json
{
  "data": {
    "id": "...",
    "status": "pending",
    "pre_verdict": null                              // 等 Reviewer Agent hourly Routine 跑过会填充
  }
}
```

#### GET /api/knowledge/drafts

审查队列。

**Query 参数**：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `status` | csv | `pending` | 状态过滤 |
| `source` | csv | — | 来源过滤 |
| `pre_verdict` | csv | — | Reviewer Agent 建议过滤 |
| `domain` | csv | — | 业务域 |
| `limit` | int | 20 | — |
| `cursor` | string | — | — |
| `sort` | string | `-priority_score` | 默认按梯度优先级排序 |

**Response 200**：draft 列表，每项含完整字段（含 pre_verdict / detected_conflicts）。

#### POST /api/knowledge/drafts/:id/approve

批准 draft，触发 NodeWriter.materialize。**需要 admin 权限**。

**Request body**（可选）：

```json
{
  "review_notes": "..."
}
```

**Response 200**：`{ "data": { "node_id": "..." } }`

#### POST /api/knowledge/drafts/:id/reject

驳回 draft。

**Request body**：

```json
{
  "review_notes": "..."                              // 推荐填，便于追溯
}
```

**Response 204**。

#### POST /api/knowledge/drafts/:id/request-revision

要求原写入者修改。系统自动创建 Issue 分配给写入者。

**Request body**：

```json
{
  "review_notes": "请补充 root_cause 字段"
}
```

**Response 200**：`{ "data": { "issue_id": "..." } }`

#### POST /api/knowledge/drafts/batch-approve

批量批准。

**Request body**：

```json
{
  "draft_ids": ["...", "...", "..."],
  "review_notes": "批量通过 Reviewer recommend_approve"
}
```

**Response 200**：

```json
{
  "data": {
    "approved_count": 3,
    "failed": []                                     // 失败 ID 列表
  }
}
```

### 4.5 反馈

#### POST /api/knowledge/nodes/:id/feedback

记录 Agent 使用某节点后的反馈。

**Request body**：

```json
{
  "feedback": "helped",                              // helped | outdated | wrong | irrelevant
  "run_id": "...",                                   // 来源 Run（可选但推荐）
  "issue_id": "...",
  "comment": "..."                                   // 可选
}
```

**Response 204**。

副作用：
- `helped`: `trigger_count += 1`, `last_triggered = now()`
- `outdated`: 强制 `freshness_score ≤ 0.3`，自动创建验证 Issue
- `wrong`: 进入冲突审查队列，开 Issue
- `irrelevant`: 降低对应 used_for 标签下推荐权重（应用层处理）

### 4.6 演化人工触发

#### POST /api/knowledge/nodes/:id/promote-to-rule

手动升规则（管理员判断 lesson 应升 rule，不等演化引擎）。

**Response 200**：

```json
{
  "data": {
    "rule_node_id": "...",                           // 新建的 rule 节点
    "derived_from_edge_id": "..."                    // derived_from 边 ID
  }
}
```

#### POST /api/knowledge/nodes/:id/verify

手动标已验证（更新 `verified_at = now()`，`verified = true`）。

**Response 200**：返回更新后的节点。

#### POST /api/knowledge/nodes/:id/mark-outdated

手动标过期（`status = outdated`）。

**Response 204**。

### 4.7 业务域管理（FR10）

#### GET /api/knowledge/domains

列出业务域。

**Query 参数**：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `include_archived` | bool | false | 是否包含归档 |

**Response 200**：

```json
{
  "data": [
    {
      "id": "...",
      "name": "software",
      "display_label": "软件与 AI 工具",
      "description": "...",
      "color": "#3B82F6",
      "icon": "code",
      "sort_order": 0,
      "archived": false,
      "node_count": 42,
      "created_at": "..."
    }
  ]
}
```

#### POST /api/knowledge/domains

创建。**需要 admin 权限**。

**Request body**：

```json
{
  "name": "ai-education",                            // slug 校验
  "display_label": "AI 教育",
  "description": "...",
  "color": "#8B5CF6",
  "icon": "graduation-cap",
  "sort_order": 5
}
```

**Response 201**：`{ "data": { "id": "..." } }`

错误：409 重名 / 400 name 格式错误。

#### PATCH /api/knowledge/domains/:id

编辑。

**Request body**：（所有字段可选，name 不可改）

```json
{
  "display_label": "...",
  "color": "...",
  "icon": "...",
  "description": "...",
  "sort_order": 3
}
```

#### POST /api/knowledge/domains/:id/archive

归档（软删）。关联节点不动，但新建/检索下拉里隐藏。

**Response 204**。

#### POST /api/knowledge/domains/:id/restore

恢复归档。

**Response 204**。

#### GET /api/knowledge/domains/:id/stats

业务域统计。

**Response 200**：

```json
{
  "data": {
    "node_count": 42,
    "by_type": { "concept": 5, "lesson": 20, "rule": 8, "decision": 6, "fact": 3 },
    "by_status": { "active": 40, "archived": 2 },
    "verified_rate": 0.75,
    "avg_confidence": 0.82,
    "most_triggered": [
      { "id": "...", "title": "...", "trigger_count": 12 }
    ]
  }
}
```

### 4.8 外部源管理（FR11）

#### GET /api/knowledge/sources

列表。

**Response 200**：含每个源的 enabled / last_crawled / 最近抓取结果数等。

#### POST /api/knowledge/sources

创建。

**Request body**：

```json
{
  "name": "Martin Fowler 博客",
  "url": "https://martinfowler.com",
  "source_type": "blog",
  "collector_name": "WebCrawler",
  "crawl_frequency": "weekly",
  "trust_weight": 0.9,
  "article_selector": "article.post",
  "sitemap_url": "https://martinfowler.com/feed.atom",
  "tags": ["architecture", "microservices"],
  "business_domain_name": "software",
  "crawl_config": { "concurrency": 1, "request_interval_ms": 5000 }
}
```

#### PATCH /api/knowledge/sources/:id

编辑。

#### POST /api/knowledge/sources/:id/crawl-now

手动触发抓取。

**Response 200**：`{ "data": { "job_id": "..." } }`

### 4.9 统计

#### GET /api/knowledge/stats

总览统计。

**Response 200**：

```json
{
  "data": {
    "total_nodes": 150,
    "by_type": { "concept": 30, "lesson": 60, "rule": 25, "decision": 20, "fact": 15 },
    "by_domain": [
      { "name": "software", "display_label": "软件与 AI 工具", "count": 40 },
      { "name": "content", "display_label": "自媒体内容", "count": 35 }
    ],
    "by_status": { "active": 120, "archived": 20, "outdated": 10 },
    "verified_rate": 0.65,
    "avg_freshness": 0.82,
    "draft_pending": 5,
    "stale_count": 8,
    "most_triggered": [
      { "id": "...", "title": "...", "trigger_count": 12 }
    ],
    "health_metrics": [
      { "name": "weekly_new_drafts", "value": 12, "status": "healthy" },
      { "name": "review_backlog_hours_p50", "value": 8.5, "status": "healthy" }
    ]
  }
}
```

---

## 5. MCP 协议规范

### 5.1 MCP 协议合规

实现标准 Anthropic MCP 规范：

- 协议版本：`2024-11-05` 及以上
- 传输：stdio（本机）+ HTTP/SSE（远程）
- 错误码：JSON-RPC 2.0 标准

### 5.2 部署形态

```bash
# stdio 模式（适合本机 Agent 集成）
paperclipai mcp --api-key=<key>

# HTTP/SSE 模式（适合远程接入）
# 由 Paperclip Server 内嵌，端点 /mcp/v1/sse
GET /mcp/v1/sse
Authorization: Bearer <api-key>
Accept: text/event-stream
```

Claude Code 配置示例：

```json
{
  "mcpServers": {
    "paperclip-llm-wiki": {
      "command": "paperclipai",
      "args": ["mcp", "--api-key=${PAPERCLIP_API_KEY}"]
    }
  }
}
```

### 5.3 工具清单

| 工具名 | 说明 | 鉴权级别 |
|--------|------|---------|
| `search_knowledge` | 语义+经验两路检索 | member |
| `get_node` | 按 ID 取详情（含 edges） | member |
| `propose_node` | 提交 draft 节点 | member |
| `record_feedback` | 反馈四值 | member |
| `list_recent_lessons` | 拉取最近 N 条 lesson | member |
| `list_domains` | 列出当前 company 的业务域 | member |

### 5.4 工具详细定义

#### search_knowledge

```typescript
{
  name: "search_knowledge",
  description: "Search Paperclip company knowledge base via semantic + experience routing. Returns Top-N nodes with freshness awareness.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Natural language query" },
      type: {
        type: "string",
        enum: ["concept", "lesson", "rule", "decision", "fact"],
        description: "Filter by node type (optional)"
      },
      domain: {
        type: "array",
        items: { type: "string" },
        description: "Filter by business domain names (按当前 company 隔离). Use list_domains first to find available domains."
      },
      used_for: {
        type: "array",
        items: { type: "string" },
        description: "Experience-recommendation tags (e.g., 'bug-fix', 'deployment')"
      },
      include_outdated: {
        type: "boolean",
        default: false,
        description: "Include outdated nodes (historical archive)"
      },
      limit: { type: "integer", default: 5, maximum: 20 }
    }
  }
}
```

返回值格式：

```typescript
{
  content: [
    {
      type: "text",
      text: "## 知识库相关条目\n\n- [[a3f1...8c2e]] **PG 死锁排查** (fresh, lesson, ...)\n..."
    }
  ],
  metadata: {
    results: [{ id, title, type, freshness_label, similarity }]
  }
}
```

#### get_node

```typescript
{
  name: "get_node",
  description: "Get full node details including edges and metadata.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" }
    }
  }
}
```

返回完整节点对象（同 REST GET /nodes/:id）。

#### propose_node

```typescript
{
  name: "propose_node",
  description: "Propose a new knowledge node or update existing one. Goes through review queue.",
  inputSchema: {
    type: "object",
    required: ["title", "content", "type"],
    properties: {
      title: { type: "string", maxLength: 200 },
      content: { type: "string", maxLength: 8192 },
      type: { type: "string", enum: ["concept", "lesson", "rule", "decision", "fact"] },
      domain: { type: "string", description: "Business domain name; defaults to 'general'" },
      level: { type: "string", enum: ["project", "company"], default: "project" },
      volatility: { type: "string", enum: ["stable", "slow", "fast"] },
      valid_until: { type: "string", format: "date-time" },
      metadata: { type: "object" },
      references_issue_ids: { type: "array", items: { type: "string" } },
      target_node_id: { type: "string", description: "For updates; null for new" }
    }
  }
}
```

返回值：

```typescript
{
  content: [{ type: "text", text: "Draft proposed: <draft-id>\nStatus: pending review" }],
  metadata: { draft_id: "..." }
}
```

#### record_feedback

```typescript
{
  name: "record_feedback",
  description: "Record feedback after using a knowledge node.",
  inputSchema: {
    type: "object",
    required: ["node_id", "feedback"],
    properties: {
      node_id: { type: "string", format: "uuid" },
      feedback: { type: "string", enum: ["helped", "outdated", "wrong", "irrelevant"] },
      comment: { type: "string", maxLength: 500 }
    }
  }
}
```

#### list_recent_lessons

```typescript
{
  name: "list_recent_lessons",
  description: "List recent lesson nodes for the company. Useful for agent startup context.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", default: 10, maximum: 50 },
      domain: { type: "array", items: { type: "string" } }
    }
  }
}
```

返回 lesson 节点摘要列表（按 created_at 降序）。

#### list_domains

```typescript
{
  name: "list_domains",
  description: "List business domains available in the current company. Use this before calling propose_node with a domain parameter.",
  inputSchema: {
    type: "object",
    properties: {
      include_archived: { type: "boolean", default: false }
    }
  }
}
```

返回值：

```typescript
{
  content: [{
    type: "text",
    text: "Available business domains:\n- software (软件与 AI 工具)\n- content (自媒体内容矩阵)\n- ..."
  }],
  metadata: { domains: [{ id, name, display_label, ... }] }
}
```

### 5.5 MCP 错误处理

| 错误码 | 含义 |
|--------|------|
| -32700 | Parse Error（JSON 格式错误） |
| -32600 | Invalid Request |
| -32601 | Method Not Found（工具不存在） |
| -32602 | Invalid Params（参数错误） |
| -32603 | Internal Error |
| -32001 | Auth Failed（API Key 无效） |
| -32002 | Forbidden（权限不足） |
| -32003 | Rate Limited |
| -32004 | Resource Not Found |

---

## 6. 请求/响应示例

### 6.1 端到端：Agent 完成任务后写入

```bash
# 1. Agent 通过 hook 提交 draft
curl -X POST https://paperclip.example/api/knowledge/drafts \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Paperclip-Run-Id: run-abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "PG 死锁排查清单",
    "content": "## 概述\n\n## 核心要点\n- ...\n",
    "type": "lesson",
    "level": "project",
    "business_domain_name": "software",
    "metadata": {
      "symptom": "事务长时间挂起",
      "root_cause": "互斥锁顺序不一致",
      "next_time": "确保多事务按相同顺序加锁"
    },
    "volatility": "slow",
    "confidence": 0.85,
    "source": "agent_self_review",
    "source_run_id": "run-abc123",
    "source_issue_id": "issue-xyz789"
  }'

# Response 201
{ "data": { "id": "draft-001", "status": "pending", "pre_verdict": null } }
```

```bash
# 2. （1 小时后）Reviewer Agent 自动初筛
# 自动调用，无需人工。结果写回 drafts.pre_verdict

# 3. 管理员审查
curl -X POST https://paperclip.example/api/knowledge/drafts/draft-001/approve \
  -H "Cookie: paperclip-session=$SESSION" \
  -H "Content-Type: application/json" \
  -d '{ "review_notes": "approved by reviewer" }'

# Response 200
{ "data": { "node_id": "node-001" } }
```

### 6.2 端到端：另一 Agent 检索

```bash
curl -G https://paperclip.example/api/knowledge/search \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode "q=database deadlock troubleshooting" \
  --data-urlencode "domain=software" \
  --data-urlencode "used_for=bug-fix,database" \
  --data-urlencode "limit=5"

# Response 200
{
  "data": {
    "results": [{
      "id": "node-001",
      "title": "PG 死锁排查清单",
      "snippet": "...",
      "type": "lesson",
      "domain": { "name": "software", "display_label": "软件与 AI 工具", "color": "#3B82F6" },
      "similarity": 0.91,
      "freshness_score": 0.97,
      "freshness_label": "fresh",
      "final_score": 0.78
    }],
    "search_type": "semantic+experience",
    "took_ms": 95
  }
}
```

### 6.3 MCP 调用示例

Claude Code 内部（伪代码）：

```typescript
// Claude Code 在执行 SQL 优化任务时
const result = await mcp.callTool('paperclip-llm-wiki', 'search_knowledge', {
  query: 'PostgreSQL slow query optimization',
  domain: ['software'],
  used_for: ['query-optimization'],
});

// Claude 用结果决策；完成后反馈
await mcp.callTool('paperclip-llm-wiki', 'record_feedback', {
  node_id: result.metadata.results[0].id,
  feedback: 'helped',
  comment: 'Resolved deadlock in payment service',
});
```

---

## 7. 错误码

完整错误码字典：

| code | HTTP | 含义 |
|------|------|------|
| `UNAUTHORIZED` | 401 | 鉴权缺失/失败 |
| `FORBIDDEN` | 403 | 权限不足（如 member 调 admin-only 接口） |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 400 | 请求参数校验失败 |
| `METADATA_SCHEMA_ERROR` | 422 | metadata 不符合 type 对应的 schema |
| `BUSINESS_DOMAIN_NOT_FOUND` | 404 | 业务域 name 不存在 |
| `DOMAIN_NAME_INVALID` | 400 | 业务域 name 格式错误（非 slug） |
| `DUPLICATE_EDGE` | 409 | 边重复（同 from/to/type） |
| `SELF_REFERENCE` | 400 | 自指引用 |
| `CROSS_COMPANY` | 403 | 跨公司引用尝试 |
| `DRAFT_ALREADY_REVIEWED` | 409 | draft 已被审查过 |
| `NODE_LOCKED` | 409 | 节点正被其他事务修改 |
| `EMBEDDING_SERVICE_DOWN` | 503 | Embedding 服务不可用 |
| `LLM_SERVICE_DOWN` | 503 | LLM 服务不可用 |
| `RATE_LIMITED` | 429 | 速率限制 |
| `SENSITIVE_CONTENT_BLOCKED` | 422 | 内容含敏感模式（信用卡 / API Key 等） |

错误响应示例：

```json
{
  "error": {
    "code": "METADATA_SCHEMA_ERROR",
    "message": "metadata schema mismatch for type=lesson",
    "details": {
      "missing_fields": ["symptom", "root_cause"],
      "invalid_fields": []
    }
  }
}
```

---

## 8. SDK 与集成示例

### 8.1 TypeScript SDK（伪代码）

```typescript
import { PaperclipKnowledge } from '@paperclipai/sdk';

const kb = new PaperclipKnowledge({
  apiKey: process.env.PAPERCLIP_API_KEY,
  baseUrl: 'https://paperclip.example',
});

// 检索
const results = await kb.search({
  query: 'PostgreSQL deadlock',
  domain: ['software'],
  usedFor: ['bug-fix'],
});

// 提交 draft
const draftId = await kb.proposeDraft({
  title: '...',
  content: '...',
  type: 'lesson',
  metadata: { symptom: '...', root_cause: '...', next_time: '...' },
});

// 反馈
await kb.recordFeedback(nodeId, { feedback: 'helped' });
```

### 8.2 Paperclip Agent 内置工具

通过 Paperclip Plugin Tool Dispatcher 暴露：

```typescript
tools: [
  { name: "search_knowledge_base", description: "搜索 LLM-Wiki 知识库" },
  { name: "propose_knowledge_node", description: "提交知识节点到审查队列" },
  { name: "record_knowledge_feedback", description: "对已检索节点反馈" },
  { name: "mark_node_outdated", description: "标记节点过时" }
]
```

实现底层调用 REST API，复用 Agent 的 Run JWT 鉴权。

### 8.3 外部 Agent（Claude / Codex）

通过 MCP 配置接入（见 §5.2）。无需写额外代码，MCP 客户端自动发现工具。

---

**结束** — API 设计涵盖 REST + MCP 双接入，全部接口的请求/响应规范、鉴权、错误码、集成示例。
