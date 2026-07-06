const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const entryHtmlPath = path.join(repoRoot, "web-shell", "index.html");

function readEntryHtml() {
  return fs.readFileSync(entryHtmlPath, "utf8");
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test("entry handoff does not prefetch renderer html or block on service worker cache", () => {
  const source = readEntryHtml();
  const bootRendererBody = sourceBetween(source, "async function bootRenderer()", "function utf8Bytes");

  // 入口页已经先完成 authStatus/login；handoff 阶段不能再多请求一次 renderer HTML。
  assert.match(bootRendererBody, /rendererUrl\.searchParams\.set\("__opencodex_renderer", "1"\)/);
  assert.match(bootRendererBody, /location\.replace\(`\$\{rendererUrl\.pathname\}\$\{rendererUrl\.search\}\$\{rendererUrl\.hash\}`\)/);
  assert.doesNotMatch(bootRendererBody, /await\s+withTimeout\(navigator\.serviceWorker\.ready/);
  assert.doesNotMatch(bootRendererBody, /await\s+new Promise\(\(resolve\).*cache-status/s);
  assert.doesNotMatch(bootRendererBody, /fetch\(rendererUrl/);
});

test("entry shell does not load desktop plugins before renderer handoff", () => {
  const source = readEntryHtml();

  // 入口壳很快会切到官方 renderer；插件只应在 renderer 里延后加载，避免这页先做一轮即将被销毁的脚本请求。
  assert.match(source, /opencodex-plugin-system\.js/);
  assert.doesNotMatch(source, /opencodex-plugin-loader\.js/);
});
