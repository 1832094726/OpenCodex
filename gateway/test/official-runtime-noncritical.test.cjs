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
  assert.match(invokeBody, /maybeServeCachedFetchResponse\(channel, invokeArgs, context, requestSummary\)/);
});

test("non-critical statsig telemetry is short-circuited locally", () => {
  const nonCriticalBody = officialRuntimeFunctionSource("nonCriticalFetchBodyForUrl", "sendFetchJsonResponse");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");

  // Statsig/telemetry 失败会在弱网下制造 10s timeout；这些请求不影响会话正文，必须本地空响应。
  assert.match(nonCriticalBody, /ab\.chatgpt\.com/);
  assert.match(nonCriticalBody, /\/v1\/initialize/);
  assert.match(nonCriticalBody, /\/v1\/rgstr/);
  assert.match(nonCriticalBody, /\/v1\/log_event/);
  assert.match(nonCriticalBody, /chatgpt\.com/);
  assert.match(nonCriticalBody, /\/ces\/v1\/rgstr/);
  assert.match(nonCriticalBody, /\/ces\/v1\/log_event/);
  assert.match(nonCriticalBody, /api\.segment\.io/);
  assert.match(nonCriticalBody, /pathname\.startsWith\("\/v1\/"\)/);
  assert.match(nonCriticalBody, /pathname === "\/inbox-items"/);
  assert.match(nonCriticalBody, /unreadRunCounts/);
  assert.match(nonCriticalBody, /pathname === "\/list-automations"/);
  assert.ok(
    invokeBody.indexOf("maybeHandleNonCriticalFetch") < invokeBody.indexOf("waitForOfficialBridgeReady"),
    "non-critical fetches should not wait for the hidden official bridge during cold startup"
  );
});

