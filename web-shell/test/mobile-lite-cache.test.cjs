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

test("mobile lite connects realtime events from the detail snapshot offset", () => {
  const source = readMobileSource();

  assert.match(source, /nextEventOffset/);
  assert.match(source, /sinceOffset=/);
  assert.match(source, /connectThreadEvents\(threadId, payload\.metrics && payload\.metrics\.nextEventOffset\)/);
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
