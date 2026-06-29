# Weak Network Fast Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCodex usable faster on weak networks by showing cached conversation state quickly and making user sends appear immediately as pending while the real app-server submission catches up.

**Architecture:** Add a focused gateway snapshot cache for safe read-only thread/config data, a browser-side snapshot/pending queue helper in the web shell, and thin hooks in `codex-bridge-polyfill.js` to serve snapshots before fresh app-server data arrives. Official app-server responses remain the source of truth and overwrite stale snapshots.

**Tech Stack:** Node.js CommonJS gateway modules, browser JavaScript in `web-shell`, Node built-in test runner, existing `flow-monitor` diagnostics, existing WebSocket/HTTP IPC bridge.

---

## File Structure

- Create `gateway/runtime/core/fast-sync-cache.cjs`
  - Owns gateway disk snapshot read/write, cacheable method allowlist, key hashing, expiry, and sensitive field trimming.
- Create `gateway/test/fast-sync-cache.test.cjs`
  - Tests cache keys, expiry, atomic recovery, and disallowing write methods.
- Modify `gateway/runtime/ipc/official-runtime.cjs`
  - Records successful official read-only responses into `fast-sync-cache`.
  - Serves stale snapshots only for approved first-screen methods when app-server is slow or unavailable.
  - Records flow events for snapshot hit/miss/fresh.
- Modify `gateway/runtime/server.cjs`
  - Adds authenticated `GET /api/fast-sync/snapshot` for browser-side early snapshot reads.
- Create `web-shell/opencodex-fast-sync.js`
  - Owns IndexedDB/localStorage snapshot store and pending send queue helpers.
- Modify `web-shell/index.html`
  - Loads `opencodex-fast-sync.js` before `codex-bridge-polyfill.js`.
- Modify `web-shell/codex-bridge-polyfill.js`
  - Uses browser snapshots before official IPC for `thread/list`, `thread/read`, and `thread/turns/list`.
  - Stores fresh responses back to browser snapshots.
  - Creates pending user messages for sends and flushes them once WS/app-server are ready.
- Modify `package.json`
  - Adds `gateway/test/fast-sync-cache.test.cjs` to `pnpm test`.

---

### Task 1: Gateway Fast Sync Cache Module

**Files:**
- Create: `gateway/runtime/core/fast-sync-cache.cjs`
- Create: `gateway/test/fast-sync-cache.test.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Create `gateway/test/fast-sync-cache.test.cjs`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
} = require("../runtime/core/fast-sync-cache.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-fast-sync-test-"));
}

test("allows only first-screen read methods", () => {
  assert.equal(isFastSyncCacheableMethod("thread/list"), true);
  assert.equal(isFastSyncCacheableMethod("thread/read"), true);
  assert.equal(isFastSyncCacheableMethod("thread/turns/list"), true);
  assert.equal(isFastSyncCacheableMethod("config/read"), true);
  assert.equal(isFastSyncCacheableMethod("model/list"), true);
  assert.equal(isFastSyncCacheableMethod("plugin/list"), false);
  assert.equal(isFastSyncCacheableMethod("turn/start"), false);
});

test("cache keys ignore volatile request ids", () => {
  const first = cacheKeyForSnapshot("thread/read", [{ id: "a", threadId: "t1" }]);
  const second = cacheKeyForSnapshot("thread/read", [{ id: "b", threadId: "t1" }]);
  assert.equal(first, second);
});

test("writes and reads a snapshot from disk", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: 60_000 });
  const key = cacheKeyForSnapshot("thread/read", [{ threadId: "t1" }]);
  cache.writeSnapshot({ key, method: "thread/read", value: { threadId: "t1", title: "Hello" } });
  assert.deepEqual(cache.readSnapshot({ key })?.value, { threadId: "t1", title: "Hello" });
});

test("expired snapshots are ignored", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: 1 });
  const key = cacheKeyForSnapshot("thread/list", []);
  cache.writeSnapshot({ key, method: "thread/list", value: { items: [] }, capturedAtMs: Date.now() - 10_000 });
  assert.equal(cache.readSnapshot({ key }), null);
});

test("corrupt snapshots are deleted and treated as missing", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: 60_000 });
  const key = cacheKeyForSnapshot("thread/read", [{ threadId: "t1" }]);
  fs.writeFileSync(cache.filePathForKey(key), "{not-json", "utf8");
  assert.equal(cache.readSnapshot({ key }), null);
  assert.equal(fs.existsSync(cache.filePathForKey(key)), false);
});
```

