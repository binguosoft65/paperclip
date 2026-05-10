import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

// 插件唯一标识和版本号，id 采用反向域名风格避免冲突
const PLUGIN_ID = "paperclip.e2b-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

// 声明 E2B 沙箱 Provider 插件的元信息
// Paperclip 插件系统通过此 manifest 在加载前即可校验环境配置的正确性
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "E2B Sandbox Provider",
  description:
    "First-party sandbox provider plugin that provisions E2B cloud sandboxes as Paperclip execution environments.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "e2b",
      kind: "sandbox_provider",
      displayName: "E2B Cloud Sandbox",
      description:
        "Provisions E2B cloud sandboxes with configurable templates, timeouts, and lease reuse.",
      // configSchema 定义了用户在前端填写环境配置时的表单结构
      // 使用 JSON Schema 格式，Plugin SDK 会自动生成对应的 UI 控件
      configSchema: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description: "E2B sandbox template name. Defaults to base when omitted.",
            default: "base",
          },
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Environment-specific E2B API key. Paste a key or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Falls back to E2B_API_KEY if omitted.",
          },
          timeoutMs: {
            type: "number",
            description: "Sandbox timeout in milliseconds.",
            default: 300000,
          },
          reuseLease: {
            type: "boolean",
            description: "Whether to pause and reuse sandboxes across runs.",
            default: false,
          },
        },
      },
    },
  ],
};

export default manifest;
