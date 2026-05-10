// HTTP 成功响应的静默策略：避免日志被高频读请求和高频轮询 API 淹没。
// 只静默 GET/HEAD 的成功响应（状态码 < 400），错误和写操作始终记录。
// 读请求的成功日志通常没有排查价值，静默以减少日志噪音
const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

// 高频轮询 API 的成功响应：健康检查、心跳、活动流、面板数据等，静默以降低日志量
const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/health(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/activity(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/issues(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
];

// Vite 开发服务器内部的静态资源请求，频率高且无排查价值
const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/_plugins/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

// 站点根路径的请求（首页、图标、manifest 等），每次页面加载都会发起，无需记录
const SILENCED_SUCCESS_STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/sw.js",
]);

// 将 URL 规范化到 pathname 部分，去除查询参数，便于模式匹配
function normalizePath(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "/";
  const pathname = trimmed.split("?")[0]?.trim() ?? "/";
  return pathname.length > 0 ? pathname : "/";
}

export function shouldSilenceHttpSuccessLog(method: string | undefined, url: string | undefined, statusCode: number): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}
