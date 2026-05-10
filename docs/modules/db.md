# `packages/db` 模块 —— 数据库 Schema 与迁移管理

## 模块概述

`packages/db` 是 Paperclip 的数据库层模块，负责：

- **Schema 定义**：使用 Drizzle ORM（pg-core）定义所有数据库表的 TypeScript schema
- **迁移管理**：管理 PostgreSQL 数据库的版本化迁移（当前共 84 个迁移文件）
- **数据库客户端**：提供 Drizzle ORM 数据库实例的创建和连接管理
- **嵌入式 Postgres**：支持嵌入式 PostgreSQL 实例的启动/停止（开发环境）
- **运行时配置**：从环境变量、配置文件等来源解析数据库连接参数
- **备份与恢复**：提供 pg_dump/pg_restore 封装的数据备份能力
- **种子数据**：提供开发和演示用的初始数据填充

### 技术栈

- **ORM**: Drizzle ORM (`drizzle-orm/pg-core`)
- **数据库**: PostgreSQL
- **迁移工具**: 自定义迁移引擎（兼容 Drizzle Kit 生成的迁移文件）
- **连接驱动**: `postgres` (postgres.js)

---

## 核心数据表

### 组织与权限

| 表名 | 业务含义 |
|------|----------|
| `companies` | 租户/公司，最高层级数据隔离单元。包含预算、品牌色、Issue 编号等配置 |
| `company_memberships` | 用户/Agent 与公司的关联关系（支持多类型主体） |
| `invites` | 公司邀请（用户/Agent 加入公司） |
| `join_requests` | 加入申请（接受邀请后的审批流程） |
| `principal_permission_grants` | 细粒度权限授予（主体 + 权限键） |
| `instance_settings` | 实例级全局配置（单行模式） |
| `instance_user_roles` | 实例级用户角色（如实例管理员） |

### 用户与认证

| 表名 | 业务含义 |
|------|----------|
| `user` | 人类用户（基于 Better Auth） |
| `session` | 用户登录会话 |
| `account` | 第三方 OAuth 账号绑定 |
| `verification` | 验证码/令牌（邮箱验证、密码重置） |
| `board_api_keys` | 用户 Board API 密钥（CLI/API 认证） |
| `cli_auth_challenges` | CLI 挑战-响应认证流程 |
| `user_sidebar_preferences` | 用户侧边栏偏好（公司排序） |
| `company_user_sidebar_preferences` | 用户在公司内的项目排序偏好 |

### Agent 管理

| 表名 | 业务含义 |
|------|----------|
| `agents` | AI Agent 定义。核心执行单元，支持组织层级（reports_to） |
| `agent_runtime_state` | Agent 运行时状态（1:1），包含 Token 用量和累计成本 |
| `agent_api_keys` | Agent API 密钥（以哈希存储） |
| `agent_config_revisions` | Agent 配置变更审计历史 |
| `agent_task_sessions` | Agent 任务级多会话管理 |
| `agent_wakeup_requests` | Agent 唤醒请求队列 |

### 项目与目标

| 表名 | 业务含义 |
|------|----------|
| `goals` | 目标/OKR 定义，支持层级（company -> project -> task） |
| `projects` | 项目定义，关联目标和负责人 Agent |
| `project_goals` | 项目与目标的多对多关联 |
| `project_workspaces` | 项目工作空间（代码仓库/目录） |
| `execution_workspaces` | 运行时工作空间（执行沙箱，从项目工作空间派生） |
| `workspace_operations` | 工作空间操作日志 |
| `workspace_runtime_services` | 工作空间运行时服务 |

### Issue 与执行

| 表名 | 业务含义 |
|------|----------|
| `issues` | 核心业务编排单元。Agent 执行的最小调度单元，支持监工模式、来源追踪、执行策略等 |
| `issue_comments` | Issue 评论/讨论（Agent 与用户异步沟通） |
| `issue_approvals` | Issue 与审批的多对多关联 |
| `issue_labels` | Issue 与标签的多对多关联 |
| `labels` | 标签定义 |
| `issue_relations` | Issue 间依赖/阻塞关系 |
| `issue_reference_mentions` | Issue 跨引用关系图谱 |
| `issue_work_products` | Issue 产出物（PR、部署等） |
| `issue_thread_interactions` | Issue 线程交互（Agent-用户对话/指令） |
| `issue_tree_holds` | Issue 树阻塞/暂停机制 |
| `issue_tree_hold_members` | 树阻塞的具体成员 Issue |
| `issue_execution_decisions` | Issue 执行决策审计 |
| `issue_attachments` | Issue 附件关联 |
| `issue_documents` | Issue 关联的文档 |
| `issue_read_states` | 用户 Issue 阅读状态 |
| `issue_inbox_archives` | 用户收件箱归档 |
| `issue_work_products` | Issue 产出物管理 |

