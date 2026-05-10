// 检测 Cursor CLI 参数中是否已包含信任绕过参数。
// Cursor 有多个等价选项可以跳过信任确认，这里统一识别。
export function hasCursorTrustBypassArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--trust" ||
      arg === "--yolo" ||
      arg === "-f" ||
      arg.startsWith("--trust="),
  );
}
