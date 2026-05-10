// Codex 本地适配器服务端导出模块。
// execute: 核心执行逻辑，通过 subprocess 启动 Codex CLI exec 模式
// ensureCodexSkillsInjected: 将 Paperclip skill 注入到 CODEX_HOME/skills/ 目录
// listCodexSkills / syncCodexSkills: Paperclip 与 Codex skills 目录的同步管理
// testEnvironment: 环境诊断，检查 CLI 可执行性、认证状态、hello probe
// parseCodexJsonl / isCodexTransientUpstreamError / isCodexUnknownSessionError:
//   Codex JSONL 输出解析、临时上游错误的识别、未知session错误的识别
export { execute, ensureCodexSkillsInjected } from "./execute.js";
export { listCodexSkills, syncCodexSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export { parseCodexJsonl, isCodexTransientUpstreamError, isCodexUnknownSessionError } from "./parse.js";
export {
  getQuotaWindows,
  readCodexAuthInfo,
  readCodexToken,
  fetchCodexQuota,
  fetchCodexRpcQuota,
  mapCodexRpcQuota,
  secondsToWindowLabel,
  fetchWithTimeout,
  codexHomeDir,
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
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
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
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
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
