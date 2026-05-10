# packages/shared 模块文档

## 模块概述

`packages/shared` 是 Paperclip 的前后端共享模块，定义了所有核心业务类型（TypeScript interface）、
Zod 校验器（validator schema）、枚举常量（const enum）和通用工具函数。
该模块没有运行时依赖（除 `zod` 外），保持轻量，可以被前端（Web）和后端（Server）同时引用。

---

## 核心内容

### 1. 业务常量 (`constants.ts`)

所有业务枚举值以 `as const` 数组定义，并导出对应的联合类型。涵盖：

| 分类 | 常量 | 说明 |
|------|------|------|
| 公司 | `COMPANY_STATUSES` | active / paused / archived |
| 部署 | `DEPLOYMENT_MODES`, `DEPLOYMENT_EXPOSURES`, `BIND_MODES`, `AUTH_BASE_URL_MODES` | 部署模式、暴露方式、绑定模式、认证 URL 模式 |
| Agent | `AGENT_STATUSES`, `AGENT_ADAPTER_TYPES`, `AGENT_ROLES`, `AGENT_ICON_NAMES` | Agent 状态、适配器类型、角色、图标 |
| Issue | `ISSUE_STATUSES`, `ISSUE_PRIORITIES`, `ISSUE_WORK_MODES`, `ISSUE_COMMENT_*`, `ISSUE_EXECUTION_*` | Issue 状态/优先级/工作模式/评论/执行策略等 |
| 审批 | `APPROVAL_TYPES`, `APPROVAL_STATUSES` | 审批类型和状态 |
| 预算 | `BUDGET_*` | 预算范围、指标、窗口、阈值 |
| 财务 | `FINANCE_*`, `BILLING_TYPES` | 计费类型、财务事件方向/单位 |
| 环境 | `ENVIRONMENT_DRIVERS`, `ENVIRONMENT_STATUSES`, `ENVIRONMENT_LEASE_*` | 环境驱动和状态 |
| Routine | `ROUTINE_*` | 常规模板状态、并发策略、触发方式 |
| 插件 | `PLUGIN_*` | 插件生命周期、能力模型、UI 插槽、事件类型 |
| 访问控制 | `PRINCIPAL_TYPES`, `MEMBERSHIP_STATUSES`, `COMPANY_MEMBERSHIP_ROLES`, `PERMISSION_KEYS` | 主体类型、成员状态、角色、权限键 |

### 2. 核心类型 (`types/` 目录)

每个文件对应一个业务实体，均导出纯 TypeScript interface：

| 文件 | 核心类型 | 说明 |
|------|---------|------|
| `company.ts` | `Company` | 公司实体 |
| `agent.ts` | `Agent`, `AgentDetail`, `AgentPermissions`, `AgentInstructionsBundle`, `AgentConfigRevision` | Agent 实体及其配置 |
| `issue.ts` | `Issue`, `IssueComment`, `IssueDocument`, `IssueThreadInteraction` 等 40+ 类型 | Issue 及其关联的所有类型 |
| `project.ts` | `Project`, `ProjectWorkspace`, `ProjectCodebase` | 项目实体 |
| `routine.ts` | `Routine`, `RoutineTrigger`, `RoutineRun`, `RoutineRevision`, `RoutineDetail` | 常规模板实体 |
| `plugin.ts` | `PaperclipPluginManifestV1`, `PluginRecord`, `PluginJobDeclaration` 等 30+ 类型 | 插件清单和运行期记录 |
| `access.ts` | `CompanyMembership`, `PrincipalPermissionGrant`, `Invite`, `JoinRequest` | 访问控制实体 |
| `workspace-runtime.ts` | `ExecutionWorkspace`, `WorkspaceRuntimeService`, `WorkspaceCommandDefinition` | 执行工作空间和运行时服务 |
| `environment.ts` | `Environment`, `EnvironmentLease` | 环境实体 |
| `secrets.ts` | `EnvBinding`, `CompanySecret` | 密钥和环境绑定 |
| `feedback.ts` | `FeedbackVote`, `FeedbackTrace` | 用户反馈 |
| `company-portability.ts` | 导出/导入相关类型 30+ | 公司可移植性（导出/导入） |
| `budget.ts`, `cost.ts`, `finance.ts` | 预算/成本/财务相关类型 | 计费和成本管理 |
| `agent-skills.ts`, `company-skill.ts` | Agent/公司技能类型 | 技能管理 |
| `search.ts` | `CompanySearchResult` | 公司搜索 |
| `heartbeat.ts`, `live.ts` | 心跳和实时事件 | Agent 活性检测 |
| `instance.ts` | `InstanceSettings`, `BackupRetentionPolicy` | 实例设置 |

