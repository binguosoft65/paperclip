/**
 * Issue 引用解析工具。
 * 支持从 Markdown 文本中提取 Issue 引用标识符（如 "PROJ-123"），
 * 自动跳过代码块和内联代码中的内容，避免误匹配。
 */

/** Issue 标识符正则：大写字母开头 + 数字，如 "PROJ-123" */
export const ISSUE_REFERENCE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/** Issue 引用匹配结果 */
export interface IssueReferenceMatch {
  index: number;
  length: number;
  identifier: string;
  matchedText: string;
}

/** 从文本中识别 Issue 引用的 token 模式：URL、路径或标识符 */
const ISSUE_REFERENCE_TOKEN_RE = /https?:\/\/[^\s<>()]+|\/[^\s<>()]+|[A-Z][A-Z0-9]*-\d+/gi;

/** 将非换行字符替换为空格，保留行号对齐 */
function preserveNewlinesAsWhitespace(value: string) {
  return value.replace(/[^\n]/g, " ");
}

/**
 * 去除 Markdown 中的代码块（``` 和 ~~~）和内联代码（`），
 * 用空白占位保持位置信息，避免误将代码中的文本当作 Issue 引用。
 */
function stripMarkdownCode(markdown: string): string {
  if (!markdown) return "";

  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const remaining = markdown.slice(index);
    const fenceMatch = /^(?:```+|~~~+)/.exec(remaining);
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart && fenceMatch) {
      const fence = fenceMatch[0]!;
      const blockStart = index;
      index += fence.length;
      while (index < markdown.length && markdown[index] !== "\n") index += 1;
      if (index < markdown.length) index += 1;

      while (index < markdown.length) {
        const lineStart = index === 0 || markdown[index - 1] === "\n";
        if (lineStart && markdown.startsWith(fence, index)) {
          index += fence.length;
          while (index < markdown.length && markdown[index] !== "\n") index += 1;
          if (index < markdown.length) index += 1;
          break;
        }
        index += 1;
      }

      output += preserveNewlinesAsWhitespace(markdown.slice(blockStart, index));
      continue;
    }

    if (markdown[index] === "`") {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1;
      }
      const fence = "`".repeat(tickCount);
      const inlineStart = index;
      index += tickCount;
      const closeIndex = markdown.indexOf(fence, index);
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount);
        index = inlineStart + tickCount;
        continue;
      }
      index = closeIndex + tickCount;
      output += preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index));
      continue;
    }

    output += markdown[index]!;
    index += 1;
  }

  return output;
}

/**
 * 去掉 token 末尾的标点符号，但要小心处理括号匹配：
 * 如果 token 末尾是右括号，检查左括号数量是否 >= 右括号数量，
 * 如果是则说明括号是匹配的，不裁剪。
 */
function trimTrailingPunctuation(token: string): string {
  let trimmed = token;
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]!;
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break;

    if (
      (last === ")" && (trimmed.match(/\(/g)?.length ?? 0) >= (trimmed.match(/\)/g)?.length ?? 0))
      || (last === "]" && (trimmed.match(/\[/g)?.length ?? 0) >= (trimmed.match(/\]/g)?.length ?? 0))
    ) {
      break;
    }
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * 归一化 Issue 标识符：去除空格、转大写，然后校验格式。
 * 合法的标识符如 "PROJ-123"，不合法的返回 null。
 */
export function normalizeIssueIdentifier(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return ISSUE_REFERENCE_IDENTIFIER_RE.test(trimmed) ? trimmed : null;
}

/**
 * 根据 Issue 标识符构建前端路由链接：/issues/标识符
 */
export function buildIssueReferenceHref(identifier: string): string {
  const normalized = normalizeIssueIdentifier(identifier);
  return `/issues/${normalized ?? identifier.trim()}`;
}

/**
 * 解析 Issue 引用链接（相对路径或完整 URL），提取标识符。
 * 支持 /issues/PROJ-123 格式和 https://host/issues/PROJ-123 格式。
 */
export function parseIssueReferenceHref(href: string): { identifier: string } | null {
  const raw = href.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = raw.startsWith("/")
      ? new URL(raw, "https://paperclip.invalid")
      : new URL(raw);
  } catch {
    return null;
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]?.toLowerCase() !== "issues") continue;
    const identifier = normalizeIssueIdentifier(segments[index + 1] ?? "");
    if (identifier) {
      return { identifier };
    }
  }

  return null;
}

export function findIssueReferenceMatches(text: string): IssueReferenceMatch[] {
  if (!text) return [];

  const matches: IssueReferenceMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ISSUE_REFERENCE_TOKEN_RE);

  while ((match = re.exec(text)) !== null) {
    const rawToken = match[0];
    const cleanedToken = trimTrailingPunctuation(rawToken);
    if (!cleanedToken) continue;

    const identifier =
      normalizeIssueIdentifier(cleanedToken)
      ?? parseIssueReferenceHref(cleanedToken)?.identifier
      ?? null;

    if (!identifier) continue;

    const cleanedIndex = match.index;
    matches.push({
      index: cleanedIndex,
      length: cleanedToken.length,
      identifier,
      matchedText: cleanedToken,
    });
  }

  return matches;
}

export function extractIssueReferenceIdentifiers(markdown: string): string[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match.identifier);
  }

  return ordered;
}

export function extractIssueReferenceMatches(markdown: string): IssueReferenceMatch[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: IssueReferenceMatch[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match);
  }

  return ordered;
}
