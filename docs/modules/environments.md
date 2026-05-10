# Environments 模块

## 模块概述

Environments 模块管理 Paperclip 中所有"运行环境"的生命周期。运行环境定义了 Agent 工作负载的执行位置，包括三种驱动类型和一种插件扩展机制：

- **local** — 宿主机本地进程（默认兜底）
- **ssh** — 通过 SSH 连接到远程服务器执行
- **sandbox** — 在沙箱（容器/VM）中隔离执行
- **plugin** — 通过插件扩展的自定义驱动

每个公司默认有一个 Local 环境，可在设置页中添加 SSH 或沙箱环境。每个环境在 run 执行时通过"租约（Lease）"机制管理资源的分配与释放。

## 核心概念

### 环境驱动 (Environment Driver)

环境驱动决定 Agent 如何与目标执行节点通信：

| Driver | 传输方式 | 适用场景 | 关键约束 |
|--------|----------|----------|----------|
| local | 本地进程 | 开发测试、简单任务 | 无远程能力 |
| ssh | SSH 通道 | 远程服务器执行 | 需要主机、用户名、私钥 |
| sandbox | 插件 Provider | 隔离沙箱（Docker/K8s/Cloud VM） | fake provider 仅用于 probe |
| plugin | 插件 RPC | 自定义执行环境 | 需要插件 worker 运行 |

### 租约 (Lease)

租约是环境资源分配的核心抽象，记录一次 run 对环境的占用。

**关键字段**：
- `status`: active / released / expired / failed / retained
- `leasePolicy`: ephemeral（用完即释放）/ reuse_by_environment（可复用）/ retain_on_failure（失败保留供调试）
- `providerLeaseId`: 下游 provider 的资源标识（如容器 ID、VM ID）
- `heartbeatRunId`: 关联的 heartbeat run，用于 run 结束时批量释放

**租约生命周期**：

```
acquire → active → release → released
                  ↘ retain_on_failure → retained
                  ↘ heartbeat timeout → expired
                  ↘ run 异常 → failed
```

### 环境选择优先级链

当 run 需要决定使用哪个环境时，按以下优先级依次解析（自上而下覆盖）：

```
1. 执行工作空间 (execution workspace) 配置
2. Issue 设置
3. 项目策略 (project policy)
4. Agent 默认环境
5. 公司默认环境 (= Local，自动创建)
```

## 核心流程

### 1. 环境 CRUD

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│  前端表单    │────→│ normalizeConfig  │────→│  数据库持久化   │
│ (UI 页面)   │     │ (secret_ref 转换) │     │ (environments) │
└─────────────┘     └──────────────────┘     └────────────────┘
```

- 创建/更新时，SSH 私钥等敏感字段自动转为 `secret_ref` 加密存储
- fake 沙箱不可保存（仅用于探测）
- 删除时级联清理所有引用了该环境的执行工作空间、Issue 和 Project

### 2. 环境探测 (Probe)

```
用户点击 "Test Connection" → normalizeConfigForProbe → probeEnvironment
                                 ├── local: 返回 hostname
                                 ├── ssh:   ensureSshWorkspaceReady
                                 ├── sandbox: 委托 provider 探测
                                 └── plugin: 委托插件驱动探测
```

探测使用独立的 schema（`sshEnvironmentConfigProbeSchema`），允许传入明文私钥。

### 3. Run 执行前的环境准备

```
environmentRunOrchestrator.acquireForRun()
    │
    ├── 1. resolveEnvironment      — 按优先级链选择环境
    ├── 2. acquireRunLease          — 获取租约（本地=立即/SSH=连接/沙箱=创建）
    ├── 3. resolveTransport         — 生成 adapter 执行目标
    └── 4. realizeForRun           — 准备 workspace + 执行 provision
```

SSH 环境的租约获取包含 `ensureSshWorkspaceReady`（自动创建远程工作目录）。
沙箱环境的租约获取包含 provider 资源创建（容器启动等耗时操作）。

### 4. 租约释放

```
environmentRunOrchestrator.releaseForRun()
    │
    ├── 遍历该 run 的所有活跃租约
    ├── 调用对应 driver 的 releaseRunLease
    │   ├── sandbox: 释放 provider 资源（销毁容器等）
    │   ├── ssh: 断开连接
    │   └── local: 无操作
    └── 记录 activity log
