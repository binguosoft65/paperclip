import { unprocessable } from "../errors.js";

// 环境选择校验：在 run/issue/project 选定环境时的准入检查。
// 校验点：1) 环境存在且属于指定公司；2) 未被归档；3) driver 在业务允许范围内；
// 4) 沙箱 provider 非 fake（fake 仅用于探针，不可运行实际工作负载）；
// 5) 沙箱 provider 在业务允许的白名单内
export async function assertEnvironmentSelectionForCompany(
  environmentsSvc: {
    getById(environmentId: string): Promise<{
      id: string;
      companyId: string;
      driver: string;
      status?: string | null;
      config: Record<string, unknown> | null;
    } | null>;
  },
  companyId: string,
  environmentId: string | null | undefined,
  options?: {
    allowedDrivers?: string[];
    allowedSandboxProviders?: string[];
  },
) {
  if (environmentId === undefined || environmentId === null) return;
  const environment = await environmentsSvc.getById(environmentId);
  if (!environment || environment.companyId !== companyId) {
    throw unprocessable("Environment not found.");
  }
  if (environment.status === "archived") {
    throw unprocessable("Environment is archived.");
  }
  if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
    throw unprocessable(
      `Environment driver "${environment.driver}" is not allowed here. Allowed drivers: ${options.allowedDrivers.join(", ")}`,
    );
  }
  if (environment.driver === "sandbox") {
    const config = environment.config && typeof environment.config === "object"
      ? environment.config as Record<string, unknown>
      : {};
    const provider = typeof config.provider === "string" ? config.provider : "";
    // fake provider 仅用于 probe（连通性测试），不能执行实际 run。
    // 如果在选择环境时放行 fake，后续 run 执行会因无真实运行时而静默失败
    if (provider === "fake") {
      throw unprocessable(
        `Environment sandbox provider "${provider}" is not allowed here. The built-in fake provider is probe-only and cannot execute runs.`,
      );
    }
    if (
      options?.allowedSandboxProviders
      && options.allowedSandboxProviders.length > 0
      && !options.allowedSandboxProviders.includes(provider)
    ) {
      throw unprocessable(
        `Environment sandbox provider "${provider || "unknown"}" is not allowed here. Allowed providers: ${options.allowedSandboxProviders.join(", ")}`,
      );
    }
  }
}
