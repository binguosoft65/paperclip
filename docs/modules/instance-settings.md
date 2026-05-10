# Instance Settings 模块 —— 实例级配置管理

## 模块概述

Instance Settings 模块是 Paperclip 平台的实例级全局配置中心，管理影响所有公司（Organization）的全局设置项。该模块采用单行模式（Singleton），数据库中始终只存在一行配置记录，所有公司共享同一套实例级配置。

### 核心概念

- **通用设置（General Settings）**：影响实例日常运行的全局配置，包括日志脱敏、键盘快捷键、反馈数据共享偏好和数据库备份保留策略。
- **实验性设置（Experimental Settings）**：平台处于孵化阶段的功能开关，默认全部关闭，需要管理员显式开启。包括环境管理、独立工作空间、开发服务器闲置重启和 Issue 活性自动恢复。
- **心跳仪表板（Heartbeat Dashboard）**：查看和管理所有 Agent 的心跳状态，支持单个开关和批量禁用。
- **访问控制（Instance Access）**：管理用户的实例级角色（Instance Admin）和公司访问权限。
- **数据库备份（Database Backups）**：手动触发全量数据库备份，支持配置保留策略（日/周/月三级）。

### 设计原则

- **单例模式（Singleton）**：实例配置只存一行，通过 `singleton_key` 唯一索引保证。简化读写逻辑，避免多行冲突。
- **读放写严**：通用设置和实验性设置的 GET 请求仅需 `board` 类型认证，PATCH 请求需 Instance Admin 权限。普通组织成员可查看配置但不允许修改。
- **安全兜底**：通过 Zod schema 进行运行时校验（`normalizeGeneralSettings`/`normalizeExperimentalSettings`），数据库中的陈旧数据不会导致系统崩溃，解析失败时回退到全默认值。
- **审计全广播**：所有配置变更操作向所有公司（`companies` 表）写入审计日志，满足多租户合规要求。

---

## 核心流程

### 1. 读取实例配置

```
请求 → assertBoardOrgAccess（验证 board 身份）
     → getOrCreateRow（三层兜底：查库 → INSERT → 重查）
     → normalizeGeneralSettings / normalizeExperimentalSettings（数据规范化）
     → 返回标准化后的配置对象
```

- `getOrCreateRow` 采用三层兜底机制：
  1. 先查询已有行；
  2. 不存在则 INSERT（`onConflictDoUpdate` 处理并发竞态）；
  3. INSERT 返回空时再查一次（罕见并发回显问题）。
- `normalize*` 函数使用 `safeParse` 而非 `parse`，因为数据库中可能存储了旧的 schema 格式数据，直接 `parse` 会抛出异常。

### 2. 更新实例配置

```
请求 → assertCanManageInstanceSettings（校验 Instance Admin 权限）
     → validate（Zod schema 校验请求体）
     → getOrCreateRow → 合并当前值 + patch 字段
     → 写入数据库（更新时间戳）
     → 向所有公司写入审计日志（含 changedKeys 记录这次改了什么）
     → 返回更新后的配置
```

- 采用"偏更新"模式：前端只发送需要变更的字段，未发送的字段保留原值。
- 审计日志记录 `changedKeys`（排序后的变更字段数组），方便追踪每次变更的影响范围。
- 更新操作同时刷新 `updatedAt` 时间戳。

### 3. 数据库备份

```
手动触发 → assertInstanceAdmin（校验权限）
         → runManualBackup（执行 pg_dump 或其他备份机制）
         → 返回备份结果（含触发方式、文件路径、保留策略、耗时等）
```

- 只有 Instance Admin 可以触发手动备份，因为备份文件包含所有公司的全量数据。
- 备份结果包含 `durationMs` 字段，可用于后续监控告警（过长备份可能暗示表锁或磁盘性能问题）。
- 备份触发来源区分 `manual`（手动）和 `scheduled`（定时），用于审计和运维排障。

### 4. Issue 活性自动恢复

```
开启预览 → 校验 Instance Admin 权限
         → buildIssueGraphLivenessAutoRecoveryPreview（只读查询，不产生变更）
         → 返回可恢复的 Issue 列表预览

执行恢复 → 校验 Instance Admin 权限
         → reconcileIssueGraphLiveness（force=true 允许覆盖已处理记录）
         → 创建升级 Issue（escalation issue）
         → 向所有公司写入审计日志（含创建数量、跳过数等）
```

- 预览是一个安全的只读操作，不产生任何数据变更。
- `force=true` 表示管理员手动触发，绕过"仅处理未处理"的限制，允许对已处理过的 Issue 再次扫描。
- 回看窗口（lookbackHours）默认 24 小时，合法范围 1~720 小时（30 天）。

### 5. 用户访问管理

```
搜索用户 → searchAdminUsers（按名称/邮箱搜索）
         → 选中用户 → 查看用户公司访问权限
         → 修改实例级角色（提升/撤销 Instance Admin）
         → 修改公司访问权限（批量增删公司成员关系）
```

- 默认选中搜索结果中的第一个用户，减少操作步骤。
- Instance Admin 的授予和撤销分别通过 `promoteInstanceAdmin` / `demoteInstanceAdmin` 接口，UI 中明确区分两种操作意图。
- 公司访问权限采取"全量替换"模式：将客户端传入的选中公司 ID 集合视为用户应有的全部权限，后端据此增删成员关系记录。

