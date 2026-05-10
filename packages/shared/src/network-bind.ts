import type { BindMode, DeploymentExposure, DeploymentMode } from "./constants.js";

/** 环回地址（仅本机访问） */
export const LOOPBACK_BIND_HOST = "127.0.0.1";
/** 所有网络接口（局域网/公网均可访问） */
export const ALL_INTERFACES_BIND_HOST = "0.0.0.0";

function normalizeHost(host: string | null | undefined): string | undefined {
  const trimmed = host?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 判断给定的 host 是否为环回地址。
 * 匹配 "127.0.0.1"、"localhost"、"::1"。
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host)?.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * 判断 host 是否为 "0.0.0.0" 或 "::"（监听所有接口）。
 */
export function isAllInterfacesHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host)?.toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

/**
 * 从绑定的 host 地址推断绑定模式：
 * - loopback：127.0.0.1/localhost/::1
 * - lan：0.0.0.0/::
 * - tailnet：匹配 tailnet 分配的地址
 * - custom：其他自定义地址
 */
export function inferBindModeFromHost(
  host: string | null | undefined,
  opts?: { tailnetBindHost?: string | null | undefined },
): BindMode {
  const normalized = normalizeHost(host);
  const tailnetBindHost = normalizeHost(opts?.tailnetBindHost);

  if (!normalized || isLoopbackHost(normalized)) return "loopback";
  if (isAllInterfacesHost(normalized)) return "lan";
  if (tailnetBindHost && normalized === tailnetBindHost) return "tailnet";
  return "custom";
}

/**
 * 校验部署配置中的绑定模式是否合法：
 * - local_trusted 模式只允许 loopback
 * - custom 模式必须指定 customBindHost
 * - tailnet 不能用于 public 暴露方式
 */
export function validateConfiguredBindMode(input: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bind?: BindMode | null | undefined;
  host?: string | null | undefined;
  customBindHost?: string | null | undefined;
}): string[] {
  const bind = input.bind ?? inferBindModeFromHost(input.host);
  const customBindHost = normalizeHost(input.customBindHost);
  const errors: string[] = [];

  if (input.deploymentMode === "local_trusted" && bind !== "loopback") {
    errors.push("local_trusted requires server.bind=loopback");
  }

  if (bind === "custom" && !customBindHost) {
    const legacyHost = normalizeHost(input.host);
    if (!legacyHost || isLoopbackHost(legacyHost) || isAllInterfacesHost(legacyHost)) {
      errors.push("server.customBindHost is required when server.bind=custom");
    }
  }

  if (input.deploymentMode === "authenticated" && input.deploymentExposure === "public" && bind === "tailnet") {
    errors.push("server.bind=tailnet is only supported for authenticated/private deployments");
  }

  return errors;
}

/**
 * 解析运行时需要绑定的实际地址。
 * 根据 bind 模式返回对应的 host 地址，同时校验配置合法性。
 */
export function resolveRuntimeBind(input: {
  bind?: BindMode | null | undefined;
  host?: string | null | undefined;
  customBindHost?: string | null | undefined;
  tailnetBindHost?: string | null | undefined;
}): {
  bind: BindMode;
  host: string;
  customBindHost?: string;
  errors: string[];
} {
  const bind = input.bind ?? inferBindModeFromHost(input.host, { tailnetBindHost: input.tailnetBindHost });
  const legacyHost = normalizeHost(input.host);
  const customBindHost =
    normalizeHost(input.customBindHost) ??
    (bind === "custom" && legacyHost && !isLoopbackHost(legacyHost) && !isAllInterfacesHost(legacyHost)
      ? legacyHost
      : undefined);

  switch (bind) {
    case "loopback":
      return { bind, host: LOOPBACK_BIND_HOST, customBindHost, errors: [] };
    case "lan":
      return { bind, host: ALL_INTERFACES_BIND_HOST, customBindHost, errors: [] };
    case "custom":
      return customBindHost
        ? { bind, host: customBindHost, customBindHost, errors: [] }
        : { bind, host: legacyHost ?? LOOPBACK_BIND_HOST, errors: ["server.customBindHost is required when server.bind=custom"] };
    case "tailnet": {
      const tailnetBindHost = normalizeHost(input.tailnetBindHost);
      return tailnetBindHost
        ? { bind, host: tailnetBindHost, customBindHost, errors: [] }
        : {
          bind,
          host: legacyHost ?? LOOPBACK_BIND_HOST,
          customBindHost,
          errors: [
            "server.bind=tailnet requires a detected Tailscale address or PAPERCLIP_TAILNET_BIND_HOST",
          ],
        };
    }
  }
}
