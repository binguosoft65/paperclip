// Vitest 配置：只在 src 目录下查找 .test.ts 文件
// 环境设为 node 因为 Daytona Provider 是纯后端插件
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
