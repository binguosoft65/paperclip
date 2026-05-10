// ACPX 本地适配器服务端导出模块。
// execute: 核心执行逻辑，通过 ACPX Runtime 统一管理 Claude/Codex/Custom 三种 ACP agent
// createAcpxLocalExecutor: 可注入依赖的执行器工厂，用于测试
// testEnvironment: 环境诊断，检查 Node 版本、依赖包可解析性、凭证配置
// getConfigSchema: 配置项 JSON Schema，用于 UI 表单渲染
// sessionCodec: session 序列化/反序列化编解码器
// listAcpxSkills / syncAcpxSkills: Paperclip runtime skill 的列举和同步
export { execute, createAcpxLocalExecutor } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";
export { sessionCodec } from "./session-codec.js";
export { listAcpxSkills, syncAcpxSkills } from "./skills.js";
