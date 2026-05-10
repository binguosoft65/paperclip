# Routines 模块 —— 定时任务模板与自动化调度

## 模块概述

Routines 模块提供**可定时执行的任务模板**机制。Routine 本质上是一个"预配置的执行模板"：定义了标题、描述、执行人、变量和后，可由**定时触发器（schedule）**、**Webhook** 或 **API 调用**触发，每次触发创建一个 `RoutineRun` 并关联一个 `Issue` 作为执行单元。

### 核心能力

- **多源触发**：支持 schedule（cron 表达式）、webhook（HMAC 签名验证）、manual（手动点击）、API 四种触发方式
- **变量模板系统**：在标题/描述中使用 `{{variable_name}}` 占位符，运行时自动填充或提示用户输入
- **版本快照与历史回滚**：每次变更（routine 属性或 trigger 增删改）自动创建版本快照（Revision），支持查看历史记录和回滚
- **并发控制**：三种策略（coalesce/skip/always_enqueue）决定当已有活跃 execution issue 时如何处理新触发
- **追赶策略**：针对 schedule 类型的漏触发恢复（skip_missed / enqueue_missed_with_cap）
- **Webhook 安全**：支持 bearers token、HMAC-SHA256（含防重放时间戳）、GitHub HMAC、无签名四种模式
- **活动日志**：所有 routine 操作自动记录活动日志，支持审计追踪
- **幂等性**：通过 `idempotencyKey` 防止重复触发

---

## 核心流程

### Routine 生命周期

```
draft → active ↔ paused → archived
```

- **draft（草稿）**：刚创建但未指定默认 agent，不会自动执行
- **active（活跃）**：scheduler 会轮询该 routine 的 schedule trigger 并触发执行
- **paused（暂停）**：停止自动触发，但配置保留
- **archived（归档）**：终态，取消激活不可再触发

### 触发执行流程

```
触发源 (schedule/webhook/manual/api)
    │
    ▼
dispatchRoutineRun()
    │
    ├─ 1. SELECT FOR UPDATE 锁定 routine 行（防并发）
    ├─ 2. 幂等性检查（idempotencyKey）
    ├─ 3. 创建 RoutineRun（status: "received"）
    ├─ 4. 并发控制检查：
    │   ├─ coalesce_if_active + 已有活跃 issue → 合并到已有 issue
    │   ├─ skip_if_active + 已有活跃 issue → 跳过，标记 skipped
    │   └─ always_enqueue / 无活跃 issue → 创建新的 execution issue
    ├─ 5. 创建 Issue（originKind="routine_execution"）
    ├─ 6. 触发 Heartbeat 唤醒（queueIssueAssignmentWakeup）
    ├─ 7. 更新 RoutineRun 状态为 "issue_created"
    └─ 8. 更新 trigger 的 nextRunAt / lastResult
```

### Scheduler 轮询流程

```
tickScheduledTriggers(now)
    │
    ├─ 查询所有满足条件的 trigger：
    │   kind=schedule, enabled=true, 关联routine=active, nextRunAt<=now
    │
    └─ 对每个 due trigger:
        ├─ 计算下一次触发时间（时区感知）
        ├─ catchUpPolicy === "enqueue_missed_with_cap"
        │   └─ 从上次计划时间开始逐个 tick 追赶，最多 25 次
        ├─ Compare-and-swap 认领（乐观锁防多实例竞争）
        └─ 对每个认领的 tick 调用 dispatchRoutineRun()
```

---

## 数据模型

### routines 表（核心表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid (PK) | 主键 |
| `company_id` | uuid (FK -> companies) | 所属公司 |
| `project_id` | uuid? (FK -> projects) | 关联项目 |
| `goal_id` | uuid? (FK -> goals) | 关联目标 |
| `parent_issue_id` | uuid? (FK -> issues) | 父级 issue |
| `title` | text | 模板标题（支持 `{{variable}}`） |
| `description` | text? | 模板描述（支持 `{{variable}}`） |
| `assignee_agent_id` | uuid? (FK -> agents) | 默认执行 agent |
| `priority` | text | 优先级：low / medium / high / urgent |
| `status` | text | 生命周期：draft / active / paused / archived |
| `concurrency_policy` | text | 并发策略：coalesce_if_active / skip_if_active / always_enqueue |
| `catch_up_policy` | text | 追赶策略：skip_missed / enqueue_missed_with_cap |
| `variables` | jsonb | 变量定义列表 `RoutineVariable[]` |
| `latest_revision_id` | uuid? (FK -> routine_revisions) | 当前最新 revision ID |
| `latest_revision_number` | integer | 当前最新 revision 编号 |

