# Dashboard 模块文档

## 模块概述

Dashboard 模块提供公司级运维概览，整合 Agent 状态、任务进度、费用统计、运行活动、预算告警和实时监控等信息。它是 Paperclip 运营人员查看系统健康状态和业务进展的入口页面。

### 核心职责

1. **聚合数据展示** — 汇总 Agent、Issue、费用、审批等多维度数据，以指标卡和图表形式呈现
2. **实时运行监控** — 展示当前正在执行的 Agent Run 及其会话日志，支持手动取消 Run
3. **活动日志推送** — 通过 SSE（Server-Sent Events）实时推送业务活动，前端轮询补偿
4. **预算告警** — 显示预算违规事件及影响的 Agent/Project 数量
5. **看门狗调度** — 心跳机制定时唤醒 Agent，调度排队中的 Run 执行
6. **生产力审查** — 自动检测 Agent 工作效率异常并创建 Review Issue

---

## 页面结构

```
Dashboard（概览页）
├── ActiveAgentsPanel — 活跃 Agent 面板
├── Metric Cards — 四个关键指标
│   ├── Agent 总数（active + running + paused + error）
│   ├── 进行中任务数
│   ├── 月度费用（含预算利用率）
│   └── 待审批数（人工审批 + 预算审批）
├── Charts — 四个趋势图
│   ├── Run Activity — 每日运行活动（成功/失败/其他）
│   ├── Issues by Priority — 任务优先级分布
│   ├── Issues by Status — 任务状态分布
│   └── Success Rate — 每日运行成功率
├── Plugin Slot — dashboardWidget 插件插槽
├── Recent Activity — 最近 10 条活动日志（含新增动画）
└── Recent Tasks — 最近更新任务列表

DashboardLive（实时仪表盘）
└── ActiveAgentsPanel（增强版）— 每个 Agent 的运行卡片，含实时会话日志
```

---

## 核心流程

### 1. 仪表盘数据聚合

```
前端请求 GET /companies/:id/dashboard
  └── dashboardService.summary(companyId)
       ├── 查询 Company 基本信息
       ├── 按 status 分组统计 Agents
       │   └── idle → active（归入活跃类别）
       ├── 按 status 分组统计 Issues
       ├── 统计待审批数量（approvals.status = 'pending'）
       ├── 统计月度费用（costEvents 当月累加）
       ├── 统计最近 14 天运行活动（按日期 + 状态分组）
       └── 查询预算概览（活跃事件、待审批、暂停数量）
```

**数据一致性策略：** 多次独立查询而非事务快照。Dashboard 数据对实时性要求不高，弱一致性可接受。前端每 30 秒重新请求刷新。

### 2. 心跳机制（Watchdog）

```
外部调度器调用 heartbeatService.tickTimers()
  └── 遍历所有 Agent
       ├── 跳过 paused/terminated/pending_approval 状态的 Agent
       ├── 检查心跳间隔：lastHeartbeatAt + intervalSec <= now
       ├── 调用 enqueueWakeup() 创建 WakeupRequest
       └── enqueueWakeup 内部：
            ├── 丰富 contextSnapshot（添加 issueId、wakeReason 等）
            ├── 检查预算限制（budgetService.getInvocationBlock）
            ├── 验证 Agent 状态和策略
            ├── 创建 WakeupRequest 记录
            └── 触发 startNextQueuedRunForAgent()

startNextQueuedRunForAgent(agentId)
  └── withAgentStartLock(agentId)  // 防止并发启动
       ├── 检查并发槽位（maxConcurrentRuns - runningCount）
       ├── 从队列取出排队中的 Run
       ├── 按照依赖就绪 > 进行中 Issue > 优先级 > 创建时间 排序
       ├── claimQueuedRun() — 乐观锁状态变更 queued → running
       └── executeRun(runId) — 启动 adapter 进程

executeRun(runId)
  ├── claimRun（queued → running）
  ├── 通过 adapter 启动 Agent 子进程
  ├── 监控输出并实时写入日志存储 + SSE 推送
  ├── 子进程结束后解析 resultJson
  ├── 计算费用（costEvents）
  ├── 判断活跃度（run-liveness classifier）
  └── 根据结果决定：完成 / 续作（continuation）/ 重试（retry）
```

### 3. 实时事件推送

```
logActivity() 写数据库
  └── publishLiveEvent() — 通过 EventEmitter 推送到 SSE 通道
       └── SSE 端点 (subscribeCompanyLiveEvents) — 推送到前端
  └── publishPluginDomainEvent() — 转发到插件系统
```

