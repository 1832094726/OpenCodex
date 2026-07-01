const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { WebSocket } = require("ws");

const repoRoot = path.resolve(__dirname, "..");
const wsHubPath = path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function wsMessage(ws, predicate, timeoutMs = 1500) {
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

function wsMessages(ws, predicate, count, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} websocket messages`));
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

async function connectClient(wsUrl, clientId) {
  const ws = new WebSocket(wsUrl);
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "hello", clientId }));
  await wsMessage(ws, (message) => message.type === "hello-ack" && message.clientId === clientId);
  return ws;
}

async function closeClient(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  ws.close();
  try {
    await once(ws, "close");
  } catch {}
}

async function connectAppHost(ws, clientId, portId, threadId, extra = {}) {
  ws.send(JSON.stringify({
    clientId,
    portId,
    threadId,
    type: "app-host-connect",
    ...extra,
  }));
  return wsMessage(ws, (message) => message.type === "app-host-port-connected" && message.portId === portId);
}

function createHarness(options = {}) {
  const oldMaxMessages = process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES;
  if (options.maxReplayMessages != null) {
    process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES = String(options.maxReplayMessages);
  } else {
    delete process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES;
  }
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
  function restoreEnv() {
    if (oldMaxMessages == null) {
      delete process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES;
    } else {
      process.env.OPENCODEX_APP_HOST_DOWNSTREAM_REPLAY_MAX_MESSAGES = oldMaxMessages;
    }
    delete require.cache[require.resolve(wsHubPath)];
  }
  return { hub, relays, restoreEnv, server };
}

function relayFor(relays, clientId) {
  const relay = relays.find((entry) => entry.clientId === clientId);
  assert.ok(relay, `missing relay for ${clientId}`);
  return relay;
}

async function emitThreadFrame(relay, ws, threadId, seq) {
  relay.onMessage(JSON.stringify({
    id: `rpc-${threadId}-${seq}`,
    method: "thread/read",
    result: { threadId, turnId: `turn-${seq}` },
  }));
  return wsMessage(ws, (message) => message.type === "app-host-port-message" && message.threadSeq === seq);
}

async function withHarness(options, fn) {
  const harness = createHarness(options);
  const clients = new Set();
  try {
    const address = await listen(harness.server);
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
    const trackClient = async (clientId) => {
      const ws = await connectClient(wsUrl, clientId);
      clients.add(ws);
      return ws;
    };
    await fn({ ...harness, trackClient, wsUrl });
  } finally {
    for (const client of clients) await closeClient(client);
    await new Promise((resolve) => harness.server.close(resolve));
    harness.restoreEnv();
  }
}

async function verifyContinuousReplay() {
  await withHarness({}, async ({ relays, trackClient }) => {
    const threadId = "thread-continuous-recovery";
    const wsA = await trackClient("client-continuous-a");
    const wsB = await trackClient("client-continuous-b");
    await connectAppHost(wsA, "client-continuous-a", "port-continuous-a", threadId);
    await connectAppHost(wsB, "client-continuous-b", "port-continuous-b", threadId);
    const relayA = relayFor(relays, "client-continuous-a");

    await emitThreadFrame(relayA, wsA, threadId, 1);
    await closeClient(wsB);

    // B 离线期间 A 收到新 app-host 增量；B 重连时 cursor=1，队列连续，只应补 seq=2。
    await emitThreadFrame(relayA, wsA, threadId, 2);

    const wsB2 = await trackClient("client-continuous-b");
    wsB2.send(JSON.stringify({
      clientId: "client-continuous-b",
      lastThreadSeq: 1,
      portId: "port-continuous-b",
      threadId,
      type: "app-host-connect",
    }));
    const replay = await wsMessage(wsB2, (message) => message.type === "app-host-port-message" && message.replay === "thread");
    assert.equal(replay.threadSeq, 2);
    assert.equal(replay.replayGap, false);
    assert.match(replay.data, /turn-2/);
  });
}

async function verifyGapThenSnapshotAck() {
  await withHarness({ maxReplayMessages: 2 }, async ({ hub, relays, trackClient }) => {
    const threadId = "thread-gap-recovery";
    const wsA = await trackClient("client-gap-a");
    const wsB = await trackClient("client-gap-b");
    await connectAppHost(wsA, "client-gap-a", "port-gap-a", threadId);
    await connectAppHost(wsB, "client-gap-b", "port-gap-b", threadId);
    const relayA = relayFor(relays, "client-gap-a");

    await emitThreadFrame(relayA, wsA, threadId, 1);
    await closeClient(wsB);

    // 队列容量为 2；B 带 cursor=1 回来时，只剩 seq=4/5，必须标记 replayGap。
    for (let seq = 2; seq <= 5; seq += 1) {
      await emitThreadFrame(relayA, wsA, threadId, seq);
    }

    const wsB2 = await trackClient("client-gap-b");
    wsB2.send(JSON.stringify({
      clientId: "client-gap-b",
      lastThreadSeq: 1,
      portId: "port-gap-b",
      threadId,
      type: "app-host-connect",
    }));
    const [firstReplay, secondReplay] = await wsMessages(
      wsB2,
      (message) => message.type === "app-host-port-message" && message.replay === "thread",
      2
    );
    assert.equal(firstReplay.replayGap, true);
    assert.equal(firstReplay.threadSeq, 4);
    assert.equal(secondReplay.replayGap, true);
    assert.equal(secondReplay.threadSeq, 5);

    wsB2.send(JSON.stringify({
      capturedAtMs: Date.now(),
      clientId: "client-gap-b",
      key: "script-gap-snapshot",
      method: "thread/read",
      source: "gateway-memory",
      threadId,
      threadSeq: 5,
      type: "opencodex:fast-sync-snapshot-ack",
    }));

    const deadline = Date.now() + 1500;
    let snapshot = null;
    while (Date.now() < deadline) {
      snapshot = hub.snapshotThreads({ threadId }).threads[0];
      const watermark = snapshot.clientWatermarks.find((entry) => entry.clientId === "client-gap-b");
      if (watermark && watermark.threadCursor === 5 && watermark.snapshotAckThreadSeq === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const watermark = snapshot.clientWatermarks.find((entry) => entry.clientId === "client-gap-b");
    assert.equal(watermark.threadCursor, 5);
    assert.equal(watermark.snapshotAckThreadSeq, 5);
    assert.equal(snapshot.lastSnapshotAckThreadSeq, 5);
  });
}

async function main() {
  await verifyContinuousReplay();
  await verifyGapThenSnapshotAck();
  console.log("multi-client recovery checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