test("health status reports gateway source revision", () => {
  const packedRefBody = officialRuntimeFunctionSource("readGitRefCommit", "gatewaySourceStatus");
  const sourceBody = officialRuntimeFunctionSource("gatewaySourceStatus", "buildGatewayStatus");
  const healthBody = officialRuntimeFunctionSource("buildGatewayStatus", "webConfigScript");

  // Win/Mac 远程调试时需要知道当前 gateway 是否已经重启到最新代码，避免把旧进程误判成新逻辑失败。
  assert.match(packedRefBody, /packed-refs/);
  assert.match(sourceBody, /OPENCODEX_VERSION_LABEL/);
  assert.match(sourceBody, /readGitRefText\("HEAD"\)/);
  assert.match(sourceBody, /refs\\\/heads\\\//);
  assert.match(sourceBody, /commit: commit\.slice\(0, 40\)/);
  assert.match(sourceBody, /GATEWAY_LOADED_SOURCE_STATUS = gatewaySourceStatus\(\)/);
  assert.match(sourceBody, /function gatewaySourceHealthStatus/);
  assert.match(sourceBody, /loaded: GATEWAY_LOADED_SOURCE_STATUS/);
  assert.match(sourceBody, /restartRequired:/);
  assert.match(healthBody, /source: gatewaySourceHealthStatus\(\)/);
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

test("duplicate desktop feature availability events are suppressed", () => {
  const normalizeBody = officialRuntimeFunctionSource(
    "normalizeDesktopFeatureAvailabilityForBundledPlugins",
    "desktopFeatureAvailabilitySignature"
  );
  const signatureBody = officialRuntimeFunctionSource(
    "desktopFeatureAvailabilitySignature",
    "maybeHandleDuplicateDesktopFeatureAvailability"
  );
  const duplicateBody = officialRuntimeFunctionSource("maybeHandleDuplicateDesktopFeatureAvailability", "stringRouteId");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");

  // 官方 focus 会重复触发 bundled plugin reconcile；OpenCodex 的桌面能力位是静态的，短期重复签名直接确认即可。
  assert.match(source, /DESKTOP_FEATURE_AVAILABILITY_DUPLICATE_TTL_MS/);
  assert.match(normalizeBody, /browserPane: true/);
  assert.match(normalizeBody, /computerUseNodeRepl: true/);
  assert.match(signatureBody, /crypto\.createHash\("sha1"\)/);
  assert.match(signatureBody, /recordAndReplay/);
  assert.match(duplicateBody, /duplicate_electron_desktop_features_changed_suppressed/);
  assert.match(duplicateBody, /lastDesktopFeatureAvailabilitySignature/);
  assert.ok(
    invokeBody.indexOf("normalizeDesktopFeatureAvailabilityForBundledPlugins") <
      invokeBody.indexOf("maybeHandleDuplicateDesktopFeatureAvailability"),
    "feature availability should be normalized before duplicate detection"
  );
  assert.ok(
    invokeBody.indexOf("maybeHandleDuplicateDesktopFeatureAvailability") < invokeBody.indexOf("logDesktopFeatureAvailability"),
    "duplicate feature events should be suppressed before official handler dispatch"
  );
});

test("archived thread resume errors are cooled down with official response shape", () => {
  const serveBody = officialRuntimeFunctionSource("maybeServeTerminalThreadResumeError", "rememberTerminalThreadResumeError");
  const rememberBody = officialRuntimeFunctionSource("rememberTerminalThreadResumeError", "maybeServeReadOnlyAppServerCache");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");
  const archivedBody = officialRuntimeFunctionSource("archivedThreadResumeErrorText", "terminalThreadResumeErrorKey");
  const freshBody = officialRuntimeFunctionSource("hasFreshTerminalThreadResumeError", "archivedThreadResumeSessionFingerprint");
  const terminalShapeBody = officialRuntimeFunctionSource("isTerminalThreadResumeErrorPayload", "clearThreadResumeSuccessCache");

  // 归档 session 的 thread/resume 是终态错误；重复请求要复用官方真实错误回包，不再每轮慢打 app-server。
  assert.match(source, /THREAD_RESUME_TERMINAL_ERROR_TTL_MS/);
  assert.match(source, /threadResumeTerminalErrorCache/);
  assert.match(source, /archivedThreadResumeErrorText/);
  assert.match(source, /isArchivedThreadResumeError/);
  assert.match(source, /is archived\|codex unarchive/);
  assert.doesNotMatch(rememberBody, /recursiveStringMatches\(payload/);
  assert.match(rememberBody, /isTerminalThreadResumeErrorPayload\(cacheKey, payload, sessionFingerprint\)/);
  assert.match(serveBody, /thread_resume_terminal_error_cache_hit/);
  assert.match(serveBody, /cloneWithReplacement/);
  assert.match(freshBody, /sessionFingerprintFromMatch\(threadId, entry\.sessionFingerprint\)/);
  assert.match(freshBody, /!current\.archived/);
  assert.match(terminalShapeBody, /isArchivedThreadResumeError\(payload\)/);
  assert.match(terminalShapeBody, /sessionFingerprint && sessionFingerprint\.archived/);
  assert.match(rememberBody, /thread_resume_terminal_error_cached/);
  assert.match(rememberBody, /cloneCacheableResponseArgs/);
  assert.match(rememberBody, /archivedThreadResumeSessionFingerprint\(cacheKey\)/);
  assert.match(rememberBody, /isTerminalThreadResumeErrorPayload\(cacheKey, payload, sessionFingerprint\)/);
  assert.match(rememberBody, /archivedBySessionFingerprint/);
  assert.match(rememberBody, /sessionFingerprint/);
  for (const wrapper of ["response", "payload", "result", "data", "body", "value"]) {
    assert.match(archivedBody, new RegExp(JSON.stringify(wrapper)));
  }
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

test("successful thread resume responses survive app-server exits when session file is unchanged", () => {
  const successShapeBody = officialRuntimeFunctionSource("hasExplicitThreadResumeSuccessPayload", "collectArchivedResumeErrorText");
  const skipReasonBody = officialRuntimeFunctionSource("threadResumeSuccessCacheSkipReason", "threadResumePayloadShape");
  const shapeBody = officialRuntimeFunctionSource("threadResumePayloadShape", "collectArchivedResumeErrorText");
  const successPayloadBody = officialRuntimeFunctionSource("isSuccessfulThreadResumePayload", "maybeServeTerminalThreadResumeError");
  const serveBody = officialRuntimeFunctionSource("maybeServeThreadResumeSuccessCache", "rememberTerminalThreadResumeError");
  const rememberBody = officialRuntimeFunctionSource("rememberThreadResumeSuccess", "maybeServeReadOnlyAppServerCache");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");
  const childBody = officialRuntimeFunctionSource("trackHiddenAppServerChild", "redirectHiddenAppServerSpawn");
  const refreshBody = officialRuntimeFunctionSource("refreshHiddenOfficialRuntime", "codexRuntimeWatchPathFromFilename");
  const validateBody = officialRuntimeFunctionSource("validateThreadResumeSuccessCacheEntry", "hasFreshTerminalThreadResumeError");

  // 成功 resume 复用真实回包；app-server 子进程退出后也可复用，但必须由本地 JSONL 指纹保护。
  assert.match(source, /THREAD_RESUME_SUCCESS_CACHE_TTL_MS/);
  assert.match(source, /THREAD_RESUME_SESSION_FINGERPRINT_RECENT_FILE_LIMIT/);
  assert.match(source, /THREAD_RESUME_SESSION_FINGERPRINT_HASH_BYTES/);
  assert.match(source, /THREAD_RESUME_SESSION_VISIBLE_TAIL_BYTES/);
  assert.match(source, /threadResumeSuccessCache/);
  assert.match(source, /threadResumeSessionFileCache/);
  assert.match(source, /visibleThreadResumeSignature/);
  assert.match(source, /threadResumeAppendIsSafe/);
  assert.match(source, /clearThreadResumeSuccessCache/);
  assert.match(successShapeBody, /payload\.responseType === "success"/);
  assert.match(successShapeBody, /payload\.type === "mcp-response"/);
  assert.match(successShapeBody, /Object\.prototype\.hasOwnProperty\.call\(payload\.message, "result"\)/);
  assert.match(successShapeBody, /Object\.prototype\.hasOwnProperty\.call\(payload, "result"\)/);
  assert.match(successShapeBody, /!payload\.message\.error/);
  assert.match(successShapeBody, /\["message", "response", "payload", "result", "data", "body", "value"\]/);
  assert.match(successShapeBody, /Array\.isArray\(payload\)/);
  assert.match(skipReasonBody, /missing_payload/);
  assert.match(skipReasonBody, /no_explicit_success_payload/);
  assert.match(skipReasonBody, /archived_error/);
  assert.match(shapeBody, /payloadType/);
  assert.match(shapeBody, /responseType/);
  assert.match(shapeBody, /keys/);
  assert.match(shapeBody, /只记录包装层 key 和类型，不记录正文内容/);
  assert.match(successPayloadBody, /threadResumeSuccessCacheSkipReason\(payload\)/);
  assert.match(serveBody, /thread_resume_success_cache_hit/);
  assert.match(serveBody, /validateThreadResumeSuccessCacheEntry\(cacheKey, entry\)/);
  assert.match(serveBody, /thread_resume_success_cache_invalidated/);
  assert.match(serveBody, /cloneWithReplacement/);
  assert.match(rememberBody, /thread_resume_success_cached/);
  assert.match(rememberBody, /thread_resume_success_cache_skipped/);
  assert.match(rememberBody, /threadResumePayloadShape\(payload\)/);
  assert.match(rememberBody, /threadResumeSuccessCacheSkipReason\(payload\)/);
  assert.match(rememberBody, /findThreadResumeSessionFingerprint\(cacheKey\)/);
  assert.match(rememberBody, /sessionFingerprint && sessionFingerprint\.archived/);
  assert.match(rememberBody, /thread_resume_success_cache_skipped_archived_session/);
  assert.match(rememberBody, /appServerChildEpoch/);
  assert.match(rememberBody, /sessionFingerprint/);
  assert.match(routeBody, /rememberThreadResumeSuccess\(channel, args, requestSummary, requestId\)/);
  assert.match(childBody, /appServerChildEpoch \+= 1/);
  assert.doesNotMatch(childBody, /clearThreadResumeSuccessCache\("app_server_child_exit"\)/);
  assert.match(childBody, /clearThreadResumeInFlight\("app_server_child_exit"\)/);
  assert.match(validateBody, /same_app_server_lifecycle/);
  assert.match(validateBody, /same_app_server_lifecycle_session_changed/);
  assert.match(validateBody, /missing_session_fingerprint/);
  assert.match(validateBody, /session_fingerprint_match/);
  assert.match(validateBody, /session_file_touched/);
  assert.match(validateBody, /session_visible_messages_changed/);
  assert.match(validateBody, /session_nonvisible_append_ignored/);
  assert.match(validateBody, /session_nonvisible_state_changed/);
  assert.match(validateBody, /visibleSignature/);
  assert.match(validateBody, /contentHash/);
  assert.match(validateBody, /session_file_changed/);
  assert.match(refreshBody, /clearThreadResumeSuccessCache\("official_runtime_refresh"\)/);
  assert.match(refreshBody, /clearThreadResumeInFlight\("official_runtime_refresh"\)/);
  assert.ok(
    invokeBody.indexOf("maybeServeTerminalThreadResumeError") < invokeBody.indexOf("maybeServeThreadResumeSuccessCache"),
    "archived terminal errors should stay higher priority than successful resume cache"
  );
  assert.ok(
    invokeBody.indexOf("maybeServeThreadResumeSuccessCache") < invokeBody.indexOf("maybeHandleDomainIsolationGlobalStateFetch"),
    "successful resume cache should short-circuit before official handlers"
  );
});

test("duplicate thread resume requests are coalesced while the first resume is in flight", () => {
  const coalesceBody = officialRuntimeFunctionSource("maybeCoalesceThreadResumeInFlight", "dispatchThreadResumeInFlightResponses");
  const dispatchBody = officialRuntimeFunctionSource("dispatchThreadResumeInFlightResponses", "rememberTerminalThreadResumeError");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");

  // 首个 thread/resume 仍走官方 app-server；同一 thread 的重复 resume 等真实回包后按 requestId 复制，避免弱网下并发慢恢复。
  assert.match(source, /threadResumeInFlight/);
  assert.match(source, /THREAD_RESUME_IN_FLIGHT_TTL_MS/);
  assert.match(coalesceBody, /thread_resume_inflight_coalesced/);
  assert.match(coalesceBody, /duplicateRequestIds\.add\(requestId\)/);
  assert.match(dispatchBody, /thread_resume_inflight_replayed/);
  assert.match(dispatchBody, /cloneWithReplacement\(args, requestId, duplicateRequestId\)/);
  assert.match(dispatchBody, /routeOfficialWebContentsSend\(channel, responseArgs\)/);
  assert.match(routeBody, /dispatchThreadResumeInFlightResponses\(channel, args, requestSummary, requestId\)/);
  assert.ok(
    invokeBody.indexOf("maybeServeThreadResumeSuccessCache") < invokeBody.indexOf("maybeCoalesceThreadResumeInFlight"),
    "successful resume cache should be used before in-flight coalescing"
  );
  assert.ok(
    invokeBody.indexOf("maybeCoalesceThreadResumeInFlight") < invokeBody.indexOf("maybeHandleDomainIsolationGlobalStateFetch"),
    "duplicate in-flight resume should stop before official handler dispatch"
  );
});

test("large local sessions can skip blocking resume after thread detail snapshot", () => {
  const fastPathBody = officialRuntimeFunctionSource("maybeServeLargeSessionThreadResumeFastPath", "maybeCoalesceThreadResumeInFlight");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");

  // 超大活动 session 首次 resume 会被官方 app-server 读完整 JSONL 拖慢；已有 thread/read 快照时先放行 UI。
  assert.match(source, /THREAD_RESUME_LARGE_SESSION_BYTES/);
  assert.match(source, /OPENCODEX_THREAD_RESUME_LARGE_SESSION_BYTES/);
  assert.match(fastPathBody, /isThreadResumeMethod\(requestSummary\)/);
  assert.match(fastPathBody, /findThreadResumeSessionFingerprint\(threadId\)/);
  assert.match(fastPathBody, /sessionFingerprint\.archived/);
  assert.match(fastPathBody, /sessionFingerprint\.size/);
  assert.match(fastPathBody, /memoryFastSyncCache\.readSnapshot\(\{ method: "thread\/read", threadId \}\)/);
  assert.match(fastPathBody, /large-session-thread-read-snapshot-ready/);
  assert.match(fastPathBody, /thread_resume_large_session_fast_path/);
  assert.match(fastPathBody, /routeOfficialWebContentsSend\(MESSAGE_FOR_VIEW_CHANNEL, responseArgs\)/);
  assert.match(routeBody, /rememberThreadResumeSuccess\(channel, args, requestSummary, requestId\)/);
  assert.ok(
    invokeBody.indexOf("maybeServeThreadResumeSuccessCache") < invokeBody.indexOf("maybeServeLargeSessionThreadResumeFastPath"),
    "real successful resume cache should stay higher priority than synthetic large-session fast path"
  );
  assert.ok(
    invokeBody.indexOf("maybeServeLargeSessionThreadResumeFastPath") < invokeBody.indexOf("maybeCoalesceThreadResumeInFlight"),
    "large-session fast path should stop before creating a slow in-flight resume"
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

test("duplicate read-only app-server requests are coalesced while the first read is in flight", () => {
  const coalesceBody = officialRuntimeFunctionSource("maybeCoalesceReadOnlyAppServerInFlight", "dispatchReadOnlyAppServerInFlightResponses");
  const dispatchBody = officialRuntimeFunctionSource("dispatchReadOnlyAppServerInFlightResponses", "rememberReadOnlyAppServerResponse");
  const routeBody = officialRuntimeFunctionSource("routeOfficialWebContentsSend", "shouldSuppressHiddenRendererSend");
  const invokeBody = officialRuntimeFunctionSource("invokeOfficialIpc", "connectOfficialAppHostPort");
  const childBody = officialRuntimeFunctionSource("trackHiddenAppServerChild", "redirectHiddenAppServerSpawn");
  const refreshBody = officialRuntimeFunctionSource("refreshHiddenOfficialRuntime", "codexRuntimeWatchPathFromFilename");

  // config/read 等首屏辅助读会在官方启动期重复并发；重复请求等待首个真实回包，减少 app-server 队列压力。
  assert.match(source, /APP_SERVER_READ_ONLY_IN_FLIGHT_TTL_MS/);
  assert.match(source, /appServerReadOnlyInFlight/);
  assert.match(coalesceBody, /read_only_inflight_coalesced/);
  assert.match(coalesceBody, /duplicateRequestIds\.add\(requestId\)/);
  assert.match(dispatchBody, /read_only_inflight_replayed/);
  assert.match(dispatchBody, /cloneWithReplacement\(args, requestId, duplicateRequestId\)/);
  assert.match(dispatchBody, /routeOfficialWebContentsSend\(channel, responseArgs\)/);
  assert.match(routeBody, /dispatchReadOnlyAppServerInFlightResponses\(channel, args, requestSummary, requestId\)/);
  assert.match(childBody, /clearAppServerReadOnlyInFlight\("app_server_child_exit"\)/);
  assert.match(refreshBody, /clearAppServerReadOnlyInFlight\("official_runtime_refresh"\)/);
  assert.ok(
    invokeBody.indexOf("maybeServeReadOnlyAppServerCache") < invokeBody.indexOf("maybeCoalesceReadOnlyAppServerInFlight"),
    "cached read-only responses should be served before in-flight coalescing"
  );
  assert.ok(
    invokeBody.indexOf("maybeCoalesceReadOnlyAppServerInFlight") < invokeBody.indexOf("maybeServeTerminalThreadResumeError"),
    "duplicate read-only requests should stop before official handler dispatch"
  );
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
