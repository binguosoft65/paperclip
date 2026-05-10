// 标准化 OpenClaw Gateway 流式输出行：识别 stdout/stderr 前缀，
// 使 UI 能正确区分普通输出和错误输出。Gateway 的输出是通过 WebSocket
// 事件帧传递的，可能与直接 CLI 输出格式不同。
export function normalizeOpenClawGatewayStreamLine(rawLine: string): {
  stream: "stdout" | "stderr" | null;
  line: string;
} {
  const trimmed = rawLine.trim();
  if (!trimmed) return { stream: null, line: "" };

  const prefixed = trimmed.match(/^(stdout|stderr)\s*[:=]?\s*(.*)$/i);
  if (!prefixed) {
    return { stream: null, line: trimmed };
  }

  const stream = prefixed[1]?.toLowerCase() === "stderr" ? "stderr" : "stdout";
  const line = (prefixed[2] ?? "").trim();
  return { stream, line };
}
