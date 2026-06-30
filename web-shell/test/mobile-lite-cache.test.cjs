const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const mobileSourcePath = path.join(repoRoot, "web-shell", "mobile.js");

function readMobileSource() {
  return fs.readFileSync(mobileSourcePath, "utf8");
}

test("mobile lite renders sessionStorage snapshots before network refresh", () => {
  const source = readMobileSource();

  for (const expected of [
    "MOBILE_CACHE_PREFIX",
    "MOBILE_CACHE_TTL_MS",
    "MOBILE_PERSISTENT_CACHE_TTL_MS",
    "readMobileCacheFrom(sessionStorage",
    "writeMobileCacheTo(sessionStorage",
    "localStorage",
    "renderBootstrapPayload(cached",
    "renderThreadPayload(threadId, cached",
    "已加载本地快照，正在刷新",
    "刷新失败，继续使用本地快照",
  ]) {
    assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("mobile lite cache stays scoped to trimmed mobile payloads", () => {
  const source = readMobileSource();

  assert.match(source, /两层缓存都只保存裁剪后的 mobile-lite DTO/);
  assert.match(source, /payload\.ok !== true/);
  assert.doesNotMatch(source, /plugin\/list|mcpServerStatus\/list|desktop-state/);
});

test("mobile lite keeps a short persistent cache for reloads under weak networks", () => {
  const source = readMobileSource();

  assert.match(source, /MOBILE_PERSISTENT_CACHE_TTL_MS = 5 \* 60_000/);
  assert.match(source, /MOBILE_PERSISTENT_CACHE_MAX_ENTRIES = 24/);
  assert.match(source, /readMobileCacheFrom\(sessionStorage, kind, id, MOBILE_CACHE_TTL_MS\)/);
  assert.match(source, /readMobileCacheFrom\(localStorage, kind, id, MOBILE_PERSISTENT_CACHE_TTL_MS\)/);
  assert.match(source, /writeMobileCacheTo\(sessionStorage, kind, id, persistent\)/);
  assert.match(source, /writeMobileCacheTo\(localStorage, kind, id, payload\)/);
});

test("mobile lite reuses fresh cache without full refresh on constrained networks", () => {
  const source = readMobileSource();

  assert.match(source, /function shouldReuseFreshCacheWithoutRefresh\(\)/);
  assert.match(source, /mobileNetworkTier\(\) === "constrained"/);
  assert.match(source, /已加载本地快照，省流量模式下暂停刷新/);
  assert.match(source, /已加载本地快照，省流量模式下只同步增量/);
  assert.match(source, /connectThreadEvents\(threadId, nextThreadEventOffset\(cached\)\)/);
  assert.match(source, /if \(shouldReuseFreshCacheWithoutRefresh\(\)\) \{/);
});

test("mobile lite coalesces non-critical bootstrap refreshes when cached state is fresh", () => {
  const source = readMobileSource();

  assert.match(source, /MOBILE_BOOTSTRAP_REFRESH_COOLDOWN_MS = 15_000/);
  assert.match(source, /payload\._cacheSavedAtMs = savedAtMs/);
  assert.match(source, /function cachedPayloadAgeMs\(payload\)/);
  assert.match(source, /function shouldSkipBootstrapRefresh\(cached\)/);
  assert.match(source, /cachedPayloadAgeMs\(cached\) <= MOBILE_BOOTSTRAP_REFRESH_COOLDOWN_MS/);
  assert.match(source, /if \(shouldSkipBootstrapRefresh\(cached\)\) \{/);
  assert.match(source, /已加载本地快照，短时间内不重复刷新列表/);
});

test("mobile lite prunes only its own persistent cache entries", () => {
  const source = readMobileSource();

  assert.match(source, /function pruneMobilePersistentCache\(storage\)/);
  assert.match(source, /key\.startsWith\(MOBILE_CACHE_PREFIX\)/);
  assert.match(source, /savedAtMs/);
  assert.match(source, /slice\(MOBILE_PERSISTENT_CACHE_MAX_ENTRIES\)/);
  assert.match(source, /storage\.removeItem\(entry\.key\)/);
  assert.match(source, /pruneMobilePersistentCache\(localStorage\)/);
});

test("mobile lite connects realtime events from the detail snapshot offset", () => {
  const source = readMobileSource();

  assert.match(source, /nextEventOffset/);
  assert.match(source, /function nextThreadEventOffset\(payload\)/);
  assert.match(source, /Math\.max\(\.\.\.candidates\)/);
  assert.match(source, /sinceOffset=/);
  assert.match(source, /connectThreadEvents\(threadId, nextThreadEventOffset\(payload\)\)/);
});

test("mobile lite keeps an existing realtime connection for unchanged detail refreshes", () => {
  const source = readMobileSource();

  assert.match(source, /threadEventsThreadId/);
  assert.match(source, /threadEventsRequestedOffset/);
  assert.match(source, /threadEvents && threadEventsThreadId === threadId/);
  assert.match(source, /requestedOffset <= threadEventsRequestedOffset/);
  assert.match(source, /return;/);
  assert.match(source, /threadEventsThreadId = ""/);
});

test("mobile lite confirms matching pending user messages instead of duplicating them", () => {
  const source = readMobileSource();

  assert.match(source, /function normalizeMessageText\(value\)/);
  assert.match(source, /item\.dataset\.pendingText = normalizeMessageText\(message\.text\)/);
  assert.match(source, /function confirmMatchingPendingUserMessage\(message\)/);
  assert.match(source, /message\.role !== "user"/);
  assert.match(source, /querySelectorAll\("\.message\.user\.pending"\)/);
  assert.match(source, /candidate\.dataset\.pendingText === text/);
  assert.match(source, /if \(confirmMatchingPendingUserMessage\(message\)\) return/);
});

test("mobile lite skips rerendering unchanged visible snapshots", () => {
  const source = readMobileSource();

  assert.match(source, /function visiblePayloadFingerprint\(payload\)/);
  assert.match(source, /lastBootstrapFingerprint/);
  assert.match(source, /lastThreadFingerprint/);
  assert.match(source, /fingerprint === lastBootstrapFingerprint/);
  assert.match(source, /轻量会话列表无变化/);
  assert.match(source, /fingerprint === lastThreadFingerprint/);
  assert.match(source, /当前会话轻量消息无变化/);
});

test("mobile lite sends cached etags and reuses snapshots on 304", () => {
  const source = readMobileSource();

  assert.match(source, /response\.status === 304/);
  assert.match(source, /_notModified: true/);
  assert.match(source, /payload\._etag = etag/);
  assert.match(source, /"if-none-match": cached\._etag/);
  assert.match(source, /payload\._notModified && cached/);
  assert.match(source, /connectThreadEvents\(threadId, nextThreadEventOffset\(cached\)\)/);
});

test("mobile lite pauses realtime events while the page is hidden", () => {
  const source = readMobileSource();

  assert.match(source, /activeThreadEventOffset/);
  assert.match(source, /event\.lastEventId/);
  assert.match(source, /function closeThreadEvents\(statusText\)/);
  assert.match(source, /document\.visibilityState === "hidden"/);
  assert.match(source, /已暂停后台增量连接/);
  assert.match(source, /connectThreadEvents\(activeThreadId, activeThreadEventOffset\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(source, /window\.addEventListener\("pagehide", \(\) => closeThreadEvents\(\)\)/);
});

test("mobile lite fetches use timeouts so weak networks do not hang forever", () => {
  const source = readMobileSource();

  assert.match(source, /MOBILE_READ_TIMEOUT_MS = 8_000/);
  assert.match(source, /MOBILE_SEND_TIMEOUT_MS = 30_000/);
  assert.match(source, /AbortController/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /请求超时/);
  assert.match(source, /fetchJsonWithTimeout\(mobileBootstrapUrl\(\)/);
  assert.match(source, /fetchJsonWithTimeout\(mobileThreadUrl\(threadId\)/);
  assert.match(source, /fetchJsonWithTimeout\(`\/api\/mobile\/thread\/\$\{encodeURIComponent\(activeThreadId\)\}\/turns`/);
});

test("mobile lite adapts bootstrap and thread history size to constrained phone networks", () => {
  const source = readMobileSource();

  assert.match(source, /MOBILE_BOOTSTRAP_LIMIT_DEFAULT = 50/);
  assert.match(source, /MOBILE_BOOTSTRAP_LIMIT_CONSTRAINED = 12/);
  assert.match(source, /MOBILE_BOOTSTRAP_LIMIT_CELLULAR = 24/);
  assert.match(source, /MOBILE_THREAD_LIMIT_DEFAULT = 120/);
  assert.match(source, /MOBILE_THREAD_LIMIT_CONSTRAINED = 40/);
  assert.match(source, /MOBILE_THREAD_LIMIT_CELLULAR = 80/);
  assert.match(source, /navigator\.connection \|\| navigator\.mozConnection \|\| navigator\.webkitConnection/);
  assert.match(source, /connection\.saveData/);
  assert.match(source, /slow-2g/);
  assert.match(source, /effectiveType === "3g"/);
  assert.match(source, /\/api\/mobile\/bootstrap\?limit=/);
  assert.match(source, /\/api\/mobile\/thread\/\$\{encodeURIComponent\(threadId\)\}\?limit=/);
  assert.match(source, /fetchJsonWithTimeout\(mobileBootstrapUrl\(\)/);
  assert.match(source, /fetchJsonWithTimeout\(mobileThreadUrl\(threadId\)/);
});
