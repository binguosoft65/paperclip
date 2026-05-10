/**
 * Project URL Key 工具函数。
 * 与 Agent URL Key 类似，但需要额外处理非 ASCII 字符和 UUID 回退。
 */

/** 将非字母数字字符替换为连字符 */
const PROJECT_URL_KEY_DELIM_RE = /[^a-z0-9]+/g;
/** 去掉首尾多余的连字符 */
const PROJECT_URL_KEY_TRIM_RE = /^-+|-+$/g;
/** 检测非 ASCII 字符 */
const NON_ASCII_RE = /[^\x00-\x7F]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 将字符串归一化为 Project URL Key。
 * 规则：转小写、非字母数字替换为连字符、去掉首尾连字符。
 */
export function normalizeProjectUrlKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(PROJECT_URL_KEY_DELIM_RE, "-")
    .replace(PROJECT_URL_KEY_TRIM_RE, "");
  return normalized.length > 0 ? normalized : null;
}

/** 检查字符串是否包含非 ASCII 字符（归一化会将其剥离） */
export function hasNonAsciiContent(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return NON_ASCII_RE.test(value);
}

/** 从合法的 UUID 中提取前 8 个十六进制字符作为短标识 */
function shortIdFromUuid(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) return null;
  return value.trim().replace(/-/g, "").slice(0, 8).toLowerCase();
}

/**
 * 从 Project 名称生成 URL Key。
 * 如果名称包含非 ASCII 字符，会在末尾追加 UUID 短标识以确保唯一性。
 */
export function deriveProjectUrlKey(name: string | null | undefined, fallback?: string | null): string {
  const base = normalizeProjectUrlKey(name);
  if (base && !hasNonAsciiContent(name)) return base;
  // 非 ASCII 内容在归一化中被剥离，追加 UUID 短标识确保唯一
  const shortId = shortIdFromUuid(fallback);
  if (base && shortId) return `${base}-${shortId}`;
  if (shortId) return shortId;
  return base ?? normalizeProjectUrlKey(fallback) ?? "project";
}
