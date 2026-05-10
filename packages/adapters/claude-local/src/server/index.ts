// Claude Code 本地适配器服务端导出模块。
// execute: 核心执行逻辑，通过 subprocess 启动 Claude CLI 的 --print 模式
// runClaudeLogin: 运行 claude login 命令完成 OAuth 登录
// listClaudeSkills / syncClaudeSkills: Paperclip 与 Claude skills 目录的同步管理
// listClaudeModels: 读取 Claude Code 支持的模型列表
// testEnvironment: 环境诊断，检查 CLI 可执行性、认证状态、hello probe
// parseClaudeStreamJson / describeClaudeFailure / isClaudeMaxTurnsResult / isClaudeUnknownSessionError:
//   输出解析工具，用于处理 Claude stream-json 格式的 stdout
// getQuotaWindows / readClaudeAuthStatus / readClaudeToken / fetchClaudeQuota 等:
//   用量配额查询和认证状态读取
export { execute, runClaudeLogin } from "./execute.js";
export { listClaudeSkills, syncClaudeSkills } from "./skills.js";
export { listClaudeModels } from "./models.js";
export { testEnvironment } from "./test.js";
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
export {
  getQuotaWindows,
  readClaudeAuthStatus,
  readClaudeToken,
  fetchClaudeQuota,
  fetchClaudeCliQuota,
  captureClaudeCliUsageText,
  parseClaudeCliUsageText,
  toPercent,
  fetchWithTimeout,
  claudeConfigDir,
} from "./quota.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const promptBundleKey =
      readNonEmptyString(record.promptBundleKey) ??
      readNonEmptyString(record.prompt_bundle_key);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const promptBundleKey =
      readNonEmptyString(params.promptBundleKey) ??
      readNonEmptyString(params.prompt_bundle_key);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
