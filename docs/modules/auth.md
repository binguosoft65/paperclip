# Auth 模块 —— 认证与授权系统

## 模块概述

Auth 模块是 Paperclip 平台的认证（Authentication）与授权（Authorization）基础设施，统一管理所有请求的身份识别和权限校验。平台中有两类主体（Principal）：**人类用户（User）**和 **AI Agent**，它们的认证方式和授权范围不同。

### 核心能力

- **多方式认证**：支持 Session Cookie（Web 登录）、Board API Key（CLI/API）、Agent API Key（持久化）、Agent JWT（临时令牌）、Cloud Tenant Token（多租户云部署）
- **统一 Actor 模型**：所有请求经过 `actorMiddleware` 后，生成标准化的 `req.actor` 对象，下游中间件和路由据此做授权决策
- **分层授权**：实例级（Instance Admin）-> 公司级（Company Membership）-> 权限键级（Permission Grant）
- **CLI 挑战-响应认证**：安全的双通道认证流程，CLI 端发起挑战，Board 端审批完成密钥交换

### 设计原则

- **最小权限**：默认拒绝所有操作（`actor.type === "none"`），需要显式认证和授权
- **多级回退**：认证方式按优先级尝试，一个失败自动降级到下一个
- **审计友好**：`req.actor.source` 字段记录认证来源，用于操作审计和问题排查

---

## 核心流程

### 认证流程

所有请求经过 `actorMiddleware`，按以下优先级依次尝试认证：

```
请求到达
  │
  ├── 1. local_trusted 模式？
  │      └── 是 → actor = { type: "board", 本地隐式信任 }
  │
  ├── 2. 非 Bearer 请求 → authenticated 模式？
  │      ├── Cloud Tenant Token（多租户云）
  │      │   └── 自动同步用户/公司/成员关系到本地数据库
  │      └── Better Auth Session（Web Cookie）
  │           └── 查询用户角色和公司成员关系
  │
  └── 3. Bearer Token 请求？
         ├── Board API Key（用户密钥，前缀 pcp_board_）
         │   └── 解析访问权限，更新最后使用时间
         ├── Agent API Key（哈希匹配，持久化密钥）
         │   └── 验证 Agent 状态，更新最后使用时间
         └── Agent JWT（HMAC-SHA256 令牌，48 小时有效）
              └── 验证签名、过期时间、Agent 存在性和公司匹配
```

### CLI 挑战-响应认证流程

```
CLI 端                        Board 端                     数据库
  │                             │                            │
  ├─ POST /api/access/cli-auth ─┤                            │
  │                             ├─ 创建挑战 + 预生成密钥     │
  │                             │  (pending 状态, 10 分钟 TTL)│
  │ ◄── 返回 challengeId       ─┤                            │
  │      + secret + url                       │              │
  │                             │                            │
  │ 用户打开 Board 审批页       │                            │
  │ (/cli-auth/:id?token=...)  │                            │
  │                             ├─ GET /api/access/cli-auth/:id
  │                             │  (用户查看挑战详情)        │
  │                             ├─ POST 批准                 │
  │                             │  (SELECT FOR UPDATE 事务)  │
  │                             ├─ 创建 Board API Key        │
  │                             │  (过期时间 30 天)          │
  │                             ├─ 更新挑战状态为 approved   │
  │                             │                            │
  │ CLI 轮询到已批准            │                            │
  │ ├─ 用预生成的 token 绑定    │                            │
  │ └─ 认证完成，开始操作       │                            │
```

### 授权流程

```
请求到达受保护路由
  │
  ├── assertAuthenticated → actor.type 是否为 "none"？
  │     └── 是 → 401 Unauthorized
  │
  ├── assertBoard → 是否要求人类用户操作？
  │     └── 否（Agent 无权限）→ 403 Forbidden
  │
  ├── assertCompanyAccess(companyId) →
  │     ├── Agent：只能访问所属公司
  │     └── Board：
  │           ├── 检查 userId 是否在公司成员列表中
  │           ├── 写操作额外检查：
  │           │   ├── 成员状态是否为 active
  │           │   └── 角色不能为 viewer（只读）
  │           └── 实例管理员绕过以上所有检查
  │
  └── permission_grant 检查（细粒度）→
        ├── 实例管理员自动拥有所有权限
        └── 普通用户需要明确的权限授权记录
```

---

## 关键文件及职责

### 服务端

