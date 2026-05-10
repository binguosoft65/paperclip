import { logger } from "../middleware/logger.js";

// 每个 Agent 的启动锁最长等待 30 秒，超过则视为陈旧并继续执行。
// 选择 30 秒的考量：短了锁不住并发，长了会阻塞排队中的心跳。
// 注意：锁存储在内存中，进程重启后所有锁自动释放。
const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
  }
}

// 以 Agent 粒度串行化启动过程：同一个 Agent 的多次启动请求会排队等待，
// 而非全部并发执行。使用 marker（哨兵 Promise）而非 fn 本身作为锁值，
// 确保 fn 完成后锁才释放；finally 块中通过引用比较（不是值比较）确认锁
// 没有被后续的排队请求替换，避免错误地清除新锁。
export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}
