const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { io: createSocketIoClient } = require("socket.io-client");

const {
  appHostStateContext,
  appHostThreadStateSnapshot,
  createAppHostFrameState,
  markAppHostClientInactive,
  observeAppHostFrame,
  recordAppHostThreadNudge,
  recordAppHostThreadReplay,
  recordAppHostThreadSnapshotAck,
  rememberAppHostThreadPort,
  summarizeAppHostFrame,
} = require("../runtime/ipc/app-host-frame-observer.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function wsMessage(ws, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (predicate && !predicate(message)) return;
      cleanup();
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function wsMessages(ws, predicate, count, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket messages"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (predicate && !predicate(message)) return;
      messages.push(message);
      if (messages.length >= count) {
        cleanup();
        resolve(messages);
      }
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function connectClient(url, clientId) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "hello", clientId }));
  await wsMessage(ws, (message) => message.type === "hello-ack" && message.clientId === clientId);
  return ws;
}

test("summarizeAppHostFrame extracts routing fields without message bodies", () => {
  const summary = summarizeAppHostFrame(JSON.stringify({
    id: "rpc-1",
    method: "thread/turns/list",
    params: {
      threadId: "thread-secret",
      prompt: "正文不能进日志",
      nested: {
        turnId: "turn-1",
        content: "工具输出也不能进日志",
      },
    },
  }));

  assert.equal(summary.parseOk, true);
  assert.equal(summary.requestId, "rpc-1");
  assert.equal(summary.method, "thread/turns/list");
  assert.equal(summary.threadId, "thread-secret");
  assert.equal(summary.turnId, "turn-1");
  assert.deepEqual(summary.redactedFields, ["content", "prompt"]);
  assert.equal(JSON.stringify(summary).includes("正文不能进日志"), false);
  assert.equal(JSON.stringify(summary).includes("工具输出也不能进日志"), false);
});

test("observeAppHostFrame remembers request and thread context per client port", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  observeAppHostFrame({
    clientId: "client-state-1",
    data: JSON.stringify({
      request: {
        id: "rpc-state-1",
        method: "turn/start",
        params: {
          threadId: "thread-state-1",
          turnId: "turn-state-1",
          input: "不要记录正文",
        },
      },
    }),
    direction: "browser-to-official",
    flow: false,
    log: false,
    portId: "port-state-1",
    state,
  });

  const context = appHostStateContext(state, "client-state-1", "port-state-1");
  assert.equal(context.method, "turn/start");
  assert.equal(context.requestId, "rpc-state-1");
  assert.equal(context.threadId, "thread-state-1");
  assert.equal(context.turnId, "turn-state-1");
  assert.equal(context.lastDirection, "browser-to-official");
});

test("summarizeAppHostFrame tolerates non-json frames", () => {
  const summary = summarizeAppHostFrame("not-json");

  assert.equal(summary.parseOk, false);
  assert.equal(summary.payloadShape, "unparsed");
  assert.equal(summary.method, "");
  assert.equal(summary.requestId, "");
  assert.equal(summary.bytes, Buffer.byteLength("not-json", "utf-8"));
});

test("thread state tracks multiple clients without storing message bodies", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  observeAppHostFrame({
    clientId: "client-thread-a",
    data: JSON.stringify({
      id: "rpc-thread-a",
      method: "thread/read",
      params: {
        prompt: "不能落状态",
        threadId: "thread-shared",
        turnId: "turn-a",
      },
    }),
    direction: "browser-to-official",
    flow: false,
    log: false,
    portId: "port-thread-a",
    state,
  });
  observeAppHostFrame({
    clientId: "client-thread-b",
    data: JSON.stringify({
      id: "rpc-thread-b",
      method: "thread/turns/list",
      params: {
        content: "也不能落状态",
        threadId: "thread-shared",
        turnId: "turn-b",
      },
    }),
    direction: "official-to-browser",
    flow: false,
    log: false,
    portId: "port-thread-b",
    state,
  });

  const snapshot = appHostThreadStateSnapshot(state, "thread-shared");
  assert.equal(snapshot.threadId, "thread-shared");
  assert.equal(snapshot.clientCount, 2);
  assert.deepEqual(snapshot.clientIds.sort(), ["client-thread-a", "client-thread-b"]);
  assert.equal(snapshot.portCount, 2);
  assert.equal(snapshot.frameCount, 2);
  assert.equal(snapshot.upstreamFrameCount, 1);
  assert.equal(snapshot.downstreamFrameCount, 1);
  assert.equal(snapshot.lastMethod, "thread/turns/list");
  assert.equal(snapshot.lastTurnId, "turn-b");
  assert.equal(JSON.stringify(snapshot).includes("不能落状态"), false);
  assert.equal(JSON.stringify(snapshot).includes("也不能落状态"), false);
});

test("thread state records connect and replay diagnostics per thread", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  rememberAppHostThreadPort(state, {
    clientId: "client-connect",
    portId: "port-connect",
    threadId: "thread-connect",
  });
  recordAppHostThreadReplay(state, {
    clientId: "client-connect",
    cursor: 4,
    gap: true,
    latestKnownThreadSeq: 8,
    oldestThreadSeq: 6,
    portId: "port-connect",
    queued: 3,
    sent: 2,
    threadId: "thread-connect",
  });

  const connected = appHostThreadStateSnapshot(state, "thread-connect");
  const missing = appHostThreadStateSnapshot(state, "thread-other");
  assert.equal(connected.clientCount, 1);
  assert.deepEqual(connected.clientIds, ["client-connect"]);
  assert.equal(connected.portCount, 1);
  assert.equal(connected.threadReplayCount, 1);
  assert.equal(connected.lastThreadReplayQueued, 3);
  assert.equal(connected.lastThreadReplaySent, 2);
  assert.equal(connected.lastThreadReplayCursor, 4);
  assert.equal(connected.lastThreadReplayLatestKnownSeq, 8);
  assert.equal(connected.lastThreadReplayOldestSeq, 6);
  assert.equal(connected.lastThreadReplayGap, true);
  assert.equal(connected.missedByTransport, 4);
  assert.equal(connected.repairedByThreadReplay, 2);
  assert.equal(connected.repairedBySnapshot, 0);
  assert.equal(missing, null);
});