### 3. Zod 校验器 (`validators/` 目录)

每个文件对应一组 API 请求体的 Zod 校验模式，与 `types/` 下的业务实体一一对应：

| 文件 | 主要校验器 | 说明 |
|------|-----------|------|
| `agent.ts` | `createAgentSchema`, `updateAgentSchema`, `wakeAgentSchema` | Agent CRUD |
| `issue.ts` | `createIssueSchema`, `updateIssueSchema`, `addIssueCommentSchema`, `issueExecutionPolicySchema` | Issue CRUD 和执行策略 |
| `routine.ts` | `createRoutineSchema`, `createRoutineTriggerSchema`, `runRoutineSchema` | 常规模板管理 |
| `plugin.ts` | `pluginManifestV1Schema`, `installPluginSchema`, `upsertPluginConfigSchema` | 插件安装与管理 |
| `project.ts` | `createProjectSchema`, `updateProjectSchema`, `createProjectWorkspaceSchema` | 项目管理 |
| `company.ts` | `createCompanySchema`, `updateCompanySchema` | 公司管理 |
| `access.ts` | `createCompanyInviteSchema`, `acceptInviteSchema`, `updateMemberPermissionsSchema` | 邀请和权限管理 |
| `secret.ts` | `envBindingSchema`, `createSecretSchema` | 密钥管理 |
| `budget.ts`, `cost.ts`, `finance.ts` | 预算/成本/财务校验 | 计费操作 |
| `environment.ts` | `createEnvironmentSchema`, `probeEnvironmentConfigSchema` | 环境管理 |
| `execution-workspace.ts` | `workspaceRuntimeControlTargetSchema` | 工作空间控制 |
| `text.ts` | `multilineTextSchema` | 多行文本工具 |
| `search.ts` | `companySearchQuerySchema` | 搜索参数 |

### 4. 工具函数 (`/*.ts` 顶层文件)

| 文件 | 核心函数 | 说明 |
|------|---------|------|
| `network-bind.ts` | `resolveRuntimeBind`, `validateConfiguredBindMode`, `inferBindModeFromHost` | 网络绑定地址解析 |
| `agent-url-key.ts` | `normalizeAgentUrlKey`, `deriveAgentUrlKey`, `isUuidLike` | Agent URL Key 生成 |
| `project-url-key.ts` | `normalizeProjectUrlKey`, `deriveProjectUrlKey`, `hasNonAsciiContent` | Project URL Key 生成 |
| `issue-references.ts` | `normalizeIssueIdentifier`, `findIssueReferenceMatches`, `extractIssueReferenceIdentifiers` | Issue 引用解析 |
| `project-mentions.ts` | `build*MentionHref`, `parse*MentionHref`, `extract*MentionIds` | Markdown 提及解析 |
| `routine-variables.ts` | `interpolateRoutineTemplate`, `extractRoutineVariableNames`, `syncRoutineVariablesWithTemplate` | 常规变量替换 |
| `environment-support.ts` | `adapterSupportsRemoteManagedEnvironments`, `getEnvironmentCapabilities` | 适配器环境支持查询 |
| `workspace-commands.ts` | `listWorkspaceCommandDefinitions`, `matchWorkspaceRuntimeServiceToCommand` | 工作空间命令解析和匹配 |
| `execution-workspace-guards.ts` | `isClosedIsolatedExecutionWorkspace` | 工作空间状态守卫 |
| `config-schema.ts` | `paperclipConfigSchema` | 实例配置校验 |
| `api.ts` | `API` 路由表 | 前端 API 路由常量 |
| `adapter-type.ts` | `agentAdapterTypeSchema` | 适配器类型校验 |
| `telemetry/client.ts` | `TelemetryClient` | 遥测数据收集和上报 |

