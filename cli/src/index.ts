import { Command } from "commander";
import { onboard } from "./commands/onboard.js";
import { doctor } from "./commands/doctor.js";
import { envCommand } from "./commands/env.js";
import { configure } from "./commands/configure.js";
import { addAllowedHostname } from "./commands/allowed-hostname.js";
import { heartbeatRun } from "./commands/heartbeat-run.js";
import { runCommand } from "./commands/run.js";
import { bootstrapCeoInvite } from "./commands/auth-bootstrap-ceo.js";
import { dbBackupCommand } from "./commands/db-backup.js";
import { registerEnvLabCommands } from "./commands/env-lab.js";
import { registerContextCommands } from "./commands/client/context.js";
import { registerCompanyCommands } from "./commands/client/company.js";
import { registerIssueCommands } from "./commands/client/issue.js";
import { registerAgentCommands } from "./commands/client/agent.js";
import { registerApprovalCommands } from "./commands/client/approval.js";
import { registerActivityCommands } from "./commands/client/activity.js";
import { registerDashboardCommands } from "./commands/client/dashboard.js";
import { registerRoutineCommands } from "./commands/routines.js";
import { registerFeedbackCommands } from "./commands/client/feedback.js";
import { applyDataDirOverride, type DataDirOptionLike } from "./config/data-dir.js";
import { loadPaperclipEnvFile } from "./config/env.js";
import { initTelemetryFromConfigFile, flushTelemetry } from "./telemetry.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { registerPluginCommands } from "./commands/client/plugin.js";
import { registerClientAuthCommands } from "./commands/client/auth.js";
import { cliVersion } from "./version.js";

// 使用 commander 库构建 CLI 命令树
// paperclipai 是统一的运维入口：安装向导、诊断、配置、心跳触发、数据库管理均由此入口路由
const program = new Command();
const DATA_DIR_OPTION_HELP =
  "Paperclip data directory root (isolates state from ~/.paperclip)";

program
  .name("paperclipai")
  .description("Paperclip CLI — setup, diagnose, and configure your instance")
  .version(cliVersion);

// preAction 钩子在每个子命令执行前运行，确保环境初始化顺序：
// 1) 应用 --data-dir 覆盖（隔离状态目录）；2) 加载相邻 .env 文件；3) 初始化遥测
program.hook("preAction", (_thisCommand, actionCommand) => {
  const options = actionCommand.optsWithGlobals() as DataDirOptionLike;
  const optionNames = new Set(actionCommand.options.map((option) => option.attributeName()));
  applyDataDirOverride(options, {
    hasConfigOption: optionNames.has("config"),
    hasContextOption: optionNames.has("context"),
  });
  // 加载与配置文件同目录的 .env 文件，使 PAPERCLIP_AGENT_JWT_SECRET 等环境变量生效
  loadPaperclipEnvFile(options.config);
  // 从配置文件读取遥测开关，决定是否启用遥测客户端
  initTelemetryFromConfigFile(options.config);
});

// 注册 onboard 子命令：一键安装向导
// --bind 参数允许用户在 quickstart 模式下直接指定可达性预设（loopback/lan/tailnet）
// -y 参数用于 CI/自动化场景，跳过交互直接使用默认值
// --run 参数在保存配置后立即启动服务器，减少用户操作步骤
program
  .command("onboard")
  .description("Interactive first-run setup wizard")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--bind <mode>", "Quickstart reachability preset (loopback, lan, tailnet)")
  .option("-y, --yes", "Accept quickstart defaults (trusted local loopback unless --bind is set) and start immediately", false)
  .option("--run", "Start Paperclip immediately after saving config", false)
  .action(onboard);

// 注册 doctor 子命令：系统诊断与自愈
// --repair 让 doctor 尝试自动修复发现的问题（如创建密钥文件、目录等）
// --fix 是 --repair 的别名，符合用户直觉
// -y 用于跳过修复确认，配合 --repair 实现无人值守诊断修复
program
  .command("doctor")
  .description("Run diagnostic checks on your Paperclip setup")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--repair", "Attempt to repair issues automatically")
  .alias("--fix")
  .option("-y, --yes", "Skip repair confirmation prompts")
  .action(async (opts) => {
    await doctor(opts);
  });

// env 子命令：将配置文件和环境合并输出为 shell export 块
// 用于 CI/CD 部署或复制环境到另一台机器，确保所有必要环境变量一目了然
program
  .command("env")
  .description("Print environment variables for deployment")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(envCommand);

// configure 子命令：分节修改现有配置，无需重新运行 onboard
// -s 参数可直接跳转到指定配置节，实现非交互式单节修改
program
  .command("configure")
  .description("Update configuration sections")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-s, --section <section>", "Section to configure (llm, database, logging, server, storage, secrets)")
  .action(configure);

