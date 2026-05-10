# Agents 模块

## 模块概述

Agents 模块是 Paperclip 平台的核心，负责 Agent 的完整生命周期管理：创建、配置、运行时调度、指令管理、权限控制以及销毁。

### 核心概念

- **Agent**：一个可独立运行的人工智能体，拥有自己的配置、指令、API Key 和运行时状态。
- **Agent 角色**：定义了 Agent 在组织中的职能等级（ceo、manager、general 等），影响默认权限。
- **Agent 状态机**：`pending_approval -> idle -> running/queued -> paused/error -> terminated`
- **指令 Bundle**：Agent 的行为指南文件集合，支持托管（Managed）和外部（External）两种模式。
- **配置修订（Revision）**：每次配置变更的 before/after 快照，支持回滚和审计。

---

## 核心流程

### 1. 创建 Agent

```
请求 → 权限检查（assertCanCreateAgentsForCompany）
     → 校验 manager/role/permissions
     → 名称去重（deduplicateAgentName）
     → 写入 agents 表
     → 加载默认指令 Bundle（loadDefaultAgentInstructionsBundle）
     → 返回标准化的 Agent 对象
```

- 公司的第一个 Agent 自动设为 CEO 角色（`NewAgent.tsx` 中的 `isFirstAgent` 逻辑）。
- 创建时自动生成唯一短名（URL Key），遇冲突时追加编号后缀（`"Agent" -> "Agent 2" -> "Agent 3"`）。
- API Key 使用 `pcp_` 前缀 + 24 字节随机数生成，数据库中仅存储 SHA-256 哈希。

### 2. 配置变更与审计

```
用户修改配置 → NormalizeAgentPermissions → 更新 agents 表
              → 对比 before/after 快照 → 如果有差异 → 写入 agent_config_revisions 表
              → 返回更新后的 Agent
```

- `CONFIG_REVISION_FIELDS` 描述了哪些字段变更需要审计（name、role、adapterConfig、runtimeConfig 等 12 个字段）。
- 回滚操作是"以旧版本的值创建新版本"，而非直接覆盖历史记录，保证了审计链的完整性。
- 包含脱敏标记的修订不能回滚（`containsRedactedMarker` 检查）。

### 3. 运行时管理

```
Heartbeat 调度 → withAgentStartLock（串行化启动）
               → 状态校验（非 paused/terminated 才能运行）
               → 创建 heartbeat_run 记录
               → 执行 Agent 工作
               → 记录运行结果和费用
```

- 启动锁（`agent-start-lock.ts`）确保同一 Agent 的多个启动请求串行执行，避免资源竞争。
- 锁超时 30 秒，超过视为陈旧锁，后续请求跳过等待。
- 暂停原因分类：`manual` / `budget` / `system`，影响恢复方式。

### 4. 权限模型

权限检查链（由严格到宽松）：

```
角色 = CEO                     → 自动拥有所有权限
拥有 canCreateAgents 权限     → 可创建 Agent、分配任务
拥有 agents:create 授权        → 可创建 Agent
拥有 tasks:assign 授权         → 可分配任务
```

- `assertCanUpdateAgent`：Agent 可修改自身；CEO 可修改任何 Agent；创建者可修改其创建的 Agent。
- `assertCanCreateAgentsForCompany`：区分 board（用户）和 agent（Agent Key）两种认证路径。

### 5. 指令 Bundle

两种管理模式：

| 模式 | 路径管理 | 适用场景 |
|------|---------|---------|
| Managed | Paperclip 自动管理路径（`companies/{companyId}/agents/{agentId}/instructions/`） | 大多数场景，不需要访问宿主文件系统 |
| External | 用户指定绝对路径 | 高级用户，需要在宿主文件系统上直接编辑指令 |

- 旧版 `promptTemplate` 单字符串字段已废弃，迁移时会自动转为 Managed 模式。
- 默认指令模板按角色区分：CEO 获得 AGENTS.md + HEARTBEAT.md + SOUL.md + TOOLS.md；普通 Agent 只有 AGENTS.md。

### 6. 生命周期终结

- **Terminate（软删除）**：标记 `status=terminated`，吊销所有 API Key，保留历史数据。
- **Remove（硬删除）**：在事务中级联删除所有关联数据（runs、sessions、keys、issues 等），不可逆。

---

## 关键文件及职责

### Server 端

