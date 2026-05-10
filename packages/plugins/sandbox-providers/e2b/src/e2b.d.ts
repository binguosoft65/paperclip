// E2B SDK 类型声明：由于 e2b npm 包在项目依赖中缺少完整的 TypeScript 类型定义，
// 这里手动声明了运行时需要用到的 API 类型，避免 ts-ignore 或 any 传播
// 主要包括沙箱创建/连接/销毁和命令执行的核心方法
declare module "e2b" {
  // 命令执行错误：包含退出码和标准输出/错误内容
  export class CommandExitError extends Error {
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  // 沙箱不存在错误：在连接已销毁或过期的沙箱时抛出
  export class SandboxNotFoundError extends Error {}
  // 超时错误：命令执行超过指定时限时抛出
  export class TimeoutError extends Error {}

  // 命令同步执行结果
  export interface SandboxRunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  // 后台命令句柄：用于管理长时间运行的进程
  export interface SandboxBackgroundHandle {
    pid: number;
    stdout: string;
    stderr: string;
    wait(): Promise<SandboxRunResult>;
  }

  // E2B 沙箱核心类：管理沙箱的完整生命周期
  export class Sandbox {
    sandboxId: string;
    sandboxDomain?: string;
    // 创建新沙箱（从模板）
    static create(
      templateOrOptions?: string | Record<string, unknown>,
      maybeOptions?: Record<string, unknown>,
    ): Promise<Sandbox>;
    // 连接已有沙箱（用于恢复租赁）
    static connect(
      sandboxId: string,
      options?: Record<string, unknown>,
    ): Promise<Sandbox>;
    // 设置沙箱超时（沙箱空闲超时后自动销毁）
    setTimeout(timeoutMs: number): Promise<void>;
    // 强制终止沙箱
    kill(): Promise<void>;
    // 暂停沙箱（保留状态以便后续恢复）
    pause(): Promise<void>;
    files: {
      write(path: string, data: string | ArrayBuffer): Promise<unknown>;
      remove(path: string): Promise<void>;
    };
    commands: {
      run(
        command: string,
        options?: {
          background?: boolean;
          stdin?: boolean;
          cwd?: string;
          envs?: Record<string, string>;
          timeoutMs?: number;
        },
      ): Promise<SandboxRunResult | SandboxBackgroundHandle>;
      sendStdin(pid: number, input: string): Promise<void>;
      closeStdin(pid: number): Promise<void>;
    };
  }
}
