import { SECRET_PROVIDERS, type SecretProvider } from "@paperclipai/shared";

// 从环境变量读取部署级别的默认 Provider。
// 该函数用于在未指定具体 Provider 时（如启动引导阶段）确定使用哪个后端。
// 如果环境变量未设置或值不合法，回退到 "local_encrypted"。
// 选择 "local_encrypted" 作为默认值是因为它无需外部基础设施即可运行。
export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  return configuredProvider && SECRET_PROVIDERS.includes(configuredProvider as SecretProvider)
    ? configuredProvider as SecretProvider
    : "local_encrypted";
}
