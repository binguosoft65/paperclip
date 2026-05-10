// resultJson 摘要字段的最大长度（字符数）。摘要用于前端展示和 Issue 评论，
// 过长的内容会被截断以避免数据库开销和 UI 溢出。500 字符足够表达一次 Run 的关键结论。
export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
// stdout/stderr 等详细输出在摘要中的截断阈值。4K 字符足以看清错误堆栈而不会撑爆 JSON。
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
// resultJson 在数据库列中的安全大小上限。超过 64KB 的 resultJson 会被截断处理，
// 防止极端情况下一行数据占用过多页面缓存或网络带宽。
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// 合并 resultJson 与 summary：如果 resultJson 中没有 summary 字段，将显式传入的 summary 注入进去。
// 这确保即使 adapter 返回的 resultJson 缺少摘要，系统也能从其他地方（如 Run 的 error 字段）构造摘要。
export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  // 如果 resultJson 已有 summary，不覆盖 — adapter 返回的 summary 优先级更高。
  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

// 从 Run 的 resultJson 中提取结构化摘要。
// 只保留关键字段（summary、result、message、error、费用、超时信息），
// 避免将完整的原始 resultJson（可能很大）返回给前端或存储在摘要中。
// 这是性能和安全性权衡：摘要足够用于展示，原始数据保留在日志中。
export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

// 从 resultJson 中提取适合作为 Issue 评论的文本。
// 优先使用 summary，降级到 result，再降级到 message。
// 用于在 Issue 线程中自动生成 Run 完成后的总结评论。
export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
}
