import { PaperclipApiError } from "./client.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
};

// 将任意返回值包装为 MCP text content 格式。
// MCP 协议要求 content 数组的每个元素必须有 type 和 text 字段；非字符串值自动序列化为 JSON 以方便 LLM 读取结构化数据。
export function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

// 区分 PaperclipApiError（包含 HTTP 状态、方法、路径等上下文）与普通异常，
// 让 LLM 在收到错误时能区分"接口拒接"和"代码异常"，从而决定重试还是上报。
export function formatErrorResponse(error: unknown): McpTextResponse {
  if (error instanceof PaperclipApiError) {
    return formatTextResponse({
      error: error.message,
      status: error.status,
      method: error.method,
      path: error.path,
      body: error.body,
    });
  }
  return formatTextResponse({
    error: error instanceof Error ? error.message : String(error),
  });
}
