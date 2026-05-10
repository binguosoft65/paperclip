# adapter-utils 模块

## 模块概述

`adapter-utils` 是 Paperclip 平台的适配器通用工具库（`packages/adapter-utils/src/`），为 SSH 连接、沙箱管理、远程运行时、命令执行等场景提供跨适配器共享的工具函数和类型定义。

**核心职责：** 构建适配器与执行目标（本地进程、SSH 远程主机、沙箱环境）之间的统一抽象层，让上层代码以一致的方式操作不同执行环境。

---

## 核心功能

### 1. 执行目标抽象（Execution Target）

文件：`execution-target.ts`

定义了三种执行目标类型：
- **local**：在 Paperclip 宿主机本地的子进程执行
- **SSH remote**：通过 SSH 连接到远程主机执行
- **Sandbox remote**：在沙箱环境（如 E2B）中执行

关键功能：
- `runAdapterExecutionTargetProcess` / `runAdapterExecutionTargetShellCommand`：统一接口运行进程或 Shell 命令
- `ensureAdapterExecutionTargetCommandResolvable`：确保命令在远程环境中可解析
- `prepareAdapterExecutionTargetRuntime`：准备运行时环境（工作空间同步、资源部署）
- `startAdapterExecutionTargetPaperclipBridge`：在远程环境启动反向 API 代理桥

### 2. SSH 连接和工作空间同步

文件：`ssh.ts`

提供完整的 SSH 远程操作能力：
- `runSshCommand`：在远程主机执行命令（支持环境变量传递、profile sourcing）
- `buildSshSpawnTarget`：构造长时间运行的 SSH spawn 目标（额外加载 NVM）
- `syncDirectoryToSsh` / `syncDirectoryFromSsh`：通过 tar | ssh 流式管道同步目录
- `prepareWorkspaceForSshExecution`：将本地 Git 工作空间导入远程环境（支持 git bundle）
- `restoreWorkspaceFromSshExecution`：从远程环境恢复工作空间到本地

SSH 认证设计：
- 私钥和 known_hosts 写入临时文件（权限 0600），执行后自动清理
- 支持 `strictHostKeyChecking` 开关，默认启用
- 使用 `BatchMode=yes` 防止回退到交互式密码输入

### 3. 沙箱回调桥（Sandbox Callback Bridge）

文件：`sandbox-callback-bridge.ts`

在沙箱环境中启动反向 HTTP 代理桥，让沙箱内的 Agent CLI 通过文件队列轮询方式调用 Paperclip API。

**架构：**
```
沙箱内 CLI (Node 服务器) ──文件队列──> 桥 Worker (本地进程) ──HTTP──> Paperclip API 主机
```

安全设计：
- 路由白名单：限定 CLI 可通过桥访问的 API 端点范围
- 请求体大小上限：256KB，排除大文件传输场景
- 桥 Token 认证：沙箱内 CLI 需要 Token 才能向桥发送请求
- Header 白名单：只透传指定的 HTTP 头部

### 4. 受管运行时准备

文件：`command-managed-runtime.ts`、`sandbox-managed-runtime.ts`、`remote-managed-runtime.ts`

三个层级的运行时准备：
- **SandboxManagedRuntime**：通过 `SandboxManagedRuntimeClient`（makeDir、writeFile、readFile、listFiles、remove、run）操作远程环境
- **CommandManagedRuntime**：在 CommandManagedRuntimeRunner 抽象上实现 SandboxManagedRuntimeClient，支持 installCommand + detectCommand 探测预安装
- **RemoteManagedRuntime**：基于 SSH 的运行时准备，利用 git bundle 进行增量同步

关键设计决策：
- 安装失败不阻断工作流：CLI 可能已在模板镜像或之前的 lease 中存在
- 差异合并恢复模式（`mergeDirectoryWithBaseline`）避免全量同步

### 5. 会话压缩策略

文件：`session-compaction.ts`

管理 Agent 会话的自动轮换（compaction）策略：
- 原生上下文管理（NativeContextManagement）：标记适配器是否自身管理上下文（如 Claude Code 自动压缩）
- 阈值策略：maxSessionRuns（200）、maxRawInputTokens（2M）、maxSessionAgeHours（72h）
- 支持 `agent_override`、`adapter_default`、`legacy_fallback` 三级策略来源

