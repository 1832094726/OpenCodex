const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  appHostStateContext,
  appHostThreadStateSnapshot,
  createAppHostFrameState,
  markAppHostClientInactive,
  observeAppHostFrame,
  recordAppHostThreadReplay,
  rememberAppHostThreadPort,
  summarizeAppHostFrame,
} = require("../runtime/ipc/app-host-frame-observer.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");

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
  assert.equal(missing, null);
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
});

test("app-host downstream replay protocol is wired on gateway and browser sides", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");
  const polyfillSource = fs.readFileSync(path.join(repoRoot, "web-shell", "codex-bridge-polyfill.js"), "utf8");

  // Gateway 给 official->browser app-host 帧编号并缓存，客户端重连时按 lastServerSeq 只补缺失帧。
  assert.match(wsHubSource, /APP_HOST_DOWNSTREAM_REPLAY_TTL_MS/);
  assert.match(wsHubSource, /rememberAppHostDownstreamFrame\(clientId, portId, data, frameSummary && frameSummary\.raw\)/);
  assert.match(wsHubSource, /flushAppHostDownstreamReplay\(ws, clientId, portId, lastServerSeq\)/);
  assert.match(wsHubSource, /type: "app-host-port-message", portId, data, seq/);

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
  assert.doesNotMatch(wsHubSource, /type: "app-host-port-message", portId, data: entry\.data, replay: "thread", seq/);

  // 浏览器 connect 帧携带当前路由 threadId；没有 per-port 游标的新客户端才能触发 thread replay。
  assert.match(polyfillSource, /function currentRouteThreadId/);
  assert.match(polyfillSource, /result\.threadId = currentRouteThreadId\(\)/);
  assert.match(wsHubSource, /lastServerSeq > 0[\s\S]*flushAppHostDownstreamReplay/);
  assert.match(wsHubSource, /flushAppHostThreadReplay\(ws, clientId, portId, routeThreadId\)/);
});

test("ws lifecycle marks app-host thread clients inactive on disconnect", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");

  // WebSocket 断开时只把 client 标成 inactive，不清掉历史 thread 参与者，后续才能做多端补偿判断。
  assert.match(wsHubSource, /markAppHostClientInactive\(appHostFrameState, closedClientId\)/);
  assert.match(wsHubSource, /markAppHostClientInactive\(appHostFrameState, erroredClientId\)/);
});
