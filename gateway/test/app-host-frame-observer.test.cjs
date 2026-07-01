const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  appHostStateContext,
  createAppHostFrameState,
  observeAppHostFrame,
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

test("app-host downstream replay protocol is wired on gateway and browser sides", () => {
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");
  const polyfillSource = fs.readFileSync(path.join(repoRoot, "web-shell", "codex-bridge-polyfill.js"), "utf8");

  // Gateway 给 official->browser app-host 帧编号并缓存，客户端重连时按 lastServerSeq 只补缺失帧。
  assert.match(wsHubSource, /APP_HOST_DOWNSTREAM_REPLAY_TTL_MS/);
  assert.match(wsHubSource, /rememberAppHostDownstreamFrame\(clientId, portId, data\)/);
  assert.match(wsHubSource, /flushAppHostDownstreamReplay\(ws, clientId, portId, lastServerSeq\)/);
  assert.match(wsHubSource, /type: "app-host-port-message", portId, data, seq/);

  // 浏览器端记录已收到的 seq，重连 connect 时带回游标，并丢弃重复补发帧。
  assert.match(polyfillSource, /lastServerSeq: 0/);
  assert.match(polyfillSource, /result\.lastServerSeq = Number\(state\.lastServerSeq \|\| 0\)/);
  assert.match(polyfillSource, /app-host-duplicate-server-frame/);
  assert.match(polyfillSource, /state\.lastServerSeq = serverSeq/);
});
