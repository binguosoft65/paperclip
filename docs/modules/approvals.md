# Approvals 模块

## 模块概述

Approvals 模块是 Paperclip 平台的人工审批枢纽。当 Agent 在执行任务中遇到需要人工决策的关键节点——如招聘新 Agent、预算超支、CEO 策略变更——Agent 可发起审批请求，由 Board 成员（人工决策者）进行批准、驳回或要求修改。

### 核心概念

- **审批（Approval）**：一个由 Agent 或用户发起的、等待 Board 成员人工决策的请求。每个审批有自己的类型、负载（payload）、状态和评论讨论区。
- **审批状态机**：`pending -> approved / rejected / revision_requested -> pending（重新提交）`
- **审批类型**：`hire_agent`（招聘 Agent）、`approve_ceo_strategy`（CEO 策略审批）、`budget_override_required`（预算超额审批）、`request_board_approval`（请求 Board 审批）
- **Issue 关联**：一个审批可以关联一个或多个 Issue，审批通过后 Agent 可继续处理相关 Issue。
- **Board**：Paperclip 中的人工决策者角色，拥有审批/驳回/要求修改的权限。

---

## 核心流程

### 1. 审批状态机

```
                  ┌─────────────────────────────────────┐
                  │              revision_requested      │
                  │                     ▲                │
                  │        resubmit     │                │
                  │                     │                │
    ┌─────────┐   │    requestRevision  │                │
    │ pending ├───┼─────────────────────┘                │
    └────┬────┘   │                                      │
         │        └──────────────────────────────────────┘
         │
    ┌────┴──────────┐
    │               │
    ▼               ▼
 approved       rejected
    (终态)         (终态)
```

- **pending**：初始状态，等待 Board 决策。支持 approve、reject、requestRevision 三种操作。
- **revision_requested**：Board 要求发起方修改审批内容。支持 resubmit（回到 pending）和 approve/reject（Board 也可直接处理）。
- **approved**：审批通过。终态，不可逆。
- **rejected**：审批驳回。终态，不可逆。
- **cancelled**：预留状态，当前未在状态流转中使用。

### 2. 创建审批

```
Agent/用户提交 → 权限检查（assertCompanyAccess）
               → 可选：关联 Issue（去重）
               → hire_agent 类型：secrets 脱敏（API Key 等敏感字段转为加密存储引用）
               → 写入 approvals 表
               → 记录 activity log
               → 返回审批对象
```

- 创建者可以是 Agent（`requestedByAgentId`）或用户（`requestedByUserId`），二者互斥。
- Issue 关联为可选，创建时传入的 `issueIds` 自动去重。
- `hire_agent` 类型的 payload 中的敏感信息（如 API Key）在持久化前经过 `secretsSvc.normalizeHireApprovalPayloadForPersistence` 处理。

### 3. 审批/驳回

```
Board 成员操作 → assertBoard（认证为 Board 成员）
               → 状态校验（仅 pending / revision_requested 可操作）
               → 乐观锁更新（条件 `WHERE status IN (pending, revision_requested)`）
               → 更新失败时二次确认（幂等保护）
               → 记录 activity log
               → 批准时：如请求者是 Agent → 唤醒 Agent 发送审批结果
```

- **幂等设计**：如果记录已被并发修改为目标状态，返回 `applied: false`，不报错。避免前端双击导致的 500 错误。
- **唤醒机制（仅批准）**：审批通过后，如果发起方是 Agent，通过 Heartbeat Service 发送 `approval_approved` 信号唤醒 Agent。唤醒失败记录日志但不会阻止审批流程——Agent 后续可通过轮询获知状态。
- **驳回不唤醒**：驳回意味着终止，Agent 不需要被唤醒继续处理。

### 4. 审批修改循环（Revision Loop）

```
pending → requestRevision（Board 要求修改）
       → revision_requested
       → resubmit（发起方重新提交）
       → pending
```

- `requestRevision`：仅 pending 状态可操作，Board 填写 `decisionNote` 说明修改意见。
- `resubmit`：仅 `revision_requested` 状态可操作，清空 `decidedByUserId`、`decidedAt`、`decisionNote` 以表示新审批周期。
- 发起方 Agent 或公司用户均可执行 resubmit，但如果是 Agent 身份，必须与 `requestedByAgentId` 一致（防止一个 Agent 篡改另一个 Agent 的审批）。

### 5. hire_agent 审批的副作用

**批准时**：
```
svc.approve()
  → resolveApproval()（状态更新）
  → 如果 payload 中有 agentId → activatePendingApproval（激活已有 Agent）
  → 否则 → agentsSvc.create()（根据 payload 创建新 Agent）
  → 如有月度预算 → budgets.upsertPolicy()（创建预算策略）
  → notifyHireApproved()（通知适配器，如发送欢迎消息，异步非阻塞）
```

**驳回时**：
```
svc.reject()
  → resolveApproval()（状态更新）
  → 如果 payload 中有 agentId → agentsSvc.terminate()（终止预创建的 Agent）
```

### 6. budget_override_required 特殊处理