### 心跳与运行

| 表名 | 业务含义 |
|------|----------|
| `heartbeat_runs` | Agent 心跳运行记录，核心执行追踪表。记录每次心跳循环的完整生命周期 |
| `heartbeat_run_events` | Agent 运行事件日志流（按序编号，支持回放） |
| `heartbeat_run_watchdog_decisions` | 看门狗决策记录（超时/异常处理） |

### 定时任务

| 表名 | 业务含义 |
|------|----------|
| `routines` | 定时任务/自动化流程定义，支持并发控制和追赶策略 |
| `routine_revisions` | Routine 版本快照历史 |
| `routine_triggers` | Routine 触发器配置（cron、webhook、manual） |
| `routine_runs` | Routine 执行历史 |

### 环境管理

| 表名 | 业务含义 |
|------|----------|
| `environments` | 执行环境配置（local、docker、remote 等） |
| `environment_leases` | 环境租约管理（独占访问和自动释放） |

### 预算与财务

| 表名 | 业务含义 |
|------|----------|
| `budget_policies` | 预算策略配置（多层级、多时间窗口） |
| `budget_incidents` | 预算违规事件 |
| `cost_events` | 成本事件明细（Token 用量和花费） |
| `finance_events` | 财务事件（计费/收入/退款流水） |

### 密钥与安全

| 表名 | 业务含义 |
|------|----------|
| `company_secrets` | 公司级密钥/凭据 |
| `company_secret_versions` | 密钥版本管理 |
| `company_secret_provider_configs` | 密钥存储后端配置（local_encrypted、vault 等） |
| `company_secret_bindings` | 密钥到消费目标的绑定注入配置 |
| `secret_access_events` | 密钥访问审计日志 |

### 文档与资源

| 表名 | 业务含义 |
|------|----------|
| `documents` | 文档（最新版本快照） |
| `document_revisions` | 文档版本历史 |
| `assets` | 文件/资源存储元数据 |
| `company_logos` | 公司 Logo 关联 |

### 技能与反馈

| 表名 | 业务含义 |
|------|----------|
| `company_skills` | 公司级技能/能力定义 |
| `feedback_votes` | 用户投票/反馈收集 |
| `feedback_exports` | 反馈数据导出 |

### 插件系统

| 表名 | 业务含义 |
|------|----------|
| `plugins` | 插件注册表（每个安装的插件一行） |
| `plugin_config` | 插件实例配置 |
| `plugin_company_settings` | 插件公司级设置 |
| `plugin_state` | 插件作用域键值存储 |
| `plugin_entities` | 插件外部实体映射 |
| `plugin_managed_resources` | 插件托管资源 |
| `plugin_database_namespaces` | 插件数据库命名空间 |
| `plugin_migrations` | 插件迁移记录 |
| `plugin_jobs` | 插件定时任务注册 |
| `plugin_job_runs` | 插件任务执行历史 |
| `plugin_webhook_deliveries` | 插件 Webhook 投递历史 |
| `plugin_logs` | 插件日志 |

### 其他

| 表名 | 业务含义 |
|------|----------|
| `activity_log` | 统一活动审计日志 |
| `approvals` | 审批请求 |
| `approval_comments` | 审批评论 |
| `inbox_dismissals` | 用户收件箱忽略记录 |

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `client.ts` | 数据库客户端与迁移引擎核心。提供 `createDb`、`inspectMigrations`、`applyPendingMigrations` 等核心函数 |
| `migrate.ts` | 迁移 CLI 入口。解析连接后自动应用待处理迁移 |
| `migration-runtime.ts` | 数据库连接解析与嵌入式 Postgres 管理（启动/停止外部或嵌入式实例） |
| `migration-status.ts` | 迁移状态查询 CLI（支持 --json 输出） |
| `runtime-config.ts` | 运行时配置解析（多来源优先级：环境变量 > .env > config.json > 默认值） |
| `backup.ts` | 数据库备份 CLI。读取配置后执行 pg_dump 备份 |
| `backup-lib.ts` | 备份/恢复库函数（pg_dump/pg_restore 封装），支持保留策略 |
| `embedded-postgres-error.ts` | 嵌入式 Postgres 错误处理和日志缓冲 |
| `seed.ts` | 开发/演示用种子数据填充 |
| `check-migration-numbering.ts` | 迁移文件编号完整性检查 |
| `schema/index.ts` | 所有数据库 schema 的统一导出入口 |
| `schema/*.ts` | 各个数据库表的 Drizzle ORM schema 定义（共 61 个表） |
| `migrations/*.sql` | 数据库版本迁移文件（共 84 个迁移） |

