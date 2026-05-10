/**
 * PluginToolDispatcher — orchestrates plugin tool discovery, lifecycle
 * integration, and execution routing for the agent service.
 *
 * This service sits between the agent service and the lower-level
 * `PluginToolRegistry` + `PluginWorkerManager`, providing a clean API that:
 *
 * - Discovers tools from loaded plugin manifests and registers them
 *   in the tool registry.
 * - Hooks into `PluginLifecycleManager` events to automatically register
 *   and unregister tools when plugins are enabled or disabled.
 * - Exposes the tool list in an agent-friendly format (with namespaced
 *   names, descriptions, parameter schemas).
 * - Routes `executeTool` calls to the correct plugin worker and returns
 *   structured results.
 * - Validates tool parameters against declared schemas before dispatch.
 *
 * The dispatcher is created once at server startup and shared across
 * the application.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */

import type { Db } from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginRecord,
} from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import {
  createPluginToolRegistry,
  type PluginToolRegistry,
  type RegisteredTool,
  type ToolListFilter,
  type ToolExecutionResult,
} from "./plugin-tool-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An agent-facing tool descriptor — the shape returned when agents
 * query for available tools.
 *
 * This is intentionally simpler than `RegisteredTool`, exposing only
 * what agents need to decide whether and how to call a tool.
 *
 * ── 为什么需要两个不同的类型 ──
 * RegisteredTool（在 tool-registry 中）包含内部实现细节，如
 * execute 函数引用和插件内部 ID。AgentToolDescriptor 是 Agent 看到的
 * 公共接口，只包含名称、描述和参数 schema。这种分离确保：
 * 1) Agent 不能直接调用 execute 绕过权限检查。
 * 2) 内部实现变更不影响 Agent 的工具发现 API。
 * 3) 工具列表可以在不同 Agent 类型间安全共享。
 */
export interface AgentToolDescriptor {
  /** Fully namespaced tool name (e.g. `"acme.linear:search-issues"`). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description for the agent — explains when and how to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: Record<string, unknown>;
  /** The plugin that provides this tool. */
  pluginId: string;
}

/**
 * Options for creating the plugin tool dispatcher.
 */
export interface PluginToolDispatcherOptions {
  /** The worker manager used to dispatch RPC calls to plugin workers. */
  workerManager?: PluginWorkerManager;
  /** The lifecycle manager to listen for plugin state changes. */
  lifecycleManager?: PluginLifecycleManager;
  /** Database connection for looking up plugin records. */
  db?: Db;
}

// ---------------------------------------------------------------------------
// PluginToolDispatcher interface
// ---------------------------------------------------------------------------

/**
 * The plugin tool dispatcher — the primary integration point between the
 * agent service and the plugin tool system.
 *
 * Agents use this service to:
 * 1. List all available tools (for prompt construction / tool choice)
 * 2. Execute a specific tool by its namespaced name
 *
 * The dispatcher handles lifecycle management internally — when a plugin
 * is loaded or unloaded, its tools are automatically registered or removed.
 */
export interface PluginToolDispatcher {
  /**
   * Initialize the dispatcher — load tools from all currently-ready plugins
   * and start listening for lifecycle events.
   *
   * Must be called once at server startup after the lifecycle manager
   * and worker manager are ready.
   */
  initialize(): Promise<void>;

  /**
   * Tear down the dispatcher — unregister lifecycle event listeners
   * and clear all tool registrations.
   *
   * Called during server shutdown.
   */
  teardown(): void;

  /**
   * List all available tools for agents, optionally filtered.
   *
   * Returns tool descriptors in an agent-friendly format.
   *
   * @param filter - Optional filter criteria
   * @returns Array of agent tool descriptors
   */
  listToolsForAgent(filter?: ToolListFilter): AgentToolDescriptor[];

  /**
   * Look up a tool by its namespaced name.
   *
   * @param namespacedName - e.g. `"acme.linear:search-issues"`
   * @returns The registered tool, or `null` if not found
   */
  getTool(namespacedName: string): RegisteredTool | null;

  /**
   * Execute a tool by its namespaced name, routing to the correct
   * plugin worker.
   *
   * @param namespacedName - Fully qualified tool name
   * @param parameters - Input parameters matching the tool's schema
   * @param runContext - Agent run context
   * @returns The execution result with routing metadata
   * @throws {Error} if the tool is not found, the worker is not running,
   *   or the tool execution fails
   */
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<ToolExecutionResult>;

