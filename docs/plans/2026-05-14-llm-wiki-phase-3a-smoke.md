# LLM-Wiki Phase 3a — Evolution Engine + 6 Behaviors Smoke

需 server 在 3100、Phase 0-3c 已部署、至少 1 个 company。

## 前置

```bash
# 基础启动 (scheduler off)
pnpm dev

# 或:启动 server 同时启用 in-process scheduler
KNOWLEDGE_EVOLUTION_ENABLED=true \
KNOWLEDGE_EVOLUTION_INTERVAL_MINUTES=10080 \
  pnpm dev
```

```bash
CID=<existing-company-uuid>
# 准备 board session cookie (下面所有 curl 都假设已有有效 session)
```

## Case 1 — 手动触发跑 6 个 behavior

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=$CID" \
  -H "Content-Type: application/json" -d '{}' | jq
```

期望响应:

```json
{
  "data": {
    "behaviorsRun": 6,
    "issuesCreated": <N>,
    "draftsCreated": <M>,
    "nodesModified": <K>,
    "perBehavior": [
      { "behavior": "promotion_check", "candidatesFound": ..., "issuesCreated": ..., "errors": [], "details": { ... } },
      { "behavior": "decay_scan", "candidatesFound": ..., "nodesModified": ..., "errors": [], "details": { "idle_days_threshold": 180 } },
      { "behavior": "merge_candidate_detect", "candidatesFound": ..., "issuesCreated": ..., "errors": [], "details": { "cosine_threshold": 0.9, "top_pairs_limit": 10, "cooldown_days": 7 } },
      { "behavior": "conflict_detect", "candidatesFound": ..., "edgesCreated": ..., "issuesCreated": ..., "errors": [], "details": { "max_drafts_per_tick": 50, "processed_drafts": ... } },
      { "behavior": "freshness_audit", "candidatesFound": ..., "issuesCreated": ..., "errors": [], "details": { "reason_counts": {...} } },
      { "behavior": "pattern_emergence", "candidatesFound": ..., "draftsCreated": ..., "errors": [], "details": { "clusters_processed": ..., "llm_calls": ... } }
    ]
  }
}
```

行为顺序: `promotion_check → decay_scan → merge_candidate_detect → conflict_detect → freshness_audit → pattern_emergence` (PRD §13.3 顺序)。

## Case 2 — decayScan 归档闲置 lesson

```sql
-- Seed: 强制 1 个 active lesson 的 last_triggered 在 200 天前
UPDATE knowledge_nodes
SET last_triggered = NOW() - INTERVAL '200 days', status = 'active'
WHERE company_id = '<CID>' AND type = 'lesson'
ORDER BY id LIMIT 1;
```

触发只跑 decay:

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"behaviors": ["decay_scan"]}' | jq
```

期望: `perBehavior[0].nodesModified >= 1`。

DB 验证:

```sql
SELECT id, status, last_triggered
FROM knowledge_nodes
WHERE company_id = '<CID>' AND status = 'archived'
ORDER BY updated_at DESC LIMIT 5;

SELECT node_id, event_type, metadata
FROM knowledge_node_events
WHERE event_type = 'archived'
ORDER BY created_at DESC LIMIT 5;
```

期望: 至少 1 行 archived 节点 + 1 行 'archived' event with `metadata.reason='auto_decay'`。

## Case 3 — promotionCheck 提案升级 lesson → rule

```sql
-- Seed: lesson + trigger_count=5 + prevention_score=0.85
UPDATE knowledge_nodes
SET trigger_count = 5, prevention_score = 0.85
WHERE company_id = '<CID>' AND type = 'lesson' AND status = 'active'
ORDER BY id LIMIT 1;
```

触发:

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"behaviors": ["promotion_check"]}' | jq
```

期望 `perBehavior[0].issuesCreated >= 1`。

DB 验证:

```sql
SELECT id, title, priority, status
FROM issues
WHERE company_id = '<CID>'
  AND title LIKE '[Evolution:promotion]%'
