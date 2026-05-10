import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

// Pi 本地适配器：运行 Pi（AI 编码 agent）CLI。
// 支持 provider/model 格式路由模型（如 xai/grok-4），
// 通过 --session 实现心跳恢复。Pi 的工具集包括 read, bash, edit, write, grep, find, ls。
export const type = "pi_local";
export const label = "Pi (local)";

// 沙箱安装命令
export const SANDBOX_INSTALL_COMMAND = "npm install -g @mariozechner/pi-coding-agent";

// Pi 的模型动态从 CLI 发现（pi --list-models），无需预定义
export const models: Array<{ id: string; label: string }> = [];

// Pi 暂无预设的模型配置文件模板
export const modelProfiles: AdapterModelProfileDefinition[] = [];

// 适配器配置文档：描述 pi_local 的用途、模型/Provider 路由格式、
// 系统提示词扩展和 session 持久化路径。
export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Use when:
- You want Paperclip to run Pi (the AI coding agent) locally as the agent runtime
- You want provider/model routing in Pi format (--provider <name> --model <id>)
- You want Pi session resume across heartbeats via --session
- You need Pi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed via -p flag
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- Paperclip requires an explicit \`model\` value for \`pi_local\` agents.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt, while the user task is sent via -p.
`;