test("thread state records snapshot nudge diagnostics", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  rememberAppHostThreadPort(state, {
    clientId: "client-nudge-a",
    portId: "port-nudge-a",
    threadId: "thread-nudge",
  });
  recordAppHostThreadNudge(state, {
    excludedClientId: "client-nudge-source",
    reason: "thread-detail-snapshot",
    sent: 1,
    threadId: "thread-nudge",
  });

  const snapshot = appHostThreadStateSnapshot(state, "thread-nudge");
  assert.equal(snapshot.nudgeCount, 1);
  assert.equal(snapshot.lastNudgeReason, "thread-detail-snapshot");
  assert.equal(snapshot.lastNudgeSent, 1);
  assert.equal(snapshot.lastNudgeExcludedClientId, "client-nudge-source");
});

test("thread state records per-client snapshot acknowledgements", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  recordAppHostThreadSnapshotAck(state, {
    capturedAtMs: 1780000000000,
    clientId: "client-snapshot-a",
    key: "snapshot-key-secret-lengthy",
    method: "thread/read",
    source: "gateway-memory",
    threadId: "thread-snapshot",
    threadSeq: 4,
  });
  recordAppHostThreadSnapshotAck(state, {
    capturedAtMs: 1780000001000,
    clientId: "client-snapshot-b",
    key: "snapshot-key-other",
    method: "thread/turns/list",
    source: "gateway-memory",
    threadId: "thread-snapshot",
    threadSeq: 9,
  });

  const snapshot = appHostThreadStateSnapshot(state, "thread-snapshot");
  assert.equal(snapshot.snapshotAckCount, 2);
  assert.equal(snapshot.snapshotAckClientCount, 2);
  assert.deepEqual(snapshot.snapshotAckClientIds.sort(), ["client-snapshot-a", "client-snapshot-b"]);
  assert.equal(snapshot.lastSnapshotAckClientId, "client-snapshot-b");
  assert.equal(snapshot.lastSnapshotAckMethod, "thread/turns/list");
  assert.equal(snapshot.lastSnapshotAckSource, "gateway-memory");
  assert.equal(snapshot.lastSnapshotAckCapturedAtMs, 1780000001000);
  assert.equal(snapshot.lastSnapshotAckKey, "snapshot-key-other");
  assert.equal(snapshot.lastSnapshotAckThreadSeq, 9);
  assert.equal(snapshot.repairedBySnapshot, 2);
  assert.deepEqual(snapshot.snapshotAckThreadSeqByClientId, {
    "client-snapshot-a": 4,
    "client-snapshot-b": 9,
  });
});

test("thread state can list sanitized thread snapshots", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  rememberAppHostThreadPort(state, {
    clientId: "client-list-a",
    portId: "port-list-a",
    threadId: "thread-list-a",
  });
  rememberAppHostThreadPort(state, {
    clientId: "client-list-b",
    portId: "port-list-b",
    threadId: "thread-list-b",
  });

  const { listAppHostThreadStateSnapshots } = require("../runtime/ipc/app-host-frame-observer.cjs");
  const all = listAppHostThreadStateSnapshots(state, { limit: 5 });
  const filtered = listAppHostThreadStateSnapshots(state, { threadId: "thread-list-b" });

  assert.equal(all.threads.length, 2);
  assert.equal(filtered.threads.length, 1);
  assert.equal(filtered.threads[0].threadId, "thread-list-b");
  assert.equal(filtered.threads[0].activeClientCount, 1);
});

test("thread state keeps historical clients while tracking active participants", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  rememberAppHostThreadPort(state, {
    clientId: "client-active-a",
    portId: "port-active-a",
    threadId: "thread-active",
  });
  rememberAppHostThreadPort(state, {
    clientId: "client-active-b",
    portId: "port-active-b",
    threadId: "thread-active",
  });
  markAppHostClientInactive(state, "client-active-a");

  const snapshot = appHostThreadStateSnapshot(state, "thread-active");
  assert.equal(snapshot.clientCount, 2);
  assert.equal(snapshot.activeClientCount, 1);
  assert.deepEqual(snapshot.activeClientIds, ["client-active-b"]);
  assert.equal(snapshot.portCount, 2);
  assert.equal(snapshot.activePortCount, 1);
  assert.deepEqual(snapshot.activePortIds, ["port-active-b"]);
  assert.deepEqual(snapshot.activeClientPorts, [{ clientId: "client-active-b", portIds: ["port-active-b"] }]);
});

test("thread state moves an active app-host port between threads", () => {
  const state = createAppHostFrameState({ maxEntries: 20 });

  rememberAppHostThreadPort(state, {
    clientId: "client-route",
    portId: "port-route",
    threadId: "thread-old",
  });
  rememberAppHostThreadPort(state, {
    clientId: "client-route",
    portId: "port-route",
    threadId: "thread-new",
  });

  const oldSnapshot = appHostThreadStateSnapshot(state, "thread-old");
  const newSnapshot = appHostThreadStateSnapshot(state, "thread-new");

  assert.deepEqual(oldSnapshot.clientIds, ["client-route"]);
  assert.equal(oldSnapshot.activeClientCount, 0);
  assert.equal(oldSnapshot.activePortCount, 0);
  assert.deepEqual(oldSnapshot.activeClientPorts, []);
  assert.deepEqual(newSnapshot.activeClientIds, ["client-route"]);
  assert.deepEqual(newSnapshot.activePortIds, ["port-route"]);
  assert.deepEqual(newSnapshot.activeClientPorts, [{ clientId: "client-route", portIds: ["port-route"] }]);
});

