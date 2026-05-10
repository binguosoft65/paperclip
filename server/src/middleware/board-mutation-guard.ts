import type { Request, RequestHandler } from "express";

// 幂等/安全方法：GET、HEAD、OPTIONS 不会修改资源，无需校验来源
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// 本地开发环境的信任来源，3100 是默认的前端开发服务器端口
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
];

// 将来源字符串标准化为 "protocol://host" 格式，用于后续比对
function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

// 根据当前请求构建信任的来源集合：包含本地开发地址、Host 头推断的地址，以及显式配置的公网地址
function trustedOriginsForRequest(req: Request) {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.header("host")?.trim();
  if (host) {
    // 同时信任 http 和 https 两种协议，因为代理可能在边界终结 TLS
    origins.add(`http://${host}`.toLowerCase());
    origins.add(`https://${host}`.toLowerCase());
  }
  // Behind some reverse proxies the Host / X-Forwarded-Host header may
  // not match the public URL (for example when TLS terminates at the
  // edge and the inbound Host is an internal service name). Trust the
  // explicitly-configured PAPERCLIP_PUBLIC_URL when it's set.
  // 当反向代理后的 Host 头是内部服务名时，显式配置的公网地址是唯一可靠的来源
  const publicUrl = parseOrigin(process.env.PAPERCLIP_PUBLIC_URL?.trim());
  if (publicUrl) origins.add(publicUrl);
  return origins;
}

// 检查请求的 Origin 或 Referer 是否在信任集合中，防止跨站请求伪造（CSRF）
function isTrustedBoardMutationRequest(req: Request) {
  const allowedOrigins = trustedOriginsForRequest(req);
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
}

// 生成 Board 写操作守卫中间件：只允许来自可信来源的 Board 写操作
// 此中间件防止 Board（白板）被外部不可信页面通过浏览器 API 非法修改
export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    // 安全方法不需要校验
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    // 非 Board 身份的操作也不受此限制
    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local-trusted mode and board bearer keys are not browser-session requests.
    // In these modes, origin/referer headers can be absent; do not block those mutations.
    // 本地隐式信任模式和 Board 密钥认证是非浏览器请求，可能缺少 Origin/Referer，跳过来源校验
    if (req.actor.source === "local_implicit" || req.actor.source === "board_key") {
      next();
      return;
    }

    // 来源不在信任列表中时拒绝请求，防止 CSRF 攻击
    if (!isTrustedBoardMutationRequest(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
