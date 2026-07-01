# Multi Client State Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make desktop, phone, and additional browser clients enter the same Codex conversation smoothly by letting the OpenCodex gateway maintain thread full-state snapshots, incremental app-host frames, and per-client watermarks instead of forcing every reconnect to reload all official state.

**Architecture:** Treat the gateway as a thread state coordinator. Official runtime responses write memory-only full-state snapshots with a `threadSeq` watermark, app-host downstream frames form a bounded per-thread incremental log, and each browser client reports the highest full-state or incremental watermark it has consumed. On reconnect or cross-client nudge, gateway sends only the missing increments when continuous, and sends a snapshot fallback signal when a gap is detected.

**Tech Stack:** Node.js CommonJS gateway modules, Electron official runtime IPC interception, browser JavaScript polyfill in `web-shell/codex-bridge-polyfill.js`, in-memory fast-sync snapshots, WebSocket app-host bridge, Node built-in test runner.

---

## Current State

Implemented pieces already present in the repository:

- Gateway observes app-host frames with `summarizeAppHostFrame()` and tracks sanitized thread state in `gateway/runtime/ipc/app-host-frame-observer.cjs`.
- Gateway assigns per-thread `threadSeq` to official-to-browser app-host frames in `gateway/runtime/ipc/ws-hub.cjs`.
- Browser stores `lastThreadSeq` per thread in `sessionStorage` and sends it on `app-host-connect`.
- Gateway replays retained per-thread frames on reconnect and marks `replayGap` when the client cursor is older than the retained queue.
- Gateway exposes `/api/fast-sync/snapshot` and memory-only snapshots for `thread/read` and `thread/turns/list`.
- Browser preloads gateway snapshots after `replayGap` nudge and can consume snapshot hints across reload.

Known gaps that still make multi-client access feel remote-desktop-like or brittle:

- Snapshot acknowledgements record diagnostics but do not advance the client replay cursor.
- Memory snapshots do not include the `threadSeq` watermark they represent.
- Gateway diagnostics do not show a per-client matrix of `cursor`, `snapshotSeq`, `latestKnownSeq`, and `gap`.
- Browser reconnect logic has an implicit state machine spread across functions; it does not expose a single “continuous replay vs snapshot repair” decision.
- Tests cover individual replay paths, but not the full “client B catches up by snapshot, then receives only new increments” path.

## Target Protocol

### App-host incremental frame

Gateway sends retained or live app-host downstream frames:

```json
{
  "type": "app-host-port-message",
  "portId": "port-b",
  "data": "{\"id\":\"rpc\",\"result\":{}}",
  "threadId": "thread-1",
  "threadSeq": 42,
  "replay": "thread",
  "replayGap": false
}
```

Browser applies the frame to the official renderer MessagePort, then records `threadSeq=42` for that thread.

### Fast-sync snapshot

Gateway memory snapshot response includes a watermark:

```json
{
  "capturedAtMs": 1780000000000,
  "key": "snapshot-key",
  "method": "thread/read",
  "source": "gateway-memory",
  "threadId": "thread-1",
  "threadSeq": 42,
  "value": { "id": "thread-1" }
}
```

`threadSeq` means “this full-state snapshot includes all official app-host downstream changes up to this thread sequence known at capture time.”

### Snapshot ack

Browser sends an ack after consuming a memory snapshot:

```json
{
  "type": "opencodex:fast-sync-snapshot-ack",
  "clientId": "client-b",
  "capturedAtMs": 1780000000000,
  "key": "snapshot-key",
  "method": "thread/read",
  "source": "gateway-memory",
  "threadId": "thread-1",
  "threadSeq": 42
}
```

Gateway uses `threadSeq` to advance all active app-host ports for `client-b` on `thread-1`. This prevents the next nudge from replaying seq 1-42 again.

## File Structure

- Modify `gateway/runtime/core/fast-sync-cache.cjs`
  - Preserve optional `threadId` and `threadSeq` metadata on memory snapshots.
  - Keep persistent disk snapshots unchanged; thread details stay memory-only.
- Modify `gateway/test/fast-sync-cache.test.cjs`
  - Add tests for memory snapshot `threadSeq` metadata and thread-id latest lookup.
- Modify `gateway/runtime/ipc/official-runtime.cjs`
  - When writing a memory snapshot, read latest thread replay stats from `wsHub.snapshotThreads({ threadId })`.
  - Pass `threadSeq` into `memoryFastSyncCache.writeSnapshot()`.
