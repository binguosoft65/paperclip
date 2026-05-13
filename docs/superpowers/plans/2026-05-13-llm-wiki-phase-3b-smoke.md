# LLM-Wiki Phase 3b — Reviewer Agent Smoke

需 server 在 3100、≥3 个 status=pending pre_verdict IS NULL 的 draft。

## 前置

```bash
export KNOWLEDGE_REVIEWER_ENABLED=true
export KNOWLEDGE_REVIEWER_INTERVAL_MINUTES=60
# OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_CHAT_MODEL 已配（DashScope qwen-plus）
pnpm dev
```

## Case 1 — 单次触发 + 落库

```bash
CID=<existing-company-uuid>
BEFORE=$(curl -sS "http://127.0.0.1:3100/api/knowledge/drafts?companyId=$CID&status=pending" \
  | jq '[.data[] | select(.preVerdict == null)] | length')
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/reviewer/run?companyId=$CID" \
  -H "Content-Type: application/json" -d '{"limit": 10}' | jq
AFTER=$(curl -sS "http://127.0.0.1:3100/api/knowledge/drafts?companyId=$CID&status=pending" \
  | jq '[.data[] | select(.preVerdict == null)] | length')
echo "未筛 before=$BEFORE after=$AFTER"
```

期望：`response.data.processed > 0`，`after < before`，被处理的 draft 行 preVerdict 三选一
（recommend_approve / recommend_reject / needs_human）。

## Case 2 — 失败兜底（LLM 报错时）

临时把 OPENAI_API_KEY 设为无效，重启 server，再调 reviewer/run。
期望：`processed > 0`，所有处理的 draft 的 preVerdict 都是 `needs_human`、
reasoning 含「LLM 调用失败」或「无法解析」。

## Case 3 — 调度器自动跑

```bash
KNOWLEDGE_REVIEWER_ENABLED=true KNOWLEDGE_REVIEWER_INTERVAL_MINUTES=1 pnpm dev
```

等 1 分钟，查 server 日志含 `reviewer scheduler: company done`。再过 1 分钟再次触发。

> 说明：当前是进程内 setInterval scheduler；后续可升级到正式 Routine 2 触发器（PRD §13.3）。

## Case 4 — UI 徽章 + 一键批量

`http://127.0.0.1:3100/<COMPANY>/knowledge/drafts/pending` →

- 已 screened 的 draft 卡片标题行有彩色 verdict 徽章（emerald=建议通过 / rose=建议驳回 / amber=需人审）
- 折叠 `<details>` 区显示 reasoning + detected_conflicts 列表
- 顶部「触发 Reviewer 初筛」按钮：点击后 toast 提示 `Reviewer 已处理 N 条`
- 顶部「一键通过 recommend_approve (N)」按钮：N 为当前页 verdict=recommend_approve 的 draft 数量；
  点击后所有对应 draft 状态变为 approved 且节点已物化

## Case 5 — 跨公司隔离

用 A 公司 token 调 `/reviewer/run?companyId=<B>` → 401/403（未通过 assertCompanyAccess）。

## 完成判定

| Case | 状态 |
|---|---|
| Case 1 单次触发 + 落库 | ☐ |
| Case 2 失败兜底 needs_human | ☐ |
| Case 3 调度器自动跑 | ☐ |
| Case 4 UI 徽章 + 批量 | ☐ |
| Case 5 跨公司隔离 | ☐ |

≥ 4/5 通过 → Phase 3b 完成；可进 Phase 3a（演化引擎）或 Phase 3c（健康自检）。
