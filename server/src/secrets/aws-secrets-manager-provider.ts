import { createHash, createHmac } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import type { DeploymentMode } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type {
  PreparedSecretVersion,
  RemoteSecretListResult,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

// AWS Secrets Manager Provider 的存储材料标识。用于 DB 中区分不同 Provider 的存储格式。
const AWS_SECRETS_MANAGER_SCHEME = "aws_secrets_manager_v1";
// 默认的 AWS Secret 名称前缀和拥有者标签
const DEFAULT_PREFIX = "paperclip";
const DEFAULT_OWNER_TAG = "paperclip";
// AWS 默认版本阶段标记为 AWSCURRENT。Paperclip 在轮换时先写入 PAPERCLIP_PENDING 阶段，
// 后续由独立协调流程将新版本标记为 AWSCURRENT 并移除旧版本的 AWSCURRENT。
// 这种"两阶段提交"设计防止轮换过程中的竞态条件——消费者在过渡期间仍然可以获取旧值。
const DEFAULT_VERSION_STAGE = "AWSCURRENT";
const PAPERCLIP_PENDING_VERSION_STAGE = "PAPERCLIP_PENDING";
// AWS Secrets Manager 删除密钥时默认有 30 天恢复窗口。
const DEFAULT_DELETE_RECOVERY_WINDOW_DAYS = 30;
// AWS API 请求超时设置：30 秒。AWS Secrets Manager 的 API 延迟通常在 200ms~2s 之间，
// 30 秒的超时足以应对大多数情况，同时避免长时间挂起服务器线程。
const AWS_SECRETS_MANAGER_REQUEST_TIMEOUT_MS = 30_000;
// AWS 凭证缓存 TTL：5 分钟。避免每次解析密钥都去拉取 STS 凭证。
// 对于使用 IAM 角色的部署，凭证有效期通常为 6~15 小时，5 分钟缓存是一个合理的刷新周期。
const AWS_CREDENTIAL_CACHE_TTL_MS = 5 * 60_000;
const AWS_CREDENTIAL_EXPIRATION_SKEW_MS = 60_000;
const AWS_RUNTIME_CREDENTIAL_WARNING =
  "AWS bootstrap credentials must be available to the Paperclip server runtime through the AWS SDK default credential provider chain: IAM role/workload identity, AWS_PROFILE/SSO/shared credentials, web identity, container/instance metadata, or short-lived shell credentials.";
const AWS_CREDENTIAL_CUSTODY_WARNING =
  "Do not store AWS root credentials or long-lived IAM user access keys in Paperclip company_secrets; the AWS provider bootstrap belongs in deployment infrastructure, the process environment, an AWS profile, or the orchestrator secret store.";

// AWS Secrets Manager 存储材料。区分两种来源：
// - managed: Paperclip 创建和管理的密钥（Paperclip 拥有写入权限）
// - external_reference: 仅引用已有的 AWS Secret（Paperclip 只读，不负责轮换）
// 这种区分对于删除/归档时的行为选择至关重要——managed 会被级联删除，external_reference 则不会。
interface AwsSecretsManagerMaterial extends StoredSecretVersionMaterial {
  scheme: typeof AWS_SECRETS_MANAGER_SCHEME;
  secretId: string;
  versionId: string | null;
  source: "managed" | "external_reference";
}

// AWS Secrets Manager Provider 的运行时配置。
// region 和 deploymentId 是必填项，其余字段有合理的默认值。
// kmsKeyId 可为 null——不指定时使用 AWS 默认的 aws/secretsmanager KMS 密钥。
interface AwsSecretsManagerConfig {
  region: string;
  endpoint: string;
  deploymentId: string;
  prefix: string;
  kmsKeyId: string | null;
  environmentTag: string;
  providerOwnerTag: string;
  deleteRecoveryWindowDays: number;
}

interface AwsSecretsManagerTag {
  Key: string;
  Value: string;
}

interface AwsSecretsManagerListSecretEntry {
  ARN?: string;
  Name?: string;
  Description?: string;
  KmsKeyId?: string;
  CreatedDate?: string | number | Date;
  LastAccessedDate?: string | number | Date;
  LastChangedDate?: string | number | Date;
  DeletedDate?: string | number | Date;
  Tags?: AwsSecretsManagerTag[];
}

interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface CachedAwsCredentialProvider {
  client: S3Client;
  credentials: AwsCredentialIdentity | null;
  expiresAt: number;
  pending: Promise<AwsCredentialIdentity> | null;
}

type ManagedSecretNamespaceContext = Pick<SecretProviderWriteContext, "companyId" | "secretKey">;

// 进程级 AWS 凭证缓存（区域 -> 凭证提供者）。
// 使用 Map 而不是全局变量的原因是：不同区域可能有不同的 IAM 角色配置。
// 注意：这是进程级缓存，不在不同进程或服务器间共享。
const awsCredentialProviders = new Map<string, CachedAwsCredentialProvider>();

interface AwsSecretsManagerGateway {
  createSecret(input: {
    Name: string;
    SecretString: string;
    KmsKeyId?: string;
    Description?: string;
    Tags: AwsSecretsManagerTag[];
  }): Promise<{
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  putSecretValue(input: {
    SecretId: string;
    SecretString: string;
    VersionStages?: string[];
  }): Promise<{
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  getSecretValue(input: {
    SecretId: string;
    VersionId?: string;
    VersionStage?: string;
  }): Promise<{
    SecretString?: string;
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  deleteSecret(input: {
    SecretId: string;
    RecoveryWindowInDays: number;
  }): Promise<unknown>;
  updateSecretVersionStage?(input: {
    SecretId: string;
    VersionStage: string;
    RemoveFromVersionId?: string;
    MoveToVersionId?: string;
  }): Promise<unknown>;
  listSecrets?(input: {
    MaxResults?: number;
    NextToken?: string;
    Filters?: Array<{
      Key: "all" | "name" | "description" | "tag-key" | "tag-value" | "primary-region" | "owning-service";
      Values: string[];
    }>;
    IncludePlannedDeletion?: boolean;
  }): Promise<{
    SecretList?: AwsSecretsManagerListSecretEntry[];
    NextToken?: string;
  }>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function awsDateParts(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function canonicalHeaderValue(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

// 手动实现 AWS Signature V4 签名算法。
// 选择手动实现而不是使用 @aws-sdk/client-secrets-manager 的原因：
// 1. 减少依赖体积和版本管理负担
// 2. Secrets Manager API 调用频率低，没必要拉取完整的 SDK 客户端
// 3. 该实现遵循 AWS SigV4 规范（https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html）
function signAwsSecretsManagerRequest(input: {
  endpoint: URL;
  region: string;
  operation: string;
  body: string;
  credentials: AwsCredentialIdentity;
}) {
  const { amzDate, dateStamp } = awsDateParts();
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: input.endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-target": `secretsmanager.${input.operation}`,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${canonicalHeaderValue(headers[name] ?? "")}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    input.endpoint.pathname || "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/secretsmanager/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, "secretsmanager");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// 通过 AWS SDK 默认凭证链加载凭证，附带区域级别的缓存。
// 使用 S3Client 作为凭证提供者的"载具"来访问 AWS SDK 的默认凭证链，
// 这是一个实现细节——我们没有真的调用 S3 API。
// 缓存策略：凭证过期时间取"缓存 TTL（5 分钟）"和"凭证实际过期时间减 60 秒偏移"两者中较小值，
// 确保在凭证即将过期前提前刷新，避免因时钟偏差导致使用过期凭证。
async function loadAwsCredentials(region: string): Promise<AwsCredentialIdentity> {
  const now = Date.now();
  let cached = awsCredentialProviders.get(region);
  if (!cached) {
    // S3Client 仅作为获取 AWS SDK 默认凭证链的工具。
    // 如果你添加了需实际使用 S3 的功能，应切换到 defaultProvider({ region })。
    cached = {
      client: new S3Client({ region }),
      credentials: null,
      expiresAt: 0,
      pending: null,
    };
    awsCredentialProviders.set(region, cached);
  }

  if (cached.credentials && cached.expiresAt > now) return cached.credentials;
  if (cached.pending) return cached.pending;

  cached.pending = (async () => {
    const credentialSource = cached.client.config.credentials;
    const credentials = typeof credentialSource === "function"
      ? await credentialSource()
      : await credentialSource;
    if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
      throw new Error("AWS SDK default credential provider chain did not return credentials");
    }
    const resolved = {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    };
    const expiration = (credentials as { expiration?: Date }).expiration?.getTime();
    cached.credentials = resolved;
    cached.expiresAt = Math.min(
      now + AWS_CREDENTIAL_CACHE_TTL_MS,
      expiration ? expiration - AWS_CREDENTIAL_EXPIRATION_SKEW_MS : Number.POSITIVE_INFINITY,
    );
    return resolved;
  })().finally(() => {
    if (cached) cached.pending = null;
  });

  return cached.pending;
}

function configuredAwsSecretsManagerDescriptor() {
  return {
    id: "aws_secrets_manager" as const,
    label: "AWS Secrets Manager",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: true,
    configured: canLoadAwsSecretsManagerConfig(),
  };
}

function canLoadAwsSecretsManagerConfig() {
  return getAwsConfigReadiness().missingConfig.length === 0;
}

function asOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readProviderVaultConfig(input: SecretProviderVaultRuntimeConfig): AwsSecretsManagerConfig {
  if (input.provider !== "aws_secrets_manager") {
    throw unprocessable("AWS Secrets Manager provider received a mismatched provider vault");
  }
  if (input.status === "disabled") {
    throw unprocessable("AWS Secrets Manager provider vault is disabled");
  }
  if (input.status === "coming_soon") {
    throw unprocessable("AWS Secrets Manager provider vault runtime is locked while coming soon");
  }
  const region = asOptionalNonEmptyString(input.config.region);
  if (!region) {
    throw unprocessable("AWS Secrets Manager provider vault requires non-secret config: region");
  }
  const recoveryWindowRaw = process.env.PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS?.trim();
  const recoveryWindow = recoveryWindowRaw ? Number(recoveryWindowRaw) : DEFAULT_DELETE_RECOVERY_WINDOW_DAYS;
  if (!Number.isFinite(recoveryWindow) || recoveryWindow < 7 || recoveryWindow > 30) {
    throw unprocessable(
      "PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS must be an integer between 7 and 30",
    );
  }

  return {
    region,
    endpoint:
      process.env.PAPERCLIP_SECRETS_AWS_ENDPOINT?.trim() ||
      `https://secretsmanager.${region}.amazonaws.com`,
    deploymentId: sanitizePathSegment(
      asOptionalNonEmptyString(input.config.namespace) ?? input.id,
    ),
    prefix: sanitizePathSegment(
      asOptionalNonEmptyString(input.config.secretNamePrefix) || DEFAULT_PREFIX,
    ),
    kmsKeyId: asOptionalNonEmptyString(input.config.kmsKeyId),
    environmentTag:
      asOptionalNonEmptyString(input.config.environmentTag) ||
      process.env.NODE_ENV?.trim() ||
      "unknown",
    providerOwnerTag:
      asOptionalNonEmptyString(input.config.ownerTag) || DEFAULT_OWNER_TAG,
    deleteRecoveryWindowDays: recoveryWindow,
  };
}

function getAwsConfigReadiness() {
  const region = (
    process.env.PAPERCLIP_SECRETS_AWS_REGION ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION
  )?.trim();
  const deploymentId = process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim();
  const kmsKeyId = process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim();
  const missingConfig: string[] = [];

  if (!region) {
    missingConfig.push("PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION");
  }
  if (!deploymentId) {
    missingConfig.push("PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID");
  }
  if (!kmsKeyId) {
    missingConfig.push("PAPERCLIP_SECRETS_AWS_KMS_KEY_ID");
  }

  return {
    missingConfig,
    region: region || null,
    deploymentId: deploymentId || null,
    kmsKeyConfigured: Boolean(kmsKeyId),
    credentialSources: describeDetectedAwsCredentialSources(),
  };
}

function describeDetectedAwsCredentialSources() {
  const sources: string[] = [];
  if (process.env.AWS_PROFILE?.trim()) sources.push("AWS_PROFILE/shared config");
  if (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) {
    sources.push("temporary AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY environment credentials");
  }
  if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim() && process.env.AWS_ROLE_ARN?.trim()) {
    sources.push("AWS web identity token");
  }
  if (
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim() ||
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()
  ) {
    sources.push("AWS container credentials endpoint");
  }
  if (process.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || process.env.AWS_CONFIG_FILE?.trim()) {
    sources.push("custom AWS shared credentials/config file");
  }
  return sources;
}

function loadAwsSecretsManagerConfig(): AwsSecretsManagerConfig {
  const readiness = getAwsConfigReadiness();
  const region =
    process.env.PAPERCLIP_SECRETS_AWS_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim();
  const deploymentId = process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim();
  const kmsKeyId = process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim();

  if (readiness.missingConfig.length > 0) {
    throw unprocessable(
      `AWS Secrets Manager provider requires non-secret config: ${readiness.missingConfig.join(", ")}`,
    );
  }
  if (!region) {
    throw unprocessable(
      "AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION",
    );
  }
  if (!deploymentId) {
    throw unprocessable(
      "AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID",
    );
  }
  if (!kmsKeyId) {
    throw unprocessable(
      "AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_KMS_KEY_ID",
    );
  }

  const recoveryWindowRaw = process.env.PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS?.trim();
  const recoveryWindow = recoveryWindowRaw ? Number(recoveryWindowRaw) : DEFAULT_DELETE_RECOVERY_WINDOW_DAYS;
  if (!Number.isFinite(recoveryWindow) || recoveryWindow < 7 || recoveryWindow > 30) {
    throw unprocessable(
      "PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS must be an integer between 7 and 30",
    );
  }

  return {
    region,
    endpoint:
      process.env.PAPERCLIP_SECRETS_AWS_ENDPOINT?.trim() ||
      `https://secretsmanager.${region}.amazonaws.com`,
    deploymentId,
    prefix: sanitizePathSegment(process.env.PAPERCLIP_SECRETS_AWS_PREFIX?.trim() || DEFAULT_PREFIX),
    kmsKeyId,
    environmentTag:
      process.env.PAPERCLIP_SECRETS_AWS_ENVIRONMENT?.trim() ||
      process.env.NODE_ENV?.trim() ||
      "unknown",
    providerOwnerTag:
      process.env.PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER?.trim() || DEFAULT_OWNER_TAG,
    deleteRecoveryWindowDays: recoveryWindow,
  };
}

function sanitizePathSegment(input: string) {
  return input
    .trim()
    .replace(/[^A-Za-z0-9/_+=.@-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

// 构造 AWS Secret 的托管名称。命名空间为：
// {prefix}/{deploymentId}/{companyId}/{secretKey}
// 这种层级命名确保不同部署和公司间的密钥不会冲突。
// 同时支持在 AWS Console 中通过前缀快速过滤和搜索。
function buildManagedSecretName(
  config: AwsSecretsManagerConfig,
  context: ManagedSecretNamespaceContext | undefined,
) {
  if (!context) {
    throw unprocessable("AWS Secrets Manager provider requires secret context for managed values");
  }
  return [
    sanitizePathSegment(config.prefix),
    sanitizePathSegment(config.deploymentId),
    sanitizePathSegment(context.companyId),
    sanitizePathSegment(context.secretKey),
  ]
    .filter(Boolean)
    .join("/");
}

function buildManagedSecretId(
  config: AwsSecretsManagerConfig,
  context: ManagedSecretNamespaceContext | undefined,
) {
  return buildManagedSecretName(config, context);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAwsSecretName(externalRef: string) {
  const trimmed = externalRef.trim();
  const arnMatch = /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)$/i.exec(trimmed);
  return arnMatch?.[1] ?? trimmed;
}

// 检查某个 externalRef 是否指向本上下文的托管密钥。
// AWS Secrets Manager 在创建密钥时会自动追加 6 字符随机后缀，
// 所以正则中匹配 optional 的 `-[A-Za-z0-9]{6}` 后缀。
function isManagedSecretRefForContext(
  config: AwsSecretsManagerConfig,
  context: ManagedSecretNamespaceContext | undefined,
  externalRef: string | null | undefined,
) {
  if (!externalRef?.trim()) return false;
  const expectedName = buildManagedSecretName(config, context);
  const actualName = extractAwsSecretName(externalRef);
  return new RegExp(`^${escapeRegExp(expectedName)}(?:-[A-Za-z0-9]{6})?$`).test(actualName);
}

function isManagedSecretNamespaceRef(
  config: AwsSecretsManagerConfig,
  externalRef: string | null | undefined,
) {
  if (!externalRef?.trim()) return false;
  const namespacePrefix = [
    sanitizePathSegment(config.prefix),
    sanitizePathSegment(config.deploymentId),
  ]
    .filter(Boolean)
    .join("/");
  if (!namespacePrefix) return false;
  const actualName = extractAwsSecretName(externalRef);
  return actualName === namespacePrefix || actualName.startsWith(`${namespacePrefix}/`);
}

function assertNotManagedNamespaceExternalRef(
  config: AwsSecretsManagerConfig,
  externalRef: string,
) {
  if (!isManagedSecretNamespaceRef(config, externalRef)) return;
  throw unprocessable(
    "AWS Paperclip-managed namespace secrets cannot be imported as external references",
  );
}

function resolveManagedSecretRef(input: {
  config: AwsSecretsManagerConfig;
  context: ManagedSecretNamespaceContext | undefined;
  externalRefs: Array<string | null | undefined>;
}) {
  let sawNonEmptyExternalRef = false;
  for (const externalRef of input.externalRefs) {
    if (externalRef?.trim()) {
      sawNonEmptyExternalRef = true;
    }
    if (externalRef?.trim() && isManagedSecretRefForContext(input.config, input.context, externalRef)) {
      return externalRef.trim();
    }
  }
  if (sawNonEmptyExternalRef) {
    throw unprocessable(
      "AWS Secrets Manager managed secret ref drifted outside the derived deployment/company scope",
    );
  }
  return buildManagedSecretId(input.config, input.context);
}

function buildManagedSecretTags(
  config: AwsSecretsManagerConfig,
  context: SecretProviderWriteContext | undefined,
): AwsSecretsManagerTag[] {
  if (!context) return [];
  return [
    { Key: "paperclip:managed-by", Value: "paperclip" },
    { Key: "paperclip:provider-owner", Value: config.providerOwnerTag },
    { Key: "paperclip:deployment-id", Value: config.deploymentId },
    { Key: "paperclip:company-id", Value: context.companyId },
    { Key: "paperclip:secret-key", Value: context.secretKey },
    { Key: "paperclip:environment", Value: config.environmentTag },
  ];
}

function createExternalReferenceMaterial(
  externalRef: string,
  providerVersionRef: string | null,
): PreparedSecretVersion {
  const normalizedExternalRef = externalRef.trim();
  const normalizedProviderVersionRef = providerVersionRef?.trim() || null;
  const fingerprint = sha256Hex(
    `${AWS_SECRETS_MANAGER_SCHEME}:${normalizedExternalRef}:${normalizedProviderVersionRef ?? ""}`,
  );
  return {
    material: {
      scheme: AWS_SECRETS_MANAGER_SCHEME,
      secretId: normalizedExternalRef,
      versionId: normalizedProviderVersionRef,
      source: "external_reference",
    },
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: normalizedExternalRef,
    providerVersionRef: normalizedProviderVersionRef,
  };
}

function createManagedMaterial(secretId: string, versionId: string | null): AwsSecretsManagerMaterial {
  return {
    scheme: AWS_SECRETS_MANAGER_SCHEME,
    secretId,
    versionId,
    source: "managed",
  };
}

function serializeAwsDate(value: string | number | Date | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function createRemoteSecretMetadata(entry: AwsSecretsManagerListSecretEntry): Record<string, unknown> {
  return {
    createdDate: serializeAwsDate(entry.CreatedDate),
    lastAccessedDate: serializeAwsDate(entry.LastAccessedDate),
    lastChangedDate: serializeAwsDate(entry.LastChangedDate),
    deletedDate: serializeAwsDate(entry.DeletedDate),
    hasDescription: Boolean(entry.Description),
    hasKmsKey: Boolean(entry.KmsKeyId),
    tagCount: Array.isArray(entry.Tags) ? entry.Tags.length : 0,
  };
}

function asAwsSecretsManagerMaterial(value: StoredSecretVersionMaterial): AwsSecretsManagerMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === AWS_SECRETS_MANAGER_SCHEME &&
    typeof value.secretId === "string" &&
    (typeof value.versionId === "string" || value.versionId === null) &&
    (value.source === "managed" || value.source === "external_reference")
  ) {
    return value as AwsSecretsManagerMaterial;
  }
  throw unprocessable("Invalid AWS Secrets Manager material");
}

function classifyAwsProviderError(message: string): SecretProviderClientErrorCode {
  if (/ResourceExistsException|AlreadyExists/i.test(message)) return "conflict";
  if (/ResourceNotFoundException|NotFound/i.test(message)) return "not_found";
  if (/AccessDeniedException|AccessDenied|UnrecognizedClientException|InvalidClientTokenId|not authorized/i.test(message)) {
    return "access_denied";
  }
  if (/Throttl|TooManyRequests|RequestLimitExceeded|Rate exceeded/i.test(message)) return "throttled";
  if (/ValidationException|InvalidParameter|InvalidRequest/i.test(message)) return "invalid_request";
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|timeout/i.test(message)) return "provider_unavailable";
  return "provider_error";
}

function awsProviderSafeMessage(code: SecretProviderClientErrorCode): string {
  switch (code) {
    case "access_denied":
      return "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.";
    case "throttled":
      return "AWS Secrets Manager throttled the request. Wait and try again.";
    case "not_found":
      return "AWS Secrets Manager could not find the requested secret.";
    case "conflict":
      return "AWS Secrets Manager reported that the requested secret already exists.";
    case "invalid_request":
      return "AWS Secrets Manager rejected the request.";
    case "provider_unavailable":
      return "AWS Secrets Manager is unavailable right now.";
    case "provider_error":
    default:
      return "AWS Secrets Manager request failed.";
  }
}

function normalizeAwsError(operation: string, error: unknown): never {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const code = classifyAwsProviderError(rawMessage);
  throw new SecretProviderClientError({
    code,
    provider: "aws_secrets_manager",
    operation,
    message: awsProviderSafeMessage(code),
    rawMessage,
    cause: error,
  });
}

// AWS Secrets Manager 的低级 HTTP JSON 客户端。
// 所有 API 调用经过统一的 call 方法路由，此方法负责：
// 1. SigV4 签名 2. 超时控制 3. 错误分类和脱敏
// 错误消息中的 AWS 原始错误码和消息被分类为业务友好的错误码，
// 避免将 AWS 内部错误信息直接暴露给前端。
class AwsSecretsManagerJsonGateway implements AwsSecretsManagerGateway {
  private readonly endpoint: URL;

  constructor(private readonly config: AwsSecretsManagerConfig) {
    this.endpoint = new URL(config.endpoint);
  }

  createSecret(input: {
    Name: string;
    SecretString: string;
    KmsKeyId?: string;
    Description?: string;
    Tags: AwsSecretsManagerTag[];
  }) {
    return this.call<{
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("CreateSecret", input);
  }

  putSecretValue(input: {
    SecretId: string;
    SecretString: string;
    VersionStages?: string[];
  }) {
    return this.call<{
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("PutSecretValue", input);
  }

  getSecretValue(input: {
    SecretId: string;
    VersionId?: string;
    VersionStage?: string;
  }) {
    return this.call<{
      SecretString?: string;
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("GetSecretValue", input);
  }

  deleteSecret(input: {
    SecretId: string;
    RecoveryWindowInDays: number;
  }) {
    return this.call("DeleteSecret", input);
  }

  updateSecretVersionStage(input: {
    SecretId: string;
    VersionStage: string;
    RemoveFromVersionId?: string;
    MoveToVersionId?: string;
  }) {
    return this.call("UpdateSecretVersionStage", input);
  }

  listSecrets(input: {
    MaxResults?: number;
    NextToken?: string;
    Filters?: Array<{
      Key: "all" | "name" | "description" | "tag-key" | "tag-value" | "primary-region" | "owning-service";
      Values: string[];
    }>;
    IncludePlannedDeletion?: boolean;
  }) {
    return this.call<{
      SecretList?: AwsSecretsManagerListSecretEntry[];
      NextToken?: string;
    }>("ListSecrets", input);
  }

  // 统一的 AWS API 调用入口。使用原生 fetch API（而非 axios 或其他 HTTP 客户端），
  // 因为 fetch 是 Node 18+ 内置 API，无需额外依赖。超时使用 AbortSignal.timeout 实现。
  private async call<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const credentials = await loadAwsCredentials(this.config.region);
    const headers = signAwsSecretsManagerRequest({
      endpoint: this.endpoint,
      region: this.config.region,
      operation,
      body,
      credentials,
    });
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(AWS_SECRETS_MANAGER_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const code = String(parsed.__type ?? parsed.code ?? parsed.Code ?? response.statusText ?? "UnknownError");
      const message = String(parsed.message ?? parsed.Message ?? code);
      const rawMessage = `${code}: ${message}`;
      const clientCode = classifyAwsProviderError(rawMessage);
      throw new SecretProviderClientError({
        code: clientCode,
        provider: "aws_secrets_manager",
        operation,
        message: awsProviderSafeMessage(clientCode),
        rawMessage,
      });
    }

    return parsed as T;
  }
}

export function createAwsSecretsManagerProvider(
  options?: {
    config?: AwsSecretsManagerConfig;
    gateway?: AwsSecretsManagerGateway;
  },
): SecretProviderModule {
  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null) {
    if (providerConfig) return readProviderVaultConfig(providerConfig);
    return options?.config ?? loadAwsSecretsManagerConfig();
  }

  function resolveGateway(config: AwsSecretsManagerConfig) {
    return options?.gateway ?? new AwsSecretsManagerJsonGateway(config);
  }

  async function validateConfig(
    input?: {
      deploymentMode?: DeploymentMode;
      strictMode?: boolean;
      providerConfig?: SecretProviderVaultRuntimeConfig | null;
    },
  ): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    const config = resolveConfig(input?.providerConfig);
    if (!config.prefix) {
      warnings.push("PAPERCLIP_SECRETS_AWS_PREFIX should be set to a deployment-scoped prefix");
    }
    return { ok: true, warnings };
  }

  // 健康检查：验证 AWS 配置的完整性，包括区域、部署 ID、KMS 密钥和凭证源。
  // 发现配置缺陷时返回 "warn" 状态（而非 "error"），因为部分功能（如本地开发）可能不需要完整配置。
  // 注意检测到环境变量中的静态凭证时会发出警告——生产环境应使用 IAM 角色而非静态密钥。
  async function healthCheck(
    input?: {
      deploymentMode?: DeploymentMode;
      strictMode?: boolean;
      providerConfig?: SecretProviderVaultRuntimeConfig | null;
    },
  ): Promise<SecretProviderHealthCheck> {
    try {
      const validation = await validateConfig(input);
      const config = resolveConfig(input?.providerConfig);
      const readiness = getAwsConfigReadiness();
      const warnings = [...validation.warnings];
      if (
        process.env.AWS_ACCESS_KEY_ID?.trim() &&
        process.env.AWS_SECRET_ACCESS_KEY?.trim()
      ) {
        warnings.push(
          "AWS static environment credentials are visible to this process; use only short-lived shell credentials locally and prefer IAM role/workload identity for hosted deployments.",
        );
      }
      return {
        provider: "aws_secrets_manager",
        status: warnings.length > 0 ? "warn" : "ok",
        message:
          "AWS Secrets Manager provider config is present; AWS credentials are resolved by the server runtime through the AWS SDK default credential provider chain.",
        warnings,
        details: {
          region: config.region,
          prefix: config.prefix,
          deploymentId: config.deploymentId,
          kmsKeyConfigured: Boolean(config.kmsKeyId),
          credentialSource: "AWS SDK default credential provider chain",
          detectedCredentialSources: readiness.credentialSources,
        },
        backupGuidance: [
          "Back up Paperclip metadata separately from AWS-managed secrets.",
          "Restoring access requires the Paperclip database plus the same AWS secret namespace and KMS permissions.",
        ],
      };
    } catch (error) {
      const readiness = getAwsConfigReadiness();
      const providerConfigMissing = input?.providerConfig && !asOptionalNonEmptyString(input.providerConfig.config.region)
        ? ["region"]
        : [];
      const missingConfig = input?.providerConfig ? providerConfigMissing : readiness.missingConfig;
      return {
        provider: "aws_secrets_manager",
        status: "warn",
        message:
          missingConfig.length > 0
            ? `AWS Secrets Manager provider is not ready: missing ${missingConfig.join(", ")}.`
            : error instanceof Error
              ? error.message
              : String(error),
        warnings: [
          ...(missingConfig.length > 0
            ? [`Missing required non-secret AWS provider config: ${missingConfig.join(", ")}.`]
            : []),
          AWS_RUNTIME_CREDENTIAL_WARNING,
          AWS_CREDENTIAL_CUSTODY_WARNING,
          "Managed secret create/rotate/resolve calls will fail until AWS provider configuration is complete.",
        ],
        details: {
          missingConfig,
          requiredProviderConfig: input?.providerConfig
            ? ["region"]
            : [
                "PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION",
                "PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID",
                "PAPERCLIP_SECRETS_AWS_KMS_KEY_ID",
              ],
          optionalProviderConfig: [
            "PAPERCLIP_SECRETS_AWS_PREFIX",
            "PAPERCLIP_SECRETS_AWS_ENVIRONMENT",
            "PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER",
            "PAPERCLIP_SECRETS_AWS_ENDPOINT",
            "PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS",
          ],
          credentialSource: "AWS SDK default credential provider chain",
          detectedCredentialSources: readiness.credentialSources,
        },
      };
    }
  }

  return {
    id: "aws_secrets_manager",
    descriptor() {
      return configuredAwsSecretsManagerDescriptor();
    },
    validateConfig,
    // 在 AWS Secrets Manager 中创建新的托管密钥。
    // 使用 buildManagedSecretId 生成结构化名称，并附带 Paperclip 标签用于追踪和过滤。
    async createSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const valueSha256 = sha256Hex(input.value);
      const secretId = buildManagedSecretId(config, input.context);

      try {
        const createInput = {
          Name: secretId,
          SecretString: input.value,
          ...(config.kmsKeyId ? { KmsKeyId: config.kmsKeyId } : {}),
          Description: input.context ? `Paperclip secret ${input.context.secretName}` : undefined,
          Tags: buildManagedSecretTags(config, input.context),
        };
        const created = await gateway.createSecret({
          ...createInput,
        });
        const normalizedSecretId = created.ARN ?? created.Name ?? secretId;
        return {
          material: createManagedMaterial(normalizedSecretId, created.VersionId ?? null),
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: normalizedSecretId,
          providerVersionRef: created.VersionId ?? null,
        };
      } catch (error) {
        normalizeAwsError("createSecret", error);
      }
    },
    // 创建新版本：通过 PutSecretValue 写入 AWS Secrets Manager。
    // 新版本标记为 PAPERCLIP_PENDING_VERSION_STAGE，后续由协调流程推进为 AWSCURRENT。
    // 这种设计允许批量轮换后一次性切换版本，而不是逐个切换造成中间状态不一致。
    async createVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const valueSha256 = sha256Hex(input.value);
      const secretId = resolveManagedSecretRef({
        config,
        context: input.context,
        externalRefs: [input.externalRef],
      });

      try {
        const created = await gateway.putSecretValue({
          SecretId: secretId,
          SecretString: input.value,
          VersionStages: [PAPERCLIP_PENDING_VERSION_STAGE],
        });
        const normalizedSecretId = created.ARN ?? created.Name ?? secretId;
        return {
          material: createManagedMaterial(normalizedSecretId, created.VersionId ?? null),
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: normalizedSecretId,
          providerVersionRef: created.VersionId ?? null,
        };
      } catch (error) {
        normalizeAwsError("createVersion", error);
      }
    },
    // 链接外部密钥：仅存储引用元数据，不实际写入 AWS。
    // 调用前检查该 externalRef 是否误指向了 Paperclip 托管的命名空间——防止循环引用。
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      assertNotManagedNamespaceExternalRef(config, input.externalRef);
      return createExternalReferenceMaterial(input.externalRef, input.providerVersionRef ?? null);
    },
    // 从 AWS Secrets Manager 远程列出密钥。支持分页和全文搜索过滤。
    // 结果仅包含元数据（名称、ARN、标签），不包含实际 SecretString 内容。
    // 这个接口主要用于 "导入外部密钥" 功能，让用户可以从 AWS 控制台的密钥列表中挑选要引用的密钥。
    async listRemoteSecrets(input): Promise<RemoteSecretListResult> {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const query = input.query?.trim();
      const pageSize =
        input.pageSize && Number.isFinite(input.pageSize)
          ? Math.min(Math.max(Math.trunc(input.pageSize), 1), 100)
          : 50;

      try {
        if (!gateway.listSecrets) {
          throw new Error("ListSecrets gateway operation is unavailable");
        }
        const listed = await gateway.listSecrets({
          MaxResults: pageSize,
          NextToken: input.nextToken?.trim() || undefined,
          IncludePlannedDeletion: false,
          Filters: query ? [{ Key: "all", Values: [query] }] : undefined,
        });
        return {
          nextToken: listed.NextToken ?? null,
          secrets: (listed.SecretList ?? [])
            .filter((entry) => Boolean(entry.ARN ?? entry.Name))
            .map((entry) => ({
              externalRef: entry.ARN ?? entry.Name ?? "",
              name: entry.Name ?? entry.ARN ?? "",
              providerVersionRef: null,
              metadata: createRemoteSecretMetadata(entry),
            })),
        };
      } catch (error) {
        normalizeAwsError("listSecrets", error);
      }
    },
    // 解析秘钥值：从 AWS Secrets Manager 读取实际 SecretString。
    // 对于 managed 密钥，使用 resolveManagedSecretRef 重新确认正确的 SecretId 路径；
    // 对于 external_reference 密钥，直接使用存储的 secretId。
    async resolveVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const material = asAwsSecretsManagerMaterial(input.material);
      const secretId =
        material.source === "managed"
          ? resolveManagedSecretRef({
              config,
              context: input.context,
              externalRefs: [input.externalRef, material.secretId],
            })
          : (input.externalRef ?? material.secretId);

      try {
        const resolved = await gateway.getSecretValue({
          SecretId: secretId,
          VersionId: input.providerVersionRef ?? material.versionId ?? undefined,
          VersionStage:
            input.providerVersionRef || material.versionId ? undefined : DEFAULT_VERSION_STAGE,
        });
        if (typeof resolved.SecretString !== "string") {
          throw new Error("SecretString was empty");
        }
        return resolved.SecretString;
      } catch (error) {
        normalizeAwsError("resolveVersion", error);
      }
    },
    // 删除或归档密钥。仅对 managed 来源的密钥产生实际操作：
    // - archive 模式：移除 PAPERCLIP_PENDING 阶段标记，保留 AWSCURRENT 版本不受影响
    // - 删除模式：调用 DeleteSecret，默认 30 天可恢复窗口
    // external_reference 来源的密钥在此处不执行任何 AWS 操作——Paperclip 只删除自己的元数据。
    async deleteOrArchive(input) {
      const material =
        input.material && typeof input.material === "object"
          ? asAwsSecretsManagerMaterial(input.material)
          : null;

      if (material?.source !== "managed") return;

      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const secretId = resolveManagedSecretRef({
        config,
        context: input.context,
        externalRefs: [input.externalRef, material.secretId],
      });

      try {
        if (input.mode === "archive") {
          if (material.versionId && gateway.updateSecretVersionStage) {
            await gateway.updateSecretVersionStage({
              SecretId: secretId,
              VersionStage: PAPERCLIP_PENDING_VERSION_STAGE,
              RemoveFromVersionId: material.versionId,
            });
          }
          return;
        }
        await gateway.deleteSecret({
          SecretId: secretId,
          RecoveryWindowInDays: config.deleteRecoveryWindowDays,
        });
      } catch (error) {
        normalizeAwsError(input.mode === "archive" ? "updateSecretVersionStage" : "deleteSecret", error);
      }
    },
    healthCheck,
  };
}

export const awsSecretsManagerProvider = createAwsSecretsManagerProvider();
