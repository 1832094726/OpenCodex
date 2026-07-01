const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const polyfillPath = path.join(repoRoot, "web-shell", "codex-bridge-polyfill.js");

function readPolyfillSource() {
  return fs.readFileSync(polyfillPath, "utf8");
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test("fast sync snapshot allowlist separates persistent and memory-only reads", () => {
  const source = readPolyfillSource();
  const persistentMethods = [
    "account/read",
    "config/read",
    "model/list",
    "thread/list",
  ];
  const memoryOnlyMethods = [
    "thread/read",
    "thread/turns/list",
  ];

  assert.match(source, /FAST_SYNC_SNAPSHOT_METHODS/);
  assert.match(source, /FAST_SYNC_PERSISTENT_SNAPSHOT_METHODS/);
  for (const method of persistentMethods.concat(memoryOnlyMethods)) {
    assert.match(source, new RegExp(JSON.stringify(method)));
  }

  const allowlistBlock = source.match(/FAST_SYNC_SNAPSHOT_METHODS[\s\S]*?\]\);/);
  assert.ok(allowlistBlock, "expected a local fast-sync allowlist block");
  const persistentBlock = source.match(/FAST_SYNC_PERSISTENT_SNAPSHOT_METHODS[\s\S]*?\]\);/);
  assert.ok(persistentBlock, "expected a persistent fast-sync allowlist block");
  // 总快照方法可以包含会话详情，但浏览器本地持久化仍只允许轻量首屏读。
  assert.doesNotMatch(allowlistBlock[0], /"plugin\/list"/);
  assert.doesNotMatch(allowlistBlock[0], /"turn\/start"/);
  assert.doesNotMatch(persistentBlock[0], /"thread\/read"/);
  assert.doesNotMatch(persistentBlock[0], /"thread\/turns\/list"/);
  assert.doesNotMatch(persistentBlock[0], /"plugin\/list"/);
  assert.doesNotMatch(persistentBlock[0], /"turn\/start"/);
});

test("fast sync snapshot diagnostics are wired in the polyfill", () => {
  const source = readPolyfillSource();
  for (const eventName of [
    "fast-sync-browser-hit",
    "fast-sync-gateway-hit",
    "fast-sync-refresh-store",
    "fast-sync-refresh-failed",
    "fast-sync-miss",
  ]) {
    assert.match(source, new RegExp(JSON.stringify(eventName)));
  }
});

test("gateway thread snapshot hits acknowledge the client cursor", () => {
  const source = readPolyfillSource();
  const gatewayBody = sourceBetween(source, "async function readGatewayFastSyncSnapshot", "async function invokeFastSyncSnapshot");

  assert.match(source, /function acknowledgeFastSyncSnapshotHit/);
  assert.match(gatewayBody, /acknowledgeFastSyncSnapshotHit\(method, ipcArgs, snapshot\)/);
  assert.match(source, /type: "opencodex:fast-sync-snapshot-ack"/);
  assert.match(source, /FAST_SYNC_PERSISTENT_SNAPSHOT_METHODS\.has\(method\)/);
});

test("gateway snapshots can be preloaded by snapshot key after a replay gap", () => {
  const source = readPolyfillSource();
  const refreshBody = sourceBetween(source, "function refreshCurrentThreadRouteFromSnapshotNudge", "function scheduleCrossClientSyncRefresh");
  const keyReadBody = sourceBetween(source, "async function readGatewayFastSyncSnapshotByKey", "async function invokeFastSyncSnapshot");

  assert.match(refreshBody, /preloadGatewaySnapshotFromNudge\(message\)/);
  assert.match(refreshBody, /preload\.catch\(\(\) => \{\}\)/);
  assert.match(refreshBody, /return navigateToRestorableRoute\(route, message\)/);
  assert.match(source, /function preloadGatewaySnapshotFromNudge/);
  assert.match(source, /message\.snapshotKey/);
  assert.match(source, /rememberGatewayKeySnapshotHint\(method, threadId, snapshotKey\)/);
  assert.match(source, /const gatewayKeySnapshotCache = new Map\(\)/);
  assert.match(source, /function rememberGatewayKeySnapshot/);
  assert.match(source, /function consumeGatewayKeySnapshot/);
  assert.match(keyReadBody, /parsed\.searchParams\.set\("key", snapshotKey\)/);
  assert.match(keyReadBody, /rememberGatewayKeySnapshot\(method, diagnosticSummary && diagnosticSummary\.threadId, snapshot\)/);
  assert.match(keyReadBody, /fast-sync-gateway-key-hit/);
  assert.match(keyReadBody, /fast-sync-gateway-key-miss/);
});