- Modify `web-shell/codex-bridge-polyfill.js`
  - Include `snapshot.threadSeq` in `opencodex:fast-sync-snapshot-ack`.
  - Record the snapshot watermark in browser `sessionStorage` using the same `rememberAppHostThreadSeq()` path as app-host frames.
- Modify `gateway/runtime/ipc/app-host-frame-observer.cjs`
  - Store `lastSnapshotAckThreadSeq` for diagnostics.
- Modify `gateway/runtime/ipc/ws-hub.cjs`
  - On snapshot ack, update active client ports for that thread to the acknowledged `threadSeq`.
  - Include ack watermarks in `/api/diagnostics/threads`.
- Modify `gateway/test/app-host-frame-observer.test.cjs`
  - Add an end-to-end WebSocket test proving snapshot ack advances replay cursor.
- Modify `web-shell/test/codex-bridge-fast-sync.test.cjs`
  - Add source-level tests that snapshot ack sends `threadSeq` and gateway snapshot consumption updates browser thread cursor.

---

### Task 1: Snapshot Metadata Watermark

**Files:**
- Modify: `gateway/runtime/core/fast-sync-cache.cjs`
- Modify: `gateway/test/fast-sync-cache.test.cjs`

- [ ] **Step 1: Write the failing cache test**

Add this test after `memory snapshots keep the latest thread detail key by thread id` in `gateway/test/fast-sync-cache.test.cjs`:

```js
test("memory snapshots preserve thread sequence watermarks", () => {
  const cache = createMemoryFastSyncCache({ maxEntries: 20, ttlMs: 60_000 });

  assert.equal(
    cache.writeSnapshot({
      key: "watermark-key",
      method: "thread/read",
      threadId: "thread-watermark",
      threadSeq: 42,
      value: { id: "thread-watermark" },
    }),
    true
  );

  const byKey = cache.readSnapshot({ key: "watermark-key" });
  const byThread = cache.readSnapshot({ method: "thread/read", threadId: "thread-watermark" });
  assert.equal(byKey.threadId, "thread-watermark");
  assert.equal(byKey.threadSeq, 42);
  assert.equal(byThread.threadSeq, 42);
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
rtk node --test gateway/test/fast-sync-cache.test.cjs
```

Expected: FAIL because `threadSeq` is missing from the returned memory snapshot.

- [ ] **Step 3: Preserve metadata in memory snapshots**

In `gateway/runtime/core/fast-sync-cache.cjs`, update `createMemoryFastSyncCache()`:

