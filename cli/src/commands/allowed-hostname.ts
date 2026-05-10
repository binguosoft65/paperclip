import * as p from "@clack/prompts";
import pc from "picocolors";
import { normalizeHostnameInput } from "../config/hostnames.js";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";

// 向配置添加允许的主机名（仅 authenticated/private 模式下生效）
// 主机名经过归一化处理（URL 提取 hostname + 小写化）
// 已存在的主机名不会重复添加，给出提示
// 添加后需要重启服务器才能生效
export async function addAllowedHostname(host: string, opts: { config?: string }): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);

  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`);
    return;
  }

  const normalized = normalizeHostnameInput(host);
  const current = new Set((config.server.allowedHostnames ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const existed = current.has(normalized);
  current.add(normalized);

  config.server.allowedHostnames = Array.from(current).sort();
  config.$meta.updatedAt = new Date().toISOString();
  config.$meta.source = "configure";
  writeConfig(config, opts.config);

  if (existed) {
    p.log.info(`Hostname ${pc.cyan(normalized)} is already allowed.`);
  } else {
    p.log.success(`Added allowed hostname: ${pc.cyan(normalized)}`);
    p.log.message(
      pc.dim("Restart the Paperclip server for this change to take effect."),
    );
  }

  // allowed hostname 仅在 authenticated/private 模式下生效
  // 其他模式下（local_trusted 或 public）主机名限制无意义，给出提示但不过度警告
  if (!(config.server.deploymentMode === "authenticated" && config.server.exposure === "private")) {
    p.log.message(
      pc.dim("Note: allowed hostnames are enforced only in authenticated/private mode."),
    );
  }
}

