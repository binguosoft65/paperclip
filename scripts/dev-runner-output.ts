// 默认输出捕获上限 256KB，防止子进程日志撑爆内存
const DEFAULT_CAPTURED_OUTPUT_BYTES = 256 * 1024;
// 默认 JSON 响应上限 64KB，避免解析超大响应导致 OOM
const DEFAULT_JSON_RESPONSE_BYTES = 64 * 1024;

export type CapturedOutput = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

// 确保字节上限至少为 1，避免除零或无效值
function normalizeByteLimit(maxBytes: number) {
  return Math.max(1, Math.trunc(maxBytes));
}

// 创建一个环形缓冲区来捕获流式输出。
// 保留最近的 N 字节，丢弃旧数据，适合查看子进程最近日志而非全部历史
export function createCapturedOutputBuffer(maxBytes = DEFAULT_CAPTURED_OUTPUT_BYTES) {
  const limit = normalizeByteLimit(maxBytes);
  const chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  return {
    append(chunk: Buffer | string | null | undefined) {
      if (chunk === null || chunk === undefined) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length === 0) return;

      chunks.push(buffer);
      bufferedBytes += buffer.length;
      totalBytes += buffer.length;

      // 如果超出容量，从头部开始丢弃，保留最新数据（尾部优先）
      while (bufferedBytes > limit && chunks.length > 0) {
        const overflow = bufferedBytes - limit;
        const head = chunks[0]!;
        if (head.length <= overflow) {
          chunks.shift();
          bufferedBytes -= head.length;
          truncated = true;
          continue;
        }

        chunks[0] = head.subarray(overflow);
        bufferedBytes -= overflow;
        truncated = true;
      }
    },

    finish(): CapturedOutput {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!truncated) {
        return {
          text: body,
          truncated,
          totalBytes,
        };
      }

      // 截断时在顶部添加说明，明确告知丢失的数据量
      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${body}`,
        truncated,
        totalBytes,
      };
    },
  };
}

// 安全解析 JSON 响应，流式读取并在超限时立即取消，避免下载整个大响应
export async function parseJsonResponseWithLimit<T>(
  response: Response,
  maxBytes = DEFAULT_JSON_RESPONSE_BYTES,
): Promise<T> {
  const limit = normalizeByteLimit(maxBytes);
  // 如果 content-length 头已告知超限，直接拒绝而无需读取 body
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error(`Response exceeds ${limit} bytes`);
  }

  if (!response.body) {
    throw new Error("Response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      // 流式读取过程中一旦超限，立即取消请求不再浪费带宽
      if (totalBytes > limit) {
        await reader.cancel("response too large");
        throw new Error(`Response exceeds ${limit} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(text) as T;
}
