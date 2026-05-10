/**
 * Agent URL Key 工具函数。
 * URL Key 是 Agent 在 URL 路径中使用的简短可读标识符（如 "ceo-agent"），
 * 由 Agent 名称通过归一化得到。
 */

/** 将非字母数字字符替换为连字符 */
const AGENT_URL_KEY_DELIM_RE = /[^a-z0-9]+/g;
/** 去掉首尾多余的连字符 */
const AGENT_URL_KEY_TRIM_RE = /^-+|-+$/g;
/** UUID 正则（支持版本 1-5） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 判断值是否为合法的 UUID 格式 */
export function isUuidLike(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return UUID_RE.test(value.trim());
}

/**
 * 将任意字符串归一化为 Agent URL Key。
 * 规则：转小写、非字母数字替换为连字符、去掉首尾连字符。
 * 无法归一化时返回 null。
 */
export function normalizeAgentUrlKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(AGENT_URL_KEY_DELIM_RE, "-")
    .replace(AGENT_URL_KEY_TRIM_RE, "");
  return normalized.length > 0 ? normalized : null;
}

/**
 * 从 Agent 名称生成 URL Key。
 * 优先使用 name 归一化结果，失败时使用 fallback，均失败时回退为 "agent"。
 */
export function deriveAgentUrlKey(name: string | null | undefined, fallback?: string | null): string {
  return normalizeAgentUrlKey(name) ?? normalizeAgentUrlKey(fallback) ?? "agent";
}
