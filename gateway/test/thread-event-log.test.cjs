const assert = require("node:assert/strict");
const test = require("node:test");

const { createThreadEventLog } = require("../runtime/core/thread-event-log.cjs");

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
