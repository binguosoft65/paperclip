# MCP Server 模块

## 模块概述

MCP Server（`packages/mcp-server/src/`）是 Paperclip 平台的 **MCP（Model Context Protocol）服务端实现**。它负责将 Paperclip 内部 REST API 封装为一组标准 MCP 工具，使得任何支持 MCP 协议的 AI 客户端（如 Claude Desktop、Claude Code CLI 等）能够直接与 Paperclip 平台交互。

核心职责：

- 注册 MCP 工具，将 CRUD 操作以 `paperclip*` 命名空间暴露给 LLM
- 处理认证转发（Bearer token + Run-Id 追踪）
- 封装 API 错误为结构化信息，供 LLM 决策重试或上报
- 管理 Issue 执行工作空间的运行时服务生命周期（启动/停止/等待就绪）

---

## 核心流程

### 服务启动

```
stdio.ts (CLI entry)
  -> index.ts: runServer()
    -> config.ts: readConfigFromEnv()   读取环境变量
    -> client.ts: PaperclipApiClient    创建 HTTP 客户端
    -> tools.ts: createToolDefinitions() 生成工具列表
    -> McpServer: tool() 注册工具      逐一注册到 MCP 协议
    -> StdioServerTransport.connect()   启动 STDIO 传输
```

服务通过标准 STDIO 传输协议运行，接受 MCP 协议格式的 JSON-RPC 请求，分发到对应的 `execute` 处理器。

### 工具调用流程

```
LLM -> MCP JSON-RPC -> server.tool 匹配 -> tools.ts makeTool.execute()
  -> Zod schema.parse(input)           校验输入
  -> PaperclipApiClient.requestJson()  调用 Paperclip API
  -> formatTextResponse() / formatErrorResponse()  包装响应
  -> MCP JSON-RPC 响应 -> LLM
```

所有工具共享相同的错误处理管线：Zod 校验失败或 API 返回非 2xx，统一经 `formatErrorResponse` 格式化为结构化 JSON 文本返回给 LLM。

---

## 关键文件

| 文件 | 职责 |
|---|---|
| `index.ts` | 服务工厂（createPaperclipMcpServer）和启动入口（runServer）；组装 server + client + tools |
| `tools.ts` | 所有 MCP 工具的定义（名称、描述、Zod 校验 Schema、执行函数）；工具工厂函数 makeTool；Issue 运行时服务选择/等待辅助逻辑 |
| `client.ts` | Paperclip API HTTP 客户端，封装 fetch 请求、Bearer token 注入、Run-Id 追踪、错误响应解析为 PaperclipApiError |
| `config.ts` | 环境变量读取（12-factor 配置）与 API URL 标准化 |
| `format.ts` | MCP text content 格式包装器（成功/错误两种输出模式） |
| `stdio.ts` | Node.js CLI 入口脚本 |

---

## 上下游依赖

### 上游（本模块依赖）

| 依赖 | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | MCP 协议核心库（McpServer, StdioServerTransport） |
| `zod` | 运行时输入校验，定义每个工具的参数 schema |
| `@paperclipai/shared` | 共享 schema 类型（createIssueSchema, addIssueCommentSchema 等） |
| Node.js `fetch` (原生) | HTTP 请求 |

### 下游（依赖本模块）

| 下游 | 接入方式 |
|---|---|
| Claude Desktop | 通过 `claude_desktop_config.json` 中配置 `command` 指向 stdio.ts |
| Claude Code CLI | 通过 MCP client 机制连接本服务 |
| 任何 MCP 兼容客户端 | STDIO 传输协议 |

### 共享数据流

- **认证**：`PAPERCLIP_API_KEY` 作为 Bearer token 注入每个 HTTP 请求
- **Run 追踪**：写操作自动附加 `X-Paperclip-Run-Id` 请求头，值来自 `PAPERCLIP_RUN_ID` 环境变量
- **上下文传递**：`companyId` / `agentId` 可通过工具参数显式传入，或从环境变量 `PAPERCLIP_COMPANY_ID` / `PAPERCLIP_AGENT_ID` 自动补全

---

## 设计要点

1. **工具命名约定**：所有工具以 `paperclip` 前缀开头，在 LLM 的工具选择空间中形成清晰命名空间，避免与其他 MCP 服务工具名冲突。

2. **校验双保险**：输入由 Zod schema 在 `makeTool` 内完成校验，API 返回的 HTTP 错误再由 `formatErrorResponse` 捕获。即使 Zod 校验通过，不当的参数仍会被服务端拒绝并得到清晰的错误消息。

3. **运行时服务生命周期**：workspace runtime 的控制采用"心跳上下文"模式——通过轻量级 `/heartbeat-context` 端点获取运行时快照，而不是拉取完整的 Issue 详情。这在频繁轮询 waitForIssueWorkspaceService 时显著减少服务端负载。

4. **兜底工具 `paperclipApiRequest`**：允许 LLM 直接调用尚未封装为独立 MCP 工具的 Paperclip API 端点。路径校验禁止 `..` 防止路径穿越，且限制为 `/api` 子路径下的请求。

5. **错误区分**：`PaperclipApiError` 携带 HTTP status、method、path 和 body，与普通 JavaScript 异常区分开。LLM 接收到 `{ error, status, method, path }` 结构后可以做出更有针对性的重试或上报决策。