### routine_triggers 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid (PK) | 主键 |
| `kind` | text | schedule / webhook |
| `cron_expression` | text? | cron 表达式（schedule 类型适用） |
| `timezone` | text? | IANA 时区（schedule 类型适用） |
| `public_id` | text? | Webhook 公开 ID（作为 URL 中的 secret） |
| `secret_id` | uuid? (FK -> company_secrets) | Webhook 密钥引用 |
| `signing_mode` | text? | bearer / hmac_sha256 / github_hmac / none |
| `replay_window_sec` | integer? | 防重放窗口（秒，默认 300） |
| `next_run_at` | timestamptz? | 下次计划触发时间 |
| `last_fired_at` | timestamptz? | 上次触发时间 |
| `last_result` | text? | 上次触发结果描述 |
| `enabled` | boolean | 是否启用 |

### routine_runs 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid (PK) | 主键 |
| `source` | text | schedule / manual / api / webhook |
| `status` | text | 状态流转：received → issue_created / coalesced / skipped / completed / failed |
| `idempotency_key` | text? | 幂等键 |
| `dispatch_fingerprint` | text? | 触发内容的 SHA256 指纹，用于并发去重判断 |
| `linked_issue_id` | uuid? (FK -> issues) | 关联的 execution issue |
| `coalesced_into_run_id` | uuid? (FK -> routine_runs) | 合并到的目标 run |
| `trigger_payload` | jsonb? | 触发时的原始 payload |
| `failure_reason` | text? | 失败原因（status=failed 时） |

### routine_revisions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid (PK) | 主键 |
| `revision_number` | integer | 版本号（从 1 开始递增） |
| `snapshot` | jsonb | 完整快照（routine + triggers 的当时状态） |
| `change_summary` | text? | 变更原因描述 |
| `restored_from_revision_id` | uuid? | 回滚来源 revision ID |

---

## 并发控制策略详解

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| `coalesce_if_active`（默认） | 存在活跃 execution issue 时，不创建新 issue，仅将本次触发记录合并到已有 issue | 常规定时任务：不希望重复创建 issue，但又不希望丢失触发记录 |
| `skip_if_active` | 存在活跃 issue 时，跳过本次触发，run 状态标记为 skipped | 数据采集类任务：最新一次触发的结果会覆盖前面，无需多次执行 |
| `always_enqueue` | 无论是否存在活跃 issue，总是创建新的 execution issue | 每次触发都必须独立执行的关键任务 |

## 追赶策略详解

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| `skip_missed`（默认） | scheduler 发现 nextRunAt 已过期时，直接计算下次时间，不补执行 | 常规场景，错过就错过 |
| `enqueue_missed_with_cap` | 从上次计划时间开始逐个 tick 触发，最多补 25 次 | 数据同步任务：错过的时间窗口需要逐个补跑 |

---

## Webhook 签名模式

| 模式 | 验证方式 | 防重放 | 典型用途 |
|------|----------|--------|----------|
| `bearer` | Authorization: Bearer `<secret>` | 否 | 简单 API 调用 |
| `hmac_sha256` | HMAC-SHA256(body)，带时间戳签名 `timestamp.body` | 是（replayWindowSec） | 通用 webhook |
| `github_hmac` | HMAC-SHA256(body)，兼容 X-Hub-Signature-256 | 否 | GitHub / Sentry webhook |
| `none` | 仅靠 URL 中的 publicId 鉴权 | 否 | 内部调试 |

---

## 变量系统

### 变量类型

| 类型 | 说明 | 前端控件 |
|------|------|----------|
| `text` | 单行文本 | HTML input |
| `textarea` | 多行文本 | HTML textarea |
| `number` | 数字 | HTML input number |
| `boolean` | 布尔值 | 开关/下拉选择 true/false |
| `select` | 枚举选择 | 下拉选择器 |

