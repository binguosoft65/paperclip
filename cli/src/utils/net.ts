import net from "node:net";

// 端口可用性检查：创建临时 TCP 服务器监听 127.0.0.1:<port>
// 如果端口被占用则返回 EADDRINUSE 错误，否则关闭服务器并返回可用
export function checkPort(port: number): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ available: false, error: `Port ${port} is already in use` });
      } else {
        resolve({ available: false, error: err.message });
      }
    });
    server.once("listening", () => {
      server.close(() => resolve({ available: true }));
    });
    server.listen(port, "127.0.0.1");
  });
}