Update `package.json` test script:

```json
"test": "node --test gateway/test/auth-rate-limit.test.cjs gateway/test/http-utils.test.cjs gateway/test/fast-sync-cache.test.cjs launcher/test/log-writer.test.cjs"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk pnpm test
```

Expected: FAIL because `gateway/runtime/core/fast-sync-cache.cjs` does not exist.

- [ ] **Step 3: Implement the cache module**

Create `gateway/runtime/core/fast-sync-cache.cjs`:

```js
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = Number(process.env.OPENCODEX_FAST_SYNC_CACHE_TTL_MS || 10 * 60 * 1000);
const CACHEABLE_METHODS = new Set([
  "account/read",
  "config/read",
  "model/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stablePart(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stablePart(item, seen));
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "id" || key === "requestId") continue;
    result[key] = stablePart(value[key], seen);
  }
  return result;
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text)).digest("base64url");
}

function isFastSyncCacheableMethod(method) {
  return CACHEABLE_METHODS.has(String(method || ""));
}

function cacheKeyForSnapshot(method, args) {
  return hashText(JSON.stringify({ method, args: stablePart(args || []) }));
}

function safeClone(value) {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function createFastSyncCache(options = {}) {
  const dir = options.dir || path.join(process.cwd(), ".data", "runtime", "cache", "fast-sync");
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);

  function filePathForKey(key) {
    return path.join(dir, `${hashText(key)}.json`);
  }

  function readSnapshot({ key }) {
    const filePath = filePathForKey(key);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      const capturedAtMs = Number(parsed.capturedAtMs) || 0;
      if (capturedAtMs <= 0 || Date.now() - capturedAtMs > ttlMs) return null;
      return {
        capturedAtMs,
        key: parsed.key,
        method: parsed.method,
        source: "gateway-disk",
        value: safeClone(parsed.value),
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
      return null;
    }
  }

  function writeSnapshot({ capturedAtMs = Date.now(), key, method, value }) {
    if (!key || !isFastSyncCacheableMethod(method)) return false;
    ensureDir(dir);
    const filePath = filePathForKey(key);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    // 快照写入采用临时文件再 rename，避免 gateway 重启或弱网中断时留下半截 JSON。
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ capturedAtMs, key, method, schemaVersion: 1, value: safeClone(value) }),
      "utf8"
    );
    fs.renameSync(tmpPath, filePath);
    return true;
  }

  return { filePathForKey, readSnapshot, writeSnapshot };
}

module.exports = {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk pnpm test
```

Expected: PASS all tests.

- [ ] **Step 5: Commit**

```bash
rtk git add gateway/runtime/core/fast-sync-cache.cjs gateway/test/fast-sync-cache.test.cjs package.json
rtk git commit -m "feat(gateway): add fast sync snapshot cache"
```

---

### Task 2: Gateway Snapshot Recording and API

**Files:**
- Modify: `gateway/runtime/ipc/official-runtime.cjs`
- Modify: `gateway/runtime/server.cjs`
- Test: `gateway/test/fast-sync-cache.test.cjs`

- [ ] **Step 1: Extend the tests for request-shaped cache keys**

Append to `gateway/test/fast-sync-cache.test.cjs`:

