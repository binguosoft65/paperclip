export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

// 命令文本敏感信息脱敏：在日志和显示中替换 API 密钥、Token、密码等敏感数据。
// 覆盖以下模式：
// - 常见 CLI 选项中的凭据（--api-key=xxx, --token xxx 等）
// - 环境变量赋值中的密文（TOKEN=xxx, PASSWORD=xxx 等）
// - Authorization: Bearer 头部
// - OpenAI sk- 密钥格式
// - GitHub Token 格式（ghp_/gho_/ghu_/ghs_/ghr_ 前缀）
// - JWT/会话 Token 格式（三或四段 base64 字符串）
// 注意：JWT 正则可能误匹配非密钥的 base64 编码字符串，但误报（false positive）比泄露更安全。
const COMMAND_CLI_SECRET_OPTION_RE =
  /(\B-{1,2}(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:\s+|=)(["']?))[^\s"'`]+(\2)/gi;
const COMMAND_ENV_SECRET_ASSIGNMENT_RE =
  /(\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Za-z0-9_]*\s*=\s*)[^\s"'`]+/gi;
const COMMAND_AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;

// 应用所有脱敏规则。redactedValue 可自定义（默认用 ***REDACTED*** 还是其他标记）。
export function redactCommandText(command: string, redactedValue = REDACTED_COMMAND_TEXT_VALUE): string {
  return command
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(COMMAND_ENV_SECRET_ASSIGNMENT_RE, `$1${redactedValue}`)
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue);
}
