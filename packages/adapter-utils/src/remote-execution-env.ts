// 远程执行环境身份键白名单：这些是"身份环境变量"，标识用户在远程系统上的身份。
// 在非特权模式下不需要覆盖它们——远程系统的 HOME、PATH 等应该由远程 profile 正确设置。
// 将调用方传入的值与进程继承的值比较，仅当不同时才传递，减少不必要覆盖引发的混淆。
const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

// 对要传递给远程执行环境的变量进行清理。
// 过滤策略：非身份键（非白名单内的变量）直接传递；
// 身份键则与当前进程的继承环境变量比较，仅当不同时才传递。
// 这样可以避免将本机的路径信息泄露到远程环境，同时保留必要的身份配置。
export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