test("preloaded gateway key snapshots are consumed before live thread reads", () => {
  const source = readPolyfillSource();
  const invokeBody = sourceBetween(source, "async function invokeFastSyncSnapshot", "/** locale-info");

  assert.match(source, /FAST_SYNC_GATEWAY_KEY_SNAPSHOT_TTL_MS/);
  assert.match(source, /fast-sync-gateway-key-consume/);
  assert.match(source, /function rememberGatewayKeySnapshotHint/);
  assert.match(source, /function consumeGatewayKeySnapshotHint/);
  assert.match(source, /fast-sync-gateway-key-hint/);
  assert.match(invokeBody, /const keyedSnapshot = consumeGatewayKeySnapshot\(method, threadId, diagnosticSummary\)/);
  assert.match(invokeBody, /refreshFastSyncSnapshot\(channel, ipcArgs, payload, method, diagnosticSummary, "gateway-key-hit"\)/);
  assert.match(invokeBody, /const hintedSnapshot = await readGatewayHintedSnapshot\(method, threadId, diagnosticSummary\)/);
  assert.match(invokeBody, /refreshFastSyncSnapshot\(channel, ipcArgs, payload, method, diagnosticSummary, "gateway-key-hint"\)/);
  assert.match(invokeBody, /return keyedSnapshot/);
});

test("thread detail sync nudge refreshes only the matching route", () => {
  const source = readPolyfillSource();
  const syncBody = sourceBetween(source, "function scheduleCrossClientSyncRefresh", "function waitForGatewayWsReady");

  assert.match(source, /function refreshCurrentThreadRouteFromSnapshotNudge/);
  assert.match(syncBody, /message\.reason === "thread-detail-snapshot"/);
  assert.match(syncBody, /currentRouteThreadId\(\) !== message\.threadId/);
  assert.match(syncBody, /refreshCurrentThreadRouteFromSnapshotNudge\(message\)/);
});

test("thread detail nudge skips hard reload when app-host replay was delivered", () => {
  const source = readPolyfillSource();
  const refreshBody = sourceBetween(source, "function refreshCurrentThreadRouteFromSnapshotNudge", "function scheduleCrossClientSyncRefresh");

  assert.match(refreshBody, /Number\(message && message\.replaySent \|\| 0\) > 0 && message\.replayGap !== true/);
  assert.match(refreshBody, /thread-detail-snapshot-replay-applied/);
  assert.match(refreshBody, /return true/);
});

test("thread detail nudge keeps refresh fallback when app-host replay has a gap", () => {
  const source = readPolyfillSource();
  const refreshBody = sourceBetween(source, "function refreshCurrentThreadRouteFromSnapshotNudge", "function scheduleCrossClientSyncRefresh");
  const appHostBody = sourceBetween(source, "function handleAppHostGatewayMessage", "function installAppHostMessagePortBridge");

  assert.match(refreshBody, /message\.replayGap !== true/);
  assert.match(appHostBody, /app-host-thread-replay-gap/);
});

test("fast sync snapshot reads have short miss timeouts", () => {
  const source = readPolyfillSource();
  // 弱网下冷缓存 miss 不能长期卡住真实 IPC，浏览器本地和 gateway 快照读取都要有短超时。
  assert.match(source, /FAST_SYNC_BROWSER_READ_TIMEOUT_MS/);
  assert.match(source, /FAST_SYNC_GATEWAY_READ_TIMEOUT_MS/);
  assert.match(source, /browser-read-timeout/);
  assert.match(source, /gateway-read-timeout/);
});

test("mobile traffic mode keeps official shell while localizing noncritical app state", () => {
  const source = readPolyfillSource();
  const localBlock = sourceBetween(source, "const MOBILE_TRAFFIC_LOCAL_METHODS", "function appServerMethod");

  assert.match(source, /MOBILE_TRAFFIC_MODE/);
  assert.match(source, /cfg\.mobileTrafficMode/);
  assert.match(localBlock, /"app\/list"/);
  assert.match(localBlock, /"mcpServerStatus\/list"/);
  assert.match(localBlock, /"skills\/list"/);
  assert.match(source, /function mobileTrafficLocalAppServerValue/);
  assert.match(source, /mobile-traffic-local-state/);
});

test("mobile traffic mode disables token usage capability initialization", () => {
  const source = readPolyfillSource();
  // 手机端进入历史会话时会同时显示多条回复；跳过 tokenUsage 可避免逐条懒查询 session 文件。
  assert.match(source, /const tokenUsageCapability = MOBILE_TRAFFIC_MODE \? null : createTokenUsageCapability\(\);/);
});

test("client diagnostics upload only flow events by default", () => {
  const source = readPolyfillSource();
  // 服务端默认只消费 fast-sync-flow，普通诊断不上报可以避免进入会话时出现大量 /api/client-log。
  assert.match(source, /CLIENT_DIAGNOSTIC_UPLOAD_ENABLED/);
  assert.match(source, /event === "fast-sync-flow"/);
  assert.match(source, /shouldUploadClientDiagnostic\(event\)/);
});

test("desktop disables official tail hydration gate in web statsig payload", () => {
  const source = readPolyfillSource();
  // tail hydration 依赖 resume.initialTurnsPage；Web 桥下该页缺失会导致历史正文要等发消息后才显示。
  assert.match(source, /OPENCODEX_DISABLED_STATSIG_GATES = \["4261455886"\]/);
  assert.match(source, /statsigPayload\.feature_gates\[gateName\] = disabledStatsigGateConfig\(gateName\)/);
  assert.match(source, /statsig-bootstrap-opencodex-patched/);
});

