// MCP 服务端配置接口，所有字段均通过环境变量注入（12-factor 应用模式）。
// companyId / agentId / runId 可为 null，调用处按需回退到默认值。
export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// 标准化 API URL：去掉尾部斜杠后确保以 /api 结尾。
// 调用方可能传入不带 /api 的根 URL，此处自动补全以避免拼写错误。
export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

// 从环境变量读取 MCP 配置。PAPERCLIP_API_URL 和 PAPERCLIP_API_KEY 为必填项，
// 缺省时直接抛错，避免连接到错误端点后产生难以排查的 401/404 错误。
export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("Missing PAPERCLIP_API_KEY");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}
