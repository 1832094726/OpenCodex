const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..", "..");
const swCachePath = path.join(repoRoot, "web-shell", "sw-cache.js");

function loadServiceWorkerHarness() {
  const source = fs.readFileSync(swCachePath, "utf8");
  const listeners = [];
  // 用 VM 加载真实 Service Worker 脚本，避免只靠字符串断言漏掉运行时分支退化。
  const context = {
    console,
    Response,
    URL,
    setTimeout: () => {},
    self: {
      addEventListener(type, handler) {
        listeners.push({ type, handler });
      },
      clients: { claim: async () => {} },
      location: { origin: "https://opencodex.test" },
      skipWaiting() {},
    },
  };
  vm.runInNewContext(
    `${source}
globalThis.__swTestHooks = {
  backgroundPrecache,
  cachedRequestUrlSet,
  PRECACHE_DELAY_MS,
  shouldUsePrecacheBundle,
};`,
    context,
    { filename: swCachePath }
  );
  return context;
}

function createFakeCache(existingUrls = []) {
  const putCalls = [];
  return {
    async keys() {
      return existingUrls.map((url) => ({ url }));
    },
    async put(url, response) {
      putCalls.push({ response, url });
    },
    putCalls,
  };
}

test("sw-cache delays background precache until after the first screen", () => {
  const context = loadServiceWorkerHarness();
  const hooks = context.__swTestHooks;

  assert.equal(hooks.PRECACHE_DELAY_MS, 30_000);
  assert.equal(hooks.shouldUsePrecacheBundle(0, 100), false);
  assert.equal(hooks.shouldUsePrecacheBundle(100, 100), true);
  assert.equal(hooks.shouldUsePrecacheBundle(1, 100), false);
  assert.equal(hooks.shouldUsePrecacheBundle(50, 100), false);
  assert.equal(hooks.shouldUsePrecacheBundle(70, 100), true);
});

test("sw-cache skips the large bundle when only a small number of assets are missing", async () => {
  const context = loadServiceWorkerHarness();
  const cache = createFakeCache(["https://opencodex.test/a.js"]);
  const fetchCalls = [];

  context.caches = { open: async () => cache };
  context.fetch = async (url) => {
    fetchCalls.push(url);
    if (url === "/api/precache-manifest") {
      return new Response(JSON.stringify(["/a.js", "/b.js"]), { status: 200 });
    }
    // 只缺一个资源时应该直接补这个文件，不能再下载完整 precache bundle 抢首屏带宽。
    if (url === "/b.js") return new Response("console.log('b')", { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  await context.__swTestHooks.backgroundPrecache();

  assert.deepEqual(fetchCalls, ["/api/precache-manifest", "/b.js"]);
  assert.equal(cache.putCalls.length, 1);
  assert.equal(cache.putCalls[0].url, "/b.js");
});

test("sw-cache uses the large bundle on a cold install", async () => {
  const context = loadServiceWorkerHarness();
  const cache = createFakeCache([]);
  const fetchCalls = [];

  context.caches = { open: async () => cache };
  context.fetch = async (url) => {
    fetchCalls.push(url);
    if (url === "/api/precache-manifest") {
      return new Response(JSON.stringify(["/a.js", "/b.css"]), { status: 200 });
    }
    // 冷启动缺失全部资源时仍保留 bundle 路径，避免弱网下打出大量小请求。
    if (url === "/api/precache-bundle") {
      return new Response(JSON.stringify({ "/a.js": "console.log('a')", "/b.css": "body{}" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await context.__swTestHooks.backgroundPrecache();

  assert.deepEqual(fetchCalls, ["/api/precache-manifest", "/api/precache-bundle"]);
  assert.equal(cache.putCalls.length, 2);
  assert.equal(cache.putCalls[0].url, "/a.js");
  assert.equal(cache.putCalls[1].url, "/b.css");
  assert.equal(cache.putCalls[1].response.headers.get("content-type"), "text/css");
});
