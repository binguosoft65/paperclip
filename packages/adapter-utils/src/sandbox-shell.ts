// 确定沙箱环境的首选 Shell。
// 如果明确指定了 bash 则用 bash，否则默认用 sh。
// 选择 sh 而非 bash 的原因是 sh 在 Alpine Linux 等最小化镜像中也可用（busybox 提供）。
// 某些沙箱提供商（如 E2B）的镜像基于 Alpine，没有 bash 但 sh 总是可用的。
export function preferredShellForSandbox(shellCommand: string | null | undefined): "bash" | "sh" {
  return shellCommand === "bash" ? "bash" : "sh";
}
