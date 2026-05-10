import type { PaperclipMcpConfig } from "./config.js";

// 封装 HTTP 错误，保留请求方法和路径等上下文，供 formatErrorResponse 展开给 LLM 做决策参考。
export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
}

// 判断是否为写方法：写操作需携带 X-Paperclip-Run-Id 头以支持操作审计和幂等追溯。
// GET/HEAD 为只读，不需要 Run-Id。
function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class PaperclipApiClient {
  constructor(private readonly config: PaperclipMcpConfig) {}

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
  }

  // 优先使用显式传入的 companyId，未传则回退到全局默认配置。
  // 这样 MCP 工具可以省略 companyId 参数，简化 LLM 调用签名。
  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  // 与 resolveCompanyId 同理，允许工具调用时省略 agentId，从环境变量 PAPERCLIP_AGENT_ID 自动补全。
  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because PAPERCLIP_AGENT_ID is not set");
    }
    return resolved;
  }

  // 核心 HTTP 请求方法：包装 fetch，自动注入 Bearer token、Content-Type、Run-Id 头。
  // 路径以 / 开头但 URL 拼接时去掉前导 /，配合 new URL(path.slice(1), base) 以正确处理 base URL 子路径。
  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    // 写操作默认携带 X-Paperclip-Run-Id 头，用于服务端追踪本次 agent run 的所有变更操作。
    // includeRunId=false 可显式跳过，适用于某些不需要追踪上下文的只读请求。
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Paperclip-Run-Id"] = this.config.runId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    // 优先解析响应 body（可能为 JSON 或纯文本），即使是非 2xx 响应也尝试提取错误信息。
    // Paperclip API 在错误时返回 { error: string } 格式，此处保留原始 body 供上层格式化。
    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      throw new PaperclipApiError({
        status: response.status,
        method: method.toUpperCase(),
        path,
        body: parsedBody,
        message: buildErrorMessage(method.toUpperCase(), path, response.status, parsedBody),
      });
    }

    return parsedBody as T;
  }
}
