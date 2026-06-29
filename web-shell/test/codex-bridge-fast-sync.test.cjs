const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const polyfillPath = path.join(repoRoot, "web-shell", "codex-bridge-polyfill.js");

function readPolyfillSource() {
  return fs.readFileSync(polyfillPath, "utf8");
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
