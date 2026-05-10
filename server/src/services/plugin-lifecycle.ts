/**
 * PluginLifecycleManager — state-machine controller for plugin status
 * transitions and worker process coordination.
 *
 * Each plugin moves through a well-defined state machine:
 *
 * ```
 *   installed ──→ ready ──→ disabled
 *       │            │         │
 *       │            ├──→ error│
 *       │            ↓         │
 *       │     upgrade_pending  │
 *       │            │         │
 *       ↓            ↓         ↓
 *              uninstalled
 * ```
 *
 * The lifecycle manager:
 *
 * 1. **Validates transitions** — Only transitions defined in
 *    `VALID_TRANSITIONS` are allowed; invalid transitions throw.
 *
 * 2. **Coordinates workers** — When a plugin moves to `ready`, its
 *    worker process is started. When it moves out of `ready`, the
 *    worker is stopped gracefully.
 *
 * 3. **Emits events** — `plugin.loaded`, `plugin.enabled`,
 *    `plugin.disabled`, `plugin.unloaded`, `plugin.status_changed`
 *    events are emitted so that other services (job coordinator,
 *    tool dispatcher, event bus) can react accordingly.
 *
 * 4. **Persists state** — Status changes are written to the database
 *    through the plugin registry service.
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 */
import { EventEmitter } from "node:events";
import type { Db } from "@paperclipai/db";
import type {
  PluginStatus,
  PluginRecord,
  PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginLoader, type PluginLoader } from "./plugin-loader.js";
import type { PluginWorkerManager, WorkerStartOptions } from "./plugin-worker-manager.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for the plugin lifecycle.
 *
 *   installed → ready       (initial load succeeds)
 *   installed → error       (initial load fails)
 *   installed → uninstalled (abort installation)
 *
 *   ready → disabled        (operator disables plugin)
 *   ready → error           (runtime failure)
 *   ready → upgrade_pending (upgrade with new capabilities)
 *   ready → uninstalled     (uninstall)
 *
 *   disabled → ready        (operator re-enables plugin)
 *   disabled → uninstalled  (uninstall while disabled)
 *
 *   error → ready           (retry / recovery)
 *   error → uninstalled     (give up and uninstall)
 *
 *   upgrade_pending → ready       (operator approves new capabilities)
 *   upgrade_pending → error       (upgrade worker fails)
 *   upgrade_pending → uninstalled (reject upgrade and uninstall)
 *
 *   uninstalled → installed (reinstall)
 *
 * ── 设计考量 ──────────────────────────────────────────────
 * - disabled → error 不允许：禁用态不应再产生运行时错误，
 *   因为 worker 已在 disable 时被停止。
 * - error → disabled 不允许：从错误恢复的唯一路径是通过重试
 *   回到 ready，而不是先进入 disabled。
 * - upgrade_pending 是一个中间态：新能力需要管理员审批，
 *   审批通过才进入 ready，拒绝则进入 uninstalled。
 * - uninstalled → installed 是唯一允许的"重新安装"路径，
 *   只有已卸载的插件才能重新安装。
 */
const VALID_TRANSITIONS: Record<string, readonly PluginStatus[]> = {
  installed: ["ready", "error", "uninstalled"],
  ready: ["ready", "disabled", "error", "upgrade_pending", "uninstalled"],
  disabled: ["ready", "uninstalled"],
  error: ["ready", "uninstalled"],
  upgrade_pending: ["ready", "error", "uninstalled"],
  uninstalled: ["installed"], // reinstall
};

/**
 * Check whether a transition from `from` → `to` is valid.
 *
 * ── 设计说明 ──
 * 使用可选链 (?.includes) 和空值合并 (?? false) 而不是直接判断：
 * 如果 from 不在 VALID_TRANSITIONS 中（例如新增了状态但未更新映射表），
 * 可选链返回 undefined，?? false 确保返回 false 而非 undefined。
 * 这是一种防御性编程模式，防止遗漏状态映射导致静默跳过校验。
 */
