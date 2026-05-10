# CLI 命令行工具模块

## 模块概述

`cli/src/` 是 `paperclipai` 命令行工具的源码模块。该 CLI 是 Paperclip 平台的统一运维入口，覆盖以下场景：

- **首次安装与配置**：`onboard` 向导式安装，`configure` 分节修改配置
- **健康诊断**：`doctor` 九项检查 + 自动修复
- **一键启动**：`run` 命令串联 onboard、doctor 和 server 启动
- **资源管理**：通过 REST API 管理 agents、companies、issues、approvals 等平台资源
- **运维工具**：数据库备份、环境变量导出、心跳手动触发、worktree 管理、env-lab 测试容器

## 核心命令列表

| 命令 | 用途 | 关键文件 |
|------|------|----------|
| `onboard` | 首次启动交互式安装向导 | `commands/onboard.ts` |
| `configure` | 分节修改现有配置（llm/database/logging/server/storage/secrets） | `commands/configure.ts` |
| `run` | 一键启动：onboard（按需）-> doctor -> server | `commands/run.ts` |
| `doctor` | 全面诊断检查 + 自动修复 | `commands/doctor.ts` |
| `env` | 输出部署环境变量（export 块） | `commands/env.ts` |
| `db:backup` | 执行一次性数据库备份 | `commands/db-backup.ts` |
| `allowed-hostname` | 添加允许的主机名（authenticated/private 模式） | `commands/allowed-hostname.ts` |
| `heartbeat run` | 手动触发 Agent 心跳并流式查看日志 | `commands/heartbeat-run.ts` |
| `auth bootstrap-ceo` | 生成一次性 CEO 邀请链接 | `commands/auth-bootstrap-ceo.ts` |
| `routines disable-all` | 紧急停用指定公司所有非归档 routine | `commands/routines.ts` |
| `env-lab up/down/status/doctor` | 管理本地 SSH 测试环境容器 | `commands/env-lab.ts` |
| `worktree *` | Git worktree 协作工作流管理 | `commands/worktree.ts` |
| `context *` | CLI 上下文/Profile 管理 | `commands/client/context.ts` |
| `company *` | 公司资源 CRUD | `commands/client/company.ts` |
| `agent *` | Agent 资源和密钥管理 | `commands/client/agent.ts` |
| `approval *` | 审批流程管理 | `commands/client/approval.ts` |
| `issue *` | Issue 跟踪 | `commands/client/issue.ts` |
| `activity *` | 活动日志 | `commands/client/activity.ts` |
| `dashboard *` | 仪表盘数据 | `commands/client/dashboard.ts` |
| `feedback *` | 用户反馈 | `commands/client/feedback.ts` |
| `plugin *` | 插件管理 | `commands/client/plugin.ts` |

## 关键文件及职责

### 入口与命令注册

| 文件 | 职责 |
|------|------|
| `index.ts` | Commander 程序入口，注册所有子命令，`preAction` 钩子初始化环境 |
| `version.ts` | 从 `package.json` 读取 CLI 版本号 |

### 配置系统 (`config/`)

| 文件 | 职责 |
|------|------|
| `store.ts` | 配置文件读写、查找（从 cwd 向上递归）、旧版迁移、写前备份 |
| `home.ts` | Paperclip 家目录和实例路径解析（`~/.paperclip/instances/<id>/`） |
| `env.ts` | `.env` 文件管理（加载、合并、Agent JWT Secret 的保证策略） |
| `data-dir.ts` | `--data-dir` 参数覆盖逻辑，隔离多实例状态 |
| `schema.ts` | 从 `@paperclipai/shared` 导出配置 Zod schema |
| `secrets-key.ts` | Secrets 主密钥文件的创建与校验（32 字节随机 data, 0600 权限） |
| `server-bind.ts` | 服务器绑定策略（loopback/lan/tailnet/custom）+ Tailscale IP 检测 |
| `hostnames.ts` | 主机名归一化（URL 提取 hostname + 小写化） |

### 交互式提示 (`prompts/`)

| 文件 | 职责 |
|------|------|
| `database.ts` | 数据库配置（embedded-postgres / external postgres + 备份策略） |
| `llm.ts` | LLM 提供商选择（Claude / OpenAI）和 API Key 收集 |
| `logging.ts` | 日志模式选择（file / cloud） |
| `server.ts` | 服务器可达性、认证模式、暴露方式、主机名和 public URL 配置 |
| `storage.ts` | 存储供应商选择（local_disk / S3） |
| `secrets.ts` | Secrets 供应商选择（local_encrypted / AWS / GCP / Vault）和 strict mode |

