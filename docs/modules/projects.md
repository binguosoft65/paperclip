# Projects 模块

## 模块概述

Projects 是 Paperclip 的核心业务实体，代表一个可追踪的工作单元（如功能开发、项目迭代）。每个 Project 可以关联多个 **Workspace**（工作区），定义 **代码库** 来源（本地路径/git 仓库/远程管理），并关联 **Goals**（目标）和 **Budget**（预算策略）。项目还支持通过 **Plugin**（插件）托管，实现声明式的项目生命周期管理。

## 核心流程

### 项目 CRUD

| 操作 | 端点 | 业务规则 |
|------|------|---------|
| 创建 | `POST /companies/:companyId/projects` | 自动分配颜色（去重轮转）、短名称去重、支持内联创建工作区、环境变量持久化归一 |
| 查询 | `GET /projects/:id` | 支持 UUID 或短名称引用、携带工作区和运行时服务详情 |
| 列表 | `GET /companies/:companyId/projects` | 返回公司下所有项目（含目标、工作区、插件托管信息） |
| 更新 | `PATCH /projects/:id` | 部分字段更新、短名称变更时重新去重、环境变量重新归一、权限校验 |
| 删除 | `DELETE /projects/:id` | 硬删除（非软删除），由外键级联清理关联资源 |

### 工作区管理

工作区是项目的代码和运行环境载体，支持四种来源类型：

1. **local_path** — 本地 git 检出目录
2. **non_git_path** — 本地非 git 目录
3. **git_repo** — 远程 git 仓库（可选搭配本地检出）
4. **remote_managed** — 由外部系统管理的远程工作区

**关键约束：**
- 每个项目有且仅有一个 **主工作区**（primary workspace），作为代码库的默认来源
- 创建第一个工作区时自动设为主工作区
- 删除主工作区时，自动将最早创建的其他工作区递补为主工作区
- 远程管理工作区必须提供 `remoteWorkspaceRef` 或 `repoUrl`

**主工作区切换规则：**
- `isPrimary` 字段在项目中是互斥的（事务保证）
- 将某个工作区设为主时，其他所有工作区的 `isPrimary` 被清空
- 若当前工作区取消主身份后项目无主工作区，自动推选最早创建的工作区

### 运行时服务控制

工作区支持两类运行时命令：

- **service** — 长运行服务（如 web 开发服务器），支持 start/stop/restart
- **job** — 一次性作业（如数据库迁移），仅支持 run

**权限和约束：**
- agent 不可对共享工作区（`sharedWorkspaceKey` 非空）执行 stop/restart
- 作业不能 start/restart，服务不能 run
- start/restart 需要工作区有运行时配置定义
- 输出上限 256KB，防止内存溢出

### 预算策略

预算作用于三级作用域：**company > agent > project**。

- **窗口类型**：项目默认使用 `lifetime`（累计总消耗），公司和 agent 使用 `calendar_month_utc`（月度）
- **阈值**：软阈值（warnPercent，默认 80%）触发告警 Incident；硬阈值（100%）暂停作用域并取消进行中的工作
- **Incident 生命周期**：open -> resolved（上调预算后）/ dismissed（拒绝后）
- **硬停止后恢复条件**：观测金额低于新预算上限

**`getInvocationBlock` 检查链：**
公司状态暂停 -> 公司预算硬停止 -> agent 预算暂停 -> agent 预算硬停止 -> 项目预算硬停止 -> 项目预算暂停

### 插件托管项目

通过 `resolveManagedProject` 实现插件的项目声明式管理，状态机：

`missing` -> `created`（首次创建） -> `resolved`（已存在且匹配） -> `reset`（重置为插件默认值） -> `relinked`（重新关联）

**能力：**
- 插件通过 manifest 声明项目模板（名称、描述、颜色、状态）
- 支持 `createIfMissing=false` 的只读查询模式
- 支持 `reset=true` 将项目属性重置为插件声明值

## 关键文件

