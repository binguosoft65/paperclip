import { createHmac, timingSafeEqual } from "node:crypto";

interface JwtHeader {
  alg: string;
  typ?: string;
}

/**
 * Agent JWT 声明 —— Agent 临时认证令牌的数据结构。
 *
 * 与标准的用户 JWT 不同，Agent JWT 不包含用户的身份信息，
 * 而是包含 Agent ID、公司 ID 和适配器类型。
 * 这些令牌由 Paperclip 平台内部签发，用于 Agent 任务执行的 API 调用认证。
 */
export interface LocalAgentJwtClaims {
  sub: string;         // Agent ID
  company_id: string;  // 所属公司 ID
  adapter_type: string; // Agent 适配器类型
  run_id: string;      // 任务运行 ID，关联执行上下文
  iat: number;         // 签发时间
  exp: number;         // 过期时间
  iss?: string;         // 签发者
  aud?: string;         // 受众（目标 API）
  jti?: string;         // JWT ID，用于重放防护
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * 获取 Agent JWT 配置。
 * secret 优先使用专用变量，回退到 BETTER_AUTH_SECRET（便于部署时减少配置项）。
 * 如果两者都未设置，返回 null 表示 JWT 功能不可用（适用于不启用 Agent 认证的场景）。
 */
function jwtConfig() {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),
    issuer: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    audience: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
  };
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 创建 Agent JWT —— 平台为运行中的 Agent 任务签发临时认证令牌。
 *
 * 令牌使用 HMAC-SHA256 签名，默认有效期为 48 小时。
 * 包含 Agent ID、公司 ID、适配器类型和运行 ID，用于 API 网关验证身份和权限。
 * 如果 JWT 未配置（无 secret），返回 null，表示不支持 Agent JWT 认证。
 */
export function createLocalAgentJwt(agentId: string, companyId: string, adapterType: string, runId: string) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

/**
 * 验证 Agent JWT —— 检查签名、过期时间和声明完整性。
 *
 * 验证步骤：
 * 1. 检查 token 格式（三部分：header.payload.signature）
 * 2. 验证头部算法为 HS256
 * 3. 使用 HMAC-SHA256 验证签名完整性
 * 4. 检查过期时间
 * 5. 如果声明中包含 issuer/audience，验证与配置匹配
 *
 * 使用恒定时间比较防止签名伪造攻击。
 * 返回 null 表示验证失败（格式错误、签名无效、已过期等）。
 */
export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !companyId || !adapterType || !runId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