// db:backup 子命令：按当前配置执行一次数据库备份
// --dir 可临时覆盖备份目录，--retention-days 控制清理窗口
// --json 用于脚本消费备份元数据
program
  .command("db:backup")
  .description("Create a one-off database backup using current config")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--dir <path>", "Backup output directory (overrides config)")
  .option("--retention-days <days>", "Retention window used for pruning", (value) => Number(value))
  .option("--filename-prefix <prefix>", "Backup filename prefix", "paperclip")
  .option("--json", "Print backup metadata as JSON")
  .action(async (opts) => {
    await dbBackupCommand(opts);
  });

// allowed-hostname 子命令：向配置添加一个允许的主机名
// 仅在 authenticated/private 模式下生效，防止未授权的 Host header 访问
program
  .command("allowed-hostname")
  .description("Allow a hostname for authenticated/private mode access")
  .argument("<host>", "Hostname to allow (for example dotta-macbook-pro)")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(addAllowedHostname);

// run 子命令：一步完成"配置缺失则 onboard -> 运行 doctor 检查 -> 启动服务器"
// --bind 仅在首次需要执行 onboard 时生效
// --repair 默认为 true，确保发现的问题能被自动修复
// --no-repair 可用于只想启动而不做任何修复的场景
program
  .command("run")
  .description("Bootstrap local setup (onboard + doctor) and run Paperclip")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-i, --instance <id>", "Local instance id (default: default)")
  .option("--bind <mode>", "On first run, use onboarding reachability preset (loopback, lan, tailnet)")
  .option("--repair", "Attempt automatic repairs during doctor", true)
  .option("--no-repair", "Disable automatic repairs during doctor")
  .action(runCommand);

// heartbeat run 子命令：手动触发一个 Agent 的心跳执行并流式查看日志
// --source 和 --trigger 用于标记调用来源，便于审计和调度区分
// --timeout-ms 控制 CLI 等待心跳完成的超时时间，0 表示无限等待
// --debug 显示原始适配器输出 JSON，用于排查适配器格式化问题
const heartbeat = program.command("heartbeat").description("Heartbeat utilities");

heartbeat
  .command("run")
  .description("Run one agent heartbeat and stream live logs")
  .requiredOption("-a, --agent-id <agentId>", "Agent ID to invoke")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--context <path>", "Path to CLI context file")
  .option("--profile <name>", "CLI context profile name")
  .option("--api-base <url>", "Base URL for the Paperclip server API")
  .option("--api-key <token>", "Bearer token for agent-authenticated calls")
  .option(
    "--source <source>",
    "Invocation source (timer | assignment | on_demand | automation)",
    "on_demand",
  )
  .option("--trigger <trigger>", "Trigger detail (manual | ping | callback | system)", "manual")
  .option("--timeout-ms <ms>", "Max time to wait before giving up", "0")
  .option("--json", "Output raw JSON where applicable")
  .option("--debug", "Show raw adapter stdout/stderr JSON chunks")
  .action(heartbeatRun);

// CRUD 子命令注册：通过 REST API 管理平台资源
// 这些命令共用一个 HTTP 客户端，从 context/profile 获取 API 地址和认证信息
registerContextCommands(program);
registerCompanyCommands(program);
registerIssueCommands(program);
registerAgentCommands(program);
registerApprovalCommands(program);
registerActivityCommands(program);
registerDashboardCommands(program);
registerRoutineCommands(program);
registerFeedbackCommands(program);
registerWorktreeCommands(program);
registerEnvLabCommands(program);
registerPluginCommands(program);

const auth = program.command("auth").description("Authentication and bootstrap utilities");

// auth bootstrap-ceo 子命令：生成一次性 CEO 邀请链接
// --force 允许在已有管理员的情况下重新生成（如邀请过期后补发）
// 仅 authenticated 模式需要，local_trusted 模式下无需邀请
auth
  .command("bootstrap-ceo")
  .description("Create a one-time bootstrap invite URL for first instance admin")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--force", "Create new invite even if admin already exists", false)
  .option("--expires-hours <hours>", "Invite expiration window in hours", (value) => Number(value))
  .option("--base-url <url>", "Public base URL used to print invite link")
  .action(bootstrapCeoInvite);

registerClientAuthCommands(auth);

async function main(): Promise<void> {
  let failed = false;
  try {
    // 解析命令行参数并执行对应的 action 处理函数
    await program.parseAsync();
  } catch (err) {
    failed = true;
    console.error(err instanceof Error ? err.message : String(err));
  } finally {
    // 无论成功或失败，确保遥测事件在进程退出前发送完毕
    await flushTelemetry();
  }

  if (failed) {
    process.exit(1);
  }
}

void main();
