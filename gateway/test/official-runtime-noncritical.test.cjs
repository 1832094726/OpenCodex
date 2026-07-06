const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourcePath = path.join(__dirname, "../runtime/ipc/official-runtime.cjs");
const source = fs.readFileSync(sourcePath, "utf8");

function officialRuntimeFunctionSource(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0, `missing ${name}`);
  assert.ok(end > start, `missing ${nextName} after ${name}`);
  return source.slice(start, end);
}

test("account usage fetch is not treated as non-critical", () => {
  const body = officialRuntimeFunctionSource("nonCriticalFetchBodyForUrl", "sendFetchJsonResponse");
  // /wham/usage 驱动头像菜单里的剩余用量，不能像遥测接口一样返回空对象。
  assert.doesNotMatch(body, /pathname\s*===\s*["']\/wham\/usage["']/);
});

test("startup wham fetches can reuse cached real responses", () => {
  const cacheBody = officialRuntimeFunctionSource("fetchResponseCacheKeyForMessage", "fetchResponseCacheKeyForSummary");
  const serveBody = officialRuntimeFunctionSource("maybeServeCachedFetchResponse", "rememberCacheableFetchResponse");
  const rememberBody = officialRuntimeFunctionSource("rememberCacheableFetchResponse", "maybeServeReadOnlyAppServerCache");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");

  // 这些接口是官方 UI 启动辅助数据；只能缓存真实成功回包，不能像遥测一样编造空对象。
  for (const pathname of ["/wham/accounts/check", "/wham/profiles/me", "/wham/statsig/bootstrap", "/wham/usage"]) {
    assert.match(source, new RegExp(JSON.stringify(pathname).replace("/", "\\/")));
  }
  assert.match(source, /FETCH_RESPONSE_CACHEABLE_PATHS/);
  assert.match(cacheBody, /message\.type !== "fetch"/);
  assert.match(cacheBody, /method !== "GET"/);
  assert.match(cacheBody, /pathname === "\/wham\/statsig\/bootstrap"/);
  assert.match(serveBody, /fetch_response_cache_hit/);
  assert.match(serveBody, /routeOfficialWebContentsSend/);
  assert.match(rememberBody, /payload\.type !== "fetch-response"/);
  assert.match(rememberBody, /payload\.responseType !== "success"/);
  assert.match(rememberBody, /FETCH_RESPONSE_CACHE_BODY_LIMIT_BYTES/);
  assert.match(routeBody, /rememberCacheableFetchResponse\(channel, args, requestSummary, requestId\)/);
  assert.ok(
    invokeBody.indexOf("maybeServeCachedFetchResponse") < invokeBody.indexOf("maybeHandleNonCriticalFetch"),
    "real-response cache should be checked before non-critical fetch shortcuts"
  );
});

test("local resume omits null service tier before official ipc", () => {
  const methodBody = officialRuntimeFunctionSource("localResumeMethodFromPayload", "removeNullServiceTier");
  const removeBody = officialRuntimeFunctionSource("removeNullServiceTier", "normalizeLocalResumeServiceTier");
  const normalizeBody = officialRuntimeFunctionSource("normalizeLocalResumeServiceTier", "valueStringAtKeys");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");

  // 旧 chunk 或浏览器缓存可能仍发 serviceTier:null；转交官方 app-server 前必须删除，避免 thread/resume 返回 -32600。
  assert.match(methodBody, /maybe-resume-conversation/);
  assert.match(methodBody, /thread\/resume/);
  assert.match(removeBody, /delete target\.serviceTier/);
  assert.match(normalizeBody, /local_resume_null_service_tier_removed/);
  assert.ok(
    invokeBody.indexOf("normalizeLocalResumeServiceTier") < invokeBody.indexOf("incomingIpcDiagnosticSummary"),
    "local resume payload should be normalized before routing summary and official handler invocation"
  );
});

test("browser use runtime paths are injected from official resources", () => {
  const appServerEnvBody = officialRuntimeFunctionSource("appServerSpawnOptions", "looksLikeOfficialCodexBinary");
  const alignBody = officialRuntimeFunctionSource("alignOfficialElectronEnvironment", "addOfficialListener");
  const runtimeBody = officialRuntimeFunctionSource("officialInstalledResourcesPath", "appServerSpawnOptions");

  // 官方 main 通过 CODEX_BROWSER_USE_NODE_PATH / CODEX_NODE_REPL_PATH 解析 runtimePaths；
  // 这两个值必须指向已安装 Codex.app 的 cua_node，不能指向不含 cua_node 的 OpenCodex 缓存目录。
  assert.match(runtimeBody, /manifest\.sourceResourcesPath/);
  assert.match(runtimeBody, /cua_node/);
  assert.match(runtimeBody, /CODEX_BROWSER_USE_NODE_PATH/);
  assert.match(runtimeBody, /CODEX_NODE_REPL_PATH/);
  assert.match(runtimeBody, /NODE_REPL_NODE_PATH/);
  assert.match(appServerEnvBody, /applyOfficialBrowserUseRuntimeEnv\(env, officialBundle\)/);
  assert.match(alignBody, /applyOfficialBrowserUseRuntimeEnv\(process\.env, bundle\)/);
});

test("archived thread resume errors are cooled down with official response shape", () => {
  const serveBody = officialRuntimeFunctionSource("maybeServeTerminalThreadResumeError", "rememberTerminalThreadResumeError");
  const rememberBody = officialRuntimeFunctionSource("rememberTerminalThreadResumeError", "maybeServeReadOnlyAppServerCache");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");

  // 归档 session 的 thread/resume 是终态错误；重复请求要复用官方真实错误回包，不再每轮慢打 app-server。
  assert.match(source, /THREAD_RESUME_TERMINAL_ERROR_TTL_MS/);
  assert.match(source, /threadResumeTerminalErrorCache/);
  assert.match(source, /archivedThreadResumeErrorText/);
  assert.match(source, /isArchivedThreadResumeError/);
  assert.match(source, /is archived\|codex unarchive/);
  assert.doesNotMatch(rememberBody, /recursiveStringMatches\(payload/);
  assert.match(rememberBody, /isArchivedThreadResumeError\(payload\)/);
  assert.match(serveBody, /thread_resume_terminal_error_cache_hit/);
  assert.match(serveBody, /cloneWithReplacement/);
  assert.match(rememberBody, /thread_resume_terminal_error_cached/);
  assert.match(rememberBody, /cloneCacheableResponseArgs/);
  assert.match(routeBody, /rememberTerminalThreadResumeError\(channel, args, requestSummary, requestId\)/);
  assert.ok(
    invokeBody.indexOf("rememberRequestRoute") < invokeBody.indexOf("maybeServeTerminalThreadResumeError"),
    "cached terminal resume errors should be served after request routing is registered"
  );
  assert.ok(
    invokeBody.indexOf("maybeServeTerminalThreadResumeError") < invokeBody.indexOf("maybeHandleDomainIsolationGlobalStateFetch"),
    "terminal resume cache should short-circuit before official handlers"
  );
});

test("successful thread resume responses are reused only within one app-server lifecycle", () => {
  const serveBody = officialRuntimeFunctionSource("maybeServeThreadResumeSuccessCache", "rememberTerminalThreadResumeError");
  const rememberBody = officialRuntimeFunctionSource("rememberThreadResumeSuccess", "maybeServeReadOnlyAppServerCache");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");
  const childBody = officialRuntimeFunctionSource("trackHiddenAppServerChild", "redirectHiddenAppServerSpawn");
  const refreshBody = officialRuntimeFunctionSource("refreshHiddenOfficialRuntime", "codexRuntimeWatchPathFromFilename");

  // 成功 resume 只在同一 app-server 生命周期内复用真实回包；进程变更后必须清空，避免伪造已恢复状态。
  assert.match(source, /THREAD_RESUME_SUCCESS_CACHE_TTL_MS/);
  assert.match(source, /threadResumeSuccessCache/);
  assert.match(source, /clearThreadResumeSuccessCache/);
  assert.match(serveBody, /thread_resume_success_cache_hit/);
  assert.match(serveBody, /cloneWithReplacement/);
  assert.match(rememberBody, /thread_resume_success_cached/);
  assert.match(rememberBody, /isSuccessfulThreadResumePayload\(payload\)/);
  assert.match(routeBody, /rememberThreadResumeSuccess\(channel, args, requestSummary, requestId\)/);
  assert.match(childBody, /clearThreadResumeSuccessCache\("app_server_child_exit"\)/);
  assert.match(refreshBody, /clearThreadResumeSuccessCache\("official_runtime_refresh"\)/);
  assert.ok(
    invokeBody.indexOf("maybeServeTerminalThreadResumeError") < invokeBody.indexOf("maybeServeThreadResumeSuccessCache"),
    "archived terminal errors should stay higher priority than successful resume cache"
  );
  assert.ok(
    invokeBody.indexOf("maybeServeThreadResumeSuccessCache") < invokeBody.indexOf("maybeHandleDomainIsolationGlobalStateFetch"),
    "successful resume cache should short-circuit before official handlers"
  );
});

test("codex runtime watcher refreshes hidden official app-server on config changes", () => {
  const watcherBody = officialRuntimeFunctionSource("installCodexRuntimeWatcher", "setWsHub");
  const signatureBody = officialRuntimeFunctionSource("runtimeRestartSignatureForFile", "rememberRuntimeRestartSignature");
  const scheduleBody = officialRuntimeFunctionSource("scheduleHiddenOfficialRuntimeRefresh", "installCodexRuntimeFsWatcher");
  // ccswitch 会更新 settings；OpenCodex 需要在不刷新前台页面的情况下重启隐藏官方 runtime。
  assert.match(source, /CODEX_RUNTIME_WATCH_FILENAMES\s*=\s*new Set\(\["auth\.json"\]\)/);
  assert.match(source, /CC_SWITCH_SETTINGS_PATH\s*=\s*path\.join\(os\.homedir\(\), "\.cc-switch", "settings\.json"\)/);
  assert.match(source, /fs\.watch\(targetPath/);
  assert.match(source, /scheduleHiddenOfficialRuntimeRefresh/);
  assert.match(watcherBody, /ccSwitchSettingsWatchPathFromFilename/);
  assert.match(source, /shouldRefreshHiddenRuntimeForConfigChange\(changedPath\)/);
  assert.match(source, /codexRuntimeRestartSignatures/);
  // 官方 renderer 启动期会写前端偏好和实验开关，这些不应触发 app-server 重启打断进对话。
  assert.match(watcherBody, /config\.toml 启动期会被官方前端触碰/);
  assert.match(signatureBody, /name === "desktop"/);
  assert.match(signatureBody, /name === "features"/);
  assert.match(source, /hidden_runtime_refresh_skipped_irrelevant_config_change/);
  // 配置切换必须尽快刷新隐藏 runtime，不能因为手机/网页客户端在线而无限顺延。
  assert.doesNotMatch(scheduleBody, /hidden_runtime_refresh_deferred_for_clients/);
  assert.doesNotMatch(scheduleBody, /activeClientCount\s*>\s*0/);
  // 会话 JSONL 是高频写入文件，不能作为 app-server 重启触发源，否则前台会看到 SIGTERM 伪 fatal。
  assert.doesNotMatch(source, /CODEX_HISTORY_WATCH_DIRS/);
  assert.doesNotMatch(watcherBody, /installCodexHistoryWatcher/);
});

test("hidden official runtime refresh closes app-host relays and reloads hidden webContents", () => {
  const refreshBody = officialRuntimeFunctionSource("refreshHiddenOfficialRuntime", "codexRuntimeWatchPathFromFilename");
  const fatalBody = officialRuntimeFunctionSource("shouldSuppressExpectedAppServerFatal", "isCrossClientSyncCandidate");
  assert.match(refreshBody, /closeAllAppHostRelays\("official_runtime_refresh"\)/);
  assert.match(refreshBody, /childrenBeforeReload\s*=\s*Array\.from\(appServerSpawnHook\.activeChildren\)/);
  assert.match(refreshBody, /scheduleTrackedAppServerChildrenTermination\(reason,\s*childrenBeforeReload\)/);
  assert.match(refreshBody, /reloadHiddenOfficialRuntime\(reason\)/);
  assert.ok(
    refreshBody.indexOf("reloadHiddenOfficialRuntime(reason)") <
      refreshBody.indexOf("scheduleTrackedAppServerChildrenTermination(reason, childrenBeforeReload)"),
    "hidden runtime should reload before the old app-server process is terminated"
  );
  assert.match(source, /webContents\.reloadIgnoringCache\(\)/);
  assert.match(source, /expectedTerminations/);
  assert.match(fatalBody, /codex-app-server-fatal-error/);
  assert.match(fatalBody, /signal=SIGTERM\|SIGTERM/);
  assert.match(fatalBody, /isExpectedAppServerTerminationRecent\(\)/);
  assert.match(fatalBody, /expected_app_server_fatal_suppressed/);
  // 只读列表缓存应穿过 hidden runtime refresh，避免配置变更后重新冷扫历史会话列表。
  assert.doesNotMatch(refreshBody, /appServerReadOnlyCache\.clear\(\)/);
});

test("conversation entry auxiliary reads can use read-only cache", () => {
  // 这些读只影响首屏辅助状态；缓存它们能避免进对话时被插件、权限、实验开关扫描拖住。
  const readOnlyBody = source.slice(
    source.indexOf("const APP_SERVER_READ_ONLY_METHODS"),
    source.indexOf("const APP_SERVER_STALE_READ_ONLY_METHODS")
  );
  const readOnlyMethodBody = officialRuntimeFunctionSource("readOnlyAppServerMethodFromSummary", "readOnlyAppServerMethodFromCacheKey");
  for (const method of [
    "app/list",
    "collaborationMode/list",
    "config/read",
    "configRequirements/read",
    "experimentalFeature/list",
    "hooks/list",
    "mcpServerStatus/list",
    "model/list",
    "permissionProfile/list",
    "plugin/list",
    "thread/list",
  ]) {
    assert.match(readOnlyBody, new RegExp(JSON.stringify(method).replace("/", "\\/")));
  }
  assert.match(readOnlyMethodBody, /\["method", "requestMethod", "paramsMethod"\]/);
});

test("thread list and auxiliary state can use stale read-only cache during conversation entry", () => {
  // thread/list 是进入会话前的入口数据；旧列表比长时间白屏更可接受，详情仍由 thread/read/resume 拉新。
  const staleBody = source.slice(
    source.indexOf("const APP_SERVER_STALE_READ_ONLY_METHODS"),
    source.indexOf("const APP_SERVER_STALE_READ_ONLY_CACHE_MAX_AGE_MS")
  );
  for (const method of [
    "app/list",
    "collaborationMode/list",
    "configRequirements/read",
    "experimentalFeature/list",
    "hooks/list",
    "mcpServerStatus/list",
    "model/list",
    "permissionProfile/list",
    "plugin/list",
    "thread/list",
  ]) {
    assert.match(staleBody, new RegExp(JSON.stringify(method).replace("/", "\\/")));
  }
  // config/read 涉及供应商切换，只走短 TTL，不允许 24 小时 stale。
  assert.doesNotMatch(staleBody, /"config\/read"/);
});

test("thread detail fast-sync snapshots stay memory-only", () => {
  const fastSyncBody = officialRuntimeFunctionSource("rememberFastSyncSnapshot", "outgoingIpcDiagnosticSummary");

  assert.match(source, /memoryFastSyncCache/);
  assert.match(source, /isFastSyncSnapshotMethod/);
  assert.match(fastSyncBody, /isFastSyncCacheableMethod\(method\) \? fastSyncCache : memoryFastSyncCache/);
  assert.match(fastSyncBody, /cache\.writeSnapshot\(\{ key, method, threadId, threadSeq, value: responseValue \}\)/);
  assert.match(fastSyncBody, /gateway 内存快照/);
});

test("thread detail snapshots store latest app-host thread sequence", () => {
  const fastSyncBody = officialRuntimeFunctionSource("rememberFastSyncSnapshot", "outgoingIpcDiagnosticSummary");

  assert.match(source, /function latestAppHostThreadSeqForSnapshot/);
  assert.match(fastSyncBody, /const threadSeq = latestAppHostThreadSeqForSnapshot\(threadId\)/);
  assert.match(fastSyncBody, /cache\.writeSnapshot\(\{ key, method, threadId, threadSeq, value: responseValue \}\)/);
});

test("thread detail snapshots notify other clients for the same thread", () => {
  const fastSyncBody = officialRuntimeFunctionSource("rememberFastSyncSnapshot", "outgoingIpcDiagnosticSummary");
  const notifyBody = officialRuntimeFunctionSource("notifyOtherClientsForThreadSnapshot", "outgoingIpcDiagnosticSummary");

  assert.match(source, /function notifyOtherClientsForThreadSnapshot/);
  assert.match(fastSyncBody, /notifyOtherClientsForThreadSnapshot\(context\.clientId \|\| "", method, threadId, requestSummary\)/);
  assert.match(notifyBody, /reason: "thread-detail-snapshot"/);
  assert.match(notifyBody, /snapshotKey: \(requestSummary && requestSummary\.fastSyncSnapshotKey\) \|\| ""/);
  assert.match(notifyBody, /threadId/);
  assert.match(notifyBody, /sendToThread/);
  assert.doesNotMatch(notifyBody, /broadcastExcept/);
});

test("official feature enablement writes are no-oped before app-server", () => {
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const noopBody = officialRuntimeFunctionSource("maybeHandleDeprecatedFeatureEnablement", "invokeOfficialIpc");

  // 官方前端和当前 CLI 的实验开关集合可能错位；set 写入只同步本地 UI，不能打断会话正文加载。
  assert.match(noopBody, /experimentalFeature\/enablement\/set/);
  assert.doesNotMatch(noopBody, /containsDeprecatedExperimentalFeature/);
  assert.match(noopBody, /feature_enablement_set_noop/);
  assert.match(noopBody, /thread\/read、thread\/resume/);
  assert.match(invokeBody, /if \(maybeHandleDeprecatedFeatureEnablement\(channel, invokeArgs\)\) return true/);
});