---

## 数据模型

### 核心实体关系

```
Company
├── Agent (智能体，由 Adapter 驱动)
│   ├── AgentPermissions
│   ├── AgentInstructionsBundle (指令包)
│   ├── AgentConfigRevision (配置历史)
│   └── AgentAccessState (访问权限)
├── Project (项目)
│   ├── ProjectWorkspace (工作空间)
│   └── ProjectGoalRef (目标引用)
├── Issue (任务)
│   ├── IssueComment (评论)
│   ├── IssueDocument (文档，支持版本管理)
│   ├── IssueAttachment (附件)
│   ├── IssueLabel (标签)
│   ├── IssueRelation (关系：blocks)
│   ├── IssueExecutionPolicy (执行策略)
│   ├── IssueExecutionState (执行状态)
│   └── IssueThreadInteraction (线程交互：推荐任务/提问/确认)
├── Routine (常规模板)
│   ├── RoutineTrigger (触发器)
│   ├── RoutineRun (运行记录)
│   ├── RoutineVariable (变量)
│   └── RoutineRevision (版本快照)
├── Goal (目标)
├── Approval (审批)
├── BudgetPolicy / BudgetIncident (预算)
├── Environment / EnvironmentLease (环境)
├── Secret / EnvBinding (密钥)
└── Plugin (插件，可扩展平台)
    ├── PaperclipPluginManifestV1 (清单)
    ├── PluginJob / PluginWebhook
    ├── PluginDatabaseNamespace
    ├── PluginApiRoute
    ├── PluginUiSlot / PluginLauncher
    └── PluginState / PluginConfig
```

### 关键接口示例

**Agent:**
```typescript
interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;         // URL 友好标识符
  role: AgentRole;        // ceo / engineer / pm ...
  status: AgentStatus;    // active / paused / running ...
  adapterType: AgentAdapterType;  // process / http / acpx_local ...
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;  // 模型配置文件
}
```

**Issue:**
```typescript
interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;      // 父子层级
  title: string;
  status: IssueStatus;
  workMode: IssueWorkMode;      // standard / planning
  priority: IssuePriority;
  assigneeAgentId: string | null;
  executionPolicy?: IssueExecutionPolicy;   // 审批/review 策略
  executionState?: IssueExecutionState;     // 当前执行进度
  originKind?: IssueOriginKind;   // 来源（手动/常规模板/活性检测等）
}
```

**Plugin Manifest:**
```typescript
interface PaperclipPluginManifestV1 {
  id: string;              // 全局唯一标识
  apiVersion: 1;           // 协议版本
  version: string;         // semver
  capabilities: PluginCapability[];  // 所需能力
  entrypoints: { worker: string; ui?: string };
  jobs?: PluginJobDeclaration[];
  tools?: PluginToolDeclaration[];   // Agent 工具
  ui?: PluginUiDeclaration;          // UI 扩展
  agents?: PluginManagedAgentDeclaration[];  // 托管 Agent
  // ...
}
```

---

## 上下游依赖

### 被谁引用（作为依赖方）

`packages/shared` 被以下模块引用：

| 模块 | 引用方式 | 说明 |
|------|---------|------|
| `packages/server` | `import { ... } from "@paperclip/shared"` | 后端 API 参数校验、类型检查 |
| `packages/web` | `import { ... } from "@paperclip/shared"` | 前端类型定义和校验器 |
| `packages/adapter-*` | `import { ... } from "@paperclip/shared"` | 适配器引用常量 |
| `packages/plugins` | `import { ... } from "@paperclip/shared"` | 插件引用核心类型 |

### 自身依赖

- `zod` — 运行时校验库（唯一运行时依赖）
- 无其他外部依赖

---

## 文件统计

- 总计非测试 TypeScript 源文件：50+
- 业务常量组数：40+
- 核心 Interface 数量：200+
- Zod 校验器数量：100+
- 工具函数数量：30+
