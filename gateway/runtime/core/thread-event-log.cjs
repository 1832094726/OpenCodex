function safePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function cursorKey(clientId, portId, threadId) {
  return `${clientId || ""}\n${portId || ""}\n${threadId || ""}`;
}

function createThreadEventLog(options = {}) {
  const maxEntries = safePositiveInteger(options.maxEntries, 500);
  const ttlMs = safePositiveInteger(options.ttlMs, 2 * 60 * 1000);
  const eventsByThreadId = new Map();
  const latestSeqByThreadId = new Map();
  const cursorByClientPortThread = new Map();

  function prune(threadId, nowMs = Date.now()) {
    const queue = eventsByThreadId.get(threadId);
    if (!queue) return [];
    const fresh = queue.filter((entry) => entry && nowMs - Number(entry.atMs || 0) <= ttlMs);
    while (fresh.length > maxEntries) fresh.shift();
    if (fresh.length === 0) {
      eventsByThreadId.delete(threadId);
      return [];
    }
    if (fresh.length !== queue.length) eventsByThreadId.set(threadId, fresh);
    return fresh;
  }

  function append(threadId, event = {}, nowMs = Date.now()) {
    if (!threadId) return { atMs: nowMs, threadId: "", threadSeq: 0 };
    const threadSeq = Number(latestSeqByThreadId.get(threadId) || 0) + 1;
    latestSeqByThreadId.set(threadId, threadSeq);
    const entry = {
      ...event,
      atMs: nowMs,
      threadId,
      threadSeq,
    };
    const queue = prune(threadId, nowMs);
    queue.push(entry);
    while (queue.length > maxEntries) queue.shift();
    eventsByThreadId.set(threadId, queue);
    return entry;
  }

  function stats(threadId, nowMs = Date.now()) {
    const queue = prune(threadId, nowMs);
    const latestKnownThreadSeq = Number(latestSeqByThreadId.get(threadId) || 0);
    let oldestThreadSeq = 0;
    let latestThreadSeq = 0;
    let latestThreadFrameAtMs = 0;
    for (const entry of queue) {
      const seq = Number(entry && entry.threadSeq) || 0;
      if (seq > 0 && (oldestThreadSeq === 0 || seq < oldestThreadSeq)) oldestThreadSeq = seq;
      if (seq > latestThreadSeq) latestThreadSeq = seq;
      latestThreadFrameAtMs = Math.max(latestThreadFrameAtMs, Number(entry && entry.atMs) || 0);
    }
    return {
      cachedThreadFrameCount: queue.length,
      latestKnownThreadSeq,
      latestThreadFrameAtMs,
      latestThreadSeq,
      oldestThreadSeq,
    };
  }

  function replayGapFor(threadId, afterSeq, nowMs = Date.now()) {
    const cursor = Number(afterSeq);
    const snapshot = stats(threadId, nowMs);
    const hasUsableCursor = Number.isFinite(cursor) && cursor > 0;
    // 队列最老 seq 已经晚于 cursor+1 时，说明中间有增量不可补，只能走快照修复。
    const missingBeforeRetainedQueue =
      snapshot.oldestThreadSeq > 1 && (!hasUsableCursor || snapshot.oldestThreadSeq > cursor + 1);
    return (
      snapshot.latestKnownThreadSeq > (hasUsableCursor ? cursor : 0) &&
      (snapshot.oldestThreadSeq === 0 || missingBeforeRetainedQueue)
    );
  }

  function readAfter(threadId, afterSeq = 0, options = {}) {
    const cursor = Number(afterSeq);
    const sourceClientId = typeof options.sourceClientId === "string" ? options.sourceClientId : "";
    const sourcePortId = typeof options.sourcePortId === "string" ? options.sourcePortId : "";
    const queue = prune(threadId, options.nowMs || Date.now());
    const snapshot = stats(threadId, options.nowMs || Date.now());
    const events = queue.filter((entry) => {
      if (sourceClientId && sourcePortId && entry.sourceClientId === sourceClientId && entry.sourcePortId === sourcePortId) {
        return false;
      }
      return !Number.isFinite(cursor) || cursor <= 0 || Number(entry.threadSeq || 0) > cursor;
    });
    return {
      ...snapshot,
      events,
      gap: replayGapFor(threadId, afterSeq, options.nowMs || Date.now()),
    };
  }

  function rememberCursor(clientId, portId, threadId, seq) {
    const nextSeq = Number(seq);
    if (!clientId || !portId || !threadId || !Number.isFinite(nextSeq) || nextSeq <= 0) return cursor(clientId, portId, threadId);
    const key = cursorKey(clientId, portId, threadId);
    const current = Number(cursorByClientPortThread.get(key) || 0);
    if (nextSeq <= current) return current;
    cursorByClientPortThread.set(key, nextSeq);
    return nextSeq;
  }

  function cursor(clientId, portId, threadId) {
    if (!clientId || !portId || !threadId) return 0;
    return Number(cursorByClientPortThread.get(cursorKey(clientId, portId, threadId)) || 0);
  }

  function ackSnapshot(clientId, threadId, seq, activePortIds = []) {
    const snapshotSeq = Math.max(0, Number(seq) || 0);
    if (!clientId || !threadId || snapshotSeq <= 0) return 0;
    let touched = 0;
    for (const portId of activePortIds) {
      if (!portId) continue;
      rememberCursor(clientId, portId, threadId, snapshotSeq);
      touched += 1;
    }
    return touched;
  }

  return {
    ackSnapshot,
    append,
    cursor,
    readAfter,
    rememberCursor,
    stats,
  };
}

module.exports = { createThreadEventLog };
