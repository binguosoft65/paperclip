import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

// 工厂函数：每次调用创建一个独立的 MCP 服务实例。通过传参注入 config 以方便单测。
// 将 Paperclip API 工具注册到 McpServer 时，逐个遍历 tool 列表并调用 server.tool() 注册。
export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

// 启动函数：使用 StdioServerTransport 运行 MCP 服务。
// STDIO 传输是 MCP 标准传输协议，适用于嵌入宿主进程（如 Claude Desktop 或 CLI Agent）。
export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
