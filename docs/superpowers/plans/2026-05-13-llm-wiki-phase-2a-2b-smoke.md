# LLM-Wiki Phase 2a + 2b — Smoke Checklist

需 PG（含 pgvector）+ OpenAI/兼容 key + Phase 1a 数据（≥ 5 个 approved knowledge_nodes）。

## 前置

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_EMBEDDING_MODEL="text-embedding-v1"
pnpm dev
```

## 2a-Case 1: 语义检索 happy path

```bash
CID=<existing-company-uuid>
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=database%20deadlock&limit=3" | jq
```

期望：返回 `data.results` 数组，每条含 `id / title / snippet / similarity / freshness_label / final_score`，按 final_score 降序；`search_type=semantic`；`took_ms` 包含。

## 2a-Case 2: 经验路径

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=database&used_for=bug-fix" | jq '.data.search_type, (.data.results | length)'
```

期望：`search_type=semantic+experience`；如果有 used_for 包含 "bug-fix" 的节点，experience_score > 0。

## 2a-Case 3: type / domain 过滤

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=anything&type=rule&domain=general" | jq '.data.results[] | {type, domain: .domain.name}'
```

期望：全部 `type=rule`，`domain.name=general`。

## 2a-Case 4: include_outdated

如果有 valid_until 过期的节点：

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=x&include_outdated=true" | jq '.data.results[] | select(.freshness_label=="outdated")'
```

期望：能看到 freshness_label="outdated" 的节点；默认（无 include_outdated）则不返回。

## 2a-Case 5: 反馈 helped

```bash
NID=<existing-node-uuid>
BEFORE=$(curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=any&limit=10" | jq '.data.results[] | select(.id=="'$NID'") | .trigger_count')
curl -X POST "http://127.0.0.1:3100/api/knowledge/nodes/$NID/feedback?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"feedback":"helped"}'
AFTER=$(curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=any&limit=10" | jq '.data.results[] | select(.id=="'$NID'") | .trigger_count')
echo "before=$BEFORE after=$AFTER"
```

期望：after = before + 1。

## 2a-Case 6: 反馈 outdated → freshness 强制降

```bash
curl -X POST "http://127.0.0.1:3100/api/knowledge/nodes/$NID/feedback?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"feedback":"outdated"}'
curl -s "http://127.0.0.1:3100/api/knowledge/search?companyId=$CID&q=any&include_outdated=true" | jq '.data.results[] | select(.id=="'$NID'") | .freshness_label'
```

期望：`stale_warning` 或 `outdated`（不可能再是 `fresh`）。

## 2b-Case 7: heartbeat-context 注入

```bash
ISSUE_ID=<existing-issue-uuid>
curl -s "http://127.0.0.1:3100/api/issues/$ISSUE_ID/heartbeat-context?companyId=$CID" | jq '.knowledgeNodes | length, .knowledgeNodes[0:2]'
```

期望：`knowledgeNodes` 是数组（≤ 5 条），每条含 SearchResultItem 字段。如果数据库节点很多，count 应 > 0；如果只少量节点且与 issue 主题无关（similarity < 0.75），count 可能为 0（fail-open）。

## 2b-Case 8: retriever 故障 fail-open

临时拔掉 OPENAI_API_KEY 重启 server，再调 heartbeat-context：

```bash
unset OPENAI_API_KEY
pnpm dev &
curl -s "http://127.0.0.1:3100/api/issues/$ISSUE_ID/heartbeat-context?companyId=$CID" | jq '.knowledgeNodes'
```

期望：`knowledgeNodes` 为 `[]`（fail-open），主响应仍 200，server 日志含 warn `knowledge retriever failed in heartbeat-context`。

## 完成判定

| Case | 状态 |
|---|---|
| 2a-Case 1 语义 | ✓ |
| 2a-Case 2 经验 | ✓ |
| 2a-Case 3 type/domain 过滤 | ✓ |
| 2a-Case 4 include_outdated | ✓ |
| 2a-Case 5 helped 反馈 trigger_count+1 | ✓ |
| 2a-Case 6 outdated 反馈 freshness 降 | ✓ |
| 2b-Case 7 heartbeat-context 注入 | ✓ |
| 2b-Case 8 fail-open | ✓ |

≥ 6/8 通过 → Phase 2a + 2b 完成，可进 Phase 2c（Agent tool plugin）或 Phase 3（演化 / Reviewer）。
