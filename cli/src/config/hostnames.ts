// 主机名归一化：支持用户传入裸主机名或带协议的 URL
// 统一提取 hostname 并转为小写，用于去重和一致性比较
// 这是安全边界 — 将用户输入的主机名标准化，防止因格式差异绕过 allowlist 检查
export function normalizeHostnameInput(raw: string): string {
  const input = raw.trim();
  if (!input) {
    throw new Error("Hostname is required");
  }

  try {
    const url = input.includes("://") ? new URL(input) : new URL(`http://${input}`);
    const hostname = url.hostname.trim().toLowerCase();
    if (!hostname) throw new Error("Hostname is required");
    return hostname;
  } catch {
    throw new Error(`Invalid hostname: ${raw}`);
  }
}

export function parseHostnameCsv(raw: string): string[] {
  if (!raw.trim()) return [];
  const unique = new Set<string>();
  for (const part of raw.split(",")) {
    const hostname = normalizeHostnameInput(part);
    unique.add(hostname);
  }
  return Array.from(unique);
}

