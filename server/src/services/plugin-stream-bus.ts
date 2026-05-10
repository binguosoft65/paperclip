/**
 * In-memory pub/sub bus for plugin SSE streams.
 *
 * Workers emit stream events via JSON-RPC notifications. The bus fans out
 * each event to all connected SSE clients that match the (pluginId, channel,
 * companyId) tuple.
 *
 * ── 设计说明 ──
 * 基于内存的 pub/sub，意味着 SSE 流数据在同一进程内传播。
 * 如果未来需要多进程部署，需要替换为分布式 pub/sub（如 Redis）。
 * 三部分复合键 (pluginId, channel, companyId) 用于隔离不同插件
 * 和不同公司的流数据，防止跨租户数据泄露。
 *
 * @see PLUGIN_SPEC.md §19.8 — Real-Time Streaming
 */

/** Valid SSE event types for plugin streams. */
export type StreamEventType = "message" | "open" | "close" | "error";

export type StreamSubscriber = (event: unknown, eventType: StreamEventType) => void;

/**
 * Composite key for stream subscriptions: pluginId:channel:companyId
 */
function streamKey(pluginId: string, channel: string, companyId: string): string {
  return `${pluginId}:${channel}:${companyId}`;
}

export interface PluginStreamBus {
  /**
   * Subscribe to stream events for a specific (pluginId, channel, companyId).
   * Returns an unsubscribe function.
   */
  subscribe(
    pluginId: string,
    channel: string,
    companyId: string,
    listener: StreamSubscriber,
  ): () => void;

  /**
   * Publish an event to all subscribers of (pluginId, channel, companyId).
   * Called by the worker manager when it receives a stream notification.
   */
  publish(
    pluginId: string,
    channel: string,
    companyId: string,
    event: unknown,
    eventType?: StreamEventType,
  ): void;
}

/**
 * Create a new PluginStreamBus instance.
 */
export function createPluginStreamBus(): PluginStreamBus {
  const subscribers = new Map<string, Set<StreamSubscriber>>();

  return {
    subscribe(pluginId, channel, companyId, listener) {
      const key = streamKey(pluginId, channel, companyId);
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(listener);

      return () => {
        set!.delete(listener);
        if (set!.size === 0) {
          subscribers.delete(key);
        }
      };
    },

    publish(pluginId, channel, companyId, event, eventType: StreamEventType = "message") {
      const key = streamKey(pluginId, channel, companyId);
      const set = subscribers.get(key);
      if (!set) return;
      for (const listener of set) {
        listener(event, eventType);
      }
    },
  };
}