```js
test("request-shaped thread cache keys are stable", () => {
  const first = cacheKeyForSnapshot("thread/turns/list", [{ request: { id: "1", params: { threadId: "t1" } } }]);
  const second = cacheKeyForSnapshot("thread/turns/list", [{ request: { id: "2", params: { threadId: "t1" } } }]);
  assert.equal(first, second);
});
```

- [ ] **Step 2: Run test to verify current cache behavior**

Run:

```bash
rtk node --test gateway/test/fast-sync-cache.test.cjs
```

Expected: PASS. This guards the key behavior before wiring it into runtime.

- [ ] **Step 3: Wire recording into official runtime**

In `gateway/runtime/ipc/official-runtime.cjs`, import the cache:

```js
const {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
} = require("../core/fast-sync-cache.cjs");
```

Near the runtime cache constants, add:

```js
const fastSyncCache = createFastSyncCache({
  dir: path.join(RUNTIME_DIR, "cache", "fast-sync"),
});
```

Add helpers near existing read-only app-server helpers:

```js
function fastSyncMethodFromRequestSummary(requestSummary) {
  return requestSummary && typeof requestSummary.method === "string" ? requestSummary.method : "";
}

function rememberFastSyncSnapshot(channel, args, requestSummary, responseValue, context = {}) {
  const method = fastSyncMethodFromRequestSummary(requestSummary);
  if (!isFastSyncCacheableMethod(method)) return;
  const key = cacheKeyForSnapshot(method, args);
  if (!fastSyncCache.writeSnapshot({ key, method, value: responseValue })) return;
  recordFlowEvent({
    clientId: context.clientId || "",
    hint: "已写入 gateway 快照",
    method,
    scope: "thread",
    stage: "gateway_snapshot_store",
    threadId: requestSummary.threadId || "",
  });
}
```

Where app-server successful responses are routed, after obtaining the success value and before resolving to the browser, call:

```js
rememberFastSyncSnapshot(channel, invokeArgs, requestSummary, value, context);
```

Use the local variable names already present in the target function. If the response route function only has `args`, compute `requestSummary` with the same `incomingIpcDiagnosticSummary(channel, invokeArgs)` helper already used by `invokeOfficialIpc`.

- [ ] **Step 4: Add the API endpoint**

In `gateway/runtime/server.cjs`, import cache helpers:

```js
const {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
} = require("./core/fast-sync-cache.cjs");
```

Create the cache near `createGateway()` setup:

```js
const fastSyncCache = createFastSyncCache({
  dir: path.join(RUNTIME_DIR, "cache", "fast-sync"),
});
```

Add a handler before generic static handling:

```js
if (pathname === "/api/fast-sync/snapshot" && req.method === "GET") {
  const method = parsedUrl.searchParams.get("method") || "";
  const argsJson = parsedUrl.searchParams.get("args") || "[]";
  if (!isFastSyncCacheableMethod(method)) {
    return sendJson(res, 400, { ok: false, error: "Method is not fast-sync cacheable" }, { "cache-control": "no-store" });
  }
  let args = [];
  try {
    args = JSON.parse(argsJson);
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid args JSON" }, { "cache-control": "no-store" });
  }
  const key = cacheKeyForSnapshot(method, args);
  const snapshot = fastSyncCache.readSnapshot({ key });
  return sendJson(res, 200, { ok: true, snapshot }, { "cache-control": "no-store" });
}
```

Use existing `parsedUrl`, `sendJson`, and auth gate patterns in the file. If `RUNTIME_DIR` is not imported in `server.cjs`, import it from `./core/config.cjs` next to existing config imports.

- [ ] **Step 5: Run checks**

Run:

```bash
rtk node --check gateway/runtime/ipc/official-runtime.cjs
rtk node --check gateway/runtime/server.cjs
rtk pnpm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
rtk git add gateway/runtime/ipc/official-runtime.cjs gateway/runtime/server.cjs gateway/test/fast-sync-cache.test.cjs
rtk git commit -m "feat(gateway): expose fast sync snapshots"
```

