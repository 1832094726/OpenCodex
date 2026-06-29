# Mobile Resume Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile foreground resume restore the OpenCodex WebSocket/app-host connection in place without automatically reloading the page, while keeping clear manual and automatic reconnect fallbacks.

**Architecture:** The existing browser bridge already owns WebSocket lifecycle, app-host relay restoration, and the network status widget. The implementation removes the mobile-only post-reconnect page reload path, replaces it with reconnect diagnostics, and keeps the existing forced WebSocket reconnect and status-panel controls as fallback.

**Tech Stack:** Plain browser JavaScript in `web-shell/codex-bridge-polyfill.js`, Node.js `node:test` source-level regression tests, pnpm test runner.

---

### Task 1: Add Mobile Resume No-Reload Regression Test

**Files:**
- Modify: `web-shell/test/codex-bridge-fast-sync.test.cjs`

- [ ] **Step 1: Add source helpers and failing assertions**

Add these tests near the existing source-level bridge tests in `web-shell/test/codex-bridge-fast-sync.test.cjs`:

```js
test("mobile resume reconnect does not automatically reload the page", () => {
  assert.doesNotMatch(
    bridgeSource,
    /mobileThreadReloadAfterReconnect|lastMobileThreadReloadAtMs|MOBILE_THREAD_RELOAD_COOLDOWN_MS|scheduleMobileThreadReloadAfterReconnect/
  );
  assert.doesNotMatch(bridgeSource, /location\.reload\(\)/);
  assert.match(bridgeSource, /mobile-resume-reconnect-without-reload/);
});

test("mobile foreground resume still forces a fresh websocket", () => {
  assert.match(bridgeSource, /MOBILE_WS_RESUME_RECONNECT_AFTER_MS/);
  assert.match(bridgeSource, /ensureGatewayWebSocket\(reason,\s*\{\s*force:\s*shouldRefreshMobileSocket\s*\}\)/);
});
```

These tests should fail before implementation because the bridge currently contains the mobile thread reload state and calls `location.reload()`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
```

Expected: failure in `mobile resume reconnect does not automatically reload the page`, showing the old reload symbols still exist.

- [ ] **Step 3: Do not commit yet**

Keep the failing test in the working tree for Task 2.

### Task 2: Replace Mobile Auto-Reload With In-Place Reconnect Diagnostics

**Files:**
- Modify: `web-shell/codex-bridge-polyfill.js`
- Test: `web-shell/test/codex-bridge-fast-sync.test.cjs`

- [ ] **Step 1: Remove mobile reload state**

In `web-shell/codex-bridge-polyfill.js`, remove these declarations near the WebSocket state:

```js
const MOBILE_THREAD_RELOAD_COOLDOWN_MS = 30000;
let mobileThreadReloadAfterReconnect = false;
let lastMobileThreadReloadAtMs = 0;
```

Keep:

```js
const MOBILE_WS_RESUME_RECONNECT_AFTER_MS = 5000;
let lastPageHiddenAtMs = 0;
```

- [ ] **Step 2: Replace the reload scheduler with a diagnostic helper**

Delete the existing `scheduleMobileThreadReloadAfterReconnect()` function. Add this helper in the same area:

```js
function markMobileResumeReconnectedWithoutReload() {
  if (!isMobileResumeSensitiveBrowser()) return;
  const route = currentRestorableRoute();
  if (!route) return;
  clientDiagnostic("mobile-resume-reconnect-without-reload", {
    route,
    wsReady,
    wsState: websocketStateName(ws),
  });
}
```

The Chinese implementation comment should explain that mobile foreground recovery now keeps renderer state in place and only records diagnostics after the bridge is ready.

- [ ] **Step 3: Call the new helper after WebSocket ready**

In `markGatewayWsReady()`, replace:

```js
scheduleMobileThreadReloadAfterReconnect();
```

with:

```js
markMobileResumeReconnectedWithoutReload();
```

Keep the existing calls to `reconnectAppHostRelays()`, `flushAllAppHostRelayMessages()`, `emitPersistedAtomSync()`, and the shared-object snapshot emissions.

- [ ] **Step 4: Remove the reload flag from resume hooks**

In `installGatewayWebSocketResumeHooks()`, replace this block:

```js
if (shouldRefreshMobileSocket && currentRestorableRoute()) {
  // 只有移动端长时间后台恢复时才允许刷新会话页，避免桌面短暂断线打断用户输入。
  mobileThreadReloadAfterReconnect = true;
}
ensureGatewayWebSocket(reason, { force: shouldRefreshMobileSocket });
```

with:

```js
if (shouldRefreshMobileSocket) {
  clientDiagnostic("mobile-resume-force-reconnect", {
    hiddenForMs,
    reason,
    route: currentRestorableRoute() || "",
    wsReady,
    wsState: websocketStateName(ws),
  });
}
ensureGatewayWebSocket(reason, { force: shouldRefreshMobileSocket });
```

The Chinese comment should state that mobile foreground recovery forces a fresh WS but leaves page reload as a manual fallback.

- [ ] **Step 5: Run focused tests**

Run:

```bash
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
```

Expected: all tests in this file pass, including the new no-reload test.

- [ ] **Step 6: Run syntax check**

Run:

```bash
rtk node --check web-shell/codex-bridge-polyfill.js
```

Expected: no output and exit code 0.

- [ ] **Step 7: Commit the implementation**

Run:

```bash
rtk git add web-shell/codex-bridge-polyfill.js web-shell/test/codex-bridge-fast-sync.test.cjs
rtk git commit -m "fix(polyfill): reconnect mobile resume without reload"
```

Expected: one focused commit with the bridge and test changes.

### Task 3: Full Verification and Gateway Restart

**Files:**
- No source files expected.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
rtk pnpm test
```

Expected: all tests pass.

- [ ] **Step 2: Restart the local Mac gateway**

Find the current listener:

```bash
rtk lsof -iTCP:3737 -sTCP:LISTEN -n -P
```

Terminate the listed PID:

```bash
rtk kill -TERM <PID>
```

Start OpenCodex again:

```bash
HOST=0.0.0.0 PORT=3737 OPENCODEX_GATEWAY_SERVICE_MODE=1 nohup bash ./start-opencodex-mac.sh > .data/logs/opencodex-manual-restart.log 2>&1 &
```

- [ ] **Step 3: Verify health**

Run:

```bash
rtk curl -sS http://127.0.0.1:3737/api/health
```

Expected: JSON with `"ok": true` and `"officialIpc": { "ready": true }`.

- [ ] **Step 4: Inspect final git state**

Run:

```bash
rtk git status --short --branch
```

Expected: no tracked implementation files modified. The pre-existing untracked `docs/REMOTE-DEPLOY-GUIDE.md` may still appear and should not be touched.