**回退策略：** SSE 连接可能因网络问题中断。前端使用 React Query 的 refetchInterval（3-30 秒）作为轮询补偿，确保即使 SSE 掉线也不会漏掉数据。

### 4. Run 重试策略（Bounded Retry）

```
失败原因分类（inferHeartbeatRunStopReason）:
├── completed — 正常完成，无重试
├── timeout — 超时，可能触发续作
├── max_turns_exhausted — 轮次耗尽，触发续作
├── process_lost — 进程丢失，触发有界重试
├── budget_paused / paused — 预算/手动暂停，不重试
├── cancelled — 手动取消，不重试
└── adapter_failed — adapter 错误，通常不可恢复

有界重试递进延迟:
  Attempt 1: 2min  (±25% jitter)
  Attempt 2: 10min (±25% jitter)
  Attempt 3: 30min (±25% jitter)
  Attempt 4: 2h    (±25% jitter)
  超过最大次数后标记为"重试耗尽"，不再自动重试。
```

### 5. 生产力审查

```
reconcileProductivityReviews()
  └── 扫描所有进行中的 Issue（排除已隐藏、已取消、自身就是 Review Issue 的）
       ├── 按 updatedAt 排序，每次最多处理 250 个候选
       ├── 跳过：近期已解决的 / 已经创建 Review 的 / 无 assigneeAgent 的
       ├── collectEvidence() 收集证据
       │   ├── 最近的 Run 列表（最多 100 条）
       │   ├── 连续无评论 Run 计数（noCommentStreak）
       │   ├── 最近 1h / 6h 的 Run 数和评论数
       │   ├── 费用统计
       │   └── 运行时长
       ├── 判断触发类型：
       │   ├── no_comment_streak ≥ 10 次连续无评论 Run
       │   ├── long_active_duration ≥ 6 小时持续活跃
       │   └── high_churn ≥ 10/h 或 ≥ 30/6h 的 Run 数或评论数
       ├── 创建/更新 Review Issue
       └── 通知负责人（enqueueWakeup）
```

---

## 关键文件

| 文件 | 职责 | 关键函数/组件 |
|------|------|---------------|
| `server/src/routes/dashboard.ts` | Dashboard API 路由 | `dashboardRoutes()` — 注册 GET /companies/:id/dashboard |
| `server/src/services/dashboard.ts` | 聚合数据服务 | `dashboardService.summary()` — 生成仪表盘摘要 |
| `server/src/services/heartbeat.ts` | 心跳机制（核心） | `tickTimers()`, `enqueueWakeup()`, `executeRun()`, `startNextQueuedRunForAgent()`, `claimQueuedRun()`, `scheduleBoundedRetryForRun()`, `resumeQueuedRuns()`, `promoteDueScheduledRetries()` |
| `server/src/services/heartbeat-run-summary.ts` | Run 结果摘要处理 | `mergeHeartbeatRunResultJson()`, `summarizeHeartbeatRunResultJson()`, `buildHeartbeatRunIssueComment()` |
| `server/src/services/heartbeat-stop-metadata.ts` | Run 停止原因分析 | `resolveHeartbeatRunTimeoutPolicy()`, `inferHeartbeatRunStopReason()`, `buildHeartbeatRunStopMetadata()` |
| `server/src/services/run-liveness.ts` | Run 活跃度分类 | `classifyRunLiveness()` — 判断 Run 是否活着、卡住或需人工介入 |
| `server/src/services/live-events.ts` | 实时事件推送引擎 | `publishLiveEvent()`, `subscribeCompanyLiveEvents()` — 内存 EventEmitter 实现 |
| `server/src/services/activity-log.ts` | 业务活动日志 | `logActivity()` — 写 DB + 推 SSE + 转发插件一次完成 |
| `server/src/services/productivity-review.ts` | 生产力审查 | `reconcileProductivityReviews()`, `collectEvidence()`, `createOrUpdateReview()` |
| `ui/src/pages/Dashboard.tsx` | 仪表盘概览页 | 4 指标卡 + 4 图表 + 活动列表 + 任务列表 |
| `ui/src/pages/DashboardLive.tsx` | 实时仪表盘页 | ActiveAgentsPanel 增强展示 |
| `ui/src/components/LiveRunWidget.tsx` | Issue 实时运行组件 | 嵌入式 Run 监视器，支持取消操作 |