---

## 关键文件

| 文件 | 模块层次 | 职责 |
|------|----------|------|
| `server/src/routes/instance-settings.ts` | 后端路由 | 通用设置和实验性设置的 CRUD 路由、Issue 活性恢复预览/执行入口 |
| `server/src/routes/instance-database-backups.ts` | 后端路由 | 手动数据库备份的路由 |
| `server/src/services/instance-settings.ts` | 后端服务 | 配置的存取逻辑、数据规范化、默认值填充、公司 ID 列表查询 |
| `ui/src/pages/InstanceSettings.tsx` | 前端页面 | 心跳仪表板（所有 Agent 心跳状态概览和管理） |
| `ui/src/pages/InstanceGeneralSettings.tsx` | 前端页面 | 通用设置编辑页面（日志脱敏、快捷键、备份策略、反馈偏好等） |
| `ui/src/pages/InstanceExperimentalSettings.tsx` | 前端页面 | 实验性功能开关和 Issue 活性恢复配置页面 |
| `ui/src/pages/InstanceAccess.tsx` | 前端页面 | 用户访问权限管理（Instance Admin 角色和公司权限） |
| `ui/src/components/SystemNotice.tsx` | 前端组件 | 系统通知通用组件，用于 Issue 评论等位置的系统级提示信息展示 |
| `packages/shared/src/types/instance.ts` | 共享类型 | 实例设置的数据类型定义和常量（保留策略预设值、回看窗口限制等） |
| `packages/shared/src/validators/instance.ts` | 共享校验 | Zod 校验 schema 定义（请求体校验和数据规范化） |
| `packages/db/src/schema/instance_settings.ts` | 数据库模型 | `instance_settings` 表结构定义（单行模式、JSONB 字段存储配置） |

---

## 数据模型

### instance_settings 表（数据库）

```sql
CREATE TABLE instance_settings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key TEXT NOT NULL DEFAULT 'default',
  general       JSONB NOT NULL DEFAULT '{}',    -- 通用设置
  experimental  JSONB NOT NULL DEFAULT '{}',    -- 实验性设置
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 唯一索引保证单行约束
  CONSTRAINT instance_settings_singleton_key_idx UNIQUE (singleton_key)
);
```

### InstanceGeneralSettings（通用设置结构）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `censorUsernameInLogs` | boolean | `false` | 是否在日志中脱敏用户名（隐私合规） |
| `keyboardShortcuts` | boolean | `false` | 是否启用键盘快捷键 |
| `feedbackDataSharingPreference` | "prompt" \| "allowed" \| "not_allowed" | `"prompt"` | 用户反馈数据共享偏好（GDPR 合规） |
| `backupRetention.dailyDays` | 3 \| 7 \| 14 | `7` | 日备保留天数 |
| `backupRetention.weeklyWeeks` | 1 \| 2 \| 4 | `4` | 周备保留周数 |
| `backupRetention.monthlyMonths` | 1 \| 3 \| 6 | `1` | 月备保留月数 |

### InstanceExperimentalSettings（实验性设置结构）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableEnvironments` | boolean | `false` | 启用环境管理功能 |
| `enableIsolatedWorkspaces` | boolean | `false` | 启用独立工作空间 |
| `autoRestartDevServerWhenIdle` | boolean | `false` | 空闲时自动重启开发服务器 |
| `enableIssueGraphLivenessAutoRecovery` | boolean | `false` | 启用 Issue 活性自动恢复 |
| `issueGraphLivenessAutoRecoveryLookbackHours` | number (1~720) | `24` | 活性检测回看窗口（小时） |

---

## 上下游依赖

### 上游依赖（被调用）

- **Auth 模块**：`assertBoardOrgAccess` 和 `assertInstanceAdmin` 进行身份认证和权限校验。
- **Heartbeat 服务**：`heartbeatService.reconcileIssueGraphLiveness` 和 `buildIssueGraphLivenessAutoRecoveryPreview` 用于 Issue 活性恢复。
- **审计日志服务**：`logActivity` 将配置变更写入审计日志。
- **Agent API**：`agentsApi.get` / `agentsApi.update` 用于心跳开关操作。
- **Access API**：`accessApi.searchAdminUsers` / `getUserCompanyAccess` / `setUserCompanyAccess` / `promoteInstanceAdmin` / `demoteInstanceAdmin` 用于用户访问管理。

### 下游依赖（依赖于此模块）

- **所有前端页面**：通用设置中的 `keyboardShortcuts` 影响整个 UI 的快捷键行为。
- **审计系统**：所有配置变更通过审计日志记录，供安全审计和问题排查使用。
- **备份调度器**：`backupRetention` 策略控制数据库备份的保留周期和清理逻辑。
- **环境和工作空间子系统**：`enableEnvironments` 和 `enableIsolatedWorkspaces` 控制这些功能的可用性。
- **调度器（Scheduler）**：心跳仪表板影响所有 Agent 的定时任务调度行为。
- **Plugin 系统**：实验性设置中的各个开关为插件系统提供了功能门控（feature gating）能力。