预算超额类型的审批不能直接在审批页面一键批准/驳回。Board 成员需要跳转到成本管理页面（`/costs`）调整预算策略，调整后系统自动重新评估。在 UI 层面：
- 审批卡片中隐藏批准/驳回按钮。
- 审批详情页展示引导文字和跳转链接。

---

## 关键文件及职责

### Server 端

| 文件 | 职责 |
|------|------|
| `server/src/services/approvals.ts` | 审批核心服务：状态机流转、CRUD、hire_agent 副作用的编排 |
| `server/src/services/issue-approvals.ts` | Issue 与审批的多对多关联管理：关联、解关联、跨公司校验 |
| `server/src/services/hire-hook.ts` | 招聘审批通过后的适配器回调，通知外部系统 |
| `server/src/routes/approvals.ts` | Express 路由：请求校验、Board 认证、唤醒调度、activity log 记录 |

### UI 端

| 文件 | 职责 |
|------|------|
| `ui/src/pages/Approvals.tsx` | 审批列表页：Tab 过滤（pending/all）、排序、快捷操作 |
| `ui/src/pages/ApprovalDetail.tsx` | 审批详情页：状态展示、操作按钮、评论系统、关联 Issue 展示 |
| `ui/src/components/ApprovalCard.tsx` | 审批卡片组件：列表中的审批摘要展示、快捷审批/驳回 |

### Shared / DB 端

| 文件 | 职责 |
|------|------|
| `packages/shared/src/types/approval.ts` | Approval / ApprovalComment 类型定义 |
| `packages/shared/src/validators/approval.ts` | Zod 校验 schema：创建、审批、驳回、要求修改、重新提交 |
| `packages/shared/src/constants.ts` | 审批类型和状态常量（APPROVAL_TYPES / APPROVAL_STATUSES） |
| `packages/db/src/schema/approvals.ts` | approvals 表 Drizzle ORM 定义 |
| `packages/db/src/schema/approval_comments.ts` | approval_comments 表 Drizzle ORM 定义 |
| `packages/db/src/schema/issue_approvals.ts` | issue_approvals 关联表 Drizzle ORM 定义 |

---

## 数据模型

### approvals 表（主表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| company_id | UUID | 所属公司（FK to companies） |
| type | string | 审批类型（hire_agent / approve_ceo_strategy / budget_override_required / request_board_approval） |
| requested_by_agent_id | UUID? | 发起方 Agent ID（FK to agents） |
| requested_by_user_id | string? | 发起方用户 ID |
| status | enum | pending / revision_requested / approved / rejected / cancelled |
| payload | JSONB | 审批负载，结构因类型而异 |
| decision_note | string? | 决策备注（驳回原因或修改意见） |
| decided_by_user_id | string? | 决策者用户 ID |
| decided_at | timestamp? | 决策时间 |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

**索引**：`(company_id, status, type)` 复合索引，支持按公司+状态+类型的组合查询。

### approval_comments 表（审批评论）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| company_id | UUID | 所属公司（FK to companies） |
| approval_id | UUID | 所属审批（FK to approvals，CASCADE 删除） |
| author_agent_id | UUID? | 评论者 Agent ID（FK to agents） |
| author_user_id | string? | 评论者用户 ID |
| body | text | 评论内容（Markdown 格式） |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

**索引**：`(approval_id, created_at)` 索引，支持按审批 + 时间排序查询评论。

### issue_approvals 表（Issue-审批关联）

| 字段 | 类型 | 说明 |
|------|------|------|
| company_id | UUID | 所属公司（FK to companies） |
| issue_id | UUID | Issue ID（FK to issues，CASCADE 删除） |
| approval_id | UUID | 审批 ID（FK to approvals，CASCADE 删除） |
| linked_by_agent_id | UUID? | 关联发起方 Agent ID |
| linked_by_user_id | string? | 关联发起方用户 ID |
| created_at | timestamp | 创建时间 |

**主键**：`(issue_id, approval_id)` 复合主键，一个 Issue 与一个审批只能关联一次。

---

## 上下游依赖

### 上游依赖（Approvals 模块依赖的其他模块）

| 模块 | 依赖内容 |
|------|---------|
| DB (`@paperclipai/db`) | 数据表定义和 ORM 查询（Drizzle） |
| Shared (`@paperclipai/shared`) | 类型定义、Zod 校验 schema、审批常量 |
| Agents Service | hire_agent 批准时创建/激活 Agent，驳回时 terminate Agent |
| Budget Service | hire_agent 批准时创建对应 Agent 的月度预算策略 |
| Heartbeat Service | 审批通过后唤醒请求方 Agent（wakeup） |
| Secret Service | hire_agent payload 中的敏感信息（API Key）脱敏与加密存储 |
| Issues Service | 审批与 Issue 的关联查询和管理 |
| Instance Settings | 评论内容脱敏开关（censorUsernameInLogs） |

### 下游依赖（依赖 Approvals 模块的其他模块）

| 模块 | 依赖内容 |
|------|---------|
| Agents | Agent 创建流程中需要发起 hire_agent 审批；Agent 运行时可能触发 budget_override 审批 |
| Dashboard | 展示待处理审批数量和列表 |
| Costs | 预算超额审批的状态影响预算管理流程 |
