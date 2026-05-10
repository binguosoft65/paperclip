# Plugins 模块

## 模块概述

Plugins 模块是 Paperclip 平台的扩展系统，允许第三方开发者通过标准化的插件机制扩展平台功能。插件以独立的 npm 包形式分发，拥有自己的 worker 进程、数据库 schema、UI 插槽和工具集。

### 核心概念

- **Plugin（插件）**：一个自包含的扩展包，拥有自己的 manifest、worker 进程、数据库 schema 和 UI 组件。
- **Manifest**：插件的声明文件（`paperclipPlugin` 字段），定义了插件的元数据、能力声明、工具、事件订阅、UI 插槽等。
- **Plugin 状态机**：`installed -> ready -> disabled -> error -> upgrade_pending -> uninstalled`
- **Worker 进程**：每个插件拥有一个独立的子进程，通过 JSON-RPC 2.0 与宿主通信。崩溃隔离确保插件故障不影响主进程。
- **工具（Tool）**：插件通过 manifest 声明可供 Agent 调用的工具，命名空间格式为 `<pluginId>:<toolName>`。
- **UI 插槽（Slot）**：插件可以在宿主 UI 中注入自定义组件，支持 page、sidebar、setting 等插槽类型。
- **事件总线（Event Bus）**：进程内事件路由，插件可以订阅核心域事件或监听其他插件的事件。
- **数据库命名空间**：每个拥有数据库需求的插件获得独立的 Postgres schema，实现存储隔离。

---

## 核心流程

### 1. 插件发现与安装

```
发现（discoverAll）
  → 扫描本地目录（DEFAULT_LOCAL_PLUGIN_DIR）
  → 扫描 npm 已安装包（@paperclipai/plugin-* / paperclip-plugin-*）
  → 返回已安装插件的清单

安装（installPlugin）
  → 权限检查（assertInstanceAdmin）
  → 解析包（npm install / local path）
  → 验证 manifest（ManifestValidator.parseOrThrow）
  → 校验版本兼容性（apiVersion in SUPPORTED_VERSIONS）
  → 校验能力一致性（capabilities 声明与实际使用匹配）
  → 执行数据库迁移（runPluginMigrations）
  → 持久化插件记录（registry.install）
  → 激活生命周期（lifecycle.load -> ready）
```

- 发现阶段使用三层策略：本地文件系统（`localPluginDir`）→ npm 包 → 未来注册中心。
- 包名必须匹配 `pluginPackageNamePattern`（`@paperclipai/plugin-*` 或 `paperclip-plugin-*`）。
- 通过路径去重（`deduplicateByPath`）：如果两个发现来源指向同一路径，只加载一次。
- npm install 使用 `--ignore-scripts` 防止插件在安装时执行任意代码。

### 2. 生命周期管理

```
状态转换流程：
  installed → ready (load: 验证 → 启动 worker → 注册工具 → 注册定时任务)
  ready → disabled    (disable: 停止 worker → 注销工具 → 取消定时任务)
  ready → error       (markError: 停止 worker → 记录错误)
  ready → upgrade_pending (markUpgradePending: 停止 worker → 等待审批)
  upgrade_pending → ready (enable: 启动新版本 worker)
  any → uninstalled   (unload: 停止 worker → 清理 artifact → 软/硬删除)
```

- 每个状态转换由 `VALID_TRANSITIONS` 映射表强制执行，非法转换抛出 `BadRequest`。
- Worker 在进入 ready 时启动，离开 ready 时优雅关闭。
- 三阶段关闭策略：10s drain（RPC shutdown）→ SIGTERM（5s）→ SIGKILL（2s）。
- 崩溃恢复：指数退避（1s → 2s → 4s → ... → 5min），25% jitter，10 次后停止。

### 3. 工具调度

```
Agent 调用工具
  → dispatcher.executeTool("acme.linear:search-issues", params, context)
  → registry 解析命名空间为 (pluginId, toolName)
  → 验证工具已注册且 worker 在运行
  → workerManager.call(pluginId, "executeTool", rpcParams)
  → JSON-RPC 转发到插件 worker 进程
  → worker 执行工具逻辑并返回结果
```

- 工具命名空间格式：`<pluginId>:<toolName>`（如 `acme.linear:search-issues`）。
- 注册表纯内存存储，双索引（byNamespace O(1) + byPlugin 批量操作）。
- 生命周期事件自动注册/注销工具（fire-and-forget 模式）。
- 参数使用 JSON Schema 验证后再转发到 worker。