test("desktop conversation entry auxiliary reads use browser read-only cache", () => {
  const source = readPolyfillSource();
  const start = source.indexOf("const READ_ONLY_APP_SERVER_METHODS");
  const end = source.indexOf("const MOBILE_TRAFFIC_LOCAL_METHODS", start);
  assert.ok(start >= 0 && end > start, "missing READ_ONLY_APP_SERVER_METHODS block");
  const block = source.slice(start, end);
  // 这些辅助读在电脑端首屏会并发触发；页内去重/短缓存可避免它们拖慢历史会话打开。
  for (const method of [
    "config/read",
    "configRequirements/read",
    "experimentalFeature/list",
    "hooks/list",
    "model/list",
    "permissionProfile/list",
    "thread/list",
  ]) {
    assert.match(block, new RegExp(JSON.stringify(method).replace("/", "\\/")));
  }
});

test("token usage inline waits until conversation entry is idle", () => {
  const source = fs.readFileSync(path.join(repoRoot, "web-shell/plugins/token-usage-inline/index.js"), "utf8");
  // token 用量 badge 是辅助信息，必须晚于会话正文加载，避免抢占 thread/resume 和 turns/list。
  assert.match(source, /REQUEST_IDLE_DELAY_MS = 15000/);
  assert.match(source, /requestUsageForRowNow\(row, ids\)/);
  assert.match(source, /pendingRequestTimers/);
});

test("turn starts create pending sends and flow diagnostics", () => {
  const source = readPolyfillSource();
  // turn/start 是写操作，不能进快照缓存，但需要本地 pending 与链路诊断帮助排查弱网转圈。
  for (const expected of [
    "createPendingSend(payload)",
    "completePendingSend(localSendId",
    "fast-sync-flow",
    "send_pending_created",
    "send_turn_accepted",
    "send_pending_failed",
    "localSendId",
    "FAST_SYNC_PENDING_CREATE_TIMEOUT_MS",
    "pending-send-create-timeout",
  ]) {
    assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("blank startup thread starts are deferred behind conversation entry", () => {
  const source = readPolyfillSource();
  const deferredBlock = sourceBetween(source, "function isBackgroundThreadStartPayload", "function invokeBackgroundThreadStartDeferred");
  const invokeBlock = sourceBetween(source, "async function invokeGateway(channel, args)", "const cachedReadOnlyAppServerInvoke");
  // 官方主页启动期会预创建空白 thread/start；延后它，避免抢占历史会话的 thread/read/resume/turns/list。
  assert.match(source, /BACKGROUND_THREAD_START_DELAY_MS = 4500/);
  assert.match(source, /BACKGROUND_THREAD_START_STARTUP_WINDOW_MS = 30000/);
  assert.match(deferredBlock, /appServerMethod\(payload\) !== "thread\/start"/);
  assert.match(deferredBlock, /hasThreadStartUserContent\(payload\)/);
  assert.match(source, /background-thread-start-deferred/);
  assert.match(invokeBlock, /invokeBackgroundThreadStartDeferred/);
  // 真正发送消息使用 turn/start，不能被空白 thread/start 的低优先级策略误伤。
  assert.doesNotMatch(deferredBlock, /turn\/start/);
});

test("mobile resume reconnect does not automatically reload the page", () => {
  const source = readPolyfillSource();
  const resumeReadyBlock = sourceBetween(source, "function markMobileResumeReconnectedWithoutReload", "function hasEditableFocus");
  const resumeHookBlock = sourceBetween(source, "function installGatewayWebSocketResumeHooks", "installGatewayWebSocketResumeHooks();");
  // 移动端回到前台应走原地重连，不能再用刷新当前会话作为默认恢复路径。
  assert.doesNotMatch(
    source,
    /mobileThreadReloadAfterReconnect|lastMobileThreadReloadAtMs|MOBILE_THREAD_RELOAD_COOLDOWN_MS|scheduleMobileThreadReloadAfterReconnect/
  );
  assert.doesNotMatch(resumeReadyBlock, /location\.reload\(\)|location\.href|history\.replaceState/);
  assert.doesNotMatch(resumeHookBlock, /location\.reload\(\)|location\.href|history\.replaceState/);
  assert.match(source, /mobile-resume-reconnect-without-reload/);
});

test("mobile foreground resume still forces a fresh websocket", () => {
  const source = readPolyfillSource();
  // 无感恢复仍必须换一条新的 WS，避免手机后台后的半开连接继续吞回包。
  assert.match(source, /MOBILE_WS_RESUME_RECONNECT_AFTER_MS/);
  assert.match(source, /ensureGatewayWebSocket\(reason,\s*\{\s*force:\s*shouldRefreshMobileSocket\s*\}\)/);
});
