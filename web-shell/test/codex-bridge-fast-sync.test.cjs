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

test("fast sync snapshot allowlist stays limited to first-screen reads", () => {
  const source = readPolyfillSource();
  const expectedMethods = [
    "account/read",
    "config/read",
    "model/list",
    "thread/list",
    "thread/read",
    "thread/turns/list",
  ];

  assert.match(source, /FAST_SYNC_SNAPSHOT_METHODS/);
  for (const method of expectedMethods) {
    assert.match(source, new RegExp(JSON.stringify(method)));
  }

  const allowlistBlock = source.match(/FAST_SYNC_SNAPSHOT_METHODS[\s\S]*?\]\);/);
  assert.ok(allowlistBlock, "expected a local fast-sync allowlist block");
  // 浏览器首屏快照只能服务安全只读方法，避免插件列表、发起 turn 和未知写操作被错误复用。
  assert.doesNotMatch(allowlistBlock[0], /"plugin\/list"/);
  assert.doesNotMatch(allowlistBlock[0], /"turn\/start"/);
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

test("token usage inline waits until conversation entry is idle", () => {
  const source = fs.readFileSync(path.join(repoRoot, "web-shell/plugins/token-usage-inline/index.js"), "utf8");
  // token 用量 badge 是辅助信息，必须晚于会话正文加载，避免抢占 thread/resume 和 turns/list。
  assert.match(source, /REQUEST_IDLE_DELAY_MS = 5000/);
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
