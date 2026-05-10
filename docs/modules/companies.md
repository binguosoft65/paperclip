# Companies 模块

## 模块概述

Companies 模块是 Paperclip 平台的多租户基础，负责公司（组织）的完整生命周期管理：创建、配置、成员权限、邀请流程、品牌设置、导入/导出以及销毁。

### 核心概念

- **公司（Company）**：一个独立的多租户单元，拥有自己的 Agent、项目、Issue、技能和成员。数据在数据库层面通过 `companyId` 外键隔离。
- **成员角色**：`owner > admin > operator > viewer`，每级角色拥有不同的隐式权限集。
- **邀请（Invite）**：单次使用的邀请链接，状态流转为 `active -> accepted/expired/revoked`。
- **品牌（Branding）**：公司 Logo、名称、品牌色等对外展示信息，可通过 agent CEO 或 board 用户更新。
- **导入/导出（Portability）**：将整个公司打包为 zip 文件，可在不同 Paperclip 实例间迁移。

---

## 核心流程

### 1. 公司创建

```
请求 → 校验 instance admin 权限
     → 创建公司记录（含唯一 issue 前缀分配）
     → 确保默认本地环境存在（ensureLocalEnvironment）
     → 将创建者添加为公司 owner 成员
     → 如有月预算则自动设置预算策略
     → 记录审计日志
     → 返回公司详情
```

- Issue 前缀从公司名提取前 3 个大写字母（例如 `My Company` → `MYC`），遇冲突时自动追加 `A, AA, AAA...` 后缀，最多尝试 9999 次。
- 只有 instance admin 可以创建新公司，创建者自动成为新公司的 owner。

### 2. 成员邀请流程

```
创建邀请 → 选择成员角色（owner/admin/operator/viewer）
        → 系统生成单次使用的邀请链接
        → 受邀用户点击链接 → 提交入社申请（Join Request）
        → 具有 joins:approve 权限的成员审批/拒绝
        → 审批通过 → 用户成为公司成员（获得角色对应的隐式权限）
```

- 邀请状态流转：`active` → `accepted`（已使用）/ `expired`（过期）/ `revoked`（撤销）
- 创建邀请时可指定 `humanRole`，决定受邀用户的默认成员角色。
- 邀请支持显式权限声明（`defaultsPayload.human.grants`），优先级高于角色隐式权限。
- 代理（Agent）加入时，系统自动补充 `tasks:assign` 权限（即使未显式声明），因为 Agent 的核心职责是执行任务。

### 3. 导入导出（公司可移植性）

**导出流程：**
```
预览 → 选择要导出的公司/Agent/项目/Issue/Skill
     → 生成文件树（用户可选勾选部分内容）
     → 构建 manifest 元数据
     → 生成 README.md、组织架构图（org-chart.png）
     → 打包为 zip（含 .paperclip.yaml 扩展配置）
     → 下载
```

**导入流程：**
```
选择来源（GitHub URL / 本地 zip 包） → 预览冲突
     → 解决冲突（重命名/跳过/替换）
     → 选择导入目标（新公司/已有公司）
     → 选择 Agent 适配器类型
     → 执行导入
     → 刷新侧边栏顺序和会话状态
```

- 导入支持三种碰撞策略：`rename`（默认，自动添加前缀）、`skip`（跳过冲突项）、`replace`（覆盖已有数据）。
- Agent 安全模式（`agent_safe`）限制导入只能针对当前路由公司，且禁止 `replace` 策略。
- 导入时自动检测待导入 Agent 的适配器类型，可手动覆盖。
- 部分适配器类型（`process`、`http`）被禁止导入，防止安全风险。

### 4. 成员角色与权限

| 角色 | 隐式权限 | 设计意图 |
|------|---------|---------|
| owner | agents:create, users:invite, users:manage_permissions, tasks:assign, joins:approve | 完整管理权 |
| admin | agents:create, users:invite, tasks:assign, joins:approve | 接近 owner 但不可管理权限 |
| operator | tasks:assign | 可参与日常工作 |
| viewer | （无） | 仅供查看 |

- 显式权限声明优先级高于角色隐式权限。
- 移除成员时可选择将开放问题重新分配给其他成员或 Agent。
- 已归档的成员无法再分配。

---

## 关键文件及职责

### 服务端