ORDER BY created_at DESC LIMIT 5;

SELECT metadata->>'last_promotion_proposal_at',
       metadata->>'last_promotion_issue_id'
FROM knowledge_nodes
WHERE company_id = '<CID>' AND trigger_count >= 3
LIMIT 5;
```

期望: 至少 1 个 `[Evolution:promotion]` 标题的 Issue + 节点 metadata 含 `last_promotion_proposal_at` 时间戳。

第二次跑 (同样 seed) → `issuesCreated=0` (7 天 cooldown 生效)。

## Case 4 — freshnessAudit 三条触发路径

```sql
-- Path (a) valid_until 临近 7 天
UPDATE knowledge_nodes
SET valid_until = NOW() + INTERVAL '3 days', status = 'active'
WHERE company_id = '<CID>' AND type IN ('rule', 'fact')
ORDER BY id LIMIT 1;

-- Path (b) volatility=fast + 100 天未验证
UPDATE knowledge_nodes
SET volatility = 'fast', verified_at = NOW() - INTERVAL '100 days', status = 'active'
WHERE company_id = '<CID>'
ORDER BY id OFFSET 1 LIMIT 1;

-- Path (c) volatility=slow + 400 天未验证
UPDATE knowledge_nodes
SET volatility = 'slow', verified_at = NOW() - INTERVAL '400 days', status = 'active'
WHERE company_id = '<CID>'
ORDER BY id OFFSET 2 LIMIT 1;
```

触发:

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"behaviors": ["freshness_audit"]}' | jq
```

期望: `perBehavior[0].details.reason_counts` 三个 reason 至少各 1 + `issuesCreated >= 3` + 标题 `[Evolution:freshness]` 前缀。

## Case 5 — mergeCandidateDetect (pgvector HNSW 索引命中)

需要两个 embedding 相似的 active 节点 (cosine ≥ 0.9)。如果没有,先 seed 两个相似 content 让 embedding 服务自动算 embedding,或手动 INSERT 相近的 vector。

触发:

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"behaviors": ["merge_candidate_detect"]}' | jq
```

期望: `perBehavior[0].issuesCreated >= 1` + 节点 `metadata.last_merge_pair_keys` 含 `"{id_a}:{id_b}"` 形式的 pair_key。

DB 验证:

```sql
SELECT id, metadata->>'last_merge_proposal_at',
       metadata->'last_merge_pair_keys'
FROM knowledge_nodes
WHERE metadata ? 'last_merge_pair_keys'
LIMIT 5;
```

## Case 6 — conflictDetect 物化 Phase 3b detected_conflicts

需要 1 个 draft 含 `detected_conflicts` 非空 + `target_node_id` 已设。Phase 3b reviewer 在跑 LLM 后会填这个数组。

或手动 seed:

```sql
UPDATE knowledge_drafts
SET detected_conflicts = ARRAY['<existing-active-node-uuid>']::uuid[],
    status = 'pending'
WHERE id = '<draft-uuid>' AND company_id = '<CID>';
```

触发:

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"behaviors": ["conflict_detect"]}' | jq
```

期望: `perBehavior[0].edgesCreated >= 1` + `issuesCreated >= 1`。

DB 验证:

```sql
-- 新边
SELECT id, from_node_id, to_node_id, edge_type, auto_generated, metadata
FROM knowledge_edges
WHERE edge_type = 'conflicts_with'
ORDER BY created_at DESC LIMIT 5;

-- draft 数组被清空
SELECT id, detected_conflicts
FROM knowledge_drafts
WHERE id = '<draft-uuid>';
-- expected: detected_conflicts = '{}'
```

## Case 7 — patternEmergence (cosine 图 + union-find + LLM)

需要 ≥ 5 条 lesson 节点共享同一 `(used_for, business_domain_id)` 且互相 cosine ≥ 0.7。

Seed:

