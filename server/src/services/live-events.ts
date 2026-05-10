// 实时事件系统 — 基于 Node.js EventEmitter 的内存中发布/订阅引擎。
// 用于向连接中的 SSE（Server-Sent Events）客户端推送实时更新（如活动日志、Run 状态变更等）。
// 不使用外部消息队列（如 Redis Pub/Sub）的原因：
// 1. Paperclip 是单进程架构，无需跨进程广播
// 2. 减少基础设施依赖和延迟
// 3. 事件最多保留几秒（不持久化），丢失可接受 — 前端会通过轮询补偿

import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
// 不限制 listener 数量，因为每个连接的客户端（SSE 订阅者）都会注册一个 listener。
// 对于大型公司可能有数十个并发连接。
emitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

// 向指定公司的所有订阅者推送事件。
// 事件以公司 ID 为频道隔离，防止跨公司数据泄漏。
export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  return event;
}

// 向所有公司（全局频道 "*"）推送事件。
// 仅用于系统级通知（如平台公告），不用于业务数据。
export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  return event;
}

// 订阅指定公司的实时事件。返回取消订阅的函数。
// 通常由 SSE 端点调用，在客户端断开时调用取消函数以释放 listener。
export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

// 订阅全局事件。
export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
