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

test("bridge exposes local thread catalog for official local conversation resume", () => {
  const source = readPolyfillSource();
  const catalogBody = sourceBetween(source, "function localThreadCatalogTimestamp", "/** 把 Electron/Codex bridge API");

  // 官方 /local/:id 页面依赖 preload.localThreadCatalog 建立本地 thread 索引，再触发 maybe-resume-conversation。
  assert.match(source, /target\.localThreadCatalog = localThreadCatalogService/);
  assert.match(catalogBody, /local-thread-catalog-read/);
  assert.match(catalogBody, /local-thread-catalog-startup-sync/);
  assert.match(catalogBody, /local-thread-catalog-sync/);
  assert.match(catalogBody, /local-thread-catalog-subscribe/);
  assert.match(catalogBody, /return snapshot/);
  assert.match(catalogBody, /return refresh\("startup"\)/);
  assert.match(catalogBody, /return refresh\("sync"\)/);
  assert.match(catalogBody, /fetch\(`\/api\/mobile\/bootstrap\?limit=200&catalog=1/);
  assert.match(catalogBody, /hostId: "local"/);
  assert.match(catalogBody, /displayTitle: title/);
  assert.match(catalogBody, /sourceUpdatedAt/);
  assert.match(catalogBody, /sourceCreatedAt/);
  assert.match(catalogBody, /sourceKind: "local"/);
});

test("local thread deep links prewarm the catalog before official delayed startup sync", () => {
  const source = readPolyfillSource();
  const prewarmBody = sourceBetween(source, "function prewarmLocalThreadCatalogForRoute", "/** 把 Electron/Codex bridge API");

  // 官方 Provider 会延迟启动同步；深链直达时先拉本地目录，避免正文等固定 5 秒。
  assert.match(prewarmBody, /\^\\\/local\\\/\[\^\/\?#\]\+/);
  assert.match(prewarmBody, /local-thread-catalog-route-prewarm/);
  assert.match(prewarmBody, /localThreadCatalogService\.requestStartupSync\(\)/);
  assert.match(source, /prewarmLocalThreadCatalogForRoute\(\);/);
});

test("restored local thread routes drop one-shot diagnostic query params", () => {
  const source = readPolyfillSource();
  const normalizeBody = sourceBetween(source, "function normalizeRestorableRoute", "function isRestorableThreadRoute");
  const paramsBlock = sourceBetween(source, "const OPENCODEX_NON_RESTORABLE_ROUTE_PARAMS", "function createBrowserClientId");

  // full/probe 等参数只用于一次性调试或强制模式，不能污染下次打开的会话深链。
  assert.match(source, /OPENCODEX_NON_RESTORABLE_ROUTE_PARAMS/);
  for (const param of ["full", "mobile", "probe", "_probe", "_deep", "_tail", "__opencodex_renderer"]) {
    assert.match(paramsBlock, new RegExp(JSON.stringify(param)));
  }
  assert.match(normalizeBody, /parsed\.searchParams\.delete\(param\)/);
});

test("bridge client id is scoped to the current tab session", () => {
  const source = readPolyfillSource();
  const clientIdBody = sourceBetween(source, "function persistentPageClientId", "function routeRestorationEnabled");

  // clientId 直接决定 gateway 定向回包；跨标签共享 localStorage 会把回包投到错误页面。
  assert.match(source, /const OPENCODEX_CLIENT_ID_STORAGE_KEY = "opencodex_tab_client_id_v1"/);
  assert.match(source, /const clientId = persistentPageClientId\(\)/);
  assert.match(clientIdBody, /sessionStorage\.getItem\(OPENCODEX_CLIENT_ID_STORAGE_KEY\)/);
  assert.match(clientIdBody, /sessionStorage\.setItem\(OPENCODEX_CLIENT_ID_STORAGE_KEY, next\)/);
  assert.doesNotMatch(clientIdBody, /localStorage\.(?:getItem|setItem)\(OPENCODEX_CLIENT_ID_STORAGE_KEY/);
  assert.match(source, /clientIdStable: "tab-session"/);
});

test("restored local thread routes skip archived catalog entries", () => {
  const source = readPolyfillSource();
  const archivedRouteBody = sourceBetween(source, "function threadIdFromRoute", "function persistCurrentRoute");
  const persistBody = sourceBetween(source, "function persistCurrentRoute", "function restoreLastRouteOnColdEntry");
  const restoreBody = sourceBetween(source, "function restoreLastRouteOnColdEntry", "function installRoutePersistence");
  const catalogBody = sourceBetween(source, "function localThreadCatalogTimestamp", "/** 把 Electron/Codex bridge API");

  // 首页自动恢复只适合活跃会话；catalog 确认归档后要清掉 last-route，避免手机打开就跳进恢复失败循环。
  assert.match(source, /OPENCODEX_ARCHIVED_THREAD_IDS_STORAGE_KEY/);
  assert.match(archivedRouteBody, /function readArchivedThreadIds/);
  assert.match(archivedRouteBody, /function rememberArchivedThreadIds/);
  assert.match(archivedRouteBody, /routePointsToArchivedThread\(lastRoute\)/);
  assert.match(archivedRouteBody, /last-route-archived-cleared/);
  assert.match(persistBody, /if \(routePointsToArchivedThread\(route\)\) return/);
  assert.match(restoreBody, /routePointsToArchivedThread\(route\)/);
  assert.match(restoreBody, /last-route-restore-skipped-archived/);
  assert.match(catalogBody, /rememberArchivedThreadIds\(entries\)/);
  assert.match(catalogBody, /archived: thread\.archived === true/);
});

test("web shell clears unavailable last-route before renderer handoff", () => {
  const html = fs.readFileSync(path.join(repoRoot, "web-shell", "index.html"), "utf8");
  const catalogBody = sourceBetween(html, "async function readThreadCatalogBeforeRenderer", "function clearUnavailableLastRouteBeforeRenderer");
  const lastRouteBody = sourceBetween(html, "function clearUnavailableLastRouteBeforeRenderer", "function clearArchivedInitialRouteBeforeRenderer");

  // 壳页比官方 renderer 更早运行；在这里清理不可用 last-route，避免 renderer 已挂载后再改路由导致白屏或只剩链路控件。
  assert.match(html, /const lastThreadRouteKey = "opencodex_last_thread_route_v1"/);
  assert.match(html, /const archivedThreadIdsKey = "opencodex_archived_thread_ids_v1"/);
  assert.match(html, /const skipLastRouteRestoreKey = "opencodex_skip_last_route_restore"/);
  assert.match(html, /function normalizeThreadRoute/);
  assert.match(html, /function threadIdFromRoute/);
  assert.match(html, /async function readThreadCatalogBeforeRenderer/);
  assert.match(catalogBody, /currentThreadRouteBeforeRenderer\(\)/);
  assert.match(catalogBody, /if \(hasCurrentThreadRoute\) \{/);
  assert.match(catalogBody, /return null/);
  assert.match(catalogBody, /if \(!hasLastThreadRoute\) return null/);
  assert.match(catalogBody, /const timeoutMs = 1200/);
  assert.match(catalogBody, /\/api\/mobile\/bootstrap\?limit=200&catalog=1/);
  assert.match(lastRouteBody, /localStorage\.removeItem\(lastThreadRouteKey\)/);
  assert.match(lastRouteBody, /sessionStorage\.setItem\(skipLastRouteRestoreKey,\s*"1"\)/);
  assert.match(html, /const catalog = await readThreadCatalogBeforeRenderer\(\)/);
  assert.match(html, /clearUnavailableLastRouteBeforeRenderer\(catalog\)/);
});

test("web shell skips archived direct local routes before renderer handoff", () => {
  const html = fs.readFileSync(path.join(repoRoot, "web-shell", "index.html"), "utf8");
  const detailBody = sourceBetween(html, "async function readInitialThreadDetailBeforeRenderer", "function clearUnavailableLastRouteBeforeRenderer");
  const archivedBody = sourceBetween(html, "function clearArchivedInitialRouteBeforeRenderer", "async function authStatus");
  const bootBody = sourceBetween(html, "async function bootRenderer", "function utf8Bytes");

  // 明确缓存为归档的 /local/:id 不能继续交给官方恢复链路，否则会停在列表或只剩链路控件。
  // 未缓存的直达深链不再等待详情探测，避免热启动进会话多出一段空白时间。
  assert.match(html, /function readArchivedThreadIdsBeforeRenderer/);
  assert.match(html, /function currentThreadRouteBeforeRenderer/);
  assert.match(html, /function catalogThreadById/);
  assert.match(html, /function rememberArchivedThreadIdBeforeRenderer/);
  assert.match(html, /async function readInitialThreadDetailBeforeRenderer/);
  assert.match(detailBody, /if \(!catalog\) return null/);
  assert.match(detailBody, /catalogThreadById\(catalog, threadId\)/);
  assert.match(detailBody, /\/api\/mobile\/thread\/\$\{encodeURIComponent\(threadId\)\}\?limit=1/);
  assert.match(detailBody, /String\(detail\.thread\.id \|\| ""\) !== threadId/);
  assert.match(archivedBody, /const route = currentThreadRouteBeforeRenderer\(\)/);
  assert.match(archivedBody, /const archivedIds = readArchivedThreadIdsBeforeRenderer\(\)/);
  assert.match(archivedBody, /const entry = catalogThreadById\(catalog, threadId\)/);
  assert.match(archivedBody, /detailThread\?\.archived === true/);
  assert.match(archivedBody, /rememberArchivedThreadIdBeforeRenderer\(threadId\)/);
  assert.match(archivedBody, /if \(!archived\) return false/);
  assert.match(archivedBody, /const homeRoute = runtimeConfig\.mobileTrafficMode \? "\/\?mobile=1" : "\/"/);
  assert.match(archivedBody, /history\.replaceState\(history\.state,\s*"",\s*homeRoute\)/);
  assert.match(archivedBody, /skipped archived initial route before renderer/);
  assert.match(bootBody, /const initialThreadDetail = await readInitialThreadDetailBeforeRenderer\(catalog\)/);
  assert.match(bootBody, /clearArchivedInitialRouteBeforeRenderer\(catalog, initialThreadDetail\)/);
});

test("active local thread changes update route without full page navigation", () => {
  const source = readPolyfillSource();
  const navigateBody = sourceBetween(source, "function navigateToLocalThreadRouteInPlace", "function preloadGatewaySnapshotFromNudge");
  const activeChangeBody = sourceBetween(source, "function ensureRouteForActiveLocalThread", "function appHostThreadSeqStorageKey");

  // 侧栏点击本身已经在官方 renderer 内切换会话；这里只同步地址栏和 popstate，避免重新冷启动。
  assert.match(source, /function navigateToLocalThreadRouteInPlace/);
  assert.match(navigateBody, /history\.pushState\(history\.state,\s*"",\s*route\)/);
  assert.match(navigateBody, /dispatchOpenCodexRouteChange\(route,\s*"active-thread-change"\)/);
  assert.match(activeChangeBody, /return navigateToLocalThreadRouteInPlace\(route, threadId\)/);
  assert.doesNotMatch(activeChangeBody, /location\.href\s*=\s*route/);
});

test("gateway thread snapshot hits acknowledge the client cursor", () => {
  const source = readPolyfillSource();
  const gatewayBody = sourceBetween(source, "async function readGatewayFastSyncSnapshot", "async function invokeFastSyncSnapshot");
  const keyGatewayBody = sourceBetween(source, "async function readGatewayFastSyncSnapshotByKey", "async function invokeFastSyncSnapshot");
  const consumeBody = sourceBetween(source, "function consumeGatewayKeySnapshot", "async function readGatewayHintedSnapshot");
  const ackBody = sourceBetween(source, "function acknowledgeFastSyncSnapshotHit", "async function readBrowserFastSyncSnapshot");

  assert.match(source, /function acknowledgeFastSyncSnapshotHit/);
  assert.match(gatewayBody, /acknowledgeFastSyncSnapshotHit\(method, ipcArgs, snapshot\)/);
  assert.match(keyGatewayBody, /acknowledgeFastSyncSnapshotHit\(method, \[\], snapshot\)/);
  assert.match(consumeBody, /acknowledgeFastSyncSnapshotHit\(method, \[\], record\.snapshot\)/);
  assert.match(source, /type: "opencodex:fast-sync-snapshot-ack"/);
  assert.match(source, /FAST_SYNC_PERSISTENT_SNAPSHOT_METHODS\.has\(method\)/);
  assert.match(ackBody, /threadSeq: Math\.max\(0, Number\(snapshot\.threadSeq\) \|\| 0\)/);
  assert.match(ackBody, /rememberAppHostThreadSeq\(threadId, threadSeq\)/);
});

test("gateway snapshots can be preloaded by snapshot key after a replay gap", () => {
  const source = readPolyfillSource();
  const refreshBody = sourceBetween(source, "function refreshCurrentThreadRouteFromSnapshotNudge", "function scheduleCrossClientSyncRefresh");
  const inPlaceBody = sourceBetween(source, "function refreshRestorableRouteInPlace", "function navigateToRestorableRoute");
  const navigateBody = sourceBetween(source, "function navigateToRestorableRoute", "function dispatchOpenCodexRouteChange");
  const keyReadBody = sourceBetween(source, "async function readGatewayFastSyncSnapshotByKey", "async function invokeFastSyncSnapshot");

  assert.match(refreshBody, /preloadGatewaySnapshotFromNudge\(message\)/);
  assert.match(refreshBody, /\.finally\(\(\) => \{\s*refreshRestorableRouteInPlace\(decision\.route, message, "snapshot-preload"\)/);
  assert.match(refreshBody, /decision\.action === "in-place-refresh"/);
  assert.match(refreshBody, /return refreshRestorableRouteInPlace\(decision\.route, message, "snapshot-nudge"\)/);
  // 同一路由补偿只能派发事件，不能整页 reload，否则手机弱网会重新冷启动官方 bundle。
  assert.match(inPlaceBody, /dispatchOpenCodexRouteChange\(route, reason \|\| "snapshot-repair"\)/);
  assert.match(inPlaceBody, /opencodex:thread-snapshot-refresh/);
  assert.doesNotMatch(inPlaceBody, /location\.reload\(\)|location\.href/);
  assert.match(navigateBody, /return refreshRestorableRouteInPlace\(route, message, "route-refresh"\)/);
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

test("replay gap snapshot preload can fall back to thread id without snapshot key", () => {
  const source = readPolyfillSource();
  const preloadBody = sourceBetween(source, "function preloadGatewaySnapshotFromNudge", "function scheduleCrossClientSyncRefresh");
  const gatewayBody = sourceBetween(source, "async function readGatewayFastSyncSnapshot", "async function readGatewayFastSyncSnapshotByKey");

  // 有些 gap nudge 只有 method/threadId；这时也要让 gateway 按 threadId 返回中间层最新全量状态。
  assert.doesNotMatch(preloadBody, /if \(!method \|\| !snapshotKey \|\| !threadId\) return null/);
  assert.match(preloadBody, /if \(!method \|\| !threadId\) return null/);
  assert.match(preloadBody, /return readGatewayFastSyncSnapshot\(method, \[\], \{/);
  assert.match(gatewayBody, /rememberGatewayKeySnapshot\(method, threadId, snapshot\)/);
});

test("snapshot key preload falls back to thread id when the key misses", () => {
  const source = readPolyfillSource();
  const keyReadBody = sourceBetween(source, "async function readGatewayFastSyncSnapshotByKey", "async function invokeFastSyncSnapshot");

  // snapshotKey 是短期定位符；key miss 时仍可按 threadId 读取 gateway 最新全量状态。
  assert.match(keyReadBody, /return readGatewayFastSyncSnapshot\(method, \[\], \{\s*\.\.\.diagnosticSummary,\s*threadId: diagnosticSummary && diagnosticSummary\.threadId/);
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

test("thread detail gateway reads include thread id for middle-layer full-state fallback", () => {
  const source = readPolyfillSource();
  const gatewayBody = sourceBetween(source, "async function readGatewayFastSyncSnapshot", "async function readGatewayFastSyncSnapshotByKey");
  const invokeBody = sourceBetween(source, "async function invokeFastSyncSnapshot", "/** locale-info");

  // thread 详情没有 snapshotKey hint 时，也要让 gateway 能按 threadId 读取最新进程内全量状态。
  assert.match(gatewayBody, /let threadId = ""/);
  assert.match(gatewayBody, /threadId = diagnosticSummary && typeof diagnosticSummary\.threadId === "string" \? diagnosticSummary\.threadId : ""/);
  assert.match(gatewayBody, /if \(threadId && FAST_SYNC_MEMORY_SNAPSHOT_METHODS\.has\(method\)\) parsed\.searchParams\.set\("threadId", threadId\)/);
  assert.match(invokeBody, /threadId,/);
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
  const decisionBody = sourceBetween(source, "function threadSnapshotNudgeDecision", "function refreshCurrentThreadRouteFromSnapshotNudge");
  const refreshBody = sourceBetween(source, "function refreshCurrentThreadRouteFromSnapshotNudge", "function scheduleCrossClientSyncRefresh");

  assert.match(decisionBody, /OpenCodexSnapshotRepairState/);
  assert.match(decisionBody, /decideSnapshotRepair/);
  assert.match(refreshBody, /thread-detail-snapshot-replay-applied/);
  assert.match(refreshBody, /return true/);
});

test("thread detail nudge keeps refresh fallback when app-host replay has a gap", () => {
  const source = readPolyfillSource();
  const appHostBody = sourceBetween(source, "function handleAppHostGatewayMessage", "function installAppHostMessagePortBridge");
  const staticAssetsSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "http", "static-assets.cjs"), "utf8");

  assert.match(staticAssetsSource, /snapshot-repair-state\.js/);
  assert.match(appHostBody, /app-host-thread-replay-gap/);
});

test("thread detail nudge uses an explicit repair decision state", () => {
  const source = readPolyfillSource();
  const decisionBody = sourceBetween(source, "function threadSnapshotNudgeDecision", "function refreshCurrentThreadRouteFromSnapshotNudge");
  const refreshBody = sourceBetween(source, "function refreshCurrentThreadRouteFromSnapshotNudge", "function scheduleCrossClientSyncRefresh");

  assert.match(source, /function threadSnapshotNudgeDecision/);
  assert.match(decisionBody, /stateMachine\.decideSnapshotRepair/);
  assert.match(decisionBody, /editing: hasEditableFocus\(\)/);
  assert.match(decisionBody, /visible: document\.visibilityState === "visible"/);
  assert.match(refreshBody, /const decision = threadSnapshotNudgeDecision\(message\)/);
  assert.match(refreshBody, /thread-detail-snapshot-decision/);
  assert.match(refreshBody, /thread-detail-snapshot-repair/);
  assert.match(refreshBody, /decision\.action === "incremental-replay"/);
  assert.match(refreshBody, /decision\.action === "snapshot-preload"/);
});

test("fast sync snapshot reads have short miss timeouts", () => {
  const source = readPolyfillSource();
  // 弱网下冷缓存 miss 不能长期卡住真实 IPC，浏览器本地和 gateway 快照读取都要有短超时。
  assert.match(source, /FAST_SYNC_BROWSER_READ_TIMEOUT_MS/);
  assert.match(source, /FAST_SYNC_GATEWAY_READ_TIMEOUT_MS/);
  assert.match(source, /browser-read-timeout/);
  assert.match(source, /gateway-read-timeout/);
});

test("gateway fast sync hit keeps thread id in scope for acknowledgement", () => {
  const source = readPolyfillSource();
  const gatewayReadBody = sourceBetween(source, "async function readGatewayFastSyncSnapshot", "async function readGatewayFastSyncSnapshotByKey");

  // gateway 快照命中后还要用 threadId 写 ack 和内存缓存；块级 const 会在命中路径抛 ReferenceError。
  assert.match(gatewayReadBody, /let threadId = "";/);
  assert.doesNotMatch(gatewayReadBody, /const threadId = diagnosticSummary/);
  assert.match(gatewayReadBody, /acknowledgeFastSyncSnapshotHit\(method, ipcArgs, snapshot\)/);
  assert.match(gatewayReadBody, /rememberGatewayKeySnapshot\(method, threadId, snapshot\)/);
});

test("mobile traffic mode keeps official shell while localizing noncritical app state", () => {
  const source = readPolyfillSource();
  const localBlock = sourceBetween(source, "const MOBILE_TRAFFIC_LOCAL_METHODS", "function appServerMethod");

  assert.match(source, /MOBILE_TRAFFIC_MODE/);
  assert.match(source, /cfg\.mobileTrafficMode/);
  assert.match(source, /__OPENCODEX_MOBILE_TRAFFIC_MODE__/);
  assert.match(source, /cfg\.mobileTrafficMode = true/);
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
  // 服务端默认只消费发送链路和传输选择诊断，普通诊断不上报可以避免进入会话时出现大量 /api/client-log。
  assert.match(source, /CLIENT_DIAGNOSTIC_UPLOAD_ENABLED/);
  assert.match(source, /eventName === "fast-sync-flow"/);
  assert.match(source, /eventName === "ws-transport-selected"/);
  assert.match(source, /eventName === "ws-hello-ack"/);
  assert.match(source, /eventName\.startsWith\("local-thread-catalog-"\)/);
  assert.match(source, /shouldUploadClientDiagnostic\(event\)/);
});

test("ipc diagnostics summarize resume payload shape without values", () => {
  const source = readPolyfillSource();
  const summaryBody = sourceBetween(source, "function ipcDiagnosticSummary", "function rawWsMessageChars");

  // 进入本地会话的问题第一现场在浏览器 IPC；只记录 key 和类型，不能把正文参数值写进日志。
  assert.match(summaryBody, /objectKeySummary\(payload\.request\.params\)/);
  assert.match(summaryBody, /objectKeySummary\(payload\.params\)/);
  assert.match(summaryBody, /serviceTierTypeFromPayload\(payload\)/);
  assert.match(summaryBody, /Object\.keys\(value\)\.sort\(\)\.slice\(0, 24\)\.join\(","\)/);
  assert.match(summaryBody, /return payloadShape\(target\.serviceTier\)/);
});

test("network status widget surfaces thread watermarks and repair counters", () => {
  const source = readPolyfillSource();
  const refreshBody = sourceBetween(source, "async function refreshThreadDiagnosticsSnapshot", "function ensureNetworkStatusWidget");
  const updateBody = sourceBetween(source, "function updateNetworkStatusWidget", "async function checkNetworkStatusHealth");
  const copyBody = sourceBetween(source, "async function copyFlowDiagnostics", "function installNetworkStatusWidget");

  assert.match(source, /let latestThreadDiagnosticsSnapshot = null/);
  assert.match(refreshBody, /\/api\/diagnostics\/threads\?threadId=/);
  assert.match(refreshBody, /currentRouteThreadId\(\)/);
  assert.match(updateBody, /threadDiagnosticsSummary\(threadDiagnostics\)/);
  assert.match(copyBody, /threadDiagnostics: latestThreadDiagnosticsSnapshot/);
  for (const field of ["clientWatermarks", "missedByTransport", "repairedByThreadReplay", "repairedBySnapshot"]) {
    assert.match(source, new RegExp(field));
  }
});

test("desktop disables official tail hydration gate in web statsig payload", () => {
  const source = readPolyfillSource();
  // tail hydration 依赖 resume.initialTurnsPage；Web 桥下该页缺失会导致历史正文要等发消息后才显示。
  assert.match(source, /OPENCODEX_DISABLED_STATSIG_GATES = \["4261455886"\]/);
  assert.match(source, /statsigPayload\.feature_gates\[gateName\] = disabledStatsigGateConfig\(gateName\)/);
  assert.match(source, /statsig-bootstrap-opencodex-patched/);
});

test("desktop enables official local thread resume gate in web statsig payload", () => {
  const source = readPolyfillSource();
  const fallbackBody = sourceBetween(source, "function buildStatsigInitializeResponse", "function isStatsigInitializeUrl");
  // 官方旧本地对话详情页只有该 gate 开启时才会触发 maybe-resume-conversation 读取 turns。
  assert.match(source, /OPENCODEX_ENABLED_STATSIG_GATES = \["567837310"\]/);
  assert.match(source, /statsigPayload\.feature_gates\[gateName\] = enabledStatsigGateConfig\(gateName\)/);
  assert.match(fallbackBody, /for \(const gateName of OPENCODEX_ENABLED_STATSIG_GATES\)[\s\S]*feature_gates\[gateName\] = enabledStatsigGateConfig\(gateName\)/);
  assert.match(source, /enabledGates: OPENCODEX_ENABLED_STATSIG_GATES\.join\(","\)/);
});

test("desktop short-circuits segment telemetry in the browser bridge", () => {
  const source = readPolyfillSource();
  const telemetryBody = sourceBetween(source, "function isTelemetryRegisterUrl", "// sentry-ipc://");

  // Segment 只承载浏览器埋点；弱网下不能让它绕过 gateway 造成 CSP 报错或重试阻塞。
  assert.match(telemetryBody, /api\.segment\.io/);
  assert.match(telemetryBody, /pathname\.startsWith\("\/v1\/"\)/);
});

test("desktop conversation entry auxiliary reads use browser read-only cache", () => {
  const source = readPolyfillSource();
  const start = source.indexOf("const READ_ONLY_APP_SERVER_METHODS");
  const end = source.indexOf("const MOBILE_TRAFFIC_LOCAL_METHODS", start);
  assert.ok(start >= 0 && end > start, "missing READ_ONLY_APP_SERVER_METHODS block");
  const block = source.slice(start, end);
  // 这些辅助读在电脑端首屏会并发触发；页内去重/短缓存可避免它们拖慢历史会话打开。
  for (const method of [
    "collaborationMode/list",
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

test("conversation entry auxiliary ipc prefers http while critical thread reads stay live", () => {
  const source = readPolyfillSource();
  const policyBody = sourceBetween(source, "function shouldPreferHttpForConversationEntry", "function hasThreadStartUserContent");
  const invokeBody = sourceBetween(source, "async function invokeGatewayImmediate", "/** 模拟 Electron ipcRenderer.invoke");

  // 进入历史会话前几秒，配置/权限/worker 等辅助 IPC 不能被半开 WS 卡住；正文读取和发送仍保持实时链路。
  assert.match(source, /CONVERSATION_ENTRY_HTTP_FIRST_WINDOW_MS = 15000/);
  assert.match(policyBody, /CONVERSATION_ENTRY_HTTP_FIRST_METHODS/);
  assert.match(policyBody, /CONVERSATION_ENTRY_HTTP_FIRST_TYPES/);
  assert.match(policyBody, /method === "thread\/read"/);
  assert.match(policyBody, /method === "thread\/turns\/list"/);
  assert.match(policyBody, /method === "turn\/start"/);
  assert.match(invokeBody, /const preferHttp =/);
  assert.match(invokeBody, /shouldPreferHttpForConversationEntry\(payload\)/);
  assert.match(invokeBody, /!wsFirstConnectDone && !preferHttp/);
  assert.match(invokeBody, /canUseWsForIpc\(\) && !preferHttp/);
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

test("gateway transport prefers Socket.IO client with raw websocket fallback", () => {
  const source = readPolyfillSource();
  const connectBody = sourceBetween(source, "function connect()", "/** WebSocket 断开后的指数退避重连。 */");

  assert.match(source, /gatewaySocketIoUrl: location\.origin/);
  assert.match(source, /gatewaySocketIoScriptUrl: location\.origin \+ "\/socket\.io\/socket\.io\.js"/);
  assert.match(source, /function loadSocketIoClientScript/);
  assert.match(source, /function createSocketIoGatewaySocket/);
  assert.match(source, /function createRawGatewayWebSocket/);
  assert.match(source, /function socketDiagnosticInfo/);
  assert.match(connectBody, /openGatewaySocket\(\)\.then/);
  assert.match(source, /createSocketIoGatewaySocket\(ioFactory\)/);
  assert.match(source, /const socket = createRawGatewayWebSocket\(\)/);
  assert.match(source, /socket\.transport = "websocket"/);
  assert.match(source, /socket\.fallbackTransport = "socket\.io"/);
  assert.match(connectBody, /ws-transport-selected/);
  assert.match(connectBody, /\.\.\.socketDiagnosticInfo\(socket\)/);
});

test("socket.io gateway adapter preserves the existing websocket-shaped contract", () => {
  const source = readPolyfillSource();
  const adapterBody = sourceBetween(source, "function createSocketIoGatewaySocket", "function createRawGatewayWebSocket");

  assert.match(adapterBody, /readyState: w\.WebSocket\.CONNECTING/);
  assert.match(adapterBody, /socket\.emit\("message", data\)/);
  assert.match(adapterBody, /socket\.on\("message"/);
  assert.match(adapterBody, /emitGatewaySocketEvent\(adapter, "message", \{ data \}\)/);
  assert.match(adapterBody, /socket\.on\("connect"/);
  assert.match(adapterBody, /adapter\.socketId = socket\.id \|\| ""/);
  assert.match(adapterBody, /adapter\.recovered = socket\.recovered === true/);
  assert.match(adapterBody, /socket\.on\("disconnect"/);
  assert.match(adapterBody, /addEventListener\(type, handler\)/);
});
