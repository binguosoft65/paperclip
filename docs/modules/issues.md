# Issues 模块文档

## 模块概述

Issues 是 Paperclip 最核心的业务模块，负责 Agent 公司内所有任务的**全生命周期管理**。一个 Issue 代表一个需要完成的工作单元，Agent 系统围绕 Issue 进行执行编排、进度追踪、质量评审和活跃度检测。

### 核心职责

1. **问题追踪** — 管理 Issue 从创建到完成的完整生命周期（backlog -> todo -> in_progress -> in_review -> done/cancelled）
2. **执行编排** — 通过执行策略（Execution Policy）定义多阶段工作流（如"开发 -> 审核 -> 审批"），驱动 Agent 逐步完成
3. **监工系统** — 监控外部服务状态（如 CI/CD、部署），自动触发 Issue 续作或标记阻塞
4. **续作摘要** — 每次 Run 结束后自动生成摘要文档，为 Agent 下次接手提供上下文
5. **依赖管理** — 通过 "blocks" 关系表达 Issue 间的阻塞依赖，自动计算阻塞链路和关注度
6. **子树控制** — 支持对 Issue 树执行暂停/恢复/取消/还原操作，管理大批量任务
7. **活跃度检测** — 分析 Run 的执行结果，判断 Issue 是否在推进、是否需要人工介入

---

## 核心流程

### 1. Issue 生命周期

```
backlog  →  todo  →  in_progress  →  in_review  →  done
                      ↓               ↓
                   blocked         cancelled
```

**状态迁移规则：**

- **backlog**：待办池，尚未开始。Agent 分配时自动移出 backlog
- **todo**：已分配但未启动。监工系统跳过此状态的 Issue
- **in_progress**：正在执行。设置此状态时自动记录 `startedAt` 时间戳
- **in_review**：等待审核。此状态会触发执行策略中的 review/approval 阶段
- **blocked**：被外部依赖阻塞。监工系统会检测阻塞是否已解除
- **done**：已完成。设置时自动记录 `completedAt` 时间戳
- **cancelled**：已取消。设置时自动记录 `cancelledAt` 时间戳

**关键约束：**
- `blocked` 状态的 Issue 仍然可以接收评论（用于沟通），但不会自动执行
- `done` 和 `cancelled` 为终态，不可通过状态迁移回到活跃状态（除非通过子树还原操作）

### 2. 执行编排（Execution Workflow）

执行策略（`executionPolicy`）驱动 Issue 的多阶段工作流：

```
执行策略结构：
{
  mode: "normal" | "planning",
  stages: [
    { id, type: "review" | "approval", participants: [...], approvalsNeeded: 1 }
  ],
  monitor?: { nextCheckAt, maxAttempts, timeoutAt, ... }
}
```

**工作流阶段类型：**
- **review**：审核阶段，参与者检查工作成果并提出修改意见
- **approval**：审批阶段，参与者审批是否通过

**编排流程：**
1. Issue 状态变为 `in_review` 时触发工作流
2. 系统自动找到第一个未完成的阶段（pending stage）
3. 从参与者中选中下一个执行人（participant）
4. 执行人审批通过（status=done）则进入下一阶段
5. 执行人请求修改则状态退回 `in_progress`，记录 changes_requested
6. 所有阶段完成后 issue 进入 `done` 状态
7. 如果所有参与者与 returnAssignee 相同，自动跳过该阶段

**设计意图：**
- 分离"执行"与"审核"职责，避免 Agent 自审自批
- `returnAssignee` 机制确保审核不通过时回到正确的执行人手中
- 自动跳过（auto-skip）减少不必要的人工确认

### 3. 监工系统（Issue Monitor）

监工系统用于监控外部服务状态，自动驱动 Issue 进展：

```
触发条件：
- Issue 处于 in_progress 或 in_review
- 已分配给 Agent（非人工处理）
- 配置了 monitor 策略

监工作用：
1. 定时检查外部服务（如 CI 状态、部署状态）
2. 达到检查时间（nextCheckAt）时触发 Agent 续作
3. 最多重试 maxAttempts 次
4. 超过 timeoutAt 后自动清除监工状态

监工状态机：
scheduled（已调度）→ triggered（已触发）→ cleared（已清除）
                      ↓
                  timeout_exceeded / max_attempts_exhausted
```

**清除监工的条件：**
- Issue 变为 `done` 或 `cancelled`
- 分配给人工（非 Agent）
- 不在 `in_progress` 或 `in_review` 状态
- 超时或达到最大尝试次数

### 4. 续作摘要（Continuation Summary）

每次 Run 结束后，系统自动生成续作摘要文档，帮助 Agent 下次接手时快速恢复上下文：