---

## 数据模型（核心表关系）

```
companies (1) ────< company_memberships (N) ──── user/agent
    │
    ├──< agents (N) ────< heartbeat_runs (N) ────< heartbeat_run_events (N)
    │     │              └──< heartbeat_run_watchdog_decisions (N)
    │     │
    │     ├──< agent_runtime_state (1:1)
    │     ├──< agent_api_keys (N)
    │     ├──< agent_config_revisions (N)
    │     ├──< agent_task_sessions (N)
    │     └──< agent_wakeup_requests (N)
    │
    ├──< goals (N) ────< project_goals (N) ────> projects (N)
    │
    ├──< projects (N) ────< project_workspaces (N) ────< execution_workspaces (N)
    │     │                                              └──< workspace_operations (N)
    │     │                                              └──< workspace_runtime_services (N)
    │     │
    │     └──< issues (N) ────< issue_comments (N)
    │           │             ├──< issue_approvals (N) ──── approvals
    │           │             ├──< issue_labels (N) ──── labels
    │           │             ├──< issue_relations (N)
    │           │             ├──< issue_reference_mentions (N)
    │           │             ├──< issue_work_products (N)
    │           │             ├──< issue_thread_interactions (N)
    │           │             ├──< issue_tree_holds (N) ────< issue_tree_hold_members (N)
    │           │             ├──< issue_execution_decisions (N)
    │           │             ├──< issue_attachments (N) ──── assets
    │           │             ├──< issue_documents (N) ──── documents ────< document_revisions (N)
    │           │             ├──< issue_read_states (N)
    │           │             └──< issue_inbox_archives (N)
    │           │
    │           └──< routines (N) ────< routine_revisions (N)
    │                 ├──< routine_triggers (N)
    │                 └──< routine_runs (N)
    │
    ├──< environments (N) ────< environment_leases (N)
    │
    ├──< budget_policies (N) ────< budget_incidents (N)
    ├──< cost_events (N)
    ├──< finance_events (N)
    │
    ├──< company_secrets (N) ────< company_secret_versions (N)
    │     ├──< company_secret_provider_configs (N)
    │     └──< company_secret_bindings (N)
    │
    ├──< company_skills (N)
    │
    └──< plugins (N) ────< plugin_config (1:1)
          ├──< plugin_company_settings (N)
          ├──< plugin_state (N)
          ├──< plugin_entities (N)
          ├──< plugin_managed_resources (N)
          ├──< plugin_database_namespaces (1:1)
          ├──< plugin_migrations (N)
          ├──< plugin_jobs (N) ────< plugin_job_runs (N)
          ├──< plugin_webhook_deliveries (N)
          └──< plugin_logs (N)
```

### 关系说明

- `(1)` 表示一方，`(N)` 表示多方，`(1:1)` 表示一对一
- `──<` 表示外键引用（一对多）
- `────` 表示多对多关联
- 所有业务表都通过 `company_id` 外键引用 `companies` 表
- `issues` 是核心业务表，关联超过 15 个子表，是整个系统的中枢

---

## 上下游依赖

### 上游依赖（本模块依赖的外部模块）

| 依赖 | 说明 |
|------|------|
| `@paperclipai/shared` | 共享 TypeScript 类型定义（如 AgentEnvConfig、RoutineRevisionSnapshotV1 等） |
| `postgres` (postgres.js) | PostgreSQL 数据库驱动 |
| `drizzle-orm` | Drizzle ORM 框架 |
| `embedded-postgres` | 嵌入式 PostgreSQL（仅开发环境需要） |

### 下游依赖（依赖本模块的外部模块）

| 依赖方 | 使用方式 |
|--------|----------|
| `@paperclipai/server` | 导入 `createDb` 和 schema 定义，在 API 路由和业务逻辑中操作数据库 |
| `@paperclipai/board` | 导入 schema 定义，在 Board 管理面板后端使用 |
| `@paperclipai/cli` | 使用迁移工具和备份工具 |
| 各 Agent worker | 通过 API 间接操作数据库（不直接依赖本模块） |

### 数据流示意图

```
  server/board (API) ──> packages/db (schema + client) ──> PostgreSQL
                              │
                              ├── migrate.ts (CLI)
                              ├── backup.ts (CLI)
                              └── seed.ts (CLI)
```
