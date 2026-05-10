import * as p from "@clack/prompts";
import type { LlmConfig } from "../config/schema.js";

// LLM 提供商配置交互提示
// 当前支持 Claude (Anthropic) 和 OpenAI
// API Key 以 password 输入（不回显）收集，最终加密存储在 secrets 中
// 用户可跳过此步骤（LLM 配置非必需 —— 可在运行后随时通过 configure 添加）
export async function promptLlm(): Promise<LlmConfig | undefined> {
  const configureLlm = await p.confirm({
    message: "Configure an LLM provider now?",
    initialValue: false,
  });

  if (p.isCancel(configureLlm)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (!configureLlm) return undefined;

  const provider = await p.select({
    message: "LLM provider",
    options: [
      { value: "claude" as const, label: "Claude (Anthropic)" },
      { value: "openai" as const, label: "OpenAI" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const apiKey = await p.password({
    message: `${provider === "claude" ? "Anthropic" : "OpenAI"} API key`,
    validate: (val) => {
      if (!val) return "API key is required";
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return { provider, apiKey };
}