  /**
   * Register all tools from a plugin manifest.
   *
   * This is called automatically when a plugin transitions to `ready`.
   * Can also be called manually for testing or recovery scenarios.
   *
   * @param pluginId - The plugin's unique identifier
   * @param manifest - The plugin manifest containing tool declarations
   */
  registerPluginTools(
    pluginId: string,
    manifest: PaperclipPluginManifestV1,
  ): void;

  /**
   * Unregister all tools for a plugin.
   *
   * Called automatically when a plugin is disabled or unloaded.
   *
   * @param pluginId - The plugin to unregister
   */
  unregisterPluginTools(pluginId: string): void;

  /**
   * Get the total number of registered tools, optionally scoped to a plugin.
   *
   * @param pluginId - If provided, count only this plugin's tools
   */
  toolCount(pluginId?: string): number;

  /**
   * Access the underlying tool registry for advanced operations.
   *
   * This escape hatch exists for internal use (e.g. diagnostics).
   * Prefer the dispatcher's own methods for normal operations.
   */
  getRegistry(): PluginToolRegistry;
}

// ---------------------------------------------------------------------------
// Factory: createPluginToolDispatcher
// ---------------------------------------------------------------------------

/**
 * Create a new `PluginToolDispatcher`.
 *
 * The dispatcher:
 * 1. Creates and owns a `PluginToolRegistry` backed by the given worker manager.
 * 2. Listens for lifecycle events (plugin.enabled, plugin.disabled, plugin.unloaded)
 *    to automatically register and unregister tools.
 * 3. On `initialize()`, loads tools from all currently-ready plugins via the DB.
 *
 * @param options - Configuration options
 *
 * @example
 * ```ts
 * // At server startup
 * const dispatcher = createPluginToolDispatcher({
 *   workerManager,
 *   lifecycleManager,
 *   db,
 * });
 * await dispatcher.initialize();
 *
 * // In agent service — list tools for prompt construction
 * const tools = dispatcher.listToolsForAgent();
 *
 * // In agent service — execute a tool
 * const result = await dispatcher.executeTool(
 *   "acme.linear:search-issues",
 *   { query: "auth bug" },
 *   { agentId: "a-1", runId: "r-1", companyId: "c-1", projectId: "p-1" },
 * );
 * ```
 */
