# Multi Client State Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make desktop, phone, and additional browser clients enter the same Codex conversation smoothly by letting the OpenCodex gateway maintain thread snapshots, incremental app-host frames, and per-client watermarks.

**Architecture:** The gateway becomes a lightweight state coordinator, not a raw remote-desktop tunnel. Official runtime responses write memory-only full-state snapshots with a `threadSeq` watermark, app-host downstream frames form a bounded per-thread incremental log, and every browser client owns its own snapshot ack watermark plus app-host replay cursor. Reconnect first tries continuous incremental replay; when retained frames are incomplete, the browser falls back to the gateway memory snapshot and acks that snapshot so later nudges only send newer increments.

**Tech Stack:** Node.js CommonJS gateway modules, Electron official runtime IPC interception, browser JavaScript polyfill in `web-shell/codex-bridge-polyfill.js`, in-memory fast-sync snapshots, WebSocket app-host bridge, Node built-in test runner.

---

## Why This Exists

The official Codex desktop app runs renderer UI and runtime locally, so `thread/read`, `thread/turns/list`, app-host MessagePort events, and model/tool status travel on a stable local IPC path. OpenCodex moves the renderer into remote browsers and phones, so WebSocket loss, high latency, reloads, and multiple clients can drop incremental app-host events. If the gateway only forwards bytes, clients either show blank history until a new message arrives, or reload too much full state.

The fix is to keep protocol state in the gateway:

- Full-state snapshots answer "what does this thread look like up to seq N?"
- Incremental app-host frames answer "what changed after seq N?"
- Per-client cursors answer "what has this specific browser/phone already consumed?"
- Gap detection answers "can I replay increments, or must I force snapshot repair?"

## Current Completed Work

- [x] Gateway observes app-host frames and stores sanitized thread state in `gateway/runtime/ipc/app-host-frame-observer.cjs`.
- [x] Gateway assigns per-thread `threadSeq` to official-to-browser app-host frames in `gateway/runtime/ipc/ws-hub.cjs`.
- [x] Browser stores `lastThreadSeq` per thread in `sessionStorage` and reports it on `app-host-connect`.
- [x] Gateway replays retained per-thread frames on reconnect and marks `replayGap` when a client cursor is older than the retained queue.
- [x] Gateway exposes memory snapshots for `thread/read` and `thread/turns/list`.
- [x] Memory snapshots include the `threadSeq` watermark they cover.
- [x] Browser includes `threadSeq` in `opencodex:fast-sync-snapshot-ack`.
- [x] Snapshot ack advances active gateway replay cursors for that client.
- [x] Diagnostics expose `clientWatermarks`.
- [x] Browser exposes repair decisions so we can tell whether it chose replay or snapshot fallback.

## Remaining Gap

`lastSnapshotAckThreadSeq` is still a thread-level "last ack wins" diagnostic. With two clients, client A can ack seq 2 after client B acked seq 4, and diagnostics will incorrectly make B look like it has no snapshot watermark. Multi-client state must keep snapshot ack watermarks per client.

The transport layer is also still too hand-rolled. Raw `ws` works, but OpenCodex currently owns reconnect backoff, hello routing, missed-message buffering, targeted delivery, and some replay behavior directly in `ws-hub.cjs`. Future work should prefer a mature transport framework for connection lifecycle and packet recovery, while keeping only Codex-specific state translation in OpenCodex.

## Mature Transport Direction

Preferred direction: run Socket.IO beside the existing `/ws` endpoint first, then migrate browser clients once parity is proven.

- Socket.IO handles connection lifecycle, ping/pong, reconnect, rooms, event acks, and connection state recovery.
- OpenCodex keeps the Codex-specific protocol: `threadSeq`, memory snapshot watermarks, app-host MessagePort relay, and sanitized diagnostics.
- Raw `/ws` remains as a compatibility fallback until the browser transport adapter proves stable on desktop and phone.

### Why Not CRDT or Local-first DB Here