### 诊断检查 (`checks/`)

| 文件 | 职责 |
|------|------|
| `index.ts` | `CheckResult` 类型定义 + 导出所有检查函数 |
| `config-check.ts` | 配置文件存在性与 schema 校验 |
| `database-check.ts` | 数据库连接验证（embedded-postgres 检查目录，postgres 执行 SELECT 1） |
| `deployment-auth-check.ts` | 部署认证模式兼容性检查 |
| `agent-jwt-secret-check.ts` | Agent JWT Secret 存在性检查 |
| `secrets-check.ts` | Secrets 适配器和密钥文件完整性检查 |
| `storage-check.ts` | 存储后端可用性检查 |
| `llm-check.ts` | LLM API Key 有效性检查 |
| `log-check.ts` | 日志目录可写性检查 |
| `port-check.ts` | 服务器端口可用性检查 |

### 适配器 (`adapters/`)

| 文件 | 职责 |
|------|------|
| `registry.ts` | CLI 适配器注册表，将类型字符串映射到格式化模块 |
| `process/index.ts` | Process 适配器（通用 JSON 回退） |
| `http/index.ts` | HTTP 适配器 |

### 实用工具 (`utils/`)

| 文件 | 职责 |
|------|------|
| `banner.ts` | Paperclip ASCII 艺术 Banner 打印 |
| `net.ts` | TCP 端口可用性检测 |
| `path-resolver.ts` | 运行时路径解析（相对路径 + ~ + 多候选查找） |

## 配置系统设计

### 配置文件查找优先级

1. 命令行 `--config <path>` 显式指定
2. 环境变量 `PAPERCLIC_CONFIG`
3. 从当前工作目录向上递归查找 `.paperclip/config.json`（类似 git 的 `.git` 查找）
4. 回退到 `~/.paperclip/instances/<instance-id>/config.json`

### 实例隔离

每个实例 ID 有独立的目录树：
```
~/.paperclip/
  instances/<id>/
    config.json           # 配置文件
    db/                   # Embedded PostgreSQL 数据目录
    logs/                 # 日志文件
    data/storage/         # 本地存储目录
    data/backups/         # 数据库备份
    secrets/master.key    # 本地加密密钥
    telemetry/            # 遥测状态
```

### Schema 版本

配置文件包含 `$meta.version` 字段。当前版本为 `v1`。
读取时自动执行旧版迁移（如 `pglite` -> `embedded-postgres` 模式名变更）。

### 写前备份

`writeConfig` 写入新配置前自动创建 `config.json.backup` 文件，`0600` 权限。

### 环境变量叠加

配置值与环境变量叠加：
- `DATABASE_URL` 覆盖数据库连接串
- `PAPERCLIP_PUBLIC_URL` 覆盖 Public Base URL
- `PAPERCLIP_AGENT_JWT_SECRET` 覆盖 Agent JWT Secret
- 以此类推，所有配置字段均可通过同名环境变量覆盖

## 上下游依赖

### 上层依赖（CLI 调用的内部包）

| 包 | 用途 |
|----|------|
| `@paperclipai/shared` | 配置 Schema 类型、枚举常量、Bind 模式推断 |
| `@paperclipai/db` | 数据库创建、迁移、备份、递归查询 |
| `@paperclipai/server` | 生产模式下启动服务器 |
| `@paperclipai/adapter-utils` | SSH env-lab fixture 管理、技能符号链接 |
| `@paperclipai/adapter-acpx-local` | ACPX 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-claude-local` | Claude 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-codex-local` | Codex 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-cursor-local` | Cursor 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-gemini-local` | Gemini 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-opencode-local` | OpenCode 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-pi-local` | Pi 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-openclaw-gateway` | OpenClaw Gateway 适配器 CLI 事件格式化 |
| `@paperclipai/adapter-utils/ssh` | SSH env-lab fixture（SSH 测试环境管理） |

### 外部依赖

| 包 | 用途 |
|----|------|
| `commander` | CLI 命令注册与参数解析 |
| `@clack/prompts` | 交互式终端提示 |
| `picocolors` | 终端颜色输出 |
| `dotenv` | `.env` 文件解析 |
| `drizzle-orm` | 数据库 ORM（查询 routine、invites 等） |
| `embedded-postgres` | 嵌入式 PostgreSQL 实例管理（可选依赖） |

### 被依赖关系

CLI 模块是独立可执行入口，不对外提供服务接口。其他模块不依赖 CLI。