| 文件 | 职责 |
|------|------|
| `server/src/routes/projects.ts` | 项目和工作区的 REST API 路由，含权限校验、输入验证、活动日志 |
| `server/src/services/projects.ts` | 项目和工作区的业务逻辑实现，含批量关联加载、短名称去重、主工作区切换 |
| `server/src/services/budgets.ts` | 预算策略管理：策略增删改、Incident 创建/解决、费用事件评估、调用阻止 |
| `server/src/services/project-workspace-runtime-config.ts` | 工作区运行时配置的读写和合并操作 |
| `ui/src/pages/Projects.tsx` | 项目列表页 |
| `ui/src/pages/ProjectDetail.tsx` | 项目详情页（含多选项卡：Issues/Overview/Workspaces/Configuration/Budget） |
| `ui/src/pages/ProjectWorkspaceDetail.tsx` | 工作区详情页（含运行时命令控制和表单编辑） |
| `ui/src/pages/Workspaces.tsx` | 工作区总览页（按项目分组） |
| `ui/src/components/ProjectProperties.tsx` | 项目属性配置组件（含执行工作区策略高级设置） |
| `ui/src/components/ProjectWorkspacesContent.tsx` | 工作区内容列表组件（运行时控制、清理失败标记） |
| `ui/src/components/SidebarProjects.tsx` | 侧边栏项目列表（支持拖拽排序、插件扩展入口） |

## 数据模型

### projects 表（核心字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| companyId | UUID | 所属公司 |
| name | string | 项目名称（在同公司内短名称唯一） |
| color | string | 项目颜色标签（预定义调色板自动分配） |
| status | enum | backlog/planned/in_progress/completed/cancelled |
| goalId | UUID | 旧版单目标关联（新版使用联表 project_goals） |
| executionWorkspacePolicy | JSON | 执行工作区策略配置 |
| env | JSON | 环境变量绑定 |
| pauseReason | string | 暂停原因（manual/budget/system） |
| pausedAt | datetime | 暂停时间 |
| archivedAt | datetime | 归档时间（非空表示已归档） |

### project_workspaces 表（核心字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| projectId | UUID | 所属项目 |
| name | string | 工作区名称（自动从路径/仓库推导） |
| sourceType | enum | local_path/non_git_path/git_repo/remote_managed |
| cwd | string | 本地工作路径 |
| repoUrl | string | git 仓库 URL |
| isPrimary | boolean | 是否为主工作区（同项目内互斥） |
| metadata | JSON | 扩展元数据（内含 runtimeConfig） |
| sharedWorkspaceKey | string | 共享工作区标识（非空表示多个 agent 共享） |

### budget_policies 表

| 字段 | 类型 | 说明 |
|------|------|------|
| scopeType | enum | company/agent/project |
| scopeId | UUID | 作用域 ID |
| metric | string | 指标类型（当前仅支持 billed_cents） |
| windowKind | enum | lifetime/calendar_month_utc |
| amount | integer | 预算上限（美分） |
| warnPercent | integer | 告警阈值百分比（默认 80） |
| hardStopEnabled | boolean | 是否启用硬停止 |

## 上下游依赖

### 上游依赖（本模块调用的服务）

- **@paperclipai/db** — 数据库 ORM（projects, projectWorkspaces, budgetPolicies 等表）
- **@paperclipai/shared** — 共享类型和工具函数（schema 校验、颜色定义、URL key 推导）
- **secretService** — 环境变量绑定持久化（归一化 + 严格模式校验）
- **environmentService** — 执行环境选择校验
- **workspaceOperationService** — 运行时操作记录器
- **activityLog** — 操作审计日志
- **telemetry** — 使用统计遥测

### 下游依赖（依赖本模块的服务）

- **Issues 模块** — Issue 关联 projectId，项目列表和详情页嵌入 IssuesList
- **Agents 模块** — 执行工作区策略引用项目配置
- **Execution Workspaces 模块** — 项目的工作区运行时配置被执行工作区继承
- **Dashboard 模块** — 仪表盘展示项目级别的预算状态
- **Goals 模块** — 项目与目标的多对多关联
- **Plugins 模块** — 插件通过 `resolveManagedProject` 声明式管理项目