Yjs, Automerge, Replicache, ElectricSQL, and PowerSync are mature, but they expect us to own the application data model. OpenCodex is proxying the official Codex renderer/runtime protocol, where important state arrives as app-host RPC frames and official thread snapshots. The reusable part is transport reliability, not the whole state model.

### Socket.IO Migration Plan

1. Add Socket.IO server dependency and mount it on the same HTTP server.
2. Normalize raw WS sockets and Socket.IO sockets behind a small JSON transport adapter.
3. Keep existing message payloads unchanged: `hello`, `ipc-invoke`, `app-host-connect`, `app-host-port-message`, `opencodex:fast-sync-snapshot-ack`, and diagnostics.
4. Use Socket.IO rooms for `clientId` and eventually `threadId`.
5. Enable connection state recovery so short mobile disconnects can receive missed packets from Socket.IO before falling back to OpenCodex `threadSeq` replay.
6. Keep OpenCodex replay/snapshot repair as the authoritative semantic fallback, because Socket.IO packet recovery cannot reconstruct official state after retention gaps or process restarts.

## Target Protocol

### App-host Incremental Frame

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

### Fast-sync Snapshot

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

`threadSeq` means this full-state snapshot includes all official app-host downstream changes up to that gateway-observed thread sequence.

### Snapshot Ack

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

Gateway uses this ack in two places:

- Advance all active app-host ports for `client-b` on `thread-1` to seq 42.
- Store `snapshotAckThreadSeqByClientId["client-b"] = 42` for diagnostics and future repair decisions.

### Diagnostics Shape

```json
{
  "threadId": "thread-1",
  "latestKnownThreadSeq": 45,
  "snapshotAckThreadSeqByClientId": {
    "client-a": 2,
    "client-b": 42
  },
  "clientWatermarks": [
    {
      "clientId": "client-a",
      "portIds": ["port-a"],
      "snapshotAckThreadSeq": 2,
      "threadCursor": 45
    },
    {
      "clientId": "client-b",
      "portIds": ["port-b"],
      "snapshotAckThreadSeq": 42,
      "threadCursor": 45
    }
  ]
}
```

## File Map

- Modify `gateway/runtime/ipc/app-host-frame-observer.cjs`
  - Add `snapshotAckThreadSeqByClientId: Map`.
  - Write per-client snapshot ack seq on every ack.
  - Project the map as a JSON-safe object in `appHostThreadStateSnapshot()`.
- Modify `gateway/runtime/ipc/ws-hub.cjs`
  - Read `snapshotAckThreadSeqByClientId` when building `clientWatermarks`.
  - Stop deriving client snapshot watermark from the thread-level `lastSnapshotAckClientId`.
- Modify `gateway/test/app-host-frame-observer.test.cjs`
  - Add observer-level assertions for per-client ack seqs.
  - Extend WebSocket replay test so A and B ack different seqs and diagnostics keep both.
- Modify `docs/STATUS-FLOW-MONITORING.md`
  - Document per-client ack watermarks after implementation.

---

### Task 7: Per-client Snapshot Ack Watermarks

**Files:**
- Modify: `gateway/runtime/ipc/app-host-frame-observer.cjs`
- Modify: `gateway/runtime/ipc/ws-hub.cjs`
- Modify: `gateway/test/app-host-frame-observer.test.cjs`
- Modify: `docs/STATUS-FLOW-MONITORING.md`

- [ ] **Step 1: Write the failing observer test**

Update `thread state records per-client snapshot acknowledgements` in `gateway/test/app-host-frame-observer.test.cjs` so client A acks seq 4 and client B acks seq 9:

```js
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

assert.deepEqual(snapshot.snapshotAckThreadSeqByClientId, {
  "client-snapshot-a": 4,
  "client-snapshot-b": 9,
});
```

- [ ] **Step 2: Write the failing multi-client hub test**

Extend `ws hub advances client thread cursor from gateway snapshot acknowledgements`:

```js
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

assert.deepEqual(snapshot.snapshotAckThreadSeqByClientId, {
  "client-snapshot-cursor-target": 4,
  "client-snapshot-cursor-source": 2,
});
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
```