test("app-host downstream replay protocol is wired on gateway and browser sides", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");
  const polyfillSource = fs.readFileSync(path.join(repoRoot, "web-shell", "codex-bridge-polyfill.js"), "utf8");

  // Gateway 给 official->browser app-host 帧编号并缓存，客户端重连时按 lastServerSeq 只补缺失帧。
  assert.match(wsHubSource, /APP_HOST_DOWNSTREAM_REPLAY_TTL_MS/);
  assert.match(wsHubSource, /rememberAppHostDownstreamFrame\(clientId, portId, data, frameSummary && frameSummary\.raw\)/);
  assert.match(wsHubSource, /flushAppHostDownstreamReplay\(ws, clientId, portId, lastServerSeq\)/);
  assert.match(wsHubSource, /function appHostPortMessagePayload/);
  assert.match(wsHubSource, /payload\.seq = frame\.seq/);

  // 浏览器端记录已收到的 seq，重连 connect 时带回游标，并丢弃重复补发帧。
  assert.match(polyfillSource, /lastServerSeq: 0/);
  assert.match(polyfillSource, /result\.lastServerSeq = Number\(state\.lastServerSeq \|\| 0\)/);
  assert.match(polyfillSource, /app-host-duplicate-server-frame/);
  assert.match(polyfillSource, /state\.lastServerSeq = serverSeq/);
});

test("app-host thread replay keeps cross-client state separate from per-port seq", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");
  const polyfillSource = fs.readFileSync(path.join(repoRoot, "web-shell", "codex-bridge-polyfill.js"), "utf8");

  // Gateway 通过 thread 事件日志索引官方下行帧，给新客户端接同一会话时补缺失增量。
  assert.match(wsHubSource, /createConfiguredThreadEventLog/);
  assert.match(wsHubSource, /OPENCODEX_THREAD_EVENT_LOG_FILE/);
  assert.match(wsHubSource, /appHostThreadEventLog\.append/);
  assert.match(wsHubSource, /appHostThreadEventLog\.readAfter/);
  assert.match(wsHubSource, /function flushAppHostThreadReplay/);
  assert.match(wsHubSource, /route: "app_host_thread_replay"/);
  assert.match(wsHubSource, /replay: "thread"/);
  assert.doesNotMatch(wsHubSource, /appHostDownstreamFramesByThreadId/);
  assert.doesNotMatch(wsHubSource, /appHostDownstreamThreadSeqByThreadId/);
  assert.match(wsHubSource, /payload\.threadSeq = frame\.threadSeq/);
  assert.match(wsHubSource, /appHostPortMessagePayload\(portId, entry\.data, entry, \{ replay: "thread", replayGap \}\)/);
  assert.doesNotMatch(wsHubSource, /type: "app-host-port-message", portId, data: entry\.data, replay: "thread", seq/);

  // 浏览器 connect 帧携带当前路由 threadId 和 threadSeq 游标，gateway 只补同 thread 缺失增量。
  assert.match(polyfillSource, /function currentRouteThreadId/);
  assert.match(polyfillSource, /const threadId = currentRouteThreadId\(\)/);
  assert.match(polyfillSource, /result\.threadId = threadId/);
  assert.match(polyfillSource, /result\.lastThreadSeq = rememberedAppHostThreadSeq\(threadId\)/);
  assert.match(polyfillSource, /sessionStorage\.setItem\(appHostThreadSeqStorageKey\(threadId\), String\(seq\)\)/);
  assert.match(polyfillSource, /app-host-duplicate-thread-frame/);
  assert.match(wsHubSource, /lastServerSeq > 0[\s\S]*flushAppHostDownstreamReplay/);
  assert.match(wsHubSource, /flushAppHostThreadReplay\(ws, clientId, portId, routeThreadId, lastThreadSeq\)/);
});