```

**重要设计决策**：ad-hoc 测试（heartbeatRunId === null）的租约永远不可复用（policy=ephemeral），防止探测操作意外销毁正在运行的任务沙箱。

### 5. 工作空间关闭

关闭执行工作空间时的清理流程：

```
1. 检查 close readiness（Git 状态、关联 issue）
2. 停止运行时服务
3. 执行 cleanup 命令 → teardown 命令
4. 删除 git worktree（如有）
5. 删除运行时创建的本地目录
6. 归档数据库记录
```

## 关键文件

### 服务层

| 文件 | 职责 |
|------|------|
| `server/src/services/environments.ts` | 环境数据访问 + 租约 CRUD |
| `server/src/services/environment-config.ts` | 配置校验、secret_ref 转换、driver 配置解析 |
| `server/src/services/environment-probe.ts` | 环境连通性探测（SSH连接/沙箱 provider 检查） |
| `server/src/services/environment-runtime.ts` | 驱动注册表 + 各 driver 的 lease acquire/release 实现 |
| `server/src/services/environment-execution-target.ts` | 环境 + 租约 → Adapter 执行目标转换 |
| `server/src/services/environment-run-orchestrator.ts` | run 流程编排：选择→获取→释放 |
| `server/src/services/execution-workspace-policy.ts` | 环境选择优先级链解析 |
| `server/src/services/execution-workspaces.ts` | 执行工作空间 CRUD + 关闭准备检查 |
| `server/src/services/sandbox-provider-runtime.ts` | 内置沙箱 provider 运行时（Docker等） |
| `server/src/services/plugin-environment-driver.ts` | 插件环境驱动管理 |

### 路由层

| 文件 | 职责 |
|------|------|
| `server/src/routes/environments.ts` | 环境 CRUD、probe、capabilities API |
| `server/src/routes/environment-selection.ts` | 环境选择校验（driver/provider 白名单） |
| `server/src/routes/execution-workspaces.ts` | 执行工作空间 CRUD + 运行时服务控制 |

### 客户端

| 文件 | 职责 |
|------|------|
| `ui/src/pages/CompanyEnvironments.tsx` | 环境管理页（列表、表单、probe 按钮） |
| `ui/src/pages/ExecutionWorkspaceDetail.tsx` | 执行工作空间详情（配置、日志、routines） |

### 共享

| 文件 | 职责 |
|------|------|
| `packages/shared/src/environment-support.ts` | Adapter-Environment 兼容性矩阵定义 |

## 数据模型

### environments 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| company_id | UUID | 所属公司 |
| name | string | 环境名称（用户可见） |
| driver | enum | local / ssh / sandbox / plugin |
| status | enum | active / archived |
| config | jsonb | 驱动配置，SSH私钥以 secret_ref 存储 |
| metadata | jsonb? | 系统标记（managedByPaperclip 等） |

### environment_leases 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| environment_id | UUID | 关联环境 |
| execution_workspace_id | UUID? | 关联执行工作空间 |
| issue_id | UUID? | 关联 Issue |
| heartbeat_run_id | string? | 关联 heartbeat run |
| status | enum | active/released/expired/failed/retained |
| lease_policy | enum | ephemeral/reuse_by_environment/retain_on_failure |
| provider | string? | 下游 provider 类型 |
| provider_lease_id | string? | provider 资源标识 |
| acquired_at | timestamp | 获取时间 |
| expires_at | timestamp? | 到期时间 |
| released_at | timestamp? | 释放时间 |
| cleanup_status | enum? | success/failed |

### execution_workspaces 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| company_id | UUID | 所属公司 |
| project_id | UUID | 关联项目 |
| project_workspace_id | UUID? | 关联项目工作空间 |
| source_issue_id | UUID? | 源 Issue |
| mode | enum | shared_workspace/isolated_workspace/operator_branch/agent_default |
| cwd | string? | 工作目录路径 |
| metadata | jsonb? | 环境选择配置、运行时服务状态等 |

environmentId 通过 `metadata.config.environmentId` 存储在 execution_workspaces 的 metadata 中。
解析时走 `resolveExecutionWorkspaceEnvironmentId` 优先级链。

## 上下游依赖

### 上游依赖

- **Activity Log**: 环境操作记录审计日志
- **Secrets**: 敏感配置（SSH 私钥）加密存储
- **Adapters**: 与适配器类型相关联，不同适配器对环境的支持能力不同
- **Plugin System**: 插件提供的沙箱 provider 和自定义驱动

### 下游依赖

- **Execution Workspace**: 环境选择结果配置在执行工作空间中
- **Issues**: Issue 可以设置运行环境偏好
- **Projects**: 项目可以设定环境策略（默认环境、允许的 provider）
- **Heartbeat Run**: Run 在执行前获取环境租约，结束时释放

## 关键业务规则

1. **fake 沙箱不可用于运行** — fake provider 仅用于探测和本地测试，选择时会被拦截
2. **ad-hoc 探测不可复用租约** — 无 heartbeatRunId 的探测请求不能复用已有沙箱，防止探测结束时级联销毁正在运行的任务
3. **SSH 私钥以 secret_ref 存储** — 数据库中不存明文私钥，持久化时自动转换为加密 secret
4. **retain_on_failure 策略** — run 失败时保留沙箱/SSH 连接供人工调试，租约状态为 retained
5. **删除环境级联清理** — 删除环境会清除所有 execution workspace、issue、project 中对该环境的引用，并删除关联的 SSH 私钥 secret
6. **Local 环境始终存在** — `ensureLocalEnvironment` 通过 `onConflictDoNothing` 保证每个公司至少有一个 Local 环境