### 4. 事件系统

```
宿主发出域事件 → 事件总线遍历所有插件的订阅
  → matchesPattern 匹配事件类型
  → passesFilter 应用服务端过滤器
  → 并发调用所有匹配的 handler
  → 收集错误（不阻止其他插件的投递）
```

- 仅支持尾部通配符（`plugin.foo.*`），不支持前缀通配符或全 glob。
- 插件发出的事件自动添加 `plugin.<pluginId>.` 前缀，防止跨命名空间伪造。
- 服务端 EventFilter 可以按 companyId、projectId、agentId 过滤。
- 每个插件的订阅列表隔离，一个插件不能查看另一个插件的订阅。

### 5. 数据库 Schema 管理

```
安装时：
  → derivePluginDatabaseNamespace 生成唯一命名空间
  → 在 Postgres 中创建 schema
  → 读取插件 migrations 目录中的 .sql 文件
  → 对每个 SQL 语句执行安全校验
    → 禁止 DROP/TRUNCATE
    → 禁止 CREATE EXTENSION / GRANT / COPY
    → 必须使用完全限定 schema 名
  → 按顺序执行迁移，计算 checksum
  → 记录迁移历史
```

- 命名空间格式：`plugin_{slug}_{hash}`（slug 可读 + hash 防碰撞）。
- Phase 1 禁止破坏性操作（DROP、TRUNCATE），防止插件误删数据。
- 运行时 SQL 限制：`ctx.db.query` 只允许 SELECT；`ctx.db.execute` 只允许 INSERT/UPDATE/DELETE。
- 所有 SQL 必须限定在插件自己的 schema 内，不允许跨 schema 操作。

### 6. 生命周期终结

- **软删除（unload + removeData=false）**：状态标记为 `uninstalled`，保留数据库记录用于审计，支持重新安装。
- **硬删除（unload + removeData=true）**：在事务中级联删除所有关联数据（配置、设置、job 记录等），不可逆。
- 已卸载的插件再次调用 unload 需要传 `removeData=true`，防止重复软删除。

---

## 关键文件及职责

### Server 端

| 文件 | 职责 |
|------|------|
| `server/src/services/plugin-loader.ts` | 插件加载器入口：发现、安装、激活、关闭；三层发现策略、npm 安装、API 版本校验、能力一致性检查、原子安装事务、运行时激活 |
| `server/src/services/plugin-lifecycle.ts` | 生命周期状态机：状态转换验证、worker 协调、事件触发、持久化 |
| `server/src/services/plugin-worker-manager.ts` | Worker 进程管理：spawn、RPC 通信（JSON-RPC 2.0）、崩溃恢复（指数退避）、三阶段优雅关闭 |
| `server/src/services/plugin-tool-dispatcher.ts` | 工具调度：Agent 与插件工具系统的集成点、生命周期事件注册/注销、工具执行路由 |
| `server/src/services/plugin-tool-registry.ts` | 工具注册表：纯内存双索引结构（byNamespace + byPlugin）、命名空间解析 |
| `server/src/services/plugin-event-bus.ts` | 事件总线：进程内事件路由、命名空间隔离、通配符匹配、服务端过滤 |
| `server/src/services/plugin-registry.ts` | 持久层：CRUD 操作（plugins、plugin_config、plugin_company_settings 等表） |
| `server/src/services/plugin-database.ts` | 数据库管理：命名空间派生、迁移执行、SQL 安全校验（DDL 白名单、禁止危险操作） |
| `server/src/services/plugin-manifest-validator.ts` | Manifest 校验：Zod schema 验证版本兼容性 |
| `server/src/services/plugin-config-validator.ts` | 配置校验：Ajv JSON Schema 验证插件实例配置 |
| `server/src/services/plugin-state-store.ts` | 状态存储：五部分复合键（pluginId, scopeKind, scopeId, namespace, stateKey）的 KV 存储 |
| `server/src/services/plugin-dev-watcher.ts` | 开发模式热重载：chokidar 监听本地路径插件变化，debounce 后重启 worker |
| `server/src/services/plugin-job-scheduler.ts` | 定时任务调度：30s tick 循环、cron 解析、重叠预防、并发限制 |
| `server/src/services/plugin-job-coordinator.ts` | Job 协调器：生命周期与调度器的桥梁 |
| `server/src/services/plugin-managed-agents.ts` | 托管 Agent：插件声明的 Agent 创建、协调、重置 |
| `server/src/services/plugin-managed-routines.ts` | 托管 Routine：插件声明的 Routine 创建、协调、重置、执行 |
| `server/src/services/plugin-environment-driver.ts` | 环境驱动：插件声明的沙箱提供者抽象 |
| `server/src/routes/plugins.ts` | REST API 路由：插件 CRUD、状态管理、工具执行 |
| `server/src/routes/plugin-ui-static.ts` | UI 静态资源服务：插件 UI 包托管、内容 hash 缓存、SSRF 保护的 dev proxy |

