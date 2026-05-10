# Adapters 模块

## 模块概述

Adapters 模块（`packages/adapters/`）是 Paperclip 平台的 IDE/编辑器集成层，将各类 AI 编码 Agent 封装为统一的适配器接口。每个适配器负责：

- **本地执行**：通过子进程启动 Agent CLI，管理 stdin/stdout 通信
- **远程执行**：通过 SSH 或沙箱环境 (E2B) 在远程主机上执行 Agent
- **环境诊断**：检查 Node 版本、CLI 可执行性、认证状态等前置条件
- **Session 管理**：跨心跳消息的 session 持久化和恢复（resume）
- **Skill 集成**：将 Paperclip runtime skills 注入到 Agent 的 skill 目录

适配器架构遵循分层设计：`adapter-utils` 提供通用执行目标抽象（本地/SSH/沙箱），各适配器在此之上实现各自的 CLI 参数构建和输出解析。

---

## 适配器对比表

| 名称 | type | IDE/Agent | 安装方式 | 特点 | 文件数 |
|------|------|-----------|----------|------|--------|
| ACPX (local) | `acpx_local` | Claude/Codex/Custom via ACPX | 内置依赖（`claude-agent-acp` + `codex-acp`） | ACP 协议运行时，统一管理多 Agent 的 session 生命周期，持久/一次性模式切换，warm handle 复用 | 17 |
| Claude Code (local) | `claude_local` | Claude Code CLI `--print` | `npm install -g @anthropic-ai/claude-code` | 通过 `--print` 模式非交互运行，支持 Bedrock 认证，max-turns 控制，提示词 bundle 缓存 | 20 |
| Codex (local) | `codex_local` | OpenAI Codex CLI `exec` | `npm install -g @openai/codex` | exec + JSONL 输出，fast mode 开关，托管 CODEX_HOME/skills/，rollout 噪音过滤 | 23 |
| Cursor CLI (local) | `cursor` | Cursor Agent CLI | `curl https://cursor.com/install \| bash` | 通过 `agent` 命令运行，自动 `--yolo` 绕过信任提示，远程沙箱 PATH 探测 | 17 |
| Gemini CLI (local) | `gemini_local` | Gemini CLI | `npm install -g @google/gemini-cli` | Google Gemini 命令行集成 | 15 |
| OpenClaw Gateway | `openclaw_gateway` | OpenClaw（外部网关） | 无（HTTP 调用） | Webhook 风格的外部调用，非本地进程执行 | 11 |
| OpenCode (local) | `opencode_local` | OpenCode CLI | `npm install -g opencode-ai` | 类似 Codex 的本地执行，dangerouslySkipPermissions 默认开启 | 18 |
| Pi (local) | `pi_local` | Pi Coding Agent CLI | `npm install -g @mariozechner/pi-coding-agent` | Pi Coding Agent 命令行集成 | 16 |

---

## 通用执行流程

所有本地适配器遵循以下通用执行流程：

1. **配置读取**：从 `AdapterExecutionContext` 中提取 agent 配置、运行时上下文、认证令牌
2. **工作区目录解析**：按优先级 `workspace context cwd > 配置 cwd > process.cwd()` 确定执行目录
3. **环境变量构建**：
   - 注入 `PAPERCLIP_*` 系列环境变量（runId、taskId、workspace 等）
   - 注入 workspace 上下文（workspaceCwd、repoUrl、worktreePath 等）
   - 应用用户配置的 `env` 覆盖
   - 注入 `authToken`（如果未显式配置 API Key）
4. **命令可执行性检查**：确认 CLI 命令已安装且可解析
5. **Session 恢复判定**：检查 runtime sessionParams 是否与当前上下文匹配（cwd、remote execution identity 等），决定 resume 或 fresh start
6. **提示词构建**：
   - 可选的 `instructionsFilePath` 指令文件注入
   - `bootstrapPromptTemplate` 用于首次运行
   - `wakePrompt` 用于心跳恢复时的 delta
   - `sessionHandoffMarkdown` + `taskMarkdown` 上下文注入
7. **子进程执行**：通过 `runAdapterExecutionTargetProcess` 启动 Agent CLI，stdin 传入提示词
8. **输出解析**：解析 Agent 的结构化输出（stream-json / jsonl / json），提取 sessionId、usage、summary
9. **结果转换**：统一输出 `AdapterExecutionResult`，包含 exitCode、sessionParams、usage、errorCode 等

对于 **远程执行**，流程额外包含：
- 工作区同步（通过 `prepareAdapterExecutionTargetRuntime`）
- CODEX_HOME / 配置目录的远程部署
- Paperclip Bridge 的启动（反向 API 代理）
- 执行完成后的工作区恢复（`restoreWorkspace`）

对于 **ACPX 适配器**，流程使用 ACPX Runtime 而非直接子进程：
- 通过 `AcpRuntime` 管理 ACP session 生命周期
- 支持 `persistent` 和 `oneshot` 两种 mode
- warm handle 缓存复用 ACP session，减少启动延迟
- 事件驱动的 text_delta / tool_call / status 流式日志

---

## 关键文件及职责

### 适配器通用入口（每个适配器）

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 适配器注册：type、label、models、modelProfiles、默认配置、agentConfigurationDoc |
| `src/server/index.ts` | 服务端导出聚合：execute、testEnvironment、skills、sessionCodec 等 |
| `src/server/execute.ts` | 核心执行逻辑：CLI 参数构建、子进程管理、输出解析、session 恢复 |
| `src/server/test.ts` | 环境诊断：版本检查、CLI 安装、认证状态、hello probe |
| `src/server/skills.ts` | Paperclip runtime skills 的列举和同步 |
| `src/ui/index.ts` | UI 端配置表单相关 |
| `src/ui/build-config.ts` | UI 配置构建 |
| `src/ui/parse-stdout.ts` | 用于 UI 的 stdout 解析逻辑 |
| `src/cli/index.ts` | CLI 相关的工具命令 |
| `src/cli/format-event.ts` | 事件格式化输出 |
| `vitest.config.ts` | Vitest 测试配置 |