- [ ] **Step 3: Verify the tests fail**

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
```

Expected: FAIL because `snapshotAckThreadSeqByClientId` does not exist and `clientWatermarks` still use the last thread-level ack.

- [ ] **Step 4: Implement observer storage**

In `ensureThreadState()` add:

```js
snapshotAckThreadSeqByClientId: new Map(),
```

In `recordAppHostThreadSnapshotAck()` add:

```js
const snapshotAckThreadSeq = Math.max(0, Number(details.threadSeq) || 0);
if (clientId) {
  // 每个浏览器/手机客户端都有自己的快照水位，不能用 thread 级最后一次 ack 覆盖。
  thread.snapshotAckThreadSeqByClientId.set(clientId, snapshotAckThreadSeq);
}
thread.lastSnapshotAckThreadSeq = snapshotAckThreadSeq;
trimMap(thread.snapshotAckThreadSeqByClientId, state.maxEntries);
```

In `appHostThreadStateSnapshot()` add:

```js
snapshotAckThreadSeqByClientId: Object.fromEntries(thread.snapshotAckThreadSeqByClientId.entries()),
```

- [ ] **Step 5: Implement diagnostics projection**

In `appHostThreadClientWatermarks()` in `gateway/runtime/ipc/ws-hub.cjs`, replace the last-ack comparison with per-client lookup:

```js
const snapshotAckThreadSeqByClientId =
  thread && thread.snapshotAckThreadSeqByClientId && typeof thread.snapshotAckThreadSeqByClientId === "object"
    ? thread.snapshotAckThreadSeqByClientId
    : {};

return activeClientPorts.map((entry) => {
  const portIds = Array.isArray(entry && entry.portIds) ? entry.portIds : [];
  const cursors = portIds.map((portId) => rememberedAppHostThreadCursor(entry.clientId, portId, thread.threadId));
  return {
    clientId: entry.clientId,
    portIds,
    snapshotAckThreadSeq: Math.max(0, Number(snapshotAckThreadSeqByClientId[entry.clientId]) || 0),
    threadCursor: Math.max(0, ...cursors),
  };
});
```

- [ ] **Step 6: Document the diagnostic rule**

Add to `docs/STATUS-FLOW-MONITORING.md`:

```md
`snapshotAckThreadSeqByClientId` 是按客户端保存的全量快照消费水位；`lastSnapshotAckThreadSeq` 只表示最近一次 ack 事件，不能用于判断其它客户端是否落后。
```

- [ ] **Step 7: Verify and commit**

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
rtk node -c gateway/runtime/ipc/app-host-frame-observer.cjs
rtk node -c gateway/runtime/ipc/ws-hub.cjs
rtk pnpm test
rtk git diff --check
rtk git add docs/superpowers/plans/2026-07-01-multi-client-state-sync.md docs/STATUS-FLOW-MONITORING.md gateway/runtime/ipc/app-host-frame-observer.cjs gateway/runtime/ipc/ws-hub.cjs gateway/test/app-host-frame-observer.test.cjs
rtk git commit -m "feat(runtime): track snapshot ack watermarks per client"
```

Expected: targeted test, syntax checks, full suite, and whitespace check pass.

## Self Review

Spec coverage:

- Multi-client smooth access is covered by replay cursors, snapshot acks, and per-client diagnostics.
- Gateway-maintained full-state is covered by memory snapshots and snapshot ack protocol.
- Missing-content repair is covered by `replayGap`, browser snapshot fallback, and ack-based cursor advancement.
- Different client state management is covered by `snapshotAckThreadSeqByClientId` and `clientWatermarks`.

Placeholder scan:

- No task uses TBD/TODO placeholders.
- Code-changing steps include exact files, snippets, commands, and expected outcomes.

Type consistency:

- `threadSeq` is the single watermark field across cache, snapshot HTTP response, browser ack, gateway ack handler, diagnostics, and tests.
- `lastSnapshotAckThreadSeq` is event-level diagnostic state.
- `snapshotAckThreadSeqByClientId` is per-client diagnostic and repair state.
- `clientWatermarks[].threadCursor` is derived from gateway replay cursor state and does not duplicate frame bodies.
