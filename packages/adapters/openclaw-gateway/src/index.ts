// OpenClaw Gateway 适配器：通过 WebSocket 协议连接 OpenClaw Gateway。
// 与本地 CLI 适配器不同，此适配器不直接运行进程，而是将任务委托给网关
// 连接的远程 agent，并通过 WebSocket 事件流接收执行结果。
export const type = "openclaw_gateway";
export const label = "OpenClaw Gateway";

// 模型由 OpenClaw Gateway 侧的 agent 决定，Paperclip 无需预配模型列表
export const models: { id: string; label: string }[] = [];

// 适配器配置文档：描述 openclaw_gateway 的 WebSocket 协议、认证方式、
// session 路由策略和标准 outbound 载荷结构。
export const agentConfigurationDoc = `# openclaw_gateway agent configuration

Adapter: openclaw_gateway

Use when:
- You want Paperclip to invoke OpenClaw over the Gateway WebSocket protocol.
- You want native gateway auth/connect semantics instead of HTTP /v1/responses or /hooks/*.

Don't use when:
- You only expose OpenClaw HTTP endpoints.
- Your deployment does not permit outbound WebSocket access from the Paperclip server.

Core fields:
- url (string, required): OpenClaw gateway WebSocket URL (ws:// or wss://)
- headers (object, optional): handshake headers; supports x-openclaw-token / x-openclaw-auth
- authToken (string, optional): shared gateway token override
- password (string, optional): gateway shared password, if configured

Gateway connect identity fields:
- clientId (string, optional): gateway client id (default gateway-client)
- clientMode (string, optional): gateway client mode (default backend)
- clientVersion (string, optional): client version string
- role (string, optional): gateway role (default operator)
- scopes (string[] | comma string, optional): gateway scopes (default ["operator.admin"])
- disableDeviceAuth (boolean, optional): disable signed device payload in connect params (default false)

Request behavior fields:
- payloadTemplate (object, optional): additional fields merged into gateway agent params
- workspaceRuntime (object, optional): reserved workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- timeoutSec (number, optional): adapter timeout in seconds (default 120)
- waitTimeoutMs (number, optional): agent.wait timeout override (default timeoutSec * 1000)
- autoPairOnFirstConnect (boolean, optional): on first "pairing required", attempt device.pair.list/device.pair.approve via shared auth, then retry once (default true)
- paperclipApiUrl (string, optional): absolute Paperclip base URL advertised in wake text
- claimedApiKeyPath (string, optional): path to the claimed API key JSON file read by the agent at wake time (default ~/.openclaw/workspace/paperclip-claimed-api-key.json)

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run
- sessionKey (string, optional): fixed session key when strategy=fixed (default paperclip)

Standard outbound payload additions:
- paperclip (object): standardized Paperclip context added to every gateway agent request
- paperclip.workspace (object, optional): resolved execution workspace for this run
- paperclip.workspaces (array, optional): additional workspace hints Paperclip exposed to the run
- paperclip.workspaceRuntime (object, optional): reserved workspace runtime metadata when explicitly supplied outside normal heartbeat execution

Standard result metadata supported:
- meta.runtimeServices (array, optional): normalized adapter-managed runtime service reports
- meta.previewUrl (string, optional): shorthand single preview URL
- meta.previewUrls (string[], optional): shorthand multiple preview URLs
`;