```
摘要内容：
- Issue 基本信息（ID、标题、状态、优先级）
- 当前模式（plan/review/implementation）
- 目标（Objective）和验收标准（Acceptance Criteria）
- 最近的具体行动
- 触及的文件/路径
- 阻塞项/决策记录
- 下一步行动建议
```

**设计意图：**
- Agent 的对话上下文有长度限制，续作摘要作为"长期记忆"的替代方案
- 从 Issue 描述中提取 `## Objective` 和 `## Acceptance Criteria` 章节
- 从 Run 的 resultJson 中提取结构化结果摘要
- 路径匹配自动识别触及的源码文件

### 5. 阻塞/依赖机制

Issue 间通过 `blocks` 关系建立依赖链：

```
A blocks B   →   B 被 A 阻塞，A 完成前 B 不能执行
```

**阻塞关注度（Blocker Attention）计算：**

系统递归遍历阻塞链，对每个被阻塞的 Issue 计算关注度状态：

| 状态 | 含义 |
|------|------|
| `needs_attention` | 阻塞链上存在需要关注的节点（未覆盖、未卡住） |
| `stalled` | 阻塞链卡在 review 阶段，没有活跃的执行或等待路径 |
| `covered` | 阻塞链上的节点正在被处理（有活跃 Agent、等待交互或等待审批） |

**关键规则：**
- `cancelled` 的 blocker 不会自动解除阻塞——需要人工移除或替换阻塞关系
- 阻塞链遍历深度最大 8 层，节点数最大 2000 个
- 恢复子树的 issue（liveness escalation）会被视为活跃等待路径

### 6. 子树控制（Tree Control）

对 Issue 树的批量控制操作：

| 模式 | 效果 |
|------|------|
| `pause` | 暂停子树执行：取消活跃 Run，延期待处理的唤醒请求 |
| `resume` | 恢复子树执行 |
| `cancel` | 取消子树：取消活跃 Run，将 Issue 状态标记为 cancelled |
| `restore` | 还原子树：将 cancelled 的 Issue 恢复到取消前的状态，重新唤醒 Agent |

**设计意图：**
- 解决大批量 Issue 的批量管理问题，避免逐个操作
- `pause` + `resume` 支持临时中断，适合部署窗口期等场景
- `cancel` + `restore` 支持安全回滚，restore 时可选择是否立即唤醒 Agent

---

## 关键文件及职责

### Server 端

| 文件路径 | 职责 |
|----------|------|
| `server/src/services/issues.ts` | Issue 核心服务：CRUD、生命周期管理、依赖计算、阻塞关注度、生产力审核 |
| `server/src/services/issue-execution-policy.ts` | 执行策略引擎：工作流阶段管理、参与者调度、监工状态机 |
| `server/src/services/issue-continuation-summary.ts` | 续作摘要：Run 结果 → Markdown 续作文档 |
| `server/src/services/issue-references.ts` | Issue 引用管理：解析 #issue 引用、同步提及关系 |
| `server/src/services/issue-goal-fallback.ts` | 目标回退逻辑：确定 Issue 所属 Goal 的默认值 |
| `server/src/services/issue-assignment-wakeup.ts` | 分配唤醒：Issue 分配后自动唤醒 Agent |
| `server/src/services/issue-approvals.ts` | Issue 审批关联：链接 Issue 与审批记录 |
| `server/src/services/issue-tree-control.ts` | 子树控制：暂停/恢复/取消/还原 Issue 子树 |
| `server/src/services/run-liveness.ts` | Run 活跃度分类：分析 Run 输出，判断活跃度状态 |
| `server/src/services/run-continuations.ts` | Run 续作决策：决定是否以及如何续作 |
| `server/src/services/run-log-store.ts` | Run 日志存储：本地文件系统日志读写 |
| `server/src/services/heartbeat-run-summary.ts` | Heartbeat Run 摘要：从 resultJson 提取结构化摘要 |
| `server/src/services/activity.ts` | 活动流服务：Issue 相关活动查询、Run 活跃度回填 |
| `server/src/routes/issues.ts` | Issue 路由：HTTP API 端点 |
| `server/src/routes/issue-tree-control.ts` | 子树控制路由：预览、创建/释放 Hold |
| `server/src/routes/activity.ts` | 活动流路由：查询活动和 Run 历史 |

### UI 端

| 文件路径 | 职责 |
|----------|------|
| `ui/src/pages/Issues.tsx` | Issue 列表页：分页加载、搜索、过滤 |
| `ui/src/pages/IssueDetail.tsx` | Issue 详情页：状态管理、评论、Run 历史、工作流 |
| `ui/src/pages/MyIssues.tsx` | 我的 Issue 页：显示未分配的 Issue |
| `ui/src/components/IssueRow.tsx` | Issue 行组件：列表中的单行渲染 |
| `ui/src/components/IssueColumns.tsx` | Issue 列组件：可配置列选择器 |
| `ui/src/components/IssueProperties.tsx` | Issue 属性面板：编辑状态、分配、标签等 |
| `ui/src/components/IssueBlockedNotice.tsx` | 阻塞通知：显示阻塞状态和链路 |
| `ui/src/components/IssueMonitorActivityCard.tsx` | 监工活动卡片：显示监工调度信息 |
| `ui/src/components/IssuesList.tsx` | Issue 列表组件：视图切换、筛选、排序、分组 |

