const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createConfiguredThreadEventLog,
  createFileThreadEventLog,
  createSqliteThreadEventLog,
  createThreadEventLog,
} = require("../runtime/core/thread-event-log.cjs");

test("thread event log assigns thread sequences and reads retained increments", () => {
  const log = createThreadEventLog({ maxEntries: 10, ttlMs: 60_000 });

  const first = log.append("thread-a", { data: "one", sourceClientId: "client-a", sourcePortId: "port-a" });
  const second = log.append("thread-a", { data: "two", sourceClientId: "client-b", sourcePortId: "port-b" });

  assert.equal(first.threadSeq, 1);
  assert.equal(second.threadSeq, 2);
  assert.deepEqual(log.readAfter("thread-a", 1).events.map((event) => event.data), ["two"]);
  assert.deepEqual(log.stats("thread-a"), {
    cachedThreadFrameCount: 2,
    latestKnownThreadSeq: 2,
    latestThreadFrameAtMs: second.atMs,
    latestThreadSeq: 2,
    oldestThreadSeq: 1,
  });
});

test("thread event log detects replay gaps after retention pruning", () => {
  const log = createThreadEventLog({ maxEntries: 2, ttlMs: 60_000 });

  log.append("thread-gap", { data: "one" });
  log.append("thread-gap", { data: "two" });
  log.append("thread-gap", { data: "three" });

  const replay = log.readAfter("thread-gap", 0);
  assert.equal(replay.gap, true);
  assert.equal(replay.oldestThreadSeq, 2);
  assert.equal(replay.latestKnownThreadSeq, 3);
  assert.deepEqual(replay.events.map((event) => event.threadSeq), [2, 3]);
});

test("thread event log tracks per-client cursors and snapshot acknowledgements", () => {
  const log = createThreadEventLog({ maxEntries: 10, ttlMs: 60_000 });

  log.append("thread-cursor", { data: "one" });
  log.append("thread-cursor", { data: "two" });
  assert.equal(log.rememberCursor("client-a", "port-a", "thread-cursor", 1), 1);
  assert.equal(log.rememberCursor("client-a", "port-a", "thread-cursor", 0), 1);
  assert.equal(log.cursor("client-a", "port-a", "thread-cursor"), 1);

  const advanced = log.ackSnapshot("client-a", "thread-cursor", 2, ["port-a", "port-b"]);
  assert.equal(advanced, 2);
  assert.equal(log.cursor("client-a", "port-a", "thread-cursor"), 2);
  assert.equal(log.cursor("client-a", "port-b", "thread-cursor"), 2);
});

test("file thread event log restores retained events and cursors across instances", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-thread-log-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, "thread-events.jsonl");

  const first = createFileThreadEventLog({ filePath, maxEntries: 10, ttlMs: 60_000 });
  first.append("thread-file", { data: "one", sourceClientId: "client-a", sourcePortId: "port-a" }, 1_000);
  first.append("thread-file", { data: "two", sourceClientId: "client-a", sourcePortId: "port-a" }, 2_000);
  first.rememberCursor("client-b", "port-b", "thread-file", 1);
  first.ackSnapshot("client-b", "thread-file", 2, ["port-b", "port-c"]);

  const restored = createFileThreadEventLog({ filePath, maxEntries: 10, ttlMs: 60_000, now: () => 3_000 });
  assert.deepEqual(restored.readAfter("thread-file", 1).events.map((event) => event.data), ["two"]);
  assert.equal(restored.cursor("client-b", "port-b", "thread-file"), 2);
  assert.equal(restored.cursor("client-b", "port-c", "thread-file"), 2);
  assert.equal(restored.stats("thread-file").latestKnownThreadSeq, 2);
});

test("file thread event log keeps sequence monotonic after retained events are pruned", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-thread-log-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, "thread-events.jsonl");

  const first = createFileThreadEventLog({ filePath, maxEntries: 2, ttlMs: 60_000 });
  first.append("thread-prune", { data: "one" }, 1_000);
  first.append("thread-prune", { data: "two" }, 2_000);
  first.append("thread-prune", { data: "three" }, 3_000);

  const restored = createFileThreadEventLog({ filePath, maxEntries: 2, ttlMs: 60_000, now: () => 4_000 });
  assert.deepEqual(restored.readAfter("thread-prune", 0).events.map((event) => event.threadSeq), [2, 3]);
  assert.equal(restored.readAfter("thread-prune", 0).gap, true);
  assert.equal(restored.append("thread-prune", { data: "four" }, 5_000).threadSeq, 4);
});

test("configured thread event log selects file adapter only when requested", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-thread-log-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, "configured.jsonl");

  const memoryLog = createConfiguredThreadEventLog({ filePath, mode: "memory", ttlMs: 60_000 });
  memoryLog.append("thread-config", { data: "memory" }, 1_000);
  assert.equal(fs.existsSync(filePath), false);

  const fileLog = createConfiguredThreadEventLog({ filePath, mode: "file", ttlMs: 60_000 });
  fileLog.append("thread-config", { data: "file" }, 1_000);
  assert.equal(fs.existsSync(filePath), true);

  const restored = createConfiguredThreadEventLog({ filePath, mode: "file", now: () => 2_000, ttlMs: 60_000 });
  assert.deepEqual(restored.readAfter("thread-config", 0).events.map((event) => event.data), ["file"]);
});

test("sqlite thread event log restores retained events and cursors across instances", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-thread-log-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, "thread-events.sqlite");

  const first = createSqliteThreadEventLog({ filePath, maxEntries: 10, ttlMs: 60_000 });
  first.append("thread-sqlite", { data: "one", sourceClientId: "client-a", sourcePortId: "port-a" }, 1_000);
  first.append("thread-sqlite", { data: "two", sourceClientId: "client-a", sourcePortId: "port-a" }, 2_000);
  first.rememberCursor("client-b", "port-b", "thread-sqlite", 1);
  first.ackSnapshot("client-b", "thread-sqlite", 2, ["port-b", "port-c"]);
  first.close();

  const restored = createSqliteThreadEventLog({ filePath, maxEntries: 10, ttlMs: 60_000, now: () => 3_000 });
  t.after(() => restored.close());
  assert.deepEqual(restored.readAfter("thread-sqlite", 1).events.map((event) => event.data), ["two"]);
  assert.equal(restored.cursor("client-b", "port-b", "thread-sqlite"), 2);
  assert.equal(restored.cursor("client-b", "port-c", "thread-sqlite"), 2);
  assert.equal(restored.stats("thread-sqlite").latestKnownThreadSeq, 2);
  assert.equal(restored.append("thread-sqlite", { data: "three" }, 4_000).threadSeq, 3);
});

test("configured thread event log selects sqlite adapter when requested", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-thread-log-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, "configured.sqlite");

  const sqliteLog = createConfiguredThreadEventLog({ filePath, mode: "sqlite", ttlMs: 60_000 });
  t.after(() => sqliteLog.close());
  sqliteLog.append("thread-config-sqlite", { data: "sqlite" }, 1_000);
  assert.equal(fs.existsSync(filePath), true);

  const restored = createConfiguredThreadEventLog({ filePath, mode: "sqlite", now: () => 2_000, ttlMs: 60_000 });
  t.after(() => restored.close());
  assert.deepEqual(restored.readAfter("thread-config-sqlite", 0).events.map((event) => event.data), ["sqlite"]);
});
