import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { printAcpxStreamEvent } from "@paperclipai/adapter-acpx-local/cli";
import { printClaudeStreamEvent } from "@paperclipai/adapter-claude-local/cli";
import { printCodexStreamEvent } from "@paperclipai/adapter-codex-local/cli";
import { printCursorStreamEvent } from "@paperclipai/adapter-cursor-local/cli";
import { printGeminiStreamEvent } from "@paperclipai/adapter-gemini-local/cli";
import { printOpenCodeStreamEvent } from "@paperclipai/adapter-opencode-local/cli";
import { printPiStreamEvent } from "@paperclipai/adapter-pi-local/cli";
import { printOpenClawGatewayStreamEvent } from "@paperclipai/adapter-openclaw-gateway/cli";
import { processCLIAdapter } from "./process/index.js";
import { httpCLIAdapter } from "./http/index.js";

const claudeLocalCLIAdapter: CLIAdapterModule = {
  type: "claude_local",
  formatStdoutEvent: printClaudeStreamEvent,
};

const acpxLocalCLIAdapter: CLIAdapterModule = {
  type: "acpx_local",
  formatStdoutEvent: printAcpxStreamEvent,
};

const codexLocalCLIAdapter: CLIAdapterModule = {
  type: "codex_local",
  formatStdoutEvent: printCodexStreamEvent,
};

const openCodeLocalCLIAdapter: CLIAdapterModule = {
  type: "opencode_local",
  formatStdoutEvent: printOpenCodeStreamEvent,
};

const piLocalCLIAdapter: CLIAdapterModule = {
  type: "pi_local",
  formatStdoutEvent: printPiStreamEvent,
};

const cursorLocalCLIAdapter: CLIAdapterModule = {
  type: "cursor",
  formatStdoutEvent: printCursorStreamEvent,
};

const geminiLocalCLIAdapter: CLIAdapterModule = {
  type: "gemini_local",
  formatStdoutEvent: printGeminiStreamEvent,
};

const openclawGatewayCLIAdapter: CLIAdapterModule = {
  type: "openclaw_gateway",
  formatStdoutEvent: printOpenClawGatewayStreamEvent,
};

// 适配器注册表：将适配器类型字符串映射到对应的 CLI 格式化模块
// 每个适配器负责将各自的 stdout JSON 事件格式化为可读文本
// 新增适配器时需要在此注册，否则 heartbeat run 的日志输出将使用 process 适配器回退
const adaptersByType = new Map<string, CLIAdapterModule>(
  [
    acpxLocalCLIAdapter,
    claudeLocalCLIAdapter,
    codexLocalCLIAdapter,
    openCodeLocalCLIAdapter,
    piLocalCLIAdapter,
    cursorLocalCLIAdapter,
    geminiLocalCLIAdapter,
    openclawGatewayCLIAdapter,
    processCLIAdapter,
    httpCLIAdapter,
  ].map((a) => [a.type, a]),
);

// 按类型查找 CLI 适配器；未注册的类型回退到 process 适配器（通用 JSON 格式化）
export function getCLIAdapter(type: string): CLIAdapterModule {
  return adaptersByType.get(type) ?? processCLIAdapter;
}
