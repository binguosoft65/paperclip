/**
 * 解析 Markdown 内容里的 `[[node-id]]` wikilink，返回去重后的 UUID 列表
 * （按首次出现顺序）。
 *
 * Phase 1a 仅支持 UUID 形式；`[[Title]]` 形式需要在拿到全库节点后做模糊
 * 匹配，留给后续 Phase。
 *
 * 解析规则：
 * - 先剥除 fenced code block（``` ... ```）和行内 code（`...`），避免误抓示例
 * - 匹配 `[[<uuid>]]`（UUID 大小写不敏感，输出归一化为小写）
 * - 同 UUID 多次出现仅保留首次
 */

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const WIKILINK_UUID_RE =
  /\[\[\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*\]\]/g;

export function parseWikilinks(content: string): string[] {
  if (!content) return [];
  const stripped = content.replace(FENCED_CODE_RE, "").replace(INLINE_CODE_RE, "");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of stripped.matchAll(WIKILINK_UUID_RE)) {
    const uuid = match[1].toLowerCase();
    if (!seen.has(uuid)) {
      seen.add(uuid);
      result.push(uuid);
    }
  }
  return result;
}
