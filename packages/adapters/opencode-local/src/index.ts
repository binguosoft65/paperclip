import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

// OpenCode 本地适配器：运行 opencode CLI 作为 agent 运行时。
// 使用 provider/model 格式路由模型（如 openai/gpt-5.2-codex），
// 通过 --session 实现心跳恢复。
export const type = "opencode_local";
export const label = "OpenCode (local)";

// 沙箱安装命令，用于远程执行环境安装 OpenCode CLI
export const SANDBOX_INSTALL_COMMAND = "npm install -g opencode-ai";

// 默认模型：OpenAI GPT-5.2 Codex，与 OpenCode 的默认值一致
export const DEFAULT_OPENCODE_LOCAL_MODEL = "openai/gpt-5.2-codex";

// 校验 OpenCode 模型 ID 格式：必须包含 "/" 且不能以 "/" 开头或结尾。
// 格式约束来自 OpenCode CLI 的 provider/model 路由约定。
export function isValidOpenCodeModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

// 预定义的 OpenCode 模型列表（Provider/Model 格式）
export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OPENCODE_LOCAL_MODEL, label: DEFAULT_OPENCODE_LOCAL_MODEL },
  { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
  { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
  { id: "openai/gpt-5.1-codex-max", label: "openai/gpt-5.1-codex-max" },
  { id: "openai/gpt-5.1-codex-mini", label: "openai/gpt-5.1-codex-mini" },
];

// 经济型模型配置：使用 Codex mini 模型，variant=low 降低推理消耗
export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use OpenCode's known Codex mini model as the budget lane.",
    adapterConfig: {
      model: "openai/gpt-5.1-codex-mini",
      variant: "low",
    },
    source: "adapter_default",
  },
];

// 适配器配置文档：描述 opencode_local 的用途、模型路由格式、
// 权限控制策略和 session 恢复机制。
export const agentConfigurationDoc = `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want Paperclip to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenCode model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant (for example minimal|low|medium|high|xhigh|max)
- dangerouslySkipPermissions (boolean, optional): inject a runtime OpenCode config that allows \`external_directory\` access without interactive prompts; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \
  \`opencode models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`opencode_local\` agents.
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets OPENCODE_DISABLE_PROJECT_CONFIG=true to prevent OpenCode from \
  writing an opencode.json config file into the project working directory. Model \
  selection is passed via the --model CLI flag instead.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip injects a temporary \
  runtime config with \`permission.external_directory=allow\` so headless runs do \
  not stall on approval prompts.
`;
