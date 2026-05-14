# LLM-Wiki Phase 1b-1 — End-to-End Smoke Checklist

需 PG (with pgvector) + 有效 OPENAI_API_KEY + Phase 1a smoke 已通过（库里有 company + business_domains.general）。

## 前置

```bash
# DB（已通过 Phase 1a 跑过 migration 即可）
pnpm db:migrate

# 启动 server（带 chat key + base url）
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_EMBEDDING_MODEL="text-embedding-v1"
export OPENAI_CHAT_MODEL="qwen-plus"
pnpm dev
```

`OPENAI_CHAT_MODEL=qwen-plus` 用阿里云百炼的 chat（成本约 ¥0.001/调用）。也可以换成 `qwen-turbo`（更便宜）/ `gpt-4o-mini`（如果用 OpenAI 官方）。

## 4 个 trigger case

### Path A: issue → done

```bash
COMPANY_ID=<existing-company-uuid>

# 1. 建 issue
ISSUE_ID=$(curl -s -X POST "http://localhost:3100/api/issues?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"Smoke 1b-1 issue","description":"测试 task_complete 触发"}' \
  | jq -r .id)
echo "issue=$ISSUE_ID"

# 2. 标 done
curl -X PATCH "http://localhost:3100/api/issues/$ISSUE_ID?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" -d '{"status":"done"}'

# 3. 等 3 秒（异步 LLM）后查 drafts
sleep 3
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=agent_self_review" | jq
```

**期望**：drafts 列表 ≥ 1 条，每条 `source=agent_self_review`，`source_issue_id=$ISSUE_ID`，proposed_content 包含与 issue 描述相关的内容。

**容错**：LLM 觉得没什么可记的 → 返回空数组也是正常（fact: 用 "测试" 这种 placeholder 内容，LLM 可能拒绝写）。这种时候改 issue 描述写真实的工作内容再测。

---

### Path B-1: issue 被 reopen

```bash
# 续上面：把刚才 done 的 issue 改回 in_progress
curl -X PATCH "http://localhost:3100/api/issues/$ISSUE_ID?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" -d '{"status":"in_progress"}'

sleep 3
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=failure_signal" | jq '.data[] | select(.source_issue_id == "'$ISSUE_ID'")'
```

**期望**：返回 ≥ 0 条相关 draft（同 Path A 容错说明：LLM 觉得无可记则空）。`source=failure_signal`。

---

### Path B-2: approval rejected

```bash
# 建一个 pending approval
APPROVAL_ID=$(curl -s -X POST "http://localhost:3100/api/approvals?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"type":"deploy","payload":{"scope":"test deploy too risky"}}' | jq -r .id)
echo "approval=$APPROVAL_ID"

# reject 它
curl -X POST "http://localhost:3100/api/approvals/$APPROVAL_ID/reject?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote":"production-grade testing not allowed in this scope"}'

sleep 3
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=failure_signal" | jq '.data[] | select(.proposed_content | test("approval|reject|deploy|risky"; "i"))'
```

**期望**：找到 ≥ 0 条相关 draft（LLM 可能觉得就一句 decisionNote 没值得 sediment 的；调高 decisionNote 信息量可触发）。

---

### Path B-3: run cancel

```bash
# 从 /api/heartbeat/runs 找一个 running 的 run
RUN_ID=$(curl -s "http://localhost:3100/api/heartbeat/runs?companyId=$COMPANY_ID&status=running" | jq -r '.data[0].id // empty')

if [ -z "$RUN_ID" ]; then
  echo "需要先有一个 running 的 run。可以通过 Web UI 触发一个 agent 任务再来跑这个 case。"
else
  curl -X POST "http://localhost:3100/api/heartbeat/runs/$RUN_ID/cancel?companyId=$COMPANY_ID"
  sleep 3
  curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=failure_signal" | jq '.data[] | select(.source_run_id == "'$RUN_ID'")'
fi
```

**期望**：找到 0-N 条相关 draft。无 running run 时这个 case 跳过（不影响其他 case 验收）。

---

## 反向验证（确保 drafter 失败不阻塞主流程）

### Case R1: 无 OPENAI_API_KEY

```bash
# 杀掉 dev server，重启但不带 OPENAI_API_KEY
unset OPENAI_API_KEY
pnpm dev &
sleep 5

# 标 issue done
curl -X PATCH "http://localhost:3100/api/issues/$ANOTHER_ISSUE_ID?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" -d '{"status":"done"}'
# → 期望：endpoint 返回 200（主流程不阻塞）

# 查 dev.log
tail -20 logs/dev.log | grep -i "knowledge drafter failed"
# → 期望：出现 warning 行，主流程未挂
```

### Case R2: chat model 错的 / base url 错的

```bash
export OPENAI_CHAT_MODEL="nonexistent-model"
pnpm dev &
# 同上：触发 issue done → 主流程 200，dev.log 出 drafter warning
```

### Case R3: drafter 单条失败不阻断（业务域 NULL 不存在的）

如 LLM 返回了 `business_domain_name: "nonexistent-domain"`，drafter 内部 create 会失败 → drafter 内部 try/catch 跳过这条，其他条继续。
SQL 验证：

```sql
SELECT count(*) FROM knowledge_drafts WHERE proposed_business_domain_id IS NULL;
-- 应为 0（drafter 不会写入半完成 draft）
```

---

## 完成判定

| Case | 状态 |
|---|---|
| Path A: task_complete | ✓ 主流程 200 + drafter 异步执行（结果 0-N） |
| Path B-1: issue_reopened | ✓ 同上 |
| Path B-2: approval_rejected | ✓ 同上 |
| Path B-3: run_cancelled | ✓ 同上（或 N/A 当无 running run） |
| R1: 缺 key 不阻塞 | ✓ 主流程 200 + dev.log warn |
| R2: 错 model 不阻塞 | ✓ 同 R1 |
| R3: 单条失败不阻断 | ✓ DB 无半完成 draft |

3/4 主路径触发 + 3/3 反向 case → Phase 1b-1 完成，可开 Phase 1b-2（Path C plugin）。

## 性能 / 成本注意

- 每个 trigger 调一次 chat completion（DashScope qwen-plus 约 ¥0.001-0.003/次）
- prompt + context 约 500-2000 tokens；JSON 输出 100-500 tokens
- 4 个触发点高频时段日累计预估 < ¥10
- 如果发现 LLM 输出质量低（drafts 全是无意义内容），可在 `knowledge-drafter.ts` 调高 `temperature` 或换 `qwen-max`
