# LLM-Wiki Phase 1a — End-to-End Smoke Checklist

需 docker（pgvector/pgvector:pg17）+ 有效 OPENAI_API_KEY。

## 前置

```bash
docker compose down -v && docker compose up -d db
pnpm --filter @paperclipai/db build && pnpm db:migrate
pnpm dev &
```

## 5 个 smoke case

### 1. 创建 draft（manual + 普通用户）

```bash
COMPANY_ID=<existing-company-uuid>
curl -X POST "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"测试 lesson","content":"避免在事务里调外部 API","type":"lesson","level":"project","business_domain_name":"general","confidence":0.7}'
```

期望：201，返回 `data.id` + `status=pending`。

### 2. 列表与详情

```bash
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID"
DRAFT_ID=<from-list>
curl "http://localhost:3100/api/knowledge/drafts/$DRAFT_ID?companyId=$COMPANY_ID"
```

期望：列表含刚才创建的 draft；详情返回完整字段。

### 3. 批准 draft → 物化

```bash
curl -X POST "http://localhost:3100/api/knowledge/drafts/$DRAFT_ID/approve?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"review_notes":"approved"}'
```

期望：200，返回 `data.node_id`。

```bash
docker compose exec db psql -U paperclip -d paperclip -c "SELECT id, title, type FROM knowledge_nodes ORDER BY created_at DESC LIMIT 1"
docker compose exec db psql -U paperclip -d paperclip -c "SELECT event_type, node_id FROM knowledge_node_events ORDER BY created_at DESC LIMIT 1"
```

期望：knowledge_nodes 有刚才物化的节点（embedding 不为 null），events 表有 `created` 事件。

### 4. 创建含 [[uuid]] 的 draft → approve → 检查 edges

```bash
EXISTING_NODE_ID=<from-step-3>
curl -X POST "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"引用测试\",\"content\":\"参考 [[$EXISTING_NODE_ID]] 的做法\",\"type\":\"decision\",\"level\":\"project\",\"business_domain_name\":\"general\"}"

curl -X POST "http://localhost:3100/api/knowledge/drafts/<new-draft-id>/approve?companyId=$COMPANY_ID" -d '{}' -H "Content-Type: application/json"

docker compose exec db psql -U paperclip -d paperclip -c "SELECT from_node_id, to_node_id, edge_type, auto_generated FROM knowledge_edges WHERE edge_type='references'"
```

期望：edges 表有一条 references 边，auto_generated=true。

### 5. skip_review=true（admin 立即落地）

开发模式下 local_implicit 默认就是 admin：

```bash
curl -X POST "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"admin直写","content":"x","type":"fact","level":"company","business_domain_name":"general","skip_review":true}'
```

期望：201，返回的 data 含 `status=approved` + `node_id`，对应 node 立刻在 knowledge_nodes 表里。

## 反向 case

- POST drafts 时 `business_domain_name` 不存在：422
- approve 一个 status=approved 的 draft：409
- 非 admin 用 skip_review=true：403
- agent 调 approve 端点：403

5/5 + 4/4 通过 → Phase 1a 完成。
