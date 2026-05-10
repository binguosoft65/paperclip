import * as p from "@clack/prompts";
import type { LoggingConfig } from "../config/schema.js";
import { resolveDefaultLogsDir, resolvePaperclipInstanceId } from "../config/home.js";

// 日志配置交互提示
// "file" 模式为当前唯一稳定选项，日志输出到实例的 logs 目录
// "cloud" 模式为预留选项，展示"即将到来"提示后回退到文件模式
export async function promptLogging(): Promise<LoggingConfig> {
  const defaultLogDir = resolveDefaultLogsDir(resolvePaperclipInstanceId());
  const mode = await p.select({
    message: "Logging mode",
    options: [
      { value: "file" as const, label: "File-based logging", hint: "recommended" },
      { value: "cloud" as const, label: "Cloud logging", hint: "coming soon" },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (mode === "file") {
    const logDir = await p.text({
      message: "Log directory",
      defaultValue: defaultLogDir,
      placeholder: defaultLogDir,
    });

    if (p.isCancel(logDir)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    return { mode: "file", logDir: logDir || defaultLogDir };
  }

  p.note("Cloud logging is coming soon. Using file-based logging for now.");
  return { mode: "file", logDir: defaultLogDir };
}
