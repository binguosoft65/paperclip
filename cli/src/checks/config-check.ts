import { readConfig, configExists, resolveConfigPath } from "../config/store.js";
import type { CheckResult } from "./index.js";

// 配置文件完整性检查：文件是否存在 + JSON 解析 + schema 校验
// 这是 doctor 的第一项检查，失败后不继续执行后续检查
export function configCheck(configPath?: string): CheckResult {
  const filePath = resolveConfigPath(configPath);

  if (!configExists(configPath)) {
    return {
      name: "Config file",
      status: "fail",
      message: `Config file not found at ${filePath}`,
      canRepair: false,
      repairHint: "Run `paperclipai onboard` to create one",
    };
  }

  try {
    readConfig(configPath);
    return {
      name: "Config file",
      status: "pass",
      message: `Valid config at ${filePath}`,
    };
  } catch (err) {
    return {
      name: "Config file",
      status: "fail",
      message: `Invalid config: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "Run `paperclipai configure --section database` (or `paperclipai onboard` to recreate)",
    };
  }
}