---

### Task 3: Browser Snapshot Store

**Files:**
- Create: `web-shell/opencodex-fast-sync.js`
- Modify: `web-shell/index.html`

- [ ] **Step 1: Create the browser helper**

Create `web-shell/opencodex-fast-sync.js`:

```js
(function () {
  const DB_NAME = "opencodex-fast-sync";
  const DB_VERSION = 1;
  const SNAPSHOT_STORE = "snapshots";
  const PENDING_STORE = "pendingSends";
  const LOCAL_STORAGE_PREFIX = "opencodex_fast_sync:";

  function hostKey() {
    return `${location.protocol}//${location.host}`;
  }

  function snapshotKey(method, args) {
    return `${hostKey()}:${method}:${JSON.stringify(args || [])}`;
  }

  function openDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(PENDING_STORE)) db.createObjectStore(PENDING_STORE, { keyPath: "localSendId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  async function withStore(storeName, mode, callback) {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = callback(store);
      tx.oncomplete = () => resolve(result && "result" in result ? result.result : result);
      tx.onerror = () => resolve(null);
    });
  }

  async function getSnapshot(method, args) {
    const key = snapshotKey(method, args);
    const fromDb = await withStore(SNAPSHOT_STORE, "readonly", (store) => store.get(key));
    if (fromDb) return fromDb;
    try {
      const raw = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function putSnapshot(method, args, value, source = "browser") {
    const key = snapshotKey(method, args);
    const snapshot = {
      capturedAtMs: Date.now(),
      key,
      method,
      schemaVersion: 1,
      source,
      sourceHost: hostKey(),
      value,
    };
    const wrote = await withStore(SNAPSHOT_STORE, "readwrite", (store) => store.put(snapshot));
    if (wrote === null) {
      try {
        localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${key}`, JSON.stringify(snapshot));
      } catch {}
    }
    return snapshot;
  }

  async function createPendingSend(payload) {
    const localSendId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pending = {
      ...payload,
      createdAtMs: Date.now(),
      localSendId,
      sourceHost: hostKey(),
      status: "pending",
    };
    await withStore(PENDING_STORE, "readwrite", (store) => store.put(pending));
    return pending;
  }

  async function updatePendingSend(localSendId, patch) {
    const current = await withStore(PENDING_STORE, "readonly", (store) => store.get(localSendId));
    if (!current) return null;
    const next = { ...current, ...patch, updatedAtMs: Date.now() };
    await withStore(PENDING_STORE, "readwrite", (store) => store.put(next));
    return next;
  }

  async function listPendingSends(threadId) {
    const db = await openDb();
    if (!db) return [];
    return await new Promise((resolve) => {
      const tx = db.transaction(PENDING_STORE, "readonly");
      const store = tx.objectStore(PENDING_STORE);
      const result = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        if (!threadId || item.value.threadId === threadId) result.push(item.value);
        item.continue();
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => resolve([]);
    });
  }

  window.__opencodexFastSync = {
    createPendingSend,
    getSnapshot,
    listPendingSends,
    putSnapshot,
    snapshotKey,
    updatePendingSend,
  };
})();
```

- [ ] **Step 2: Load it before the polyfill**

In `web-shell/index.html`, add this script before `codex-bridge-polyfill.js` is loaded:

```html
<script src="/opencodex-fast-sync.js"></script>
```

If `codex-bridge-polyfill.js` is injected dynamically by gateway HTML patching instead of a literal script tag, add `/opencodex-fast-sync.js` to the same injection block immediately before the polyfill script.

- [ ] **Step 3: Run syntax checks**

Run:

```bash
rtk node --check web-shell/opencodex-fast-sync.js
rtk pnpm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
rtk git add web-shell/opencodex-fast-sync.js web-shell/index.html
rtk git commit -m "feat(web): add fast sync browser store"
```

---

### Task 4: Snapshot Reads and Writes in the Polyfill

**Files:**
- Modify: `web-shell/codex-bridge-polyfill.js`

- [ ] **Step 1: Add method allowlist helpers**

Near existing `READ_ONLY_APP_SERVER_METHODS`, add:

```js
const FAST_SYNC_METHODS = new Set([
  "account/read",
  "config/read",
  "model/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
]);

function isFastSyncMethod(method) {
  return FAST_SYNC_METHODS.has(String(method || ""));
}
```

- [ ] **Step 2: Add gateway snapshot fetch helper**

Near `invokeReadOnlyAppServerCached`, add:

```js
async function readGatewayFastSyncSnapshot(method, ipcArgs) {
  if (!isFastSyncMethod(method)) return null;
  const url = new URL("/api/fast-sync/snapshot", location.origin);
  url.searchParams.set("method", method);
  url.searchParams.set("args", JSON.stringify(ipcArgs || []));
  try {
    const response = await w.fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: gatewayAuthHeaders({ accept: "application/json" }),
    });
    if (!response.ok) return null;
    const json = await response.json();
    return json && json.snapshot ? json.snapshot : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Add browser snapshot read/store helpers**

Add:

```js
async function readBrowserFastSyncSnapshot(method, ipcArgs) {
  if (!isFastSyncMethod(method)) return null;
  const store = w.__opencodexFastSync;
  if (!store || typeof store.getSnapshot !== "function") return null;
  try {
    return await store.getSnapshot(method, ipcArgs || []);
  } catch {
    return null;
  }
}

async function storeBrowserFastSyncSnapshot(method, ipcArgs, value, source) {
  if (!isFastSyncMethod(method)) return;
  const store = w.__opencodexFastSync;
  if (!store || typeof store.putSnapshot !== "function") return;
  try {
    await store.putSnapshot(method, ipcArgs || [], value, source);
  } catch {}
}
```

- [ ] **Step 4: Serve snapshots before fresh IPC for first-screen methods**

In `invokeGateway(channel, args)`, after computing `method` with `appServerMethod(payload)` and before `invokeReadOnlyAppServerCached`, add:

```js
const fastSyncMethod = appServerMethod(payload);
if (isFastSyncMethod(fastSyncMethod)) {
  const browserSnapshot = await readBrowserFastSyncSnapshot(fastSyncMethod, ipcArgs);
  if (browserSnapshot && browserSnapshot.value != null) {
    clientDiagnostic("fast-sync-browser-snapshot-hit", {
      ...diagnosticSummary,
      method: fastSyncMethod,
    });
    // 先异步请求新鲜数据并回写快照；当前调用立即返回本地快照，保证首屏先可见。
    invokeGatewayImmediate(channel, ipcArgs, payload)
      .then((freshValue) => storeBrowserFastSyncSnapshot(fastSyncMethod, ipcArgs, freshValue, "official-fresh"))
      .catch(() => {});
    return clonePlainPayload(browserSnapshot.value);
  }
  const gatewaySnapshot = await readGatewayFastSyncSnapshot(fastSyncMethod, ipcArgs);
  if (gatewaySnapshot && gatewaySnapshot.value != null) {
    clientDiagnostic("fast-sync-gateway-snapshot-hit", {
      ...diagnosticSummary,
      method: fastSyncMethod,
    });
    storeBrowserFastSyncSnapshot(fastSyncMethod, ipcArgs, gatewaySnapshot.value, "gateway-disk");
    invokeGatewayImmediate(channel, ipcArgs, payload)
      .then((freshValue) => storeBrowserFastSyncSnapshot(fastSyncMethod, ipcArgs, freshValue, "official-fresh"))
      .catch(() => {});
    return clonePlainPayload(gatewaySnapshot.value);
  }
}
```

Keep the fresh request fire-and-forget for Task 4. Task 5 will add flow events and conflict handling. Do not apply this branch to `plugin/list` or write methods.

- [ ] **Step 5: Store fresh responses for cacheable methods**

In `invokeGatewayImmediate`, wrap successful `value` returns so fresh official values are stored:

```js
const value = await existingInvokeLogic();
const method = appServerMethod(payload);
if (isFastSyncMethod(method)) {
  void storeBrowserFastSyncSnapshot(method, ipcArgs, value, "official-fresh");
}
return value;
```

If the function currently has multiple return points, refactor minimally by assigning the final result to `value` just before each success return. Add Chinese comments at each non-obvious branch explaining whether the value is stale or fresh.

- [ ] **Step 6: Run checks**

Run:

```bash
rtk node --check web-shell/codex-bridge-polyfill.js
rtk pnpm test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
rtk git add web-shell/codex-bridge-polyfill.js
rtk git commit -m "feat(polyfill): hydrate from fast sync snapshots"
```

---

### Task 5: Pending Send Queue and Flow Events

**Files:**
- Modify: `web-shell/codex-bridge-polyfill.js`
- Modify: `gateway/runtime/core/flow-monitor.cjs`
- Modify: `gateway/runtime/ipc/ws-hub.cjs`
- Test: `gateway/test/fast-sync-cache.test.cjs`

- [ ] **Step 1: Add flow event local dispatch helper in polyfill**

Add near `clientDiagnostic` helpers:

```js
function recordFastSyncFlow(stage, extra = {}) {
  clientDiagnostic("fast-sync-flow", {
    stage,
    ...extra,
  });
}
```

- [ ] **Step 2: Detect send methods**

Add near `appServerMethod`:

```js
function isTurnStartMethod(method) {
  return method === "turn/start" || method === "thread/turn/start";
}
```

- [ ] **Step 3: Create pending send before network submission**

In `invokeGateway(channel, args)`, after `const payload = payloadFromIpcArgs(ipcArgs);` and before waiting for WS, add:

```js
const methodForPending = appServerMethod(payload);
if (isTurnStartMethod(methodForPending)) {
  const threadId =
    payload?.threadId ||
    payload?.params?.threadId ||
    payload?.request?.params?.threadId ||
    "";
  const pending = await w.__opencodexFastSync?.createPendingSend?.({
    args: clonePlainPayload(ipcArgs),
    method: methodForPending,
    threadId,
  });
  if (pending) {
    recordFastSyncFlow("send_pending_created", {
      localSendId: pending.localSendId,
      method: methodForPending,
      threadId,
    });
  }
}
```

This step records the pending item but does not yet render a custom message bubble. Rendering integration depends on official renderer state and is handled by the next task after observing payload shape.

- [ ] **Step 4: Mark pending flushed and accepted**

In the success path of `invokeGatewayImmediate`, when `method` is a turn start method, add:

```js
if (isTurnStartMethod(method)) {
  recordFastSyncFlow("send_turn_accepted", { method });
}
```

In the catch path for turn start errors, add:

```js
if (isTurnStartMethod(appServerMethod(payload))) {
  recordFastSyncFlow("send_pending_failed", {
    error: error instanceof Error ? error.message : String(error),
    method: appServerMethod(payload),
  });
}
```

- [ ] **Step 5: Extend flow monitor event shape**

In `gateway/runtime/core/flow-monitor.cjs`, add optional `localSendId` to `normalizeEvent`:

```js
localSendId: boundedText(input && input.localSendId, 120),
```

In `recordFlowEvent`, when `event.scope === "turn"` include:

```js
localSendId: event.localSendId || "",
```

- [ ] **Step 6: Bridge fast-sync diagnostics to flow monitor**

In `gateway/runtime/ipc/ws-hub.cjs`, wherever browser diagnostics are received and parsed, add:

```js
if (payload && payload.type === "client-diagnostic" && payload.name === "fast-sync-flow") {
  recordFlowEvent({
    clientId: socketClientId(ws),
    error: payload.error || "",
    hint: payload.hint || "",
    localSendId: payload.localSendId || "",
    method: payload.method || "",
    scope: payload.stage && String(payload.stage).startsWith("send_") ? "turn" : "thread",
    stage: payload.stage || "fast_sync",
    threadId: payload.threadId || "",
  });
}
```

Use the actual diagnostic payload variable name in `ws-hub.cjs`; keep the logic close to existing client diagnostic handling.

- [ ] **Step 7: Run checks**

Run:

```bash
rtk node --check web-shell/codex-bridge-polyfill.js
rtk node --check gateway/runtime/core/flow-monitor.cjs
rtk node --check gateway/runtime/ipc/ws-hub.cjs
rtk pnpm test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
rtk git add web-shell/codex-bridge-polyfill.js gateway/runtime/core/flow-monitor.cjs gateway/runtime/ipc/ws-hub.cjs
rtk git commit -m "feat(polyfill): track pending sends"
```

---

### Task 6: Manual Weak-Network Verification

**Files:**
- Modify only if verification reveals a bug.

- [ ] **Step 1: Restart gateway**

Run:

```bash
rtk launchctl kickstart -k gui/$(id -u)/dev.opencodex.gateway
rtk sleep 4
rtk launchctl print gui/$(id -u)/dev.opencodex.gateway | rtk rg 'state =|pid ='
```

Expected: `state = running` and a current `pid`.

- [ ] **Step 2: Verify static checks**

Run:

```bash
rtk pnpm test
rtk git status --short --branch
```

Expected: tests pass. Working tree should only contain intentional files or unrelated user files.

- [ ] **Step 3: Verify browser-client safety remains intact**

Run:

```bash
rtk sed -n '1,8p' /Users/hechengjun.9/.codex/plugins/cache/openai-bundled/browser/26.623.61825/scripts/browser-client.mjs
```

Expected: output contains:

```text
"BROWSER_USE_AVAILABLE_BACKENDS":"chrome"
```

- [ ] **Step 4: Verify snapshot API**

Open an existing OpenCodex page once so fresh data can be cached. Then run:

```bash
rtk curl -s 'http://127.0.0.1:3737/api/fast-sync/snapshot?method=thread/list&args=[]' | rtk head -c 500
```

Expected: JSON with `"ok":true`. `snapshot` may be `null` before the first successful official `thread/list`, and non-null after the page has loaded once.

- [ ] **Step 5: Verify flow diagnostics**

Run:

```bash
rtk curl -s 'http://127.0.0.1:3737/api/diagnostics/flow' | rtk head -c 1200
```

Expected: JSON includes recent flow events. After sending a message, it should include `send_pending_created` and either `send_turn_accepted` or `send_pending_failed`.

- [ ] **Step 6: Commit any verification fixes**

If verification required code changes:

```bash
rtk git add gateway/runtime/core/fast-sync-cache.cjs gateway/runtime/ipc/official-runtime.cjs gateway/runtime/server.cjs web-shell/opencodex-fast-sync.js web-shell/index.html web-shell/codex-bridge-polyfill.js gateway/runtime/core/flow-monitor.cjs gateway/runtime/ipc/ws-hub.cjs package.json gateway/test/fast-sync-cache.test.cjs
rtk git commit -m "fix(gateway): stabilize fast sync verification"
```

If no changes were needed, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: first-screen snapshots are covered by Tasks 1-4; pending send tracking is covered by Task 5; flow-monitor visibility is covered by Tasks 5-6; non-goals are preserved by the method allowlist and excluding `plugin/list`/`turn/start` from read caches.
- Placeholder scan: this plan intentionally contains no placeholder markers or unspecified test commands.
- Type consistency: `cacheKeyForSnapshot`, `createFastSyncCache`, `isFastSyncCacheableMethod`, `localSendId`, and snapshot field names are defined before use and reused consistently.