### 各适配器的差异化文件

**ACPX 本地适配器** (`acpx-local/`):
- `src/server/session-codec.ts`：ACPX session 序列化编解码
- `src/server/config-schema.ts`：配置项的 JSON Schema

**Claude Code 本地适配器** (`claude-local/`):
- `src/server/parse.ts`：stream-json 输出解析、失败分类、session 错误检测
- `src/server/claude-config.ts`：Claude 配置种子（远程执行时注入凭证）
- `src/server/models.ts`：模型 ID 辅助函数（Bedrock ID 检测）
- `src/server/prompt-cache.ts`：提示词 bundle 缓存（内容寻址，复用 bundle 减少 token 消耗）
- `src/server/quota.ts`：Claude Code API 配额查询

**Codex 本地适配器** (`codex-local/`):
- `src/server/parse.ts`：JSONL 输出解析、临时上游错误检测
- `src/server/codex-args.ts`：Codex exec 命令行参数构建（含 fast mode）
- `src/server/codex-home.ts`：Paperclip 托管的 CODEX_HOME 管理
- `src/server/quota.ts`：Codex 配额查询

**Cursor 本地适配器** (`cursor-local/`):
- `src/server/parse.ts`：JSONL 输出解析
- `src/server/remote-command.ts`：远程沙箱命令准备（PATH 探测、agent 路径发现）
- `src/shared/stream.ts`：流式输出行归一化（分离 stdout/stderr 前缀）
- `src/shared/trust.ts`：信任绕过参数检测（--trust/--yolo/-f）

---

## 各适配器差异化设计

### acpx-local（ACP 协议运行时）
- 不直接启动 CLI 子进程，而是通过 `acpx/runtime` 库管理 ACP session
- 支持三种 agent 后端：claude（`claude-agent-acp`）、codex（`codex-acp`）、custom（任意 ACP 命令）
- `persistent` mode 保留 ACP session 状态，warm handle 在 idle 窗口内复用（减少冷启动延迟）
- 技能注入策略按 agent 分叉：Claude 通过 prompt bundle 注入，Codex 通过 skills 目录注入
- **约束**：要求 Node >=22.12.0（ACPX 运行时前置依赖）

### claude-local（Claude Code CLI）
- 使用 `--print` 模式 + 标准输入传递提示词，无头非交互运行
- `--dangerously-skip-permissions` 默认开启（headless 下无法处理交互弹窗）
- Bedrock 环境下跳过 Anthropic 风格模型 ID（只传递 Bedrock 原生 ARN）
- Session 恢复通过 `--resume <sessionId>` 实现，恢复时不重新注入指令文件以节省 token
- 远程执行时自动管理 `CLAUDE_CONFIG_DIR` 和凭证种子

### codex-local（Codex CLI）
- 使用 `exec --json` 模式 + 标准输入传递提示词
- Fast Mode 通过 `service_tier="fast"` + `features.fast_mode=true` 启用
- 内置 rollout 噪音过滤，避免 Codex 内部 ERROR 日志干扰用户
- 默认使用 Paperclip 托管的 `CODEX_HOME`（按公司隔离），从用户源 `CODEX_HOME` 或 `~/.codex` 种子凭证
- 临时上游错误（transient upstream）有专门的检测和 fallback 策略（更安全的调用参数 + 强制刷新 session）

### cursor-local（Cursor Agent CLI）
- 使用 `agent -p --output-format stream-json` 命令（非 `cursor` 命令本身）
- 自动添加 `--yolo`（除非用户已在 extraArgs 中添加了 --trust/--yolo/-f）
- 远程沙箱环境需要特殊的 PATH 探测：在远程主机通过 SSH 探测 `$HOME/.local/bin/cursor-agent`
- 技能注入到 `~/.cursor/skills/` 目录
- 没有 npm 包，安装方式为 `curl | bash`

---

## 上下游依赖

### 上游依赖（公共库）
- `@paperclipai/adapter-utils`：适配器通用工具库（执行目标抽象、SSH、沙箱、命令执行）
- `@paperclipai/adapter-utils/execution-target`：执行目标接口（local/SSH/sandbox 统一抽象）
- `@paperclipai/adapter-utils/server-utils`：服务端通用工具（环境变量、提示词模板、workspace 处理）
- `@paperclipai/adapter-utils/ssh`：SSH 连接和同步

### 下游依赖（被谁使用）
- `@paperclipai/server`：服务器端 adapter manager，根据 agent 配置的 type 字段调用对应适配器
- `@paperclipai/ui`：UI 配置面板，使用适配器的 models、modelProfiles、configSchema 渲染表单

### ACPX 特定依赖
- `acpx`、`@agentclientprotocol/claude-agent-acp`、`@zed-industries/codex-acp`：ACP 协议运行时和 Agent 实现

### 安装依赖
- `claude-local`：`@anthropic-ai/claude-code`（npm）
- `codex-local`：`@openai/codex`（npm）
- `gemini-local`：`@google/gemini-cli`（npm）
- `pi-local`：`@mariozechner/pi-coding-agent`（npm）
- `opencode-local`：`opencode-ai`（npm）
- `cursor-local`：无 npm 包，通过 `curl https://cursor.com/install | bash` 安装
