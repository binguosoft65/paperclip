# LLM-Wiki Phase 3c — Healthcheck + Alarm Smoke

需 server 在 3100、Phase 0-3b 已部署、至少 1 个 company。

## 前置

```bash
# 基础启动(scheduler off)
pnpm dev

# 或: 启动 server 同时启用 in-process scheduler
KNOWLEDGE_HEALTHCHECK_ENABLED=true \
KNOWLEDGE_HEALTHCHECK_INTERVAL_MINUTES=1440 \
  pnpm dev
```

```bash
CID=<existing-company-uuid>
# 准备 board session cookie(下面所有 curl 都假设已有有效 session)
```

## Case 1 — 单次手动触发 + 6 行 metric 写入

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=$CID" \
  -H "Content-Type: application/json" -d '{}' | jq
```

期望响应：

```json
{ "data": { "metricsComputed": 6, "alarmsCreated": <N> } }
```

DB 验证：

```sql
SELECT metric_name, metric_value, status, computed_at
FROM knowledge_metrics
WHERE company_id = '<CID>'
ORDER BY computed_at DESC
LIMIT 6;
```

期望 6 行，每个 metric_name 一行（`weekly_new_drafts` / `review_backlog_hours_p50` / `helped_ratio` / `avg_edges_per_node` / `unresolved_conflicts` / `stale_unchecked_fast`），`computed_at` 几秒内。

## Case 2 — 制造 critical 状况触发 alarm Issue

最容易制造的 critical：清空 drafts，让 `weekly_new_drafts = 0`：

```sql
-- 先备份(可选)
CREATE TEMP TABLE tmp_drafts_backup AS
SELECT * FROM knowledge_drafts WHERE company_id = '<CID>' AND created_at > NOW() - INTERVAL '7 days';

-- 暂时移走过去 7 天的 drafts
UPDATE knowledge_drafts SET created_at = created_at - INTERVAL '30 days'
WHERE company_id = '<CID>' AND created_at > NOW() - INTERVAL '7 days';
```

再跑 healthcheck：

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=$CID" \
  -H "Content-Type: application/json" -d '{}' | jq
```

期望响应：`alarmsCreated >= 1`。

验证 Issue 创建：

```sql
SELECT id, title, status, priority, created_at
FROM issues
WHERE company_id = '<CID>'
  AND title LIKE '[LLM-Wiki Health]%'
ORDER BY created_at DESC LIMIT 5;
```

期望：至少 1 行新 Issue，标题包含 `weekly_new_drafts = 0 (critical)`，priority=`high`，status=`todo`。

description 应含 metric 名 + value + 阈值描述 + computed_at + details JSON + plan reference。

## Case 3 — Dedup: 第二次跑同状态不重复创建

立刻再调一次（不改 metric 数据）：

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=$CID" \
  -H "Content-Type: application/json" -d '{}' | jq
```

期望响应：`alarmsCreated = 0`（dedup 生效——上次已是 critical，本次还是 critical 不创建新 Issue）。

DB 验证：刚才查的 Issue 表行数不变（仍是上次的 N 行）。

`knowledge_metrics` 表会多写 6 行（每次跑都写一遍历史用于 dashboard 趋势图）。

## Case 4 — 状态恶化触发新 alarm

恢复 weekly_new_drafts 到 healthy（手动 INSERT 1 条 draft 或恢复 drafts 时间戳），让 metric 重新跑：

```sql
-- 恢复 Case 2 移走的 drafts(让 weekly_new_drafts > 0)
UPDATE knowledge_drafts SET created_at = created_at + INTERVAL '30 days'
WHERE company_id = '<CID>' AND created_at < NOW() - INTERVAL '7 days'
  AND created_at > NOW() - INTERVAL '37 days';
```

跑一次让 status 切回 healthy（不发 alarm）：

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=$CID" \
  -d '{}' -H "Content-Type: application/json" | jq
# 期望 alarmsCreated = 0(healthy→healthy 不发,critical→healthy 也不发,这里 critical→healthy)
```

再次清空 drafts:

```sql
UPDATE knowledge_drafts SET created_at = created_at - INTERVAL '30 days'
WHERE company_id = '<CID>' AND created_at > NOW() - INTERVAL '7 days';
```

跑一次（healthy→critical 应该发 alarm）：

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=$CID" \
  -d '{}' -H "Content-Type: application/json" | jq
```

期望响应：`alarmsCreated >= 1`（新 alarm 因为 status 恶化）。

DB 验证：又多 1 条 `[LLM-Wiki Health] weekly_new_drafts...` Issue。

## Case 5 — opts.metrics 子集请求

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"metrics": ["weekly_new_drafts", "helped_ratio"]}' | jq
```

期望响应：`metricsComputed = 2`。

DB 验证（最新一批）：

```sql
SELECT metric_name FROM knowledge_metrics
WHERE company_id = '<CID>'
ORDER BY computed_at DESC LIMIT 2;
```

期望：刚好 2 行，名字是 `weekly_new_drafts` 和 `helped_ratio`。

错误用例：

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"metrics": ["bogus_metric"]}' -o /tmp/err.json -w "%{http_code}\n"
# 期望 400
cat /tmp/err.json | jq
```

## Case 6 — Scheduler 自动跑

启动 server 时启用 scheduler + 短间隔：

```bash
KNOWLEDGE_HEALTHCHECK_ENABLED=true \
KNOWLEDGE_HEALTHCHECK_INTERVAL_MINUTES=1 \
  pnpm dev
```

期望 server log 立即（启动时 tick）+ 1 分钟后再次出现：

```
[INFO] healthcheck scheduler: company done { companyId: '<CID>', metricsComputed: 6, alarmsCreated: 0 }
```

DB 验证：每 1 分钟 `knowledge_metrics` 多 6 行（× company 数）。

> 说明：当前是进程内 setInterval；后续可升级到正式 Routine 3 触发器（PRD §13.3）。

## Case 7 — 跨公司隔离

用 A 公司 board session 调 `?companyId=<B>`：

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/healthcheck/run?companyId=<COMPANY_B_UUID>" \
  -H "Content-Type: application/json" -d '{}' -o /tmp/err.json -w "%{http_code}\n"
```

期望：401 或 403（未通过 assertCompanyAccess）。

## 完成判定

| Case | 状态 |
|---|---|
| Case 1 手动触发 + 6 行 metric 写入 | ☐ |
| Case 2 critical 触发 alarm Issue | ☐ |
| Case 3 dedup 不重复创建 | ☐ |
| Case 4 状态恶化触发新 alarm | ☐ |
| Case 5 opts.metrics 子集 + 400 错误 | ☐ |
| Case 6 Scheduler 自动跑 | ☐ |
| Case 7 跨公司隔离 | ☐ |

≥ 6/7 通过 → Phase 3c 完成；可进 Phase 3a（演化引擎）或 Phase 4（Web UI）。

## 已知限制（不在 smoke 范围）

- **`unresolved_conflicts` 永远 healthy** —— 因为 maintainer 决定 3A：Phase 3a 落地前一律 source-unavailable 兜底。这是预期行为，不是 bug。
- **`/knowledge/dashboard` 读 metrics API** —— Phase 4 UI scope；当前只能用 SQL 直接查 `knowledge_metrics`。
- **沉默检测 / Routine 1/2 失败重试告警** —— v0.2 follow-up，本 phase 不实现。
- **`knowledge_metrics` 历史 90 天清理** —— 留待单独 Routine。