### 内置变量

| 变量名 | 示例值 | 说明 |
|--------|--------|------|
| `{{date}}` | 2026-05-10 | 触发时的当前日期（UTC，YYYY-MM-DD） |
| `{{timestamp}}` | May 10, 2026 at 12:00 PM UTC | 触发时的可读时间（UTC） |

### 变量解析优先级

1. **自动注入变量**（如 workspace_branch）：系统自动填充，调用方无法覆盖
2. **用户提供值**（payload 中的变量字段或显式传入的 variables 参数）
3. **默认值**（variable.defaultValue）作为兜底

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `packages/shared/src/types/routine.ts` | 类型定义（Routine / RoutineTrigger / RoutineRun / RoutineRevision 等） |
| `packages/shared/src/routine-variables.ts` | 变量插值引擎：检测 `{{var}}`、同步变量列表、插值替换 |
| `packages/shared/src/constants.ts` | 枚举常量（并发策略、追赶策略、trigger kind、signing mode 等） |
| `server/src/services/routines.ts` | 核心业务逻辑（~2300 行）：CRUD、dispatch、并发控制、scheduler tick、webhook 验证 |
| `server/src/services/cron.ts` | Cron 表达式解析器与 next-run 计算工具 |
| `server/src/routes/routines.ts` | Express 路由与权限控制（board/agent 的角色权限校验） |
| `ui/src/pages/Routines.tsx` | Routine 列表页：创建、排序、分组、批量操作 |
| `ui/src/pages/RoutineDetail.tsx` | Routine 详情页：编辑配置、管理 trigger、查看运行记录和历史 |
| `ui/src/components/ScheduleEditor.tsx` | 调度编辑器：预设模式和自定义 cron 表达式 |
| `ui/src/components/RoutineVariablesEditor.tsx` | 变量编辑器：检测 `{{var}}`、配置类型/默认值/必填 |
| `ui/src/components/RoutineRunVariablesDialog.tsx` | 手动运行时变量填写弹窗 |

---

## 上下游依赖

### 上游（调用 Routines 的模块）

- **Scheduler 系统**：定时调用 `tickScheduledTriggers()` 轮询到期的 schedule trigger
- **External Webhook 调用方**：如 GitHub、Sentry 等发送 webhook 请求到 `/routine-triggers/public/:publicId/fire`
- **Board UI / API**：用户通过界面或 REST API 手动创建/编辑/触发 routine
- **Plugin 系统**：插件可通过 `pluginManagedResources` 注册托管 routine

### 下游（Routines 调用的模块）

- **Issues 模块**：execution issue 的创建、状态同步
- **Heartbeat 模块**：通过 `queueIssueAssignmentWakeup` 触发 agent 唤醒
- **Activity Log 模块**：记录 routine 和 trigger 的变更活动
- **Secrets 模块**：管理 webhook trigger 的签名密钥
- **Execution Workspace 模块**：读取 workspace branch 信息用于变量注入
- **Telemetry 模块**：记录 routine 创建和运行的统计事件
- **Access Control 模块**：校验用户权限（tasks:assign）

---

## 边界条件与业务规则

1. **Agent 权限隔离**：agent 只能管理分配给自己的 routine，不可越权操作其他 agent 的 routine
2. **Schedule 触发器要求**：定时触发的 routine 所有 required 变量必须有默认值（否则无法自动执行）
3. **Active 状态依赖**：只有有默认执行 agent 的 routine 才能进入 active 状态
4. **Revision 快照**：所有变更（routine 属性/trigger 增删改/secret 轮换）都生成新 revision，旧 revision 保留用于回滚
5. **分布式锁**：scheduler 认领 trigger 使用乐观锁（compare-and-swap on nextRunAt），支持多实例部署
6. **唯一约束双重保障**：并发控制同时使用应用层检查（findLiveExecutionIssue）和数据库层唯一约束（issues_open_routine_execution_uq）
7. **Webhook 密钥一次展示**：创建/轮换 webhook trigger 时，密钥只在响应中返回一次，不持久化存储原始值