### 6. 安全和隐私保护

- `command-redaction.ts`：脱敏命令中的 API Key、Token、JWT、GitHub Token 等敏感信息
- `log-redaction.ts`：脱敏日志中的 HOME 路径（/Users/xxx → /Users/j******）
- `remote-execution-env.ts`：远程执行环境变量清理，避免将本机路径泄露到远程

### 7. 命令执行管道

文件：`server-utils.ts`

- `runChildProcess`：完整子进程生命周期管理（spawn、超时、输出捕获、进程组清理）
- 超时策略：SIGTERM 优雅退出（5s 窗口）→ SIGKILL 强制杀死
- 终端结果检测：定时检查输出中的"完成标记"，结果就绪后主动终止进程
- 嵌套会话保护：清除 Claude Code 嵌套环境变量，避免子进程拒绝启动
- 技能管理：技能的目录扫描、安装、文件物化、维护者清理

### 8. 工作区恢复合并

文件：`workspace-restore-merge.ts`

基于 SHA-256 基线快照的目录差异合并：
- 计算从运行前到运行后新增/修改/删除的文件集合
- 仅复制发生变化的条目，避免全量同步
- 使用 PID 感知的目录锁防止并发冲突

---

## 关键文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `types.ts` | ~506 | 核心类型定义 |
| `execution-target.ts` | ~1120 | 执行目标抽象和桥管理 |
| `ssh.ts` | ~1404 | SSH 连接、认证、文件同步、环境实验室 |
| `sandbox-callback-bridge.ts` | ~1159 | 沙箱反向 API 代理桥 |
| `server-utils.ts` | ~1990 | 子进程管理、环境构建、技能生命周 |
| `command-managed-runtime.ts` | ~228 | 命令式受管运行时 |
| `sandbox-managed-runtime.ts` | ~336 | 沙箱受管运行时准备 |
| `remote-managed-runtime.ts` | ~117 | SSH 受管运行时准备 |
| `session-compaction.ts` | ~188 | 会话压缩策略管理 |
| `workspace-restore-merge.ts` | ~258 | 工作区差异合并 |
| `command-redaction.ts` | ~22 | 命令脱敏 |
| `log-redaction.ts` | ~98 | 日志路径脱敏 |
| `remote-execution-env.ts` | ~50 | 远程环境变量清理 |
| `billing.ts` | ~21 | 提供商计费推断 |
| `sandbox-shell.ts` | ~3 | Shell 偏好探测 |
| `index.ts` | ~76 | 模块入口导出 |

---

## 上下游依赖

### 上游依赖方（使用 adapter-utils 的模块）

- **server/src/adapters/**：适配器执行引擎，使用 execution-target 执行 Agent 命令
- **server/src/workspace/**：工作空间管理，使用 SSH 目录同步和恢复功能
- **server/src/runs/**：运行管理，使用子进程管理和会话压缩
- **ui/src/**：UI 前端，仅导入类型定义（types.ts），不依赖 Node.js 特有模块

### 下游依赖（adapter-utils 导入的模块）

- **Node.js 内置模块**：child_process、fs、crypto、net、os、path、util
- **adapter-utils 内部模块**：各文件相互引用（如 execution-target.ts 引用 ssh.ts 和 command-managed-runtime.ts）

### 沙箱提供商集成

Sandbox 执行目标依赖第三方沙箱提供商提供的 `CommandManagedRuntimeRunner` 实现：
- E2B（e2b）等沙箱服务实现此接口
- SSH 运行时通过 `createSshCommandManagedRuntimeRunner` 原生实现

---

## 设计原则

1. **安全优先**：私钥写入 0600 临时文件、API Token 不暴露到沙箱内部、命令脱敏、环境变量清理
2. **容错设计**：安装命令失败不阻断运行（"leaky abstraction"原则）
3. **最小依赖**：根入口保持浏览器安全，Node.js 特有功能通过子路径导出
4. **向后兼容**：保留 legacy sessionId、executionTransport 等字段简化迁移
5. **增量同步**：Git bundle + tar 流式管道避免全量文件传输
6. **统一抽象**：三种执行目标（local/SSH/sandbox）对外暴露一致接口
