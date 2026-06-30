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
    "sessionStorage.getItem",
    "sessionStorage.setItem",
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

  assert.match(source, /只缓存 mobile-lite API 已裁剪 DTO/);
  assert.match(source, /payload\.ok !== true/);
  assert.doesNotMatch(source, /plugin\/list|mcpServerStatus\/list|desktop-state/);
});
