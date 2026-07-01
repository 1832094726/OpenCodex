const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { WebSocket } = require("ws");

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
  });
  recordAppHostThreadSnapshotAck(state, {
    capturedAtMs: 1780000001000,
    clientId: "client-snapshot-b",
    key: "snapshot-key-other",
    method: "thread/turns/list",
    source: "gateway-memory",
    threadId: "thread-snapshot",
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

  // Gateway 额外按 threadId 索引官方下行帧，给新客户端接同一会话时补缺失增量。
  assert.match(wsHubSource, /appHostDownstreamFramesByThreadId/);
  assert.match(wsHubSource, /function flushAppHostThreadReplay/);
  assert.match(wsHubSource, /route: "app_host_thread_replay"/);
  assert.match(wsHubSource, /replay: "thread"/);
  assert.match(wsHubSource, /appHostDownstreamThreadSeqByThreadId/);
  assert.match(wsHubSource, /threadSeq = appHostThreadNextSeq\(threadId\)/);
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
