// Cursor CLI 的 stream-json 输出有时会将 stdout/stderr 前缀混在 JSON 行前。
// 例如 "stdout: {"type":"text","text":"hello"}"。此函数解析并分离流标签，
// 确保 JSON 内容被正确路由到对应的日志流。
export function normalizeCursorStreamLine(rawLine: string): {
  stream: "stdout" | "stderr" | null;
  line: string;
} {
  const trimmed = rawLine.trim();
  if (!trimmed) return { stream: null, line: "" };

  const prefixed = trimmed.match(/^(stdout|stderr)\s*[:=]?\s*([\[{].*)$/i);
  if (!prefixed) {
    return { stream: null, line: trimmed };
  }

  const stream = prefixed[1]?.toLowerCase() === "stderr" ? "stderr" : "stdout";
  const line = (prefixed[2] ?? "").trim();
  return { stream, line };
}