---

## 数据模型

### 核心表：issues

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `companyId` | UUID | 所属公司 |
| `projectId` | UUID? | 所属项目 |
| `goalId` | UUID? | 所属目标 |
| `parentId` | UUID? | 父 Issue（树形结构） |
| `title` | text | 标题 |
| `description` | text? | 描述（Markdown，含 Objective 和 Acceptance Criteria 章节） |
| `status` | enum | backlog/todo/in_progress/in_review/blocked/done/cancelled |
| `priority` | enum | none/low/medium/high/urgent |
| `identifier` | text? | 可读标识符（如 ISSUE-123） |
| `assigneeAgentId` | UUID? | 分配给哪个 Agent |
| `assigneeUserId` | UUID? | 分配给哪个用户 |
| `executionPolicy` | jsonb? | 执行策略（工作流定义） |
| `executionState` | jsonb? | 执行状态（工作流进度） |
| `executionRunId` | UUID? | 当前执行 Run ID |
| `blockerAttention` | jsonb? | 阻塞关注度计算结果 |
| `originKind` | text? | 来源类型（如 plugin:slack:message） |
| `originId` | text? | 来源 ID |
| `requestDepth` | integer | 请求深度（从原始请求到子 Issue 的层级） |
| `startedAt` | timestamptz? | 开始时间（首次进入 in_progress） |
| `completedAt` | timestamptz? | 完成时间（进入 done） |
| `cancelledAt` | timestamptz? | 取消时间（进入 cancelled） |
| `hiddenAt` | timestamptz? | 隐藏时间（软删除） |

### 关联表

| 表名 | 说明 |
|------|------|
| `issue_relations` | Issue 间关系（blocks 类型） |
| `issue_comments` | Issue 评论 |
| `issue_labels` / `labels` | Issue 标签 |
| `issue_documents` / `documents` | Issue 文档（含续作摘要） |
| `issue_approvals` / `approvals` | Issue 审批关联 |
| `issue_reference_mentions` | Issue 引用提及 |
| `issue_read_states` | 用户阅读状态 |
| `issue_inbox_archives` | 用户收件箱归档 |
| `issue_attachments` | Issue 附件 |
| `issue_work_products` | Issue 工作产物 |
| `issue_thread_interactions` | Issue 线程交互（如询问用户） |
| `issue_blocker_attention` | 阻塞关注度快照 |

### 关联表：heartbeat_runs

| 字段 | 说明 |
|------|------|
| `id` | Run ID |
| `issueId` | 关联 Issue（通过 contextSnapshot 间接） |
| `status` | queued/running/succeeded/failed/timed_out/cancelled |
| `livenessState` | 活跃度分类结果 |
| `livenessReason` | 活跃度分类原因 |
| `continuationAttempt` | 续作尝试次数 |
| `resultJson` | 执行结果（JSON） |

---

## 上下游依赖

### 上游依赖（Issues 模块依赖的模块）

| 模块 | 依赖关系 |
|------|----------|
| Agents | Agent 状态查询、分配验证 |
| Heartbeat | Run 管理、Agent 唤醒 |
| Documents | 续作摘要文档存储 |
| Goals | 目标回退查询 |
| Projects | 项目工作区策略查询 |
| Approvals | 审批记录关联 |
| Execution Workspaces | 执行工作区策略 |
| Instance Settings | 实例级配置 |

### 下游依赖（依赖 Issues 模块的模块）

| 模块 | 依赖关系 |
|------|----------|
| Activity / Activity Log | 记录 Issue 相关活动 |
| Recovery / Liveness | 活跃度检测的结果写入 heartbeat_runs |
| Plugins | 通过 originKind/originId 关联外部系统（如 Slack） |
| UI 前端 | Issues 列表、详情、属性编辑、工作流展示 |

### 数据流示例

```
Agent 提交 Run 结果
    ↓
classifyRunLiveness() → 判断活跃度（advanced/blocked/plan_only/empty/needs_followup）
    ↓
refreshIssueContinuationSummary() → 生成续作摘要文档
    ↓
decideRunLivenessContinuation() → 决定是否续作、如何续作
    ↓
（如需续作）queueIssueAssignmentWakeup() → 唤醒 Agent 继续工作
    ↓
（如监工到期）buildIssueMonitorTriggeredPatch() → 触发外部服务检查
```