| 文件 | 职责 |
|------|------|
| `server/src/middleware/auth.ts` | Actor 中间件 —— 请求认证入口，解析所有认证方式，生成标准化 actor 对象 |
| `server/src/routes/auth.ts` | 认证路由 —— session 查询、用户资料读写（登录/注册由 Better Auth 处理） |
| `server/src/routes/authz.ts` | 授权断言函数集 —— assertAuthenticated、assertBoard、assertCompanyAccess 等 |
| `server/src/services/access.ts` | 访问控制服务 —— 公司成员管理、权限授予、实例管理员管理 |
| `server/src/services/board-auth.ts` | Board 认证服务 —— Board API Key 管理、CLI 挑战认证流程 |
| `server/src/services/agent-permissions.ts` | Agent 权限模型 —— Agent 自身操作权限（如创建子 Agent） |
| `server/src/agent-auth-jwt.ts` | Agent JWT 签发和验证 —— HMAC-SHA256 令牌实现 |
| `server/src/auth/better-auth.ts` | Better Auth 集成 —— 第三方认证库适配层 |
| `server/src/routes/access.ts` | 访问控制路由 —— 邀请、加入请求、成员管理、CLI 认证的 API 端点 |
| `server/src/routes/workspace-runtime-service-authz.ts` | Workspace Runtime 服务授权 —— Agent 层级管理范围控制 |
| `server/src/routes/workspace-command-authz.ts` | 宿主机命令保护 —— 防止 Agent 修改宿主级 Workspace 命令 |
| `server/src/routes/workspace-command-authz.ts` | 同上（上条重复，应指向不同文件） |

### UI 端

| 文件 | 职责 |
|------|------|
| `ui/src/pages/Auth.tsx` | 登录/注册页面 —— 支持 sign_in / sign_up 双模式，session 检查后自动跳转 |
| `ui/src/pages/CliAuth.tsx` | CLI 认证审批页面 —— 挑战详情展示、批准/取消操作 |
| `ui/src/api/auth.ts` | 认证 API 客户端 —— session 查询、登录/注册、资料管理、错误解析 |

### 共享类型

| 文件 | 职责 |
|------|------|
| `packages/shared/src/types/access.ts` | 访问控制实体类型定义 —— 成员关系、权限授权、邀请、加入请求 |
| `packages/shared/src/validators/access.ts` | 请求参数校验 —— Zod Schema 定义 |

### 数据库 Schema

| 文件 | 职责 |
|------|------|
| `packages/db/src/schema/auth.ts` | 用户、Session、OAuth Account、验证码表 |
| `packages/db/src/schema/board_api_keys.ts` | Board API 密钥表（哈希存储，支持吊销和过期） |
| `packages/db/src/schema/cli_auth_challenges.ts` | CLI 认证挑战表（挑战-响应流程） |
| `packages/db/src/schema/company_memberships.ts` | 公司成员关系表（支持用户和 Agent 双主体） |
| `packages/db/src/schema/principal_permission_grants.ts` | 细粒度权限授予表 |
| `packages/db/src/schema/instance_user_roles.ts` | 实例级用户角色表 |

---

## 数据模型

### Actor 模型（运行时）

```typescript
type Actor =
  | { type: "board"; userId: string; userName: string | null; userEmail: string | null;
      companyIds: string[]; memberships: Membership[]; isInstanceAdmin: boolean;
      keyId?: string; runId?: string; source: ActorSource }
  | { type: "agent"; agentId: string; companyId: string; keyId?: string;
      runId?: string; source: "agent_jwt" | "agent_key" }
  | { type: "none"; source: "none" }
```

### 核心表关系

```
authUsers (user)
  ├── authSessions (session)        — 登录会话
  ├── authAccounts (account)        — OAuth 账号绑定
  ├── boardApiKeys                  — Board API 密钥
  ├── instanceUserRoles             — 实例级角色
  └── companyMemberships            — 公司成员关系（多对多）
        ├── companies               — 公司表
        └── principalPermissionGrants — 权限授予

agents (Agent)
  └── companyMemberships            — Agent 的公司成员关系
        └── principalPermissionGrants — Agent 权限授予

cliAuthChallenges
  ├── boardApiKeys (待创建)         — 审批后创建的密钥
  └── authUsers (审批人)
```

### 权限键（PermissionKey）

权限键用于 `principal_permission_grants` 表，定义在 `packages/shared/src/constants.ts`。

### 成员状态机

```
pending → active → suspended → archived
              ↑________________________|  (可恢复为 active)
```

### CLI 挑战状态机

```
pending → approved（已批准，创建密钥）
       → cancelled（已取消）
       → expired（已过期，10 分钟未处理）
```

---

## 上下游依赖

### 上游（Auth 模块依赖的服务）

- **Better Auth**（`better-auth` npm 包）：第三方认证库，处理密码哈希、Session 管理、OAuth 流程
- **Drizzle ORM**：数据库访问层，所有认证和授权数据持久化
- `packages/db`：数据库 Schema 定义和迁移管理

### 下游（依赖 Auth 模块的模块）

- **所有受保护路由**：通过 `assertAuthenticated`、`assertCompanyAccess` 等函数进行授权检查
- **Activity Log 模块**：通过 `getActorInfo` 获取操作主体信息用于审计日志
- **Agent 管理**：使用 `agent-permissions.ts` 和 `workspace-runtime-service-authz.ts` 进行 Agent 权限控制
- **公司管理**：使用 `access.ts` 进行成员管理和邀请流程
- **CLI 工具**：通过 `board-auth.ts` 的挑战-响应流程完成 API 密钥绑定