---

## 数据模型

### 主要数据库表

| 表 | 用途 | 关键字段 |
|----|------|----------|
| `heartbeatRuns` | Run 执行记录 | id, status, agentId, companyId, startedAt, finishedAt, resultJson, contextSnapshot, livenessState |
| `heartbeatRunEvents` | Run 事件日志 | seq, eventType, message, payload |
| `agentWakeupRequests` | 唤醒请求 | status (queued/skipped/ran), source (timer/assignment/on_demand/automation) |
| `costEvents` | 费用事件 | costCents, billingType, occurredAt, issueId, agentId |
| `activityLog` | 业务活动日志 | actorType, action, entityType, entityId, details |
| `agents` | Agent 配置 | status, lastHeartbeatAt, runtimeConfig (含心跳策略) |
| `issues` | 任务 | status, assigneeAgentId, originKind (用于生产力审查) |

### Dashboard API 返回结构

```typescript
{
  companyId: string;
  agents: { active: number; running: number; paused: number; error: number };
  tasks: { open: number; inProgress: number; blocked: number; done: number };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: Array<{
    date: string;
    succeeded: number;
    failed: number;
    other: number;
    total: number;
  }>;
}
```

---

## 上下游依赖

### 上游（Dashboard 依赖）

| 依赖 | 用途 |
|------|------|
| `services/budgets.ts` | 预算概览（活跃事件、待审批、暂停计数） |
| `services/costs.ts` | 月度费用汇总 |
| `services/issues.ts` | Issue 状态和查询 |
| `services/activity-log.ts` | 活动日志记录与推送 |
| `services/live-events.ts` | 实时事件 SSE 推送 |
| `services/recovery/*` | Run 续作和恢复机制 |
| `services/run-liveness.ts` | Run 活跃度分类 |
| `services/productivity-review.ts` | 生产力审查 |
| `services/workspace-runtime.ts` | 执行工作区管理 |
| `adapters/*` | AI adapter 接口（启动 Agent 进程） |
| `db` schema (`@paperclipai/db`) | 所有数据库表定义 |

### 下游（依赖 Dashboard）

| 下游 | 用途 |
|------|------|
| `ui/src/pages/Dashboard.tsx` | 概览页消费 dashboard API |
| `ui/src/pages/DashboardLive.tsx` | 实时页消费 heartbeat API |
| `ui/src/components/ActiveAgentsPanel` | 共享的 Active Agent 面板组件 |
| `ui/src/components/MetricCard` / `ActivityCharts` | 指标卡和图表组件 |
| Plugin system (`dashboardWidget` slot) | 插件可注入自定义 widget |

---

## 设计权衡与边界条件

1. **弱一致性** — Dashboard 数据来自多次独立查询，各块数据可能存在秒级的时间差。这在概览场景中是可接受的，用户不会注意到微小的计数差异。

2. **内存 EventEmitter vs 消息队列** — 实时事件使用 Node.js EventEmitter 而非 Redis Pub/Sub。Paperclip 是单进程架构，不需要跨进程广播。如果将来需要水平扩展，需要迁移到外部消息队列。

3. **SSE 掉线补偿** — 实时事件通过 SSE 推送，但前端也同时使用 React Query 的 refetchInterval 轮询。SSE 提供低延迟，轮询提供可靠性。两者并存确保数据不丢失。

4. **Dashboard 数据缓存** — 当前 Dashboard 数据不设服务器端缓存，每次请求都重新查询数据库。对于大规模部署（数千 Agents），建议引入 Redis 缓存或定期物化视图。

5. **并发控制** — `startNextQueuedRunForAgent` 使用 `withAgentStartLock` 确保同一 Agent 的执行不会并发启动。`claimQueuedRun` 使用数据库乐观锁（UPDATE ... WHERE status='queued'）防止重复接管。

6. **重试风暴防护** — 有界重试使用 jitter（±25%）避免多个 Run 同时重试导致的"心跳同步风暴"（thundering herd problem）。

7. **run-liveness 的分类成本** — 活跃度分类需要分析 Run 的输出文本和 Issue 的评论、文档等关联数据，这在高频场景下可能成为性能瓶颈。当前在每个 Run 结束后执行一次分类，不会单独调度。

8. **生产力审查的频率限制** — 每个 Issue 在 24 小时内最多创建 3 次 Review Issue，且如果 6 小时内有活跃的 Review Issue 则跳过更新，防止重复告警骚扰。
