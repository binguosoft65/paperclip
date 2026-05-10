// 导出插件清单和插件实例，供 Paperclip 插件系统加载
// 分离 manifest 和 plugin 使得 SDK 可以独立校验配置结构而不加载运行时逻辑
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./plugin.js";
