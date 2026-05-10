function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// 推断 OpenAI 兼容 API 的提供商。
// 优先级：显式设置 OPENROUTER_API_KEY > BASE_URL 包含 openrouter 关键词 > fallback 默认值。
// 设计原因：许多 LLM 提供商使用 OpenAI 兼容 API 格式，但计费方不同。
// 在存在 OPENROUTER_API_KEY 时必然是 OpenRouter 而非 OpenAI。
export function inferOpenAiCompatibleBiller(
  env: NodeJS.ProcessEnv,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL");
  if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter";

  return fallback;
}
