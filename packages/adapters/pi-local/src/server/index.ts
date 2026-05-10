import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

// 辅助函数：提取非空字符串
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// sessionCodec：Pi 会话编码器。
// Pi 的 sessionId 是文件路径（~/.pi/paperclips/<timestamp>-<agentId>.jsonl），
// 因此比 Gemini/OpenCode 多支持 "session" 字段名，但不保存 workspace 元数据
// （Pi 的 session 文件格式与其他适配器不同）。
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};

export { execute } from "./execute.js";
export { listPiSkills, syncPiSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  listPiModels,
  discoverPiModels,
  discoverPiModelsCached,
  ensurePiModelConfiguredAndAvailable,
  resetPiModelsCacheForTests,
} from "./models.js";
export { parsePiJsonl, isPiUnknownSessionError } from "./parse.js";
