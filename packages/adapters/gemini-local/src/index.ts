import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

// Gemini CLI 本地适配器的类型标识和显示名称，用于注册和 UI 展示
export const type = "gemini_local";
export const label = "Gemini CLI (local)";

// 沙箱模式下安装 Gemini CLI 的命令，确保远程执行环境有可用的 CLI
export const SANDBOX_INSTALL_COMMAND = "npm install -g @google/gemini-cli";

// 默认模型为 "auto"，让 Gemini CLI 自行选择最合适的模型
export const DEFAULT_GEMINI_LOCAL_MODEL = "auto";

// 预定义的 Gemini 模型列表，用户可在适配器配置中指定
export const models = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
];

// 模型配置文件（modelProfiles）：提供预设的"经济型"配置，使用 Flash Lite 模型节省成本
export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini Flash Lite as the budget Gemini CLI lane while preserving the primary model.",
    adapterConfig: {
      model: "gemini-2.5-flash-lite",
    },
    source: "adapter_default",
  },
];

// 适配器配置文档：描述 gemini_local 的用途、核心字段和设计约束。
// 帮助用户在创建 agent 时理解何时使用该适配器以及如何配置。
export const agentConfigurationDoc = `# gemini_local agent configuration

Adapter: gemini_local

Use when:
- You want Paperclip to run the Gemini CLI locally on the host machine
- You want Gemini chat sessions resumed across heartbeats with --resume
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Gemini CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Gemini model id. Defaults to auto.
- sandbox (boolean, optional): run in sandbox mode (default: false, passes --sandbox=none)
- command (string, optional): defaults to "gemini"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use positional prompt arguments, not stdin.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.gemini/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use GEMINI_API_KEY / GOOGLE_API_KEY or local Gemini CLI login.
`;