| 文件 | 职责 |
|------|------|
| `server/src/routes/companies.ts` | 公司路由：CRUD、导出导入、品牌更新、归档/删除，含多租户权限断言 |
| `server/src/services/companies.ts` | 公司服务：数据库操作、唯一 issue 前缀分配、月度花费统计、级联删除 |
| `server/src/services/company-member-roles.ts` | 成员角色定义：角色层级、隐式权限映射、角色规范化 |
| `server/src/services/company-search.ts` | 公司内搜索引擎：跨 issue/agent/project 的全文检索与模糊匹配 |
| `server/src/services/company-portability.ts` | 公司导入导出：manifest 构建、zip 打包、冲突检测、技能目录映射 |
| `server/src/services/company-skills.ts` | 技能管理：从 GitHub/本地/URL 导入技能、文件编辑、项目扫描 |
| `server/src/routes/company-skills.ts` | 技能路由：CRUD、导入、项目扫描、更新检查，含权限校验 |
| `server/src/services/invite-grants.ts` | 邀请权限：默认权限解析、human/agent 加入时的权限合并策略 |
| `server/src/services/company-search-rate-limit.ts` | 搜索频率限制 |

### UI 端

| 文件 | 职责 |
|------|------|
| `ui/src/pages/Companies.tsx` | 公司列表页：卡片展示、行内重命名、删除确认 |
| `ui/src/pages/CompanySettings.tsx` | 公司设置页：基本信息、品牌色/Logo、附件限制、团队审批、邀请 Snippet |
| `ui/src/pages/CompanyAccess.tsx` | 访问控制页：成员管理、角色编辑、权限分配、加入请求审批 |
| `ui/src/pages/CompanyInvites.tsx` | 邀请管理页：创建邀请、历史记录、撤销 |
| `ui/src/pages/CompanyExport.tsx` | 导出页：文件树选择、zip 下载、预览 |
| `ui/src/pages/CompanyImport.tsx` | 导入页：来源配置、冲突解决、适配器选择、执行导入 |
| `ui/src/pages/CompanySkills.tsx` | 技能管理页：技能列表、文件树、编辑/预览 |
| `ui/src/pages/CompanyEnvironments.tsx` | 运行环境管理页：SSH/Sandbox/Local 环境配置与连接测试 |

---

## 数据模型

### companies 表（核心字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键，多租户隔离的外键目标 |
| `name` | VARCHAR | 公司名称 |
| `description` | TEXT | 公司描述 |
| `status` | ENUM('active', 'paused', 'archived') | 公司状态 |
| `issue_prefix` | VARCHAR(10) | Issue 编号前缀（唯一约束） |
| `issue_counter` | INTEGER | Issue 编号计数器 |
| `budget_monthly_cents` | INTEGER | 月度预算（美分），0 表示无限制 |
| `spent_monthly_cents` | INTEGER | 本月已花费（实时计算，非持久化） |
| `attachment_max_bytes` | INTEGER | 附件大小上限 |
| `require_board_approval_for_new_agents` | BOOLEAN | 新 Agent 是否需要审批 |
| `feedback_data_sharing_enabled` | BOOLEAN | 反馈数据共享开关 |
| `brand_color` | VARCHAR(7) | 品牌色（十六进制） |

### 成员关系

| 表 | 说明 |
|----|------|
| `company_memberships` | 用户与公司的多对多关系，记录角色（owner/admin/operator/viewer）和状态 |
| `principal_permission_grants` | 精细权限授权表，支持 scope 限定 |
| `invites` | 邀请记录，跟踪状态流转（active/accepted/expired/revoked） |
| `join_requests` | 加入申请，关联邀请和审批流程 |

### 关联子表（按 companyId 隔离）

| 表 | 关系 |
|----|------|
| `agents` | 公司下的所有 Agent |
| `projects` | 项目 |
| `issues` | Issue/任务 |
| `company_skills` | 公司技能库 |
| `environments` | 运行环境 |
| `company_secrets` | 密钥 |
| `activity_log` | 审计日志 |
| `cost_events` | 费用记录 |

---

## 上下游依赖

### 上游依赖（Companies 模块依赖的服务）

- **Authz 模块** (`server/src/routes/authz.ts`)：提供 `assertBoard`、`assertCompanyAccess`、`assertInstanceAdmin` 等权限断言函数。
- **Agent 服务** (`agents.ts`)：用于校验 agent 角色和权限。
- **Access 服务** (`access.ts`)：管理成员关系和权限授予。
- **Budget 服务** (`budgets.ts`)：公司预算策略管理。
- **Environment 服务** (`environments.ts`)：创建公司时自动初始化本地运行环境。
- **Storage 服务** (`storage/types.ts`)：导出包的远程存储。

### 下游依赖（依赖 Companies 模块的服务）

- **Dashboard 模块**：展示公司统计概览。
- **Onboarding 模块**：创建公司后的引导流程。
- **Issue/Project/Agent 模块**：所有实体通过 `companyId` 与公司关联。
- **Org Chart 模块**：使用公司 Agent 数据渲染组织架构图。
- **Feedback 模块**：反馈追踪按公司隔离。