function isValidTransition(from: PluginStatus, to: PluginStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/**
 * Events emitted by the PluginLifecycleManager.
 * Consumers can subscribe to these for routing-table updates, UI refresh
 * notifications, and observability.
 */
export interface PluginLifecycleEvents {
  /** Emitted after a plugin is loaded (installed → ready). */
  "plugin.loaded": { pluginId: string; pluginKey: string };
  /** Emitted after a plugin transitions to ready (enabled). */
  "plugin.enabled": { pluginId: string; pluginKey: string };
  /** Emitted after a plugin is disabled (ready → disabled). */
  "plugin.disabled": { pluginId: string; pluginKey: string; reason?: string };
  /** Emitted after a plugin is unloaded (any → uninstalled). */
  "plugin.unloaded": { pluginId: string; pluginKey: string; removeData: boolean };
  /** Emitted on any status change. */
  "plugin.status_changed": {
    pluginId: string;
    pluginKey: string;
    previousStatus: PluginStatus;
    newStatus: PluginStatus;
  };
  /** Emitted when a plugin enters an error state. */
  "plugin.error": { pluginId: string; pluginKey: string; error: string };
  /** Emitted when a plugin enters upgrade_pending. */
  "plugin.upgrade_pending": { pluginId: string; pluginKey: string };
  /** Emitted when a plugin worker process has been started. */
  "plugin.worker_started": { pluginId: string; pluginKey: string };
  /** Emitted when a plugin worker process has been stopped. */
  "plugin.worker_stopped": { pluginId: string; pluginKey: string };
}

type LifecycleEventName = keyof PluginLifecycleEvents;
type LifecycleEventPayload<K extends LifecycleEventName> = PluginLifecycleEvents[K];

// ---------------------------------------------------------------------------
// PluginLifecycleManager
// ---------------------------------------------------------------------------

export interface PluginLifecycleManager {
  /**
   * Load a newly installed plugin – transitions `installed` → `ready`.
   *
   * This is called after the registry has persisted the initial install record.
   * The caller should have already spawned the worker and performed health
   * checks before calling this.  If the worker fails, call `markError` instead.
   */
  load(pluginId: string): Promise<PluginRecord>;

  /**
   * Enable a plugin that is in `disabled`, `error`, or `upgrade_pending` state.
   * Transitions → `ready`.
   */
  enable(pluginId: string): Promise<PluginRecord>;

  /**
   * Disable a running plugin.
   * Transitions `ready` → `disabled`.
   */
  disable(pluginId: string, reason?: string): Promise<PluginRecord>;

  /**
   * Unload (uninstall) a plugin from any active state.
   * Transitions → `uninstalled`.
   *
   * When `removeData` is true, the plugin row and cascaded config are
   * hard-deleted.  Otherwise a soft-delete sets status to `uninstalled`.
   */
  unload(pluginId: string, removeData?: boolean): Promise<PluginRecord | null>;

  /**
   * Mark a plugin as errored (e.g. worker crash, health-check failure).
   * Transitions → `error`.
   */
  markError(pluginId: string, error: string): Promise<PluginRecord>;

  /**
   * Mark a plugin as requiring upgrade approval.
   * Transitions `ready` → `upgrade_pending`.
   */
  markUpgradePending(pluginId: string): Promise<PluginRecord>;

  /**
   * Upgrade a plugin to a newer version.
   * This is a placeholder that handles the lifecycle state transition.
   * The actual package installation is handled by plugin-loader.
   *
   * If the upgrade adds new capabilities, transitions to `upgrade_pending`.
   * Otherwise, transitions to `ready` directly.
   */
  upgrade(pluginId: string, version?: string): Promise<PluginRecord>;

  /**
   * Start the worker process for a plugin that is already in `ready` state.
   *
   * This is used by the server startup orchestration to start workers for
   * plugins that were persisted as `ready`. It requires a `PluginWorkerManager`
   * to have been provided at construction time.
   *
   * @param pluginId - The UUID of the plugin to start
   * @param options  - Worker start options (entrypoint path, config, etc.)
   * @throws if no worker manager is configured or the plugin is not ready
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<void>;

  /**
   * Stop the worker process for a plugin without changing lifecycle state.
   *
   * This is used during server shutdown to gracefully stop all workers.
   * It does not transition the plugin state — plugins remain in their
   * current status so they can be restarted on next server boot.
   *
   * @param pluginId - The UUID of the plugin to stop
   */
  stopWorker(pluginId: string): Promise<void>;

  /**
   * Restart the worker process for a running plugin.
   *
   * Stops and re-starts the worker process. The plugin remains in `ready`
   * state throughout. This is typically called after a config change.
   *
   * @param pluginId - The UUID of the plugin to restart
   * @throws if no worker manager is configured or the plugin is not ready
   */
  restartWorker(pluginId: string): Promise<void>;

  /**
   * Get the current lifecycle state for a plugin.
   */
  getStatus(pluginId: string): Promise<PluginStatus | null>;

  /**
   * Check whether a transition is allowed from the plugin's current state.
   */
  canTransition(pluginId: string, to: PluginStatus): Promise<boolean>;

  /**
   * Subscribe to lifecycle events.
   */
  on<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Unsubscribe from lifecycle events.
   */
  off<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Subscribe to a lifecycle event once.
   */
  once<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for constructing a PluginLifecycleManager.
 */
export interface PluginLifecycleManagerOptions {
  /** Plugin loader instance. Falls back to the default if omitted. */
  loader?: PluginLoader;

  /**
   * Worker process manager. When provided, lifecycle transitions that bring
   * a plugin online (load, enable, upgrade-to-ready) will start the worker
   * process, and transitions that take a plugin offline (disable, unload,
   * markError) will stop it.
   *
   * When omitted the lifecycle manager operates in state-only mode — the
   * caller is responsible for managing worker processes externally.
   */
  workerManager?: PluginWorkerManager;
}

/**
 * Create a PluginLifecycleManager.
 *
 * This service orchestrates plugin state transitions on top of the
 * `pluginRegistryService` (which handles raw DB persistence).  It enforces
 * the lifecycle state machine, emits events for downstream consumers
 * (routing tables, UI, observability), and manages worker processes via
 * the `PluginWorkerManager` when one is provided.
 *
 * Usage:
 * ```ts
 * const lifecycle = pluginLifecycleManager(db, {
 *   workerManager: createPluginWorkerManager(),
 * });
 * lifecycle.on("plugin.enabled", ({ pluginId }) => { ... });
 * await lifecycle.load(pluginId);
 * ```
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugins.status` column
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLifecycleManager(
  db: Db,
  options?: PluginLoader | PluginLifecycleManagerOptions,
): PluginLifecycleManager {
  // Support the legacy signature: pluginLifecycleManager(db, loader)
  // as well as the new options object form.
  let loaderArg: PluginLoader | undefined;
  let workerManager: PluginWorkerManager | undefined;

  if (options && typeof options === "object" && "discoverAll" in options) {
    // Legacy: second arg is a PluginLoader directly
    loaderArg = options as PluginLoader;
  } else if (options && typeof options === "object") {
    const opts = options as PluginLifecycleManagerOptions;
    loaderArg = opts.loader;
    workerManager = opts.workerManager;
  }

  const registry = pluginRegistryService(db);
  const pluginLoaderInstance = loaderArg ?? pluginLoader(db);
  const emitter = new EventEmitter();
  // ── 设置最大监听器数量 ──
  // 每个生命周期事件会被多个下游服务监听（job-scheduler、tool-dispatcher、
  // event-bus、UI 推送等），默认的 10 个上限不够用。
  // 100 是一个安全的经验值：既防止遗忘 removeListener 导致的内存泄漏，
  // 又足以支持当前和可预见的未来的订阅者数量。
  emitter.setMaxListeners(100);

  const log = logger.child({ service: "plugin-lifecycle" });

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function requirePlugin(pluginId: string): Promise<PluginRecord> {
    const plugin = await registry.getById(pluginId);
    if (!plugin) throw notFound(`Plugin not found: ${pluginId}`);
    return plugin as PluginRecord;
  }

  function assertTransition(plugin: PluginRecord, to: PluginStatus): void {
    if (!isValidTransition(plugin.status, to)) {
      throw badRequest(
        `Invalid lifecycle transition: ${plugin.status} → ${to} for plugin ${plugin.pluginKey}`,
      );
    }
  }

  async function transition(
    pluginId: string,
    to: PluginStatus,
    lastError: string | null = null,
    existingPlugin?: PluginRecord,
  ): Promise<PluginRecord> {
    const plugin = existingPlugin ?? await requirePlugin(pluginId);
    assertTransition(plugin, to);

    const previousStatus = plugin.status;

    const updated = await registry.updateStatus(pluginId, {
      status: to,
      lastError,
    });

    if (!updated) throw notFound(`Plugin not found after status update: ${pluginId}`);
    const result = updated as PluginRecord;

    log.info(
      { pluginId, pluginKey: result.pluginKey, from: previousStatus, to },
      `plugin lifecycle: ${previousStatus} → ${to}`,
    );

    // Emit the generic status_changed event
    emitter.emit("plugin.status_changed", {
      pluginId,
      pluginKey: result.pluginKey,
      previousStatus,
      newStatus: to,
    });

    return result;
  }

  function emitDomain(
    event: LifecycleEventName,
    payload: PluginLifecycleEvents[LifecycleEventName],
  ): void {
    emitter.emit(event, payload);
  }

  // -----------------------------------------------------------------------
  // Worker management helpers
  // -----------------------------------------------------------------------

  /**
   * Stop the worker for a plugin if one is running.
   * This is a best-effort operation — if no worker manager is configured
   * or no worker is running, it silently succeeds.
   *
   * ── 为什么是 best-effort ──
   * worker 进程可能已经崩溃（例如段错误），此时 stopWorker 调用会失败。
   * 但这不应阻止状态机的继续推进 —— 插件需要能够从异常状态中恢复，
   * 即使底层进程已经不存在。静默失败确保了状态机不会因为 worker
   * 管理的副作用而卡住。
   */
  async function stopWorkerIfRunning(
    pluginId: string,
    pluginKey: string,
  ): Promise<void> {
    if (!workerManager) return;
    if (!workerManager.isRunning(pluginId) && !workerManager.getWorker(pluginId)) return;

    try {
      await workerManager.stopWorker(pluginId);
      log.info({ pluginId, pluginKey }, "plugin lifecycle: worker stopped");
      emitDomain("plugin.worker_stopped", { pluginId, pluginKey });
    } catch (err) {
      log.warn(
        { pluginId, pluginKey, err: err instanceof Error ? err.message : String(err) },
        "plugin lifecycle: failed to stop worker (best-effort)",
      );
    }
  }

  /**
   * Activate a plugin's runtime when transitioning to the "ready" state.
   *
   * ── 设计考量 ──
   * 通过 hasRuntimeServices() + loadSingle() 双方法检查来判断当前
   * PluginLoader 是否支持运行时激活。这是为了兼容两种加载器模式：
   * 1) 有运行时服务的加载器（需要启动 worker 进程）；
   * 2) 纯状态管理的加载器（例如测试环境，不需要实际启动进程）。
   * 如果不支持运行时激活，静默跳过（return void），不阻塞状态转换。
   */
  async function activateReadyPlugin(pluginId: string): Promise<void> {
    const supportsRuntimeActivation =
      typeof pluginLoaderInstance.hasRuntimeServices === "function"
      && typeof pluginLoaderInstance.loadSingle === "function";
    if (!supportsRuntimeActivation || !pluginLoaderInstance.hasRuntimeServices()) {
      return;
    }

    const loadResult = await pluginLoaderInstance.loadSingle(pluginId);
    if (!loadResult.success) {
      throw new Error(
        loadResult.error
        ?? `Failed to activate plugin ${loadResult.plugin.pluginKey}`,
      );
    }
  }

  /**
   * Deactivate a plugin's runtime when transitioning away from the "ready" state.
   *
   * ── 去激活策略 ──
   * 优先使用 PluginLoader 的 unloadSingle() 进行有序卸载（释放资源、刷写缓冲区、
   * 断开连接），这是最优雅的关闭路径。如果加载器不支持运行时去激活，
   * 回退到 stopWorkerIfRunning() —— 直接停止 worker 进程。
   * 这种双层降级策略确保了：无论是哪种加载器实现，都能正确清理资源。
   */
  async function deactivatePluginRuntime(
    pluginId: string,
    pluginKey: string,
  ): Promise<void> {
    const supportsRuntimeDeactivation =
      typeof pluginLoaderInstance.hasRuntimeServices === "function"
      && typeof pluginLoaderInstance.unloadSingle === "function";

    if (supportsRuntimeDeactivation && pluginLoaderInstance.hasRuntimeServices()) {
      await pluginLoaderInstance.unloadSingle(pluginId, pluginKey);
      return;
    }

    await stopWorkerIfRunning(pluginId, pluginKey);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    // -- load -------------------------------------------------------------
    /**
     * load — Transitions a plugin to 'ready' status and starts its worker.
     *
     * This method is called after a plugin has been successfully installed and
     * validated. It marks the plugin as ready in the database and immediately
     * triggers the plugin loader to start the worker process.
     *
     * ── 流程说明 ──
     * 1. 先执行状态转换（transition），持久化到数据库。
     * 2. 再激活运行时（activateReadyPlugin），启动 RPC worker。
     * 3. 最后发出 plugin.loaded + plugin.enabled 两个事件。
     *
     * 先持久化后激活是有意为之的：即使 worker 启动失败，
     * 数据库状态已经更新，下游服务可以通过 status_changed 事件感知。
     * 如果反过来（先启动 worker 再持久化），worker 启动成功后但
     * 持久化失败会导致状态不一致 —— worker 在跑但数据库标记为 installed。
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns The updated plugin record.
     */
    async load(pluginId: string): Promise<PluginRecord> {
      const result = await transition(pluginId, "ready");
      await activateReadyPlugin(pluginId);

      emitDomain("plugin.loaded", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      emitDomain("plugin.enabled", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- enable -----------------------------------------------------------
    /**
     * enable — Re-enables a plugin that was previously in an error or upgrade state.
     *
     * Similar to load(), this method transitions the plugin to 'ready' and starts
     * its worker, but it specifically targets plugins that are currently disabled.
     *
     * ── 边界条件 ──
     * 只有 disabled、error、upgrade_pending 三种状态可以 enable。
     * 注意：installed → ready 必须走 load() 而非 enable()，
     * 因为新安装的插件需要完整的首次激活流程（包括 manifest 校验、
     * 工具注册等），enable 假定这些已经完成。
     *
     * @param pluginId - The UUID of the plugin to enable.
     * @returns The updated plugin record.
     */
    async enable(pluginId: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      // Only allow enabling from disabled, error, or upgrade_pending states
      if (plugin.status !== "disabled" && plugin.status !== "error" && plugin.status !== "upgrade_pending") {
        throw badRequest(
          `Cannot enable plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'disabled', 'error', or 'upgrade_pending' status to be enabled.`,
        );
      }

      const result = await transition(pluginId, "ready", null, plugin);
      await activateReadyPlugin(pluginId);
      emitDomain("plugin.enabled", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- disable ----------------------------------------------------------
    /**
     * disable — 将运行中的插件切换到 disabled 状态。
     *
     * ── 停用流程 ──
     * 1. 先停止运行时（deactivatePluginRuntime），确保 worker 不再处理请求。
     * 2. 再执行状态转换（transition），持久化到数据库。
     * 3. 最后发出 plugin.disabled 事件。
     *
     * 先停运行时再持久化的顺序与 load() 相反，这是有意为之：
     * 如果先更新数据库再停进程，数据库已经标记为 disabled 但
     * worker 仍在运行，存在短暂的"已禁用但仍在执行任务"窗口期。
     * 对于需要严格停止的场景（如安全违规），先停进程更安全。
     *
     * 仅允许从 ready 状态进入 disabled，因为其他状态（如 error、installed）
     * 本来就没有运行中的 worker，不需要 disable。
     */
    async disable(pluginId: string, reason?: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      // Only allow disabling from ready state
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot disable plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status to be disabled.`,
        );
      }

      await deactivatePluginRuntime(pluginId, plugin.pluginKey);

      const result = await transition(pluginId, "disabled", reason ?? null, plugin);
      emitDomain("plugin.disabled", {
        pluginId,
        pluginKey: result.pluginKey,
        reason,
      });
      return result;
    },

    // -- unload -----------------------------------------------------------
    /**
     * unload — 卸载插件（软删除或硬删除）。
     *
     * ── 删除策略 ──
     * - removeData=false（默认）：软删除。将状态标记为 uninstalled，
     *   保留数据库记录用于历史审计。支持重新安装（uninstalled → installed）。
     * - removeData=true：硬删除。级联删除所有关联数据（配置、设置、job 记录等），
     *   不可逆。仅在用户明确确认时使用。
     *
     * ── 特殊处理：已卸载插件再次调用 unload ──
     * 如果插件状态已经是 uninstalled 且 removeData=true，执行硬删除。
     * 这允许先软删除（状态变为 uninstalled），用户后悔后再执行硬删除。
     * 但如果没有传 removeData=true，抛 BadRequest，防止重复软删除。
     */
    async unload(
      pluginId: string,
      removeData = false,
    ): Promise<PluginRecord | null> {
      const plugin = await requirePlugin(pluginId);

      // If already uninstalled and removeData, hard-delete
      if (plugin.status === "uninstalled") {
        if (removeData) {
          await pluginLoaderInstance.cleanupInstallArtifacts(plugin);
          const deleted = await registry.uninstall(pluginId, true);
          log.info(
            { pluginId, pluginKey: plugin.pluginKey },
            "plugin lifecycle: hard-deleted already-uninstalled plugin",
          );
          emitDomain("plugin.unloaded", {
            pluginId,
            pluginKey: plugin.pluginKey,
            removeData: true,
          });
          return deleted as PluginRecord | null;
        }
        throw badRequest(
          `Plugin ${plugin.pluginKey} is already uninstalled. ` +
            `Use removeData=true to permanently delete it.`,
        );
      }

      await deactivatePluginRuntime(pluginId, plugin.pluginKey);
      await pluginLoaderInstance.cleanupInstallArtifacts(plugin);

      // Perform the uninstall via registry (handles soft/hard delete)
      const result = await registry.uninstall(pluginId, removeData);

      log.info(
        { pluginId, pluginKey: plugin.pluginKey, removeData },
        `plugin lifecycle: ${plugin.status} → uninstalled${removeData ? " (hard delete)" : ""}`,
      );

      emitter.emit("plugin.status_changed", {
        pluginId,
        pluginKey: plugin.pluginKey,
        previousStatus: plugin.status,
        newStatus: "uninstalled" as PluginStatus,
      });

      emitDomain("plugin.unloaded", {
        pluginId,
        pluginKey: plugin.pluginKey,
        removeData,
      });

      return result as PluginRecord | null;
    },

    // -- markError --------------------------------------------------------
    /**
     * markError — 将插件标记为错误状态。
     *
     * ── 为什么先停运行时再转换状态 ──
     * 插件进入 error 状态意味着其 worker 可能处于不稳定状态。
     * 先调用 deactivatePluginRuntime() 确保：
     * 1) 不会有新的 RPC 请求被路由到这个有问题的 worker。
     * 2) worker 的 crash loop（崩溃循环重启）被终止。
     * 3) 资源被及时释放，避免泄漏。
     *
     * workerManager 的指数退避自动重启机制在这里被有意覆盖：
     * markError 是管理员或系统有意将插件下线，不应触发自动恢复。
     * 从 error 恢复的唯一路径是通过 enable() 手动触发。
     */
    async markError(pluginId: string, error: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);
      await deactivatePluginRuntime(pluginId, plugin.pluginKey);

      const result = await transition(pluginId, "error", error, plugin);
      emitDomain("plugin.error", {
        pluginId,
        pluginKey: result.pluginKey,
        error,
      });
      return result;
    },

    // -- markUpgradePending -----------------------------------------------
    /**
     * markUpgradePending — 标记插件需要升级审批。
     *
     * ── 为什么需要这个中间态 ──
     * 当插件升级引入了新的能力（capabilities）时，不能直接进入 ready，
     * 因为新能力可能带来安全风险或资源消耗变化。
     * upgrade_pending 状态给了管理员审查新能力并决定是否批准的机会。
     *
     * 去激活运行时是为了在审批期间不运行旧版本，防止"已升级但未审批"
     * 的中间状态下旧 worker 继续处理请求。
     */
    async markUpgradePending(pluginId: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);
      await deactivatePluginRuntime(pluginId, plugin.pluginKey);

      const result = await transition(pluginId, "upgrade_pending", null, plugin);
      emitDomain("plugin.upgrade_pending", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- upgrade ----------------------------------------------------------
    /**
     * Upgrade a plugin to a newer version by performing a package update and
     * managing the lifecycle state transition.
     *
     * Following PLUGIN_SPEC.md §25.3, the upgrade process:
     * 1. Stops the current worker process (if running).
     * 2. Fetches and validates the new plugin package via the `PluginLoader`.
     * 3. Compares the capabilities declared in the new manifest against the old one.
     * 4. If new capabilities are added, transitions the plugin to `upgrade_pending`
     *    to await operator approval (worker stays stopped).
     * 5. If no new capabilities are added, transitions the plugin back to `ready`
     *    with the updated version and manifest metadata.
     *
     * ── 能力对比的逻辑 ──
     * 升级时比较新旧 manifest 的 capabilities 数组差异：
     * - 如果新版本有新增能力（旧版本中没有的能力），需要管理员审批。
     * - 如果只是版本号变化但能力集不变（bugfix、性能优化），直接进入 ready。
     * - 如果新版本移除了某些能力，不需要审批 —— 移除能力不会带来新的风险。
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param version - Optional target version specifier.
     * @returns The updated `PluginRecord`.
     * @throws {BadRequest} If the plugin is not in a ready or upgrade_pending state.
     */
    async upgrade(pluginId: string, version?: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      // Can only upgrade plugins that are ready or already in upgrade_pending
      if (plugin.status !== "ready" && plugin.status !== "upgrade_pending") {
        throw badRequest(
          `Cannot upgrade plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' or 'upgrade_pending' status to be upgraded.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey, targetVersion: version },
        "plugin lifecycle: upgrade requested",
      );

      await deactivatePluginRuntime(pluginId, plugin.pluginKey);

      // 1. Download and validate new package via loader
      const { oldManifest, newManifest, discovered } =
        await pluginLoaderInstance.upgradePlugin(pluginId, { version });

      log.info(
        {
          pluginId,
          pluginKey: plugin.pluginKey,
          oldVersion: oldManifest.version,
          newVersion: newManifest.version,
        },
        "plugin lifecycle: package upgraded on disk",
      );

      // 2. Compare capabilities
      const addedCaps = newManifest.capabilities.filter(
        (cap) => !oldManifest.capabilities.includes(cap),
      );

      // 3. Transition state
      if (addedCaps.length > 0) {
        // New capabilities require operator approval — worker stays stopped
        log.info(
          { pluginId, pluginKey: plugin.pluginKey, addedCaps },
          "plugin lifecycle: new capabilities detected, transitioning to upgrade_pending",
        );
        // Skip the inner stopWorkerIfRunning since we already stopped above
        const result = await transition(pluginId, "upgrade_pending", null, plugin);
        emitDomain("plugin.upgrade_pending", {
          pluginId,
          pluginKey: result.pluginKey,
        });
        return result;
      } else {
        const result = await transition(pluginId, "ready", null, {
          ...plugin,
          version: discovered.version,
          manifestJson: newManifest,
        } as PluginRecord);
        await activateReadyPlugin(pluginId);

        emitDomain("plugin.loaded", {
          pluginId,
          pluginKey: result.pluginKey,
        });
        emitDomain("plugin.enabled", {
          pluginId,
          pluginKey: result.pluginKey,
        });

        return result;
      }
    },

    // -- startWorker ------------------------------------------------------
    /**
     * startWorker — 手动启动插件的 worker 进程。
     *
     * ── 与 load/enable 的区别 ──
     * startWorker 不改变插件的生命周期状态，它假设插件已经在 ready 状态，
     * 只是需要启动（或重启）底层 worker。这种分离允许：
     * 1) 服务器启动时，先从数据库恢复所有 ready 插件的状态，再逐个启动 worker。
     * 2) 不改变插件的"就绪"标记，只控制运行时进程。
     * 3) 可以在不修改插件状态的情况下调试 worker 问题。
     *
     * 如果没有配置 workerManager，抛 BadRequest —— 不静默跳过，
     * 因为调用方期望 worker 确实被启动。
     */
    async startWorker(
      pluginId: string,
      options: WorkerStartOptions,
    ): Promise<void> {
      if (!workerManager) {
        throw badRequest(
          "Cannot start worker: no PluginWorkerManager is configured. " +
            "Provide a workerManager option when constructing the lifecycle manager.",
        );
      }

      const plugin = await requirePlugin(pluginId);
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot start worker for plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: starting worker",
      );

      await workerManager.startWorker(pluginId, options);
      emitDomain("plugin.worker_started", {
        pluginId,
        pluginKey: plugin.pluginKey,
      });

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: worker started",
      );
    },

    // -- stopWorker -------------------------------------------------------
    /**
     * stopWorker — 手动停止插件的 worker 进程，不改变生命周期状态。
     *
     * ── 使用场景 ──
     * 主要用于服务器优雅关闭（graceful shutdown）期间，
     * 逐个停止所有插件的 worker。插件在数据库中的状态保持不变（仍是 ready），
     * 以便下次启动时可以自动恢复所有 worker。
     *
     * 与 disable 的区别：stopWorker 只停止进程，不修改数据库记录。
     * 与 startWorker 对称：都只操作运行时，不触及生命周期。
     */
    async stopWorker(pluginId: string): Promise<void> {
      if (!workerManager) return; // No worker manager — nothing to stop

      const plugin = await requirePlugin(pluginId);
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);
    },

    // -- restartWorker ----------------------------------------------------
    async restartWorker(pluginId: string): Promise<void> {
      if (!workerManager) {
        throw badRequest(
          "Cannot restart worker: no PluginWorkerManager is configured.",
        );
      }

      const plugin = await requirePlugin(pluginId);
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot restart worker for plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
        );
      }

      const handle = workerManager.getWorker(pluginId);
      if (!handle) {
        throw badRequest(
          `Cannot restart worker for plugin "${plugin.pluginKey}": no worker is running.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: restarting worker",
      );

      await handle.restart();

      emitDomain("plugin.worker_stopped", { pluginId, pluginKey: plugin.pluginKey });
      emitDomain("plugin.worker_started", { pluginId, pluginKey: plugin.pluginKey });

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: worker restarted",
      );
    },

    // -- getStatus --------------------------------------------------------
    async getStatus(pluginId: string): Promise<PluginStatus | null> {
      const plugin = await registry.getById(pluginId);
      return plugin?.status ?? null;
    },

    // -- canTransition ----------------------------------------------------
    async canTransition(pluginId: string, to: PluginStatus): Promise<boolean> {
      const plugin = await registry.getById(pluginId);
      if (!plugin) return false;
      return isValidTransition(plugin.status, to);
    },

    // -- Event subscriptions ----------------------------------------------
    on(event, listener) {
      emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener);
    },

    once(event, listener) {
      emitter.once(event, listener);
    },
  };
}
