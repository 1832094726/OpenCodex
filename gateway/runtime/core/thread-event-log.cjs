const fs = require("fs");
const path = require("path");

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
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onRecord = typeof options.onRecord === "function" ? options.onRecord : null;
  const eventsByThreadId = new Map();
  const latestSeqByThreadId = new Map();
  const cursorByClientPortThread = new Map();

  function persistRecord(record) {
    if (!onRecord || !record || typeof record !== "object") return;
    try {
      onRecord(record);
    } catch {}
  }

  function prune(threadId, nowMs = now()) {
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

  function appendEntry(threadId, event = {}, nowMs = now(), restoredThreadSeq = 0, persist = true) {
    if (!threadId) return { atMs: nowMs, threadId: "", threadSeq: 0 };
    const currentSeq = Number(latestSeqByThreadId.get(threadId) || 0);
    const restoredSeq = Math.max(0, Number(restoredThreadSeq) || 0);
    const threadSeq = restoredSeq > currentSeq ? restoredSeq : currentSeq + 1;
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
    if (persist) persistRecord({ entry, threadId, type: "event" });
    return entry;
  }

  function append(threadId, event = {}, nowMs = now()) {
    return appendEntry(threadId, event, nowMs, 0, true);
  }

  function stats(threadId, nowMs = now()) {
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

  function replayGapFor(threadId, afterSeq, nowMs = now()) {
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
    const queue = prune(threadId, options.nowMs || now());
    const snapshot = stats(threadId, options.nowMs || now());
    const events = queue.filter((entry) => {
      if (sourceClientId && sourcePortId && entry.sourceClientId === sourceClientId && entry.sourcePortId === sourcePortId) {
        return false;
      }
      return !Number.isFinite(cursor) || cursor <= 0 || Number(entry.threadSeq || 0) > cursor;
    });
    return {
      ...snapshot,
      events,
      gap: replayGapFor(threadId, afterSeq, options.nowMs || now()),
    };
  }

  function rememberCursorEntry(clientId, portId, threadId, seq, persist = true) {
    const nextSeq = Number(seq);
    if (!clientId || !portId || !threadId || !Number.isFinite(nextSeq) || nextSeq <= 0) return cursor(clientId, portId, threadId);
    const key = cursorKey(clientId, portId, threadId);
    const current = Number(cursorByClientPortThread.get(key) || 0);
    if (nextSeq <= current) return current;
    cursorByClientPortThread.set(key, nextSeq);
    if (persist) persistRecord({ clientId, portId, seq: nextSeq, threadId, type: "cursor" });
    return nextSeq;
  }

  function rememberCursor(clientId, portId, threadId, seq) {
    return rememberCursorEntry(clientId, portId, threadId, seq, true);
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

  function restoreRecord(record) {
    if (!record || typeof record !== "object") return;
    if (record.type === "event" && record.entry && typeof record.threadId === "string") {
      const entry = record.entry && typeof record.entry === "object" ? record.entry : {};
      appendEntry(record.threadId, entry, Number(entry.atMs) || now(), Number(entry.threadSeq) || 0, false);
    } else if (record.type === "cursor") {
      rememberCursorEntry(record.clientId, record.portId, record.threadId, record.seq, false);
    }
  }

  if (Array.isArray(options.records)) {
    for (const record of options.records) restoreRecord(record);
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

function readJsonlRecords(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {}
    }
    return records;
  } catch (error) {
    return error && error.code === "ENOENT" ? [] : [];
  }
}

function appendJsonlRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 持久 event log 使用 append-only JSONL，避免重启时半写文件破坏已有记录。
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function createFileThreadEventLog(options = {}) {
  const filePath = options.filePath || path.join(process.cwd(), ".data", "runtime", "cache", "thread-event-log.jsonl");
  const records = readJsonlRecords(filePath);
  const log = createThreadEventLog({
    ...options,
    records,
    onRecord(record) {
      appendJsonlRecord(filePath, { ...record, recordedAtMs: typeof options.now === "function" ? options.now() : Date.now() });
      if (typeof options.onRecord === "function") options.onRecord(record);
    },
  });
  return {
    ...log,
    filePath,
  };
}

function requireBetterSqlite3() {
  try {
    return require("better-sqlite3");
  } catch (error) {
    const wrapped = new Error("better-sqlite3 is required for OPENCODEX_THREAD_EVENT_LOG_MODE=sqlite");
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeSqliteRecord(row) {
  if (!row || typeof row !== "object") return null;
  try {
    return JSON.parse(String(row.payload || ""));
  } catch {
    return null;
  }
}

function createSqliteThreadEventLog(options = {}) {
  const filePath = options.filePath || path.join(process.cwd(), ".data", "runtime", "cache", "thread-event-log.sqlite");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const Database = requireBetterSqlite3();
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_event_log_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      thread_id TEXT,
      client_id TEXT,
      port_id TEXT,
      seq INTEGER,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_event_log_records_thread
      ON thread_event_log_records(thread_id, id);
  `);

  const rows = db.prepare("SELECT payload FROM thread_event_log_records ORDER BY id ASC").all();
  const records = rows.map(normalizeSqliteRecord).filter(Boolean);
  const insertRecord = db.prepare(`
    INSERT INTO thread_event_log_records (type, recorded_at_ms, thread_id, client_id, port_id, seq, payload)
    VALUES (@type, @recordedAtMs, @threadId, @clientId, @portId, @seq, @payload)
  `);
  const log = createThreadEventLog({
    ...options,
    records,
    onRecord(record) {
      const recordedAtMs = typeof options.now === "function" ? options.now() : Date.now();
      // SQLite adapter 只负责成熟持久化；replay/gap/cursor 语义仍由内存 ThreadEventLog 统一计算。
      insertRecord.run({
        clientId: record.clientId || null,
        payload: JSON.stringify({ ...record, recordedAtMs }),
        portId: record.portId || null,
        recordedAtMs,
        seq: Number(record.seq || (record.entry && record.entry.threadSeq) || 0) || null,
        threadId: record.threadId || null,
        type: record.type || "unknown",
      });
      if (typeof options.onRecord === "function") options.onRecord(record);
    },
  });
  return {
    ...log,
    close() {
      db.close();
    },
    db,
    filePath,
  };
}

function createConfiguredThreadEventLog(options = {}) {
  const mode = String(options.mode || process.env.OPENCODEX_THREAD_EVENT_LOG_MODE || "memory").toLowerCase();
  if (mode === "sqlite" || mode === "sqlite3") return createSqliteThreadEventLog(options);
  if (mode === "file" || mode === "jsonl") return createFileThreadEventLog(options);
  return createThreadEventLog(options);
}

module.exports = { createConfiguredThreadEventLog, createFileThreadEventLog, createSqliteThreadEventLog, createThreadEventLog };