test("ws hub replays only app-host thread frames after the client thread cursor", async () => {
  const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const relays = [];
  createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connectClient(wsUrl, "client-thread-replay-a");
    wsA.send(JSON.stringify({
      clientId: "client-thread-replay-a",
      portId: "port-thread-replay-a",
      threadId: "thread-replay",
      type: "app-host-connect",
    }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-connected");
    const relayA = relays.find((relay) => relay.clientId === "client-thread-replay-a");
    assert.ok(relayA);

    // A 端先收到两个同 thread 的官方下行帧，中间层会按 threadSeq 记录可补偿增量。
    relayA.onMessage(JSON.stringify({ id: "rpc-replay-1", method: "thread/read", result: { threadId: "thread-replay", turnId: "turn-1" } }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === 1);
    relayA.onMessage(JSON.stringify({ id: "rpc-replay-2", method: "thread/read", result: { threadId: "thread-replay", turnId: "turn-2" } }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === 2);

    wsB = await connectClient(wsUrl, "client-thread-replay-b");
    wsB.send(JSON.stringify({
      clientId: "client-thread-replay-b",
      lastThreadSeq: 1,
      portId: "port-thread-replay-b",
      threadId: "thread-replay",
      type: "app-host-connect",
    }));
    // connected 和 replay 会连续到达；一个监听器直接等 replay，避免测试本身漏帧。
    const replay = await wsMessage(wsB, (message) => message.type === "app-host-port-message" && message.replay === "thread");

    assert.equal(replay.threadId, "thread-replay");
    assert.equal(replay.threadSeq, 2);
    assert.match(replay.data, /turn-2/);
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ws hub can use an injected thread event log for app-host thread replay", async () => {
  const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const calls = [];
  const injectedThreadEventLog = {
    ackSnapshot() {
      calls.push(["ackSnapshot", ...arguments]);
      return 0;
    },
    append(threadId, event) {
      calls.push(["append", threadId, event.sourceClientId, event.sourcePortId]);
      // 这里故意返回非 1 起步的 seq，证明 gateway 使用的是可替换 event log，而不是内置队列。
      return { ...event, atMs: Date.now(), threadId, threadSeq: 42 };
    },
    cursor(clientId, portId, threadId) {
      calls.push(["cursor", clientId, portId, threadId]);
      return 41;
    },
    readAfter(threadId, afterSeq, options) {
      calls.push(["readAfter", threadId, afterSeq, options.sourceClientId, options.sourcePortId]);
      if (Number(afterSeq) !== 41) {
        return {
          cachedThreadFrameCount: 0,
          events: [],
          gap: false,
          latestKnownThreadSeq: 0,
          latestThreadFrameAtMs: 0,
          latestThreadSeq: 0,
          oldestThreadSeq: 0,
        };
      }
      return {
        cachedThreadFrameCount: 1,
        events: [
          {
            atMs: Date.now(),
            data: JSON.stringify({ id: "rpc-injected-replay", method: "thread/read", result: { threadId, turnId: "turn-injected" } }),
            threadId,
            threadSeq: 99,
          },
        ],
        gap: false,
        latestKnownThreadSeq: 99,
        latestThreadFrameAtMs: Date.now(),
        latestThreadSeq: 99,
        oldestThreadSeq: 99,
      };
    },
    rememberCursor(clientId, portId, threadId, seq) {
      calls.push(["rememberCursor", clientId, portId, threadId, seq]);
      return seq;
    },
    stats() {
      return {
        cachedThreadFrameCount: 0,
        latestKnownThreadSeq: 0,
        latestThreadFrameAtMs: 0,
        latestThreadSeq: 0,
        oldestThreadSeq: 0,
      };
    },
  };
  const relays = [];
  createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
    threadEventLog: injectedThreadEventLog,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connectClient(wsUrl, "client-injected-log-a");
    wsA.send(JSON.stringify({
      clientId: "client-injected-log-a",
      portId: "port-injected-log-a",
      threadId: "thread-injected-log",
      type: "app-host-connect",
    }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-connected");
    const relayA = relays.find((relay) => relay.clientId === "client-injected-log-a");
    assert.ok(relayA);

    relayA.onMessage(JSON.stringify({ id: "rpc-injected-live", method: "thread/read", result: { threadId: "thread-injected-log", turnId: "turn-live" } }));
    const live = await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadId === "thread-injected-log");
    assert.equal(live.threadSeq, 42);

    wsB = await connectClient(wsUrl, "client-injected-log-b");
    wsB.send(JSON.stringify({
      clientId: "client-injected-log-b",
      lastThreadSeq: 41,
      portId: "port-injected-log-b",
      threadId: "thread-injected-log",
      type: "app-host-connect",
    }));
    const replay = await wsMessage(wsB, (message) => message.type === "app-host-port-message" && message.replay === "thread");
    assert.equal(replay.threadSeq, 99);
    assert.match(replay.data, /turn-injected/);

    assert.ok(calls.some((call) => call[0] === "append" && call[1] === "thread-injected-log"));
    assert.ok(calls.some((call) => call[0] === "readAfter" && call[1] === "thread-injected-log" && call[2] === 41));
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ws hub can persist app-host thread replay events through configured file event log", async (t) => {
  const wsHubPath = path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-ws-thread-log-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, "thread-events.jsonl");
  const oldMode = process.env.OPENCODEX_THREAD_EVENT_LOG_MODE;
  const oldFile = process.env.OPENCODEX_THREAD_EVENT_LOG_FILE;
  process.env.OPENCODEX_THREAD_EVENT_LOG_MODE = "file";
  process.env.OPENCODEX_THREAD_EVENT_LOG_FILE = filePath;
  delete require.cache[require.resolve(wsHubPath)];
  const { createWsHub } = require(wsHubPath);
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const relays = [];
  createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let ws = null;

  try {
    ws = await connectClient(wsUrl, "client-file-log");
    ws.send(JSON.stringify({
      clientId: "client-file-log",
      portId: "port-file-log",
      threadId: "thread-file-log",
      type: "app-host-connect",
    }));
    await wsMessage(ws, (message) => message.type === "app-host-port-connected");
    const relay = relays.find((entry) => entry.clientId === "client-file-log");
    assert.ok(relay);

    relay.onMessage(JSON.stringify({ id: "rpc-file-log", method: "thread/read", result: { threadId: "thread-file-log", turnId: "turn-file-log" } }));
    await wsMessage(ws, (message) => message.type === "app-host-port-message" && message.threadSeq === 1);

    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
    assert.ok(lines.some((line) => line.includes('"type":"event"') && line.includes("thread-file-log")));
  } finally {
    if (ws) ws.close();
    await new Promise((resolve) => server.close(resolve));
    if (oldMode == null) {
      delete process.env.OPENCODEX_THREAD_EVENT_LOG_MODE;
    } else {
      process.env.OPENCODEX_THREAD_EVENT_LOG_MODE = oldMode;
    }
    if (oldFile == null) {
      delete process.env.OPENCODEX_THREAD_EVENT_LOG_FILE;
    } else {
      process.env.OPENCODEX_THREAD_EVENT_LOG_FILE = oldFile;
    }
    delete require.cache[require.resolve(wsHubPath)];
  }
});

test("ws hub marks app-host thread replay gaps when a client cursor is older than the retained queue", async () => {
  const wsHubPath = path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs");
  const oldMaxMessages = process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES;
  process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES = "2";
  delete require.cache[require.resolve(wsHubPath)];
  const { createWsHub } = require(wsHubPath);
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const relays = [];
  const hub = createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connectClient(wsUrl, "client-thread-gap-a");
    wsA.send(JSON.stringify({
      clientId: "client-thread-gap-a",
      portId: "port-thread-gap-a",
      threadId: "thread-gap",
      type: "app-host-connect",
    }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-connected");
    const relayA = relays.find((relay) => relay.clientId === "client-thread-gap-a");
    assert.ok(relayA);

    // 队列最多保留两条；发送四条后，threadSeq=2 之前的增量已经无法完整补齐。
    for (let index = 1; index <= 4; index += 1) {
      relayA.onMessage(JSON.stringify({ id: `rpc-gap-${index}`, method: "thread/read", result: { threadId: "thread-gap", turnId: `turn-${index}` } }));
      await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === index);
    }

    wsB = await connectClient(wsUrl, "client-thread-gap-b");
    const replayMessagesPromise = wsMessages(wsB, (message) => message.type === "app-host-port-message" && message.replay === "thread", 2);
    wsB.send(JSON.stringify({
      clientId: "client-thread-gap-b",
      lastThreadSeq: 1,
      portId: "port-thread-gap-b",
      threadId: "thread-gap",
      type: "app-host-connect",
    }));
    const [replay, secondReplay] = await replayMessagesPromise;
    assert.equal(replay.replayGap, true);
    assert.equal(replay.threadSeq, 3);
    assert.equal(secondReplay.replayGap, true);
    assert.equal(secondReplay.threadSeq, 4);

    const snapshot = hub.snapshotThreads({ threadId: "thread-gap" }).threads[0];
    assert.equal(snapshot.oldestThreadSeq, 3);
    assert.equal(snapshot.latestThreadSeq, 4);
    assert.equal(snapshot.lastThreadReplayGap, true);
    assert.equal(snapshot.missedByTransport, 3);
    assert.equal(snapshot.repairedByThreadReplay, 2);
    assert.equal(snapshot.repairedBySnapshot, 0);

    relayA.onMessage(JSON.stringify({ id: "rpc-gap-5", method: "thread/read", result: { threadId: "thread-gap", turnId: "turn-5" } }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === 5);
    const nudgeReplayPromise = wsMessage(wsB, (message) => message.type === "app-host-port-message" && message.replay === "thread");
    const nudgePromise = wsMessage(wsB, (message) => message.type === "opencodex:sync-nudge");
    hub.sendToThread(
      "thread-gap",
      {
        type: "opencodex:sync-nudge",
        reason: "thread-detail-snapshot",
        threadId: "thread-gap",
      },
      { excludedClientId: "client-thread-gap-a", suppressDiagnostic: true }
    );

    const nudgeReplay = await nudgeReplayPromise;
    const nudge = await nudgePromise;
    assert.equal(nudgeReplay.threadSeq, 5);
    assert.equal(nudgeReplay.replayGap, false);
    assert.equal(nudge.replaySent, 1);
    assert.equal(nudge.replayGap, false);
    const repairedSnapshot = hub.snapshotThreads({ threadId: "thread-gap" }).threads[0];
    assert.equal(repairedSnapshot.repairedByThreadReplay, 3);
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
    if (oldMaxMessages == null) {
      delete process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES;
    } else {
      process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES = oldMaxMessages;
    }
    delete require.cache[require.resolve(wsHubPath)];
  }
});

test("ws hub marks replay gap when a client has no cursor and retained thread frames start late", async () => {
  const wsHubPath = path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs");
  const oldMaxMessages = process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES;
  process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES = "2";
  delete require.cache[require.resolve(wsHubPath)];
  const { createWsHub } = require(wsHubPath);
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const relays = [];
  const hub = createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connectClient(wsUrl, "client-thread-nocursor-a");
    wsA.send(JSON.stringify({
      clientId: "client-thread-nocursor-a",
      portId: "port-thread-nocursor-a",
      threadId: "thread-nocursor",
      type: "app-host-connect",
    }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-connected");
    const relayA = relays.find((relay) => relay.clientId === "client-thread-nocursor-a");
    assert.ok(relayA);

    // 新客户端没有本地 cursor 时，如果队列已经只剩后半段，也必须标记缺口让前端触发快照补偿。
    for (let index = 1; index <= 4; index += 1) {
      relayA.onMessage(JSON.stringify({ id: `rpc-nocursor-${index}`, method: "thread/read", result: { threadId: "thread-nocursor", turnId: `turn-${index}` } }));
      await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === index);
    }

    wsB = await connectClient(wsUrl, "client-thread-nocursor-b");
    const replayMessagesPromise = wsMessages(wsB, (message) => message.type === "app-host-port-message" && message.replay === "thread", 2);
    wsB.send(JSON.stringify({
      clientId: "client-thread-nocursor-b",
      portId: "port-thread-nocursor-b",
      threadId: "thread-nocursor",
      type: "app-host-connect",
    }));

    const [replay, secondReplay] = await replayMessagesPromise;
    assert.equal(replay.replayGap, true);
    assert.equal(replay.threadSeq, 3);
    assert.equal(secondReplay.replayGap, true);
    assert.equal(secondReplay.threadSeq, 4);

    const snapshot = hub.snapshotThreads({ threadId: "thread-nocursor" }).threads[0];
    assert.equal(snapshot.oldestThreadSeq, 3);
    assert.equal(snapshot.latestThreadSeq, 4);
    assert.equal(snapshot.latestKnownThreadSeq, 4);
    assert.equal(snapshot.lastThreadReplayCursor, 0);
    assert.equal(snapshot.lastThreadReplayOldestSeq, 3);
    assert.equal(snapshot.lastThreadReplayLatestKnownSeq, 4);
    assert.equal(snapshot.lastThreadReplayGap, true);
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
    if (oldMaxMessages == null) {
      delete process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES;
    } else {
      process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES = oldMaxMessages;
    }
    delete require.cache[require.resolve(wsHubPath)];
  }
});

test("ws hub marks replay gap when retained thread frames have expired", async () => {
  const wsHubPath = path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs");
  const oldTtlMs = process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_TTL_MS;
  process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_TTL_MS = "1";
  delete require.cache[require.resolve(wsHubPath)];
  const { createWsHub } = require(wsHubPath);
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const relays = [];
  const hub = createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connectClient(wsUrl, "client-thread-expired-a");
    wsA.send(JSON.stringify({
      clientId: "client-thread-expired-a",
      portId: "port-thread-expired-a",
      threadId: "thread-expired",
      type: "app-host-connect",
    }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-connected");
    const relayA = relays.find((relay) => relay.clientId === "client-thread-expired-a");
    assert.ok(relayA);

    relayA.onMessage(JSON.stringify({ id: "rpc-expired-1", method: "thread/read", result: { threadId: "thread-expired", turnId: "turn-1" } }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === 1);
    relayA.onMessage(JSON.stringify({ id: "rpc-expired-2", method: "thread/read", result: { threadId: "thread-expired", turnId: "turn-2" } }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    wsB = await connectClient(wsUrl, "client-thread-expired-b");
    wsB.send(JSON.stringify({
      clientId: "client-thread-expired-b",
      lastThreadSeq: 1,
      portId: "port-thread-expired-b",
      threadId: "thread-expired",
      type: "app-host-connect",
    }));
    await wsMessage(wsB, (message) => message.type === "app-host-port-connected");

    const nudgePromise = wsMessage(wsB, (message) => message.type === "opencodex:sync-nudge");
    hub.sendToThread(
      "thread-expired",
      {
        type: "opencodex:sync-nudge",
        reason: "thread-detail-snapshot",
        threadId: "thread-expired",
      },
      { excludedClientId: "client-thread-expired-a", suppressDiagnostic: true }
    );

    const nudge = await nudgePromise;
    assert.equal(nudge.replaySent, 0);
    assert.equal(nudge.replayGap, true);
    const snapshot = hub.snapshotThreads({ threadId: "thread-expired" }).threads[0];
    assert.equal(snapshot.cachedThreadFrameCount, 0);
    assert.equal(snapshot.latestKnownThreadSeq, 2);
    assert.equal(snapshot.latestThreadSeq, 0);
    assert.equal(snapshot.lastThreadReplayCursor, 1);
    assert.equal(snapshot.lastThreadReplayLatestKnownSeq, 2);
    assert.equal(snapshot.lastThreadReplayOldestSeq, 0);
    assert.equal(snapshot.lastThreadReplayGap, true);
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
    if (oldTtlMs == null) {
      delete process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_TTL_MS;
    } else {
      process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_TTL_MS = oldTtlMs;
    }
    delete require.cache[require.resolve(wsHubPath)];
  }
});

test("ws lifecycle marks app-host thread clients inactive on disconnect", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");

  // WebSocket 断开时只把 client 标成 inactive，不清掉历史 thread 参与者，后续才能做多端补偿判断。
  assert.match(wsHubSource, /markAppHostClientInactive\(appHostFrameState, closedClientId\)/);
  assert.match(wsHubSource, /markAppHostClientInactive\(appHostFrameState, erroredClientId\)/);
});

test("ws hub can target active clients for a single app-host thread", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");

  // 多端同步应尽量只发给正在看同一 thread 的活跃客户端，避免无关页面收到刷新提示。
  assert.match(wsHubSource, /appHostThreadStateSnapshot/);
  assert.match(wsHubSource, /function sendToThread/);
  assert.match(wsHubSource, /function snapshotThreads/);
  assert.match(wsHubSource, /activeClientIds/);
  assert.match(wsHubSource, /return \{ broadcast, broadcastExcept, clients, closeAllAppHostRelays, hasClient, sendTo, sendToThread, snapshotThreads \}/);
});

test("ws hub exposes a Socket.IO transport beside raw websocket fallback", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  // 成熟传输层由 Socket.IO 承担连接恢复和 room/ack 语义；raw /ws 保留为兼容回退。
  assert.equal(typeof packageJson.dependencies["socket.io"], "string");
  assert.match(wsHubSource, /require\("socket\.io"\)/);
  assert.match(wsHubSource, /connectionStateRecovery/);
  assert.match(wsHubSource, /function attachSocketIoTransport/);
  assert.match(wsHubSource, /url\.pathname !== "\/ws"/);
});

test("socket.io transport accepts the existing gateway json protocol", async () => {
  const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");
  const { snapshotFlowState } = require("../runtime/core/flow-monitor.cjs");
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const hub = createWsHub(server, {
    createAppHostRelay() {
      throw new Error("not used");
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const client = createSocketIoClient(`http://127.0.0.1:${address.port}`, {
    path: "/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });

  try {
    await once(client, "connect");
    const helloAckPromise = once(client, "message");
    client.emit("message", { type: "hello", clientId: "client-socketio" });
    const [helloAckRaw] = await helloAckPromise;
    const helloAck = JSON.parse(String(helloAckRaw));
    assert.equal(helloAck.type, "hello-ack");
    assert.equal(helloAck.clientId, "client-socketio");
    assert.equal(helloAck.transport, "socket.io");
    assert.equal(typeof helloAck.socketId, "string");
    assert.equal(helloAck.recovered, false);
    assert.equal(hub.hasClient("client-socketio"), true);
    const flow = snapshotFlowState({ clientId: "client-socketio" });
    assert.equal(flow.connection.transport, "socket.io");
    assert.equal(flow.connection.recovered, false);
    assert.equal(flow.connection.socketId, helloAck.socketId);

    const targetedPromise = once(client, "message");
    assert.equal(hub.sendTo("client-socketio", { type: "socketio-targeted", value: 1 }), true);
    const [targetedRaw] = await targetedPromise;
    assert.deepEqual(JSON.parse(String(targetedRaw)), { type: "socketio-targeted", value: 1 });
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("socket.io thread rooms target active thread clients while raw websocket remains a fallback", async () => {
  const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const hub = createWsHub(server, {
    createAppHostRelay() {
      return {
        close() {},
        postMessage() {},
      };
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const socketIoUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const socketA = createSocketIoClient(socketIoUrl, {
    path: "/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  const socketB = createSocketIoClient(socketIoUrl, {
    path: "/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  let rawClient = null;

  async function socketIoJsonMessage(socket, predicate) {
    while (true) {
      const [raw] = await once(socket, "message");
      const message = JSON.parse(String(raw));
      if (!predicate || predicate(message)) return message;
    }
  }

  async function helloSocketIo(socket, clientId) {
    await once(socket, "connect");
    socket.emit("message", { type: "hello", clientId });
    return socketIoJsonMessage(socket, (message) => message.type === "hello-ack" && message.clientId === clientId);
  }

  async function connectSocketIoAppHost(socket, clientId, portId, threadId) {
    socket.emit("message", { type: "app-host-connect", clientId, portId, threadId });
    return socketIoJsonMessage(socket, (message) => message.type === "app-host-port-connected" && message.portId === portId);
  }

  try {
    await Promise.all([
      helloSocketIo(socketA, "client-room-a"),
      helloSocketIo(socketB, "client-room-b"),
    ]);
    await Promise.all([
      connectSocketIoAppHost(socketA, "client-room-a", "port-room-a", "thread-room"),
      connectSocketIoAppHost(socketB, "client-room-b", "port-room-b", "thread-room"),
    ]);

    rawClient = await connectClient(wsUrl, "client-room-raw");
    rawClient.send(JSON.stringify({
      type: "app-host-connect",
      clientId: "client-room-raw",
      portId: "port-room-raw",
      threadId: "thread-room",
    }));
    await wsMessage(rawClient, (message) => message.type === "app-host-port-connected" && message.portId === "port-room-raw");

    const socketAMessage = socketIoJsonMessage(socketA, (message) => message.type === "room-nudge");
    const socketBMessage = socketIoJsonMessage(socketB, (message) => message.type === "room-nudge");
    const rawMessage = wsMessage(rawClient, (message) => message.type === "room-nudge");

    assert.equal(hub.sendToThread("thread-room", { type: "room-nudge", value: 1 }, { suppressDiagnostic: true }), 3);
    assert.deepEqual(await socketAMessage, { type: "room-nudge", value: 1 });
    assert.deepEqual(await socketBMessage, { type: "room-nudge", value: 1 });
    assert.deepEqual(await rawMessage, { type: "room-nudge", value: 1 });
  } finally {
    socketA.close();
    socketB.close();
    if (rawClient) rawClient.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ws hub records fast sync snapshot acknowledgements per app-host thread", async () => {
  const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const hub = createWsHub(server, {
    createAppHostRelay() {
      throw new Error("not used");
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let ws = null;

  try {
    ws = await connectClient(wsUrl, "client-snapshot-ws");
    ws.send(JSON.stringify({
      capturedAtMs: 1780000002000,
      clientId: "client-snapshot-ws",
      key: "snapshot-key-ws",
      method: "thread/read",
      source: "gateway-memory",
      threadId: "thread-snapshot-ws",
      type: "opencodex:fast-sync-snapshot-ack",
    }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    const snapshot = hub.snapshotThreads({ threadId: "thread-snapshot-ws" });
    assert.equal(snapshot.threads.length, 1);
    assert.equal(snapshot.threads[0].snapshotAckCount, 1);
    assert.equal(snapshot.threads[0].lastSnapshotAckClientId, "client-snapshot-ws");
    assert.equal(snapshot.threads[0].lastSnapshotAckMethod, "thread/read");
    assert.equal(snapshot.threads[0].lastSnapshotAckSource, "gateway-memory");
  } finally {
    if (ws) ws.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ws hub replays cached app-host thread frames before snapshot nudge reload", async () => {
  const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const relays = [];
  const hub = createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connectClient(wsUrl, "client-nudge-source");
    wsB = await connectClient(wsUrl, "client-nudge-target");
    wsA.send(JSON.stringify({
      clientId: "client-nudge-source",
      portId: "port-nudge-source",
      threadId: "thread-nudge-replay",
      type: "app-host-connect",
    }));
    wsB.send(JSON.stringify({
      clientId: "client-nudge-target",
      portId: "port-nudge-target",
      threadId: "thread-nudge-replay",
      type: "app-host-connect",
    }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-connected");
    await wsMessage(wsB, (message) => message.type === "app-host-port-connected");

    const relayA = relays.find((relay) => relay.clientId === "client-nudge-source");
    assert.ok(relayA);
    relayA.onMessage(JSON.stringify({ id: "rpc-nudge-replay", method: "thread/read", result: { threadId: "thread-nudge-replay", turnId: "turn-new" } }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === 1);
    const beforeNudge = hub.snapshotThreads({ threadId: "thread-nudge-replay" }).threads[0];
    assert.equal(beforeNudge.cachedThreadFrameCount, 1);
    assert.equal(beforeNudge.oldestThreadSeq, 1);
    assert.equal(beforeNudge.latestThreadSeq, 1);
    assert.ok(beforeNudge.latestThreadFrameAtMs > 0);

    const replayPromise = wsMessage(wsB, (message) => message.type === "app-host-port-message" && message.replay === "thread");
    const nudgePromise = wsMessage(wsB, (message) => message.type === "opencodex:sync-nudge");
    hub.sendToThread(
      "thread-nudge-replay",
      {
        type: "opencodex:sync-nudge",
        reason: "thread-detail-snapshot",
        threadId: "thread-nudge-replay",
      },
      { excludedClientId: "client-nudge-source", suppressDiagnostic: true }
    );

    const replay = await replayPromise;
    const nudge = await nudgePromise;

    assert.equal(replay.threadSeq, 1);
    assert.match(replay.data, /turn-new/);
    assert.equal(nudge.replaySent, 1);
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ws hub advances client thread cursor from gateway snapshot acknowledgements", async () => {
  const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const relays = [];
  const hub = createWsHub(server, {
    createAppHostRelay(details) {
      const relay = {
        clientId: details.clientId,
        close() {},
        onMessage: details.onMessage,
        portId: details.portId,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    isAuthed: () => true,
  });
  const address = await listen(server);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  let wsA = null;
  let wsB = null;

  try {
    wsA = await connectClient(wsUrl, "client-snapshot-cursor-source");
    wsB = await connectClient(wsUrl, "client-snapshot-cursor-target");
    wsA.send(JSON.stringify({
      clientId: "client-snapshot-cursor-source",
      portId: "port-snapshot-cursor-source",
      threadId: "thread-snapshot-cursor",
      type: "app-host-connect",
    }));
    wsB.send(JSON.stringify({
      clientId: "client-snapshot-cursor-target",
      portId: "port-snapshot-cursor-target",
      threadId: "thread-snapshot-cursor",
      type: "app-host-connect",
    }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-connected");
    await wsMessage(wsB, (message) => message.type === "app-host-port-connected");

    const relayA = relays.find((relay) => relay.clientId === "client-snapshot-cursor-source");
    assert.ok(relayA);
    for (let index = 1; index <= 4; index += 1) {
      relayA.onMessage(JSON.stringify({ id: `rpc-snapshot-cursor-${index}`, method: "thread/read", result: { threadId: "thread-snapshot-cursor", turnId: `turn-${index}` } }));
      await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === index);
    }

    // B 通过 gateway 全量快照补到了 seq4；ack 应把该客户端的 replay cursor 同步到中间层。
    wsB.send(JSON.stringify({
      capturedAtMs: Date.now(),
      clientId: "client-snapshot-cursor-target",
      key: "snapshot-cursor-key",
      method: "thread/read",
      source: "gateway-memory",
      threadId: "thread-snapshot-cursor",
      threadSeq: 4,
      type: "opencodex:fast-sync-snapshot-ack",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A 如果随后 ack 一个更低水位，不能把 B 的 per-client 快照水位覆盖掉。
    wsA.send(JSON.stringify({
      capturedAtMs: Date.now(),
      clientId: "client-snapshot-cursor-source",
      key: "snapshot-cursor-source-key",
      method: "thread/read",
      source: "gateway-memory",
      threadId: "thread-snapshot-cursor",
      threadSeq: 2,
      type: "opencodex:fast-sync-snapshot-ack",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    relayA.onMessage(JSON.stringify({ id: "rpc-snapshot-cursor-5", method: "thread/read", result: { threadId: "thread-snapshot-cursor", turnId: "turn-5" } }));
    await wsMessage(wsA, (message) => message.type === "app-host-port-message" && message.threadSeq === 5);

    const replayPromise = wsMessage(wsB, (message) => message.type === "app-host-port-message" && message.replay === "thread");
    const nudgePromise = wsMessage(wsB, (message) => message.type === "opencodex:sync-nudge");
    hub.sendToThread(
      "thread-snapshot-cursor",
      {
        type: "opencodex:sync-nudge",
        reason: "thread-detail-snapshot",
        threadId: "thread-snapshot-cursor",
      },
      { excludedClientId: "client-snapshot-cursor-source", suppressDiagnostic: true }
    );

    const replay = await replayPromise;
    const nudge = await nudgePromise;
    assert.equal(replay.threadSeq, 5);
    assert.match(replay.data, /turn-5/);
    assert.equal(nudge.replaySent, 1);

    const snapshot = hub.snapshotThreads({ threadId: "thread-snapshot-cursor" }).threads[0];
    assert.equal(snapshot.lastSnapshotAckThreadSeq, 2);
    assert.deepEqual(snapshot.snapshotAckThreadSeqByClientId, {
      "client-snapshot-cursor-target": 4,
      "client-snapshot-cursor-source": 2,
    });
    assert.ok(Array.isArray(snapshot.clientWatermarks));
    assert.deepEqual(snapshot.clientWatermarks.find((entry) => entry.clientId === "client-snapshot-cursor-target"), {
      clientId: "client-snapshot-cursor-target",
      portIds: ["port-snapshot-cursor-target"],
      snapshotAckThreadSeq: 4,
      threadCursor: 5,
    });
    assert.deepEqual(snapshot.clientWatermarks.find((entry) => entry.clientId === "client-snapshot-cursor-source"), {
      clientId: "client-snapshot-cursor-source",
      portIds: ["port-snapshot-cursor-source"],
      snapshotAckThreadSeq: 2,
      threadCursor: 5,
    });
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