| 文件 | 职责 |
|------|------|
| `server/src/services/agents.ts` | Agent 核心服务：CRUD、权限校验、配置审计、名称去重、组织树构建 |
| `server/src/services/agent-instructions.ts` | 指令 Bundle 管理：模式推导、文件读写、Bundle 迁移 |
| `server/src/services/agent-permissions.ts` | 权限规范化：默认权限（CEO 可创建 Agent）、输入校验和降级 |
| `server/src/services/agent-start-lock.ts` | 启动锁：内存级串行化锁，防止同一 Agent 并发启动 |
| `server/src/services/default-agent-instructions.ts` | 默认指令模板：按角色提供初始化文件 |
| `server/src/routes/agents.ts` | Express 路由：请求校验、认证授权、路由分派 |

### UI 端

| 文件 | 职责 |
|------|------|
| `ui/src/pages/Agents.tsx` | Agent 列表页：Tab 过滤、组织树/列表视图切换、活跃运行指示 |
| `ui/src/pages/AgentDetail.tsx` | Agent 详情页：仪表盘、指令编辑、配置修改、运行历史、预算管理 |
| `ui/src/pages/NewAgent.tsx` | 创建 Agent 页面：角色选择、技能分配、适配器测试 |
| `ui/src/components/ActiveAgentsPanel.tsx` | 仪表盘活跃 Agent 面板：运行卡片、实时日志轮询 |
| `ui/src/components/AgentProperties.tsx` | Agent 属性面板：状态、角色、适配器、运行时信息展示 |
| `ui/src/components/agent-config-primitives.tsx` | 底层 UI 组件：DraftInput、ChoosePathButton、CollapsibleSection 等 |

---

## 数据模型

### agents 表（主表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| company_id | UUID | 所属公司 |
| name | string | Agent 名称（显示用） |
| url_key | string | URL 友好的短名（由 name 自动派生） |
| role | string | 角色（ceo/general 等） |
| title | string? | 职位头衔 |
| status | enum | pending_approval / idle / running / paused / error / terminated |
| reports_to | UUID? | 上级 Agent ID |
| adapter_type | string | 适配器类型 |
| adapter_config | JSONB | 适配器配置 |
| runtime_config | JSONB | 运行时配置 |
| permissions | JSONB | 权限标志 |
| icon | string? | 图标名称 |
| budget_monthly_cents | number | 月度预算（美分） |
| default_environment_id | UUID? | 默认环境 |
| metadata | JSONB? | 扩展元数据 |
| pause_reason | string? | 暂停原因（manual/budget/system） |
| paused_at | timestamp? | 暂停时间 |
| spent_monthly_cents | number | 当月已花费（计算字段，来自 cost_events 聚合） |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

### agent_runtime_state 表（运行时状态）

| 字段 | 说明 |
|------|------|
| agent_id | FK to agents |
| session_id | 当前会话 ID |
| session_display_id | 会话显示 ID |
| last_error | 最后一次错误消息 |
| total_input_tokens | 累计输入 Token 数 |
| total_output_tokens | 累计输出 Token 数 |
| total_cached_input_tokens | 累计缓存输入 Token 数 |
| total_cost_cents | 累计费用 |

### agent_config_revisions 表（配置审计）

| 字段 | 说明 |
|------|------|
| agent_id | FK to agents |
| before_config | JSONB 快照（变更前） |
| after_config | JSONB 快照（变更后） |
| changed_keys | 变更的字段名列表 |
| source | 变更来源（patch / rollback / hire） |
| rolled_back_from_revision_id | 如果 source=rollback，指向被回滚的 revision |

### agent_api_keys 表（API Key）

| 字段 | 说明 |
|------|------|
| agent_id | FK to agents |
| key_hash | SHA-256 哈希值 |
| name | Key 名称 |
| revoked_at | 吊销时间 |

---

## 上下游依赖

### 上游依赖（Agents 模块依赖的其他模块）

| 模块 | 依赖内容 |
|------|---------|
| DB (`@paperclipai/db`) | 数据库模型定义和查询能力（Drizzle ORM） |
| Shared (`@paperclipai/shared`) | 类型定义、工具函数（normalizeAgentUrlKey、isUuidLike） |
| Access Service | 权限模型（grants、permissions） |
| Heartbeat Service | Agent 运行调度和执行 |
| Budget Service | 预算检查（暂停超预算 Agent） |
| Environment Service | 执行环境管理（SSH、Sandbox 等） |
| Issue Service | Agent 任务分配 |
| Secret Service | 敏感数据管理 |
| Approval Service | Agent 审批流程 |

### 下游依赖（依赖 Agents 模块的其他模块）

| 模块 | 依赖内容 |
|------|---------|
| Heartbeat | 获取 Agent 配置和指令用于执行 |
| Dashboard | 展示活跃 Agent 列表和运行状态 |
| Issues | 分配 Issue 给 Agent，查看 Agent 参与的问题 |
| Org Chart | 基于 agents.reports_to 构建组织树 |
| Budget | 读取 agent.budget_monthly_cents 用于预算管理 |