```js
function readSnapshot({ key, method, threadId }) {
  const nowMs = Date.now();
  prune(nowMs);
  let resolvedKey = key;
  if (!resolvedKey && method && threadId) {
    // thread 详情快照需要支持“按会话取最新全量状态”，避免弱网重连时必须重建原始 IPC args。
    resolvedKey = keyByMethodThreadId.get(methodThreadKey(method, threadId)) || "";
  }
  if (!resolvedKey) return null;
  const entry = snapshots.get(resolvedKey);
  if (!entry || nowMs - entry.capturedAtMs > ttlMs) return null;
  return {
    capturedAtMs: entry.capturedAtMs,
    key: entry.key,
    method: entry.method,
    source: "gateway-memory",
    threadId: entry.threadId,
    threadSeq: Math.max(0, Number(entry.threadSeq) || 0),
    value: safeClone(entry.value),
  };
}

function writeSnapshot({ capturedAtMs = Date.now(), key, method, threadId = "", threadSeq = 0, value }) {
  if (!key || !isFastSyncMemoryCacheableMethod(method)) return false;
  try {
    // 详情快照只留在进程内，threadSeq 表示该全量状态覆盖到的 app-host 增量水位。
    snapshots.set(key, {
      capturedAtMs,
      key,
      method,
      threadId: typeof threadId === "string" ? threadId.slice(0, 160) : "",
      threadSeq: Math.max(0, Number(threadSeq) || 0),
      value: safeClone(value),
    });
    if (threadId) keyByMethodThreadId.set(methodThreadKey(method, threadId), key);
    prune(capturedAtMs);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Verify cache tests pass**

Run:

```bash
rtk node --test gateway/test/fast-sync-cache.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add gateway/runtime/core/fast-sync-cache.cjs gateway/test/fast-sync-cache.test.cjs
rtk git commit -m "feat(runtime): preserve thread snapshot watermarks"
```

---

### Task 2: Capture Latest ThreadSeq When Writing Snapshots

**Files:**
- Modify: `gateway/runtime/ipc/official-runtime.cjs`
- Modify: `gateway/test/official-runtime-noncritical.test.cjs`

- [ ] **Step 1: Write the failing source contract test**

Add assertions to the existing fast-sync snapshot test in `gateway/test/official-runtime-noncritical.test.cjs`:

```js
test("thread detail snapshots store latest app-host thread sequence", () => {
  const body = sourceBetween(
    source,
    "function rememberFastSyncSnapshot",
    "function notifyOtherClientsForThreadSnapshot"
  );

  assert.match(body, /const threadSeq = latestAppHostThreadSeqForSnapshot\(threadId\)/);
  assert.match(body, /cache\.writeSnapshot\(\{ key, method, threadId, threadSeq, value: responseValue \}\)/);
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
rtk node --test gateway/test/official-runtime-noncritical.test.cjs
```

Expected: FAIL because `latestAppHostThreadSeqForSnapshot()` does not exist.

- [ ] **Step 3: Add helper and write watermark**

Add this helper before `rememberFastSyncSnapshot()` in `gateway/runtime/ipc/official-runtime.cjs`:

```js
function latestAppHostThreadSeqForSnapshot(threadId) {
  if (!threadId || !wsHub || typeof wsHub.snapshotThreads !== "function") return 0;
  const snapshot = wsHub.snapshotThreads({ threadId, limit: 1 });
  const thread = snapshot && Array.isArray(snapshot.threads) ? snapshot.threads[0] : null;
  // 这里读取的是 gateway 已观察到的 app-host 下行最高水位，用来给全量快照标记覆盖范围。
  return Math.max(0, Number(thread && thread.latestKnownThreadSeq) || 0);
}
```

Update the write call inside `rememberFastSyncSnapshot()`:

```js
const threadSeq = latestAppHostThreadSeqForSnapshot(threadId);
const cache = isFastSyncCacheableMethod(method) ? fastSyncCache : memoryFastSyncCache;
if (!cache.writeSnapshot({ key, method, threadId, threadSeq, value: responseValue })) return;
```

- [ ] **Step 4: Verify official runtime test passes**

Run:

```bash
rtk node --test gateway/test/official-runtime-noncritical.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add gateway/runtime/ipc/official-runtime.cjs gateway/test/official-runtime-noncritical.test.cjs
rtk git commit -m "feat(runtime): tag thread snapshots with app-host watermarks"
```

---

### Task 3: Browser Ack Carries Snapshot Watermark

**Files:**
- Modify: `web-shell/codex-bridge-polyfill.js`
- Modify: `web-shell/test/codex-bridge-fast-sync.test.cjs`

- [ ] **Step 1: Write source contract tests**

Add to `web-shell/test/codex-bridge-fast-sync.test.cjs`:

```js
test("gateway snapshot acknowledgements include thread sequence watermarks", () => {
  const source = fs.readFileSync(path.join(repoRoot, "web-shell", "codex-bridge-polyfill.js"), "utf8");
  const body = sourceBetween(source, "function acknowledgeFastSyncSnapshotHit", "async function readBrowserFastSyncSnapshot");

  assert.match(body, /threadSeq: Math\.max\(0, Number\(snapshot\.threadSeq\) \|\| 0\)/);
  assert.match(body, /rememberAppHostThreadSeq\(threadId, snapshot\.threadSeq\)/);
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
```

Expected: FAIL because ack does not include `threadSeq`.

- [ ] **Step 3: Update browser ack**

In `acknowledgeFastSyncSnapshotHit()` add the watermark:

```js
const threadSeq = Math.max(0, Number(snapshot.threadSeq) || 0);
if (threadSeq > 0) rememberAppHostThreadSeq(threadId, threadSeq);
// ack 只回传快照水位，不回传 value，避免把会话正文作为诊断状态再传一遍。
sendGatewayControlPayload(
  {
    type: "opencodex:fast-sync-snapshot-ack",
    capturedAtMs: Number(snapshot.capturedAtMs || 0),
    key: typeof snapshot.key === "string" ? snapshot.key : "",
    method,
    source: typeof snapshot.source === "string" ? snapshot.source : "",
    threadId,
    threadSeq,
  },
  "fast-sync-snapshot-ack-send-failed"
);
```

- [ ] **Step 4: Verify browser test passes**

Run:

```bash
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add web-shell/codex-bridge-polyfill.js web-shell/test/codex-bridge-fast-sync.test.cjs
rtk git commit -m "feat(polyfill): acknowledge snapshot watermarks"
```

---

### Task 4: Snapshot Ack Advances Gateway Client Cursor

**Files:**
- Modify: `gateway/runtime/ipc/app-host-frame-observer.cjs`
- Modify: `gateway/runtime/ipc/ws-hub.cjs`
- Modify: `gateway/test/app-host-frame-observer.test.cjs`

- [ ] **Step 1: Write observer diagnostics test**

Extend `thread state records per-client snapshot acknowledgements` in `gateway/test/app-host-frame-observer.test.cjs`:

```js
recordAppHostThreadSnapshotAck(state, {
  capturedAtMs: 1780000002000,
  clientId: "client-snapshot-b",
  key: "snapshot-key-watermark",
  method: "thread/read",
  source: "gateway-memory",
  threadId: "thread-snapshot",
  threadSeq: 9,
});

const snapshot = appHostThreadStateSnapshot(state, "thread-snapshot");
assert.equal(snapshot.lastSnapshotAckThreadSeq, 9);
```

- [ ] **Step 2: Write WebSocket behavior test**

Add this test near the nudge replay tests in `gateway/test/app-host-frame-observer.test.cjs`:

```js
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
    await wsMessage(wsB, (message) => message.type === "flow-monitor-update");

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
    assert.equal(hub.snapshotThreads({ threadId: "thread-snapshot-cursor" }).threads[0].lastSnapshotAckThreadSeq, 4);
  } finally {
    if (wsA) wsA.close();
    if (wsB) wsB.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 3: Verify tests fail**

Run:

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
```

Expected: FAIL because `lastSnapshotAckThreadSeq` is missing and ack does not advance replay cursor.

- [ ] **Step 4: Store ack watermark in observer**

In `ensureThreadState()` add:

```js
lastSnapshotAckThreadSeq: 0,
```

In `recordAppHostThreadSnapshotAck()` add:

```js
thread.lastSnapshotAckThreadSeq = Math.max(0, Number(details.threadSeq) || 0);
```

In `appHostThreadStateSnapshot()` add:

```js
lastSnapshotAckThreadSeq: thread.lastSnapshotAckThreadSeq,
```

- [ ] **Step 5: Advance active port cursors in ws-hub**

Add this helper near `rememberedAppHostThreadCursor()` in `gateway/runtime/ipc/ws-hub.cjs`:

```js
function rememberAppHostThreadCursorForClientThread(clientId, threadId, threadSeq) {
  const seq = Math.max(0, Number(threadSeq) || 0);
  if (!clientId || !threadId || seq <= 0) return 0;
  const snapshot = appHostThreadStateSnapshot(appHostFrameState, threadId);
  const ports = snapshot && Array.isArray(snapshot.activeClientPorts)
    ? snapshot.activeClientPorts.find((entry) => entry && entry.clientId === clientId)
    : null;
  let touched = 0;
  for (const portId of ports && Array.isArray(ports.portIds) ? ports.portIds : []) {
    rememberAppHostThreadCursor(clientId, portId, threadId, seq);
    touched += 1;
  }
  return touched;
}
```

In `handleFastSyncSnapshotAckMessage()` parse and apply `threadSeq`:

```js
const threadSeq = Math.max(0, Number(message.threadSeq) || 0);
const advancedPortCount = rememberAppHostThreadCursorForClientThread(clientId, threadId, threadSeq);
const snapshot = recordAppHostThreadSnapshotAck(appHostFrameState, {
  capturedAtMs: message.capturedAtMs,
  clientId,
  key: typeof message.key === "string" ? message.key : "",
  method,
  source: typeof message.source === "string" ? message.source : "",
  threadId,
  threadSeq,
});
```

Extend the flow event:

```js
recordFlowEvent({
  clientId,
  hint: "浏览器已消费 gateway thread 快照，中间层记录客户端水位",
  method,
  scope: "thread",
  stage: "gateway_snapshot_ack",
  threadId,
  threadSeq,
  advancedPortCount,
});
```

- [ ] **Step 6: Verify app-host tests pass**

Run:

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add gateway/runtime/ipc/app-host-frame-observer.cjs gateway/runtime/ipc/ws-hub.cjs gateway/test/app-host-frame-observer.test.cjs
rtk git commit -m "feat(runtime): advance replay cursors from snapshot acks"
```

---

### Task 5: Diagnostics Matrix for Multi-Client State

**Files:**
- Modify: `gateway/runtime/ipc/ws-hub.cjs`
- Modify: `gateway/test/app-host-frame-observer.test.cjs`
- Modify: `docs/STATUS-FLOW-MONITORING.md`

- [ ] **Step 1: Write diagnostics test**

Add assertions to `ws hub advances client thread cursor from gateway snapshot acknowledgements`:

```js
const diagnostic = hub.snapshotThreads({ threadId: "thread-snapshot-cursor" }).threads[0];
assert.ok(Array.isArray(diagnostic.clientWatermarks));
assert.deepEqual(diagnostic.clientWatermarks.find((entry) => entry.clientId === "client-snapshot-cursor-target"), {
  clientId: "client-snapshot-cursor-target",
  portIds: ["port-snapshot-cursor-target"],
  threadCursor: 4,
  snapshotAckThreadSeq: 4,
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
```

Expected: FAIL because `clientWatermarks` is missing.

- [ ] **Step 3: Add diagnostic projection**

In `snapshotThreads()` enrich each thread:

```js
function appHostThreadClientWatermarks(thread) {
  const activeClientPorts = Array.isArray(thread && thread.activeClientPorts) ? thread.activeClientPorts : [];
  return activeClientPorts.map((entry) => {
    const portIds = Array.isArray(entry.portIds) ? entry.portIds : [];
    const cursors = portIds.map((portId) => rememberedAppHostThreadCursor(entry.clientId, portId, thread.threadId));
    return {
      clientId: entry.clientId,
      portIds,
      threadCursor: Math.max(0, ...cursors),
      snapshotAckThreadSeq: entry.clientId === thread.lastSnapshotAckClientId ? Number(thread.lastSnapshotAckThreadSeq || 0) : 0,
    };
  });
}

function snapshotThreads(options = {}) {
  const snapshot = listAppHostThreadStateSnapshots(appHostFrameState, options);
  const threads = snapshot.threads.map((thread) => ({
    ...thread,
    ...appHostThreadReplayStats(thread.threadId),
    clientWatermarks: appHostThreadClientWatermarks(thread),
  }));
  return {
    ok: true,
    ...snapshot,
    threads,
  };
}
```

- [ ] **Step 4: Document diagnostics output**

Append to `docs/STATUS-FLOW-MONITORING.md`:

```md
## 多客户端水位诊断

`GET /api/diagnostics/threads?threadId=<id>` 会返回 `clientWatermarks`：

- `threadCursor`：gateway 已认为该客户端端口消费到的 app-host threadSeq。
- `snapshotAckThreadSeq`：该客户端最近一次消费 gateway 全量快照的水位。
- `latestKnownThreadSeq`：gateway 当前观察到的 thread 最新下行水位。

排查规则：如果 `latestKnownThreadSeq > threadCursor` 且 replay 队列连续，gateway 只补增量；如果队列不连续，浏览器应读取 gateway memory snapshot 并发送 snapshot ack。
```

- [ ] **Step 5: Verify diagnostics tests pass**

Run:

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add gateway/runtime/ipc/ws-hub.cjs gateway/test/app-host-frame-observer.test.cjs docs/STATUS-FLOW-MONITORING.md
rtk git commit -m "feat(runtime): expose client sync watermarks"
```

---

### Task 6: Full Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run syntax checks**

```bash
rtk node -c gateway/runtime/core/fast-sync-cache.cjs
rtk node -c gateway/runtime/ipc/official-runtime.cjs
rtk node -c gateway/runtime/ipc/ws-hub.cjs
rtk node -c gateway/runtime/ipc/app-host-frame-observer.cjs
rtk node -c web-shell/codex-bridge-polyfill.js
```

Expected: all commands exit 0.

- [ ] **Step 2: Run targeted tests**

```bash
rtk node --test gateway/test/fast-sync-cache.test.cjs
rtk node --test gateway/test/official-runtime-noncritical.test.cjs
rtk node --test gateway/test/app-host-frame-observer.test.cjs
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
```

Expected: all targeted tests pass.

- [ ] **Step 3: Run full suite**

```bash
rtk pnpm test
```

Expected: all tests pass.

- [ ] **Step 4: Check whitespace and status**

```bash
rtk git diff --check
rtk git status --short
```

Expected: no whitespace errors; only intended files changed before each commit.

## Self Review

Spec coverage:

- Multi-client smooth access is covered by Task 4 and Task 5.
- Gateway-maintained full-state is covered by Task 1 and Task 2.
- Missing-content repair is covered by snapshot watermark, ack, and replay cursor advancement.
- Different client state management is covered by per-client active port cursor updates and `clientWatermarks`.

Placeholder scan:

- No task uses TBD/TODO placeholders.
- Each code-changing step includes exact files, snippets, commands, and expected outcomes.

Type consistency:

- `threadSeq` is the single watermark field across cache, snapshot HTTP response, browser ack, gateway ack handler, diagnostics, and tests.
- `lastSnapshotAckThreadSeq` is diagnostic-only state in `app-host-frame-observer`.
- `clientWatermarks[].threadCursor` is derived from gateway replay cursor state and does not duplicate frame bodies.
