#!/usr/bin/env node
import { runServer } from "./index.js";

// STDIO 入口脚本。void 操作符显式标记顶层 await 的 Promise 不需要 await，
// 符合 Node.js ESM 模块不允许顶层 await 的惯例（如果 tsconfig target 较低）。
void runServer().catch((error) => {
  console.error("Failed to start Paperclip MCP server:", error);
  process.exit(1);
});
