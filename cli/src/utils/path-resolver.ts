import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "../config/home.js";

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

// 运行时路径解析：处理相对路径和 ~ 前缀
// 查找策略：配置目录 > 工作空间根目录 > 当前工作目录
// 用于解析配置中可能为相对路径的字段（如 secrets key 路径、数据目录）
// 如果所有候选路径都不存在，返回第一个候选路径（让调用方决定是否创建）
export function resolveRuntimeLikePath(value: string, configPath?: string): string {
  const expanded = expandHomePrefix(value);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);

  const cwd = process.cwd();
  const configDir = configPath ? path.dirname(configPath) : null;
  const workspaceRoot = configDir ? path.resolve(configDir, "..") : cwd;

  const candidates = unique([
    ...(configDir ? [path.resolve(configDir, expanded)] : []),
    path.resolve(workspaceRoot, "server", expanded),
    path.resolve(workspaceRoot, expanded),
    path.resolve(cwd, expanded),
  ]);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