```sql
-- 假设已有 5 条 lesson 节点,确保 used_for + business_domain_id 一致
UPDATE knowledge_nodes
SET used_for = 'bug-fix', type = 'lesson', status = 'active'
WHERE company_id = '<CID>'
  AND business_domain_id = (SELECT id FROM business_domains WHERE company_id = '<CID>' LIMIT 1)
ORDER BY id LIMIT 5;
```

触发:

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=$CID" \
  -H "Content-Type: application/json" \
  -d '{"behaviors": ["pattern_emergence"]}' | jq
```

期望: `perBehavior[0].details.llm_calls >= 1` + 要么 `draftsCreated >= 1` (pattern 抽出) 要么 `cooldowns_set >= 5` (LLM 返回 no_pattern)。

DB 验证 (pattern 路径):

```sql
SELECT id, proposed_title, proposed_type, proposed_metadata
FROM knowledge_drafts
WHERE company_id = '<CID>'
  AND proposed_type = 'concept'
  AND proposed_metadata @> '{"is_pattern": true}'::jsonb
ORDER BY created_at DESC LIMIT 5;
```

DB 验证 (cooldown 路径):

```sql
SELECT id, metadata->>'evolution_cooldown_until'
FROM knowledge_nodes
WHERE metadata ? 'evolution_cooldown_until'
LIMIT 5;
```

## Case 8 — Scheduler 自动跑

```bash
KNOWLEDGE_EVOLUTION_ENABLED=true \
KNOWLEDGE_EVOLUTION_INTERVAL_MINUTES=1 \
  pnpm dev
```

期望 server log 立即 + 每 1 分钟出现:

```
[INFO] evolution scheduler: company done { companyId: '<CID>', behaviorsRun: 6, issuesCreated: ..., draftsCreated: ..., nodesModified: ... }
```

> 说明: 当前是进程内 setInterval; 后续可升级到正式 Routine 1 触发器 (PRD §13.3)。

## Case 9 — 跨公司隔离

用 A 公司 board session 调 `?companyId=<B>`:

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/knowledge/evolution/run?companyId=<COMPANY_B_UUID>" \
  -H "Content-Type: application/json" -d '{}' -o /tmp/err.json -w "%{http_code}\n"
```

期望: 401 或 403 (未通过 assertCompanyAccess)。

## 完成判定

| Case | 状态 |
|---|---|
| Case 1 手动触发 6 behaviors | ☐ |
| Case 2 decayScan 归档 | ☐ |
| Case 3 promotionCheck Issue + cooldown | ☐ |
| Case 4 freshnessAudit 三路 | ☐ |
| Case 5 mergeCandidateDetect pgvector | ☐ |
| Case 6 conflictDetect 边 + 清数组 | ☐ |
| Case 7 patternEmergence draft 或 cooldown | ☐ |
| Case 8 Scheduler 自动跑 | ☐ |
| Case 9 跨公司隔离 | ☐ |

≥ 7/9 通过 → Phase 3a 完成;PRD §15 Phase 3 完整闭环 (Phase 3b 已 master + Phase 3c PR #2 + Phase 3a 本 PR)。

## 已知限制 (不在本 phase 范围)

- **Curator Agent 不创建** (decision A): 所有 Issue assignee=null,靠 board operator 手动指派
- **HDBSCAN 退化为 cosine 阈值图 + union-find** (decision B): 无 npm 依赖,但密度感知能力弱于 HDBSCAN
- **conflictDetect 只物化 Phase 3b 已检测的 conflicts** (decision C): 无独立 active-rule scan; v0.2 可加
- **mergeCandidateDetect 无 LLM body 生成**: Issue 仅含基本配对信息;v0.2 可加 LLM 写 merge proposal
- **`last_merge_pair_keys` 无限增长**: 节点 metadata 数组每提案 1 对 +1 条;v0.3 可加保留策略
- **Scheduler interval-based 而非 cron**: PRD §13.3 期望准点 weekly,当前 setInterval 近似 (启动立即跑 + 每 7 天)
- **`source='agent_self_review'`**: patternEmergence draft 用现有 enum 值;v0.2 可加 `evolution_pattern_emergence`
