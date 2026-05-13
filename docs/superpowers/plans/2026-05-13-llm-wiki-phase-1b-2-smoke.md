# LLM-Wiki Phase 1b-2 — Path C Plugin Smoke Checklist

需 PG (with pgvector) + Phase 1a/1b-1 smoke 已通过 + plugin 已构建。

## 前置

```bash
# 1. 构建 SDK + plugin
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/plugin-knowledge-engine build

# 2. 启动 server（Phase 1a embedding 仍依赖 OpenAI key）
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_EMBEDDING_MODEL="text-embedding-v1"
pnpm dev
```

## 安装 plugin

通过 API 安装（也可走 UI 的 plugin marketplace）：

```bash
CID=<existing-company-uuid>

# 列出可安装的 bundled plugins，应该看到 paperclip.knowledge-engine
curl -sf "http://127.0.0.1:3100/api/plugins/available-examples" | jq

# 触发安装到目标 company
curl -X POST "http://127.0.0.1:3100/api/plugins/install" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$CID\",\"packageName\":\"@paperclipai/plugin-knowledge-engine\"}"
```

## 主路径 case

### Case 1: 直接调 tool execute endpoint

```bash
curl -X POST "http://127.0.0.1:3100/api/plugins/tools/execute" \
  -H "Content-Type: application/json" \
  -d "{
    \"tool\": \"paperclip.knowledge-engine:propose_knowledge_node\",
    \"parameters\": {
      \"title\": \"Use prepared statements to avoid SQL injection\",
      \"content\": \"Always use parameterized queries (prepared statements) instead of string concatenation when building SQL. This prevents SQL injection regardless of input sanitization quality.\",
      \"type\": \"rule\",
      \"level\": \"company\",
      \"business_domain_name\": \"general\",
      \"confidence\": 0.95,
      \"volatility\": \"stable\",
      \"used_for\": [\"backend\", \"security\"]
    },
    \"runContext\": {
      \"agentId\": \"00000000-0000-0000-0000-000000000001\",
      \"runId\": \"00000000-0000-0000-0000-000000000002\",
      \"companyId\": \"$CID\",
      \"projectId\": \"00000000-0000-0000-0000-000000000003\"
    }
  }"
```

**期望**：HTTP 200，response.result.data 含 `{id, status: "pending", preVerdict: null}`。

### Case 2: 验证 draft 落库

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/drafts?companyId=$CID&source=manual" | jq '.data | length'
# → 应 ≥ 1
```

通过调试 UI（`http://127.0.0.1:5173/knowledge/drafts/pending`）能看到该 draft 出现在 pending tab；点 ✓批准 → 走完整 approve / materialize 链路。

### Case 3: 缺少必填字段返回 error

```bash
curl -X POST "http://127.0.0.1:3100/api/plugins/tools/execute" \
  -H "Content-Type: application/json" \
  -d "{
    \"tool\": \"paperclip.knowledge-engine:propose_knowledge_node\",
    \"parameters\": { \"content\": \"only content\" },
    \"runContext\": {\"agentId\":\"00000000-0000-0000-0000-000000000001\",\"runId\":\"00000000-0000-0000-0000-000000000002\",\"companyId\":\"$CID\",\"projectId\":\"00000000-0000-0000-0000-000000000003\"}
  }"
```

**期望**：result.error 包含 "required"。

## 反向 case

- 调一个不存在的 tool 名（`paperclip.knowledge-engine:bogus`）→ 404
- runContext.companyId 不属于安装该 plugin 的 company → 权限拒绝
- 提供错误的 type 枚举（`type: "BANANA"`）→ JSON Schema 校验失败

## 验证 actor 为 system（FK 安全）

```sql
SELECT id, source, source_user_id, source_agent_id, source_run_id
FROM knowledge_drafts
WHERE company_id = '<CID>' AND source = 'manual'
ORDER BY created_at DESC
LIMIT 1;
```

**期望**：`source_user_id IS NULL`，`source_agent_id IS NULL`，`source_run_id` = plugin tool 传入的 runId。

## 完成判定

| Case | 状态 |
|---|---|
| Case 1 主路径 | ✓ 200 + draft 创建 |
| Case 2 落库验证 + UI 可见 | ✓ ≥ 1 条 source=manual |
| Case 3 校验错误 | ✓ error 返回 |
| 反向 case | ✓ 三个都按预期拒绝 |
| Actor FK 安全 | ✓ source_user_id / source_agent_id 双 null |

3/3 主路径 + 3/3 反向 + actor 安全 → Phase 1b-2 完成。

## 注意事项

- Plugin 安装是 per-company 的。每个 fresh 公司都要走一次安装 API
- Plugin worker 是独立子进程；首次安装/启动有几秒冷启动
- Tool 调用走 JSON-RPC over stdio，host 端 capability 校验在 `knowledge.draft.create` 上