export function createPluginToolDispatcher(
  options: PluginToolDispatcherOptions = {},
): PluginToolDispatcher {
  const { workerManager, lifecycleManager, db } = options;
  const log = logger.child({ service: "plugin-tool-dispatcher" });

  // Create the underlying tool registry, backed by the worker manager
  const registry = createPluginToolRegistry(workerManager);

  // Track lifecycle event listeners so we can remove them on teardown
  let enabledListener: ((payload: { pluginId: string; pluginKey: string }) => void) | null = null;
  let disabledListener: ((payload: { pluginId: string; pluginKey: string; reason?: string }) => void) | null = null;
  let unloadedListener: ((payload: { pluginId: string; pluginKey: string; removeData: boolean }) => void) | null = null;

  let initialized = false;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Attempt to register tools for a plugin by looking up its manifest
   * from the DB. No-ops gracefully if the plugin or manifest is missing.
   *
   * ── 为什么从数据库读取而不是从内存缓存 ──
   * 生命周期事件触发时，插件的 manifest 可能还没有被加载器缓存
   * （例如服务器刚启动时恢复状态）。直接从 DB 读取确保了无论何种
   * 场景都能获取到最新的 manifest 数据。这也是 registerFromDb 这个
   * 命名中 "Db" 的由来 —— 强调数据来源。
   */
  async function registerFromDb(pluginId: string): Promise<void> {
    if (!db) {
      log.warn(
        { pluginId },
        "cannot register tools from DB — no database connection configured",
      );
      return;
    }

    const pluginRegistry = pluginRegistryService(db);
    const plugin = await pluginRegistry.getById(pluginId) as PluginRecord | null;

    if (!plugin) {
      log.warn({ pluginId }, "plugin not found in registry, cannot register tools");
      return;
    }

    const manifest = plugin.manifestJson;
    if (!manifest) {
      log.warn({ pluginId }, "plugin has no manifest, cannot register tools");
      return;
    }

    registry.registerPlugin(plugin.pluginKey, manifest, plugin.id);
  }

  /**
   * Convert a `RegisteredTool` to an `AgentToolDescriptor`.
   */
  function toAgentDescriptor(tool: RegisteredTool): AgentToolDescriptor {
    return {
      name: tool.namespacedName,
      displayName: tool.displayName,
      description: tool.description,
      parametersSchema: tool.parametersSchema,
      pluginId: tool.pluginDbId,
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle event handlers
  // -----------------------------------------------------------------------

  /**
   * 处理插件启用事件：注册插件的工具到工具注册表。
   *
   * ── 为什么使用 fire-and-forget（异步但不等待） ──
   * 生命周期管理器的事件处理器是同步的（EventEmitter 的默认行为），
   * 不能 await 异步操作。如果这里阻塞等待，会拖慢整个生命周期状态机。
   * 使用 void registerFromDb().catch() 模式：
   * 1) 不阻塞事件循环，状态机可以继续处理其他插件的转换。
   * 2) 异步注册失败不影响插件状态转换 —— 工具注册是"副作用"而非"核心操作"。
   * 3) .catch() 确保未捕获的 Promise 拒绝不会触发 unhandledRejection。
   *
   * ── 失败后果 ──
   * 如果注册失败，该插件的工具对 Agent 不可见。管理员需要手动触发
   * 恢复操作（如重新启用插件）。这个降级策略优于阻塞状态机。
   */
  function handlePluginEnabled(payload: { pluginId: string; pluginKey: string }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin enabled — registering tools");
    // Async registration from DB — we fire-and-forget since the lifecycle
    // event handler must be synchronous. Any errors are logged.
    void registerFromDb(payload.pluginId).catch((err) => {
      log.error(
        { pluginId: payload.pluginId, err: err instanceof Error ? err.message : String(err) },
        "failed to register tools after plugin enabled",
      );
    });
  }

  /**
   * 处理插件禁用事件：从工具注册表中移除该插件的所有工具。
   *
   * ── 同步 vs 异步 ──
   * 与 handlePluginEnabled 不同，这里的注销操作是纯同步的 ——
   * 只需要从内存 Map 中删除条目，不涉及 I/O 操作。
   * 因此不需要 fire-and-forget 模式。
   *
   * ── 使用 pluginKey 而非 pluginId ──
   * 工具注册表的命名空间基于 pluginKey（人类可读的唯一标识符），
   * 而非 UUID 类型的 pluginId。这是因为工具名称格式是
   * "<pluginKey>:<toolName>"，Agent 看到的是 pluginKey 而非 pluginId。
   */
  function handlePluginDisabled(payload: { pluginId: string; pluginKey: string; reason?: string }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin disabled — unregistering tools");
    registry.unregisterPlugin(payload.pluginKey);
  }

  /**
   * 处理插件卸载事件：从工具注册表中移除该插件的所有工具。
   *
   * 与 handlePluginDisabled 的行为相同，但触发条件不同：
   * disabled 是临时停用（可恢复），unloaded 是永久移除（不可恢复）。
   * 从工具注册的角度看，两者效果一致 —— 工具不再可用。
   */
  function handlePluginUnloaded(payload: { pluginId: string; pluginKey: string; removeData: boolean }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin unloaded — unregistering tools");
    registry.unregisterPlugin(payload.pluginKey);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async initialize(): Promise<void> {
      if (initialized) {
        log.warn("dispatcher already initialized, skipping");
        return;
      }

      log.info("initializing plugin tool dispatcher");

      // Step 1: Load tools from all currently-ready plugins
      // ── 为什么分两步初始化 ──
      // 先全量加载（Step 1）再订阅增量事件（Step 2），而不是只用事件订阅。
      // 原因：在订阅事件之前，可能已经有 ready 插件运行了（如服务器重启恢复），
      // 这些插件不会触发 plugin.enabled 事件，必须通过全量扫描加载。
      // 两步法确保了初始化后所有 ready 插件的工具都可用，同时后续状态变更
      // 也能通过事件订阅增量更新。
      if (db) {
        const pluginRegistry = pluginRegistryService(db);
        const readyPlugins = await pluginRegistry.listByStatus("ready") as PluginRecord[];

        let totalTools = 0;
        for (const plugin of readyPlugins) {
          const manifest = plugin.manifestJson;
          if (manifest?.tools && manifest.tools.length > 0) {
            registry.registerPlugin(plugin.pluginKey, manifest, plugin.id);
            totalTools += manifest.tools.length;
          }
        }

        log.info(
          { readyPlugins: readyPlugins.length, registeredTools: totalTools },
          "loaded tools from ready plugins",
        );
      }

      // Step 2: Subscribe to lifecycle events for dynamic updates
      if (lifecycleManager) {
        enabledListener = handlePluginEnabled;
        disabledListener = handlePluginDisabled;
        unloadedListener = handlePluginUnloaded;

        lifecycleManager.on("plugin.enabled", enabledListener);
        lifecycleManager.on("plugin.disabled", disabledListener);
        lifecycleManager.on("plugin.unloaded", unloadedListener);

        log.debug("subscribed to lifecycle events");
      } else {
        log.warn("no lifecycle manager provided — tools will not auto-update on plugin state changes");
      }

      initialized = true;
      log.info(
        { totalTools: registry.toolCount() },
        "plugin tool dispatcher initialized",
      );
    },

    teardown(): void {
      if (!initialized) return;

      // Unsubscribe from lifecycle events
      if (lifecycleManager) {
        if (enabledListener) lifecycleManager.off("plugin.enabled", enabledListener);
        if (disabledListener) lifecycleManager.off("plugin.disabled", disabledListener);
        if (unloadedListener) lifecycleManager.off("plugin.unloaded", unloadedListener);

        enabledListener = null;
        disabledListener = null;
        unloadedListener = null;
      }

      // ── 为什么 teardown 不清空注册表 ──
      // teardown 可能在优雅关闭期间被调用，此时可能还有正在执行的
      // 工具调用（in-flight tool calls）。这些调用在关闭过程中仍需要
      // 通过注册表查找工具的元数据（如命名空间、参数 schema）来完成响应。
      // 如果清空注册表，in-flight 调用会因找不到工具而失败。
      // 注册表会在进程退出时自动释放，无需显式清空。

      initialized = false;
      log.info("plugin tool dispatcher torn down");
    },

    listToolsForAgent(filter?: ToolListFilter): AgentToolDescriptor[] {
      return registry.listTools(filter).map(toAgentDescriptor);
    },

    getTool(namespacedName: string): RegisteredTool | null {
      return registry.getTool(namespacedName);
    },

    /**
     * executeTool — 执行一个插件工具。
     *
     * ── 路由流程 ──
     * 1. registry.executeTool 根据 namespacedName（如 "acme.linear:search-issues"）
     *    解析出 pluginKey 和 toolName。
     * 2. 在注册表中查找对应的 RegisteredTool，获取其 execute 函数引用。
     * 3. 通过 workerManager 将调用转发到对应插件的 worker 进程（RPC）。
     * 4. worker 进程执行工具逻辑，返回结果。
     * 5. 结果包含路由元数据（pluginId、pluginKey），供调用方追溯。
     *
     * ── 参数校验 ──
     * 参数验证由底层 registry.executeTool 处理，使用 JSON Schema
     * 对 parameters 进行校验。如果不匹配 schema，会在执行前抛错，
     * 避免无效参数到达 worker 进程。
     */
    async executeTool(
      namespacedName: string,
      parameters: unknown,
      runContext: ToolRunContext,
    ): Promise<ToolExecutionResult> {
      log.debug(
        {
          tool: namespacedName,
          agentId: runContext.agentId,
          runId: runContext.runId,
        },
        "dispatching tool execution",
      );

      const result = await registry.executeTool(
        namespacedName,
        parameters,
        runContext,
      );

      log.debug(
        {
          tool: namespacedName,
          pluginId: result.pluginId,
          hasContent: !!result.result.content,
          hasError: !!result.result.error,
        },
        "tool execution completed",
      );

      return result;
    },

    registerPluginTools(
      pluginId: string,
      manifest: PaperclipPluginManifestV1,
    ): void {
      registry.registerPlugin(pluginId, manifest);
    },

    unregisterPluginTools(pluginId: string): void {
      registry.unregisterPlugin(pluginId);
    },

    toolCount(pluginId?: string): number {
      return registry.toolCount(pluginId);
    },

    getRegistry(): PluginToolRegistry {
      return registry;
    },
  };
}