### UI 端

| 文件 | 职责 |
|------|------|
| `ui/src/pages/PluginManager.tsx` | 插件管理列表页：浏览、安装、卸载、启用/禁用插件 |
| `ui/src/pages/PluginSettings.tsx` | 插件设置页：配置管理、UI 插槽渲染、状态显示 |
| `ui/src/pages/PluginPage.tsx` | 插件运行时页面：公司上下文内渲染插件 page 插槽 |

---

## 数据模型

### plugins 表（主表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| plugin_key | string | 插件唯一标识符（来自 manifest.id，如 "acme.linear"） |
| package_name | string | npm 包名（如 "@acme/paperclip-plugin-linear"） |
| package_path | string? | 本地路径（仅 local path 安装的插件有值） |
| version | string | 当前安装版本 |
| api_version | number | 插件 API 版本 |
| status | enum | installed / ready / disabled / error / upgrade_pending / uninstalled |
| manifest_json | JSONB | 完整 manifest 内容 |
| categories | string[] | 分类标签 |
| install_order | number | 安装顺序（用于 UI 排序） |
| last_error | string? | 最后一次错误消息 |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

### plugin_config 表

| 字段 | 说明 |
|------|------|
| plugin_id | FK to plugins |
| company_id | UUID（company 级配置）或 null（全局配置）|
| config_json | JSONB 配置内容 |

### plugin_state 表

| 字段 | 说明 |
|------|------|
| plugin_id | FK to plugins |
| scope_kind | 作用域类型（instance / company / project）|
| scope_id | 作用域 ID（可为 null）|
| namespace | 插件内部命名空间 |
| state_key | 状态键 |
| state_value | JSONB 状态值 |

### plugin_migrations 表

| 字段 | 说明 |
|------|------|
| plugin_id | FK to plugins |
| filename | 迁移文件名 |
| checksum | 文件内容 SHA-256 校验和 |
| applied_at | 执行时间 |

### plugin_jobs / plugin_job_runs 表

Job 和 Run 的标准 cron 调度表，支持 overlap 预防、执行记录和手动触发。

### plugin_webhook_deliveries 表

Webhook 投递记录，包含请求/响应、重试次数和投递状态。

---

## 上下游依赖

### 上游依赖（Plugins 模块依赖的其他模块）

| 模块 | 依赖内容 |
|------|---------|
| DB (`@paperclipai/db`) | 数据模型定义和查询能力（Drizzle ORM） |
| Shared (`@paperclipai/shared`) | 类型定义、Zod schema（manifest、config）、常量 |
| Plugin SDK (`@paperclipai/plugin-sdk`) | JSON-RPC 协议、ToolRunContext、事件类型 |
| Error Service (`server/src/errors.ts`) | HTTP 错误类型（badRequest、notFound、conflict 等） |
| Authz Service (`server/src/routes/authz.ts`) | 权限检查（assertInstanceAdmin、assertBoard 等） |
| Agent Service | Agent 上下文（ToolRunContext）和工具调用 |
| Activity Log | 安装/卸载/升级等操作审计 |
| Live Events | Worker 崩溃/重启的实时事件推送 |

### 下游依赖（依赖 Plugins 模块的其他模块）

| 模块 | 依赖内容 |
|------|---------|
| Agent Service | 通过 PluginToolDispatcher 发现和执行插件工具 |
| UI Framework | 通过 PluginSlotMount 渲染插件 UI 插槽 |
| Heartbeat | 插件声明的 Agent 参与运行调度 |
| Routine Service | 插件声明的 Routine 参与定时执行 |
| Environment Service | 插件声明的 environment driver 提供运行环境 |
