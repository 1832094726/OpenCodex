const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PATCHED_OFFICIAL_PREFIX, WEB_SHELL_DIR } = require("../runtime/core/config.cjs");
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");

function collectResponse(handler, req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      headers: {},
      statusCode: 0,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers || {};
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        resolve({
          bodyBuffer: Buffer.concat(chunks),
          headers: this.headers,
          statusCode: this.statusCode,
        });
      },
      on(event, callback) {
        if (event === "error") reject(callback);
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("serveFile reuses cached static responses until the source file changes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-static-cache-"));
  const asset = path.join(tempRoot, "app-main-cache-test.js");
  const reqPath = "/official/assets/app-main-cache-test.js";
  fs.writeFileSync(asset, `console.log(${JSON.stringify("首屏缓存".repeat(400))});`);

  const staticAssets = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => null,
  });
  const originalReadFileSync = fs.readFileSync;
  let assetReads = 0;
  fs.readFileSync = function readFileSyncWithCounter(target, ...args) {
    if (path.resolve(String(target)) === asset) assetReads += 1;
    return originalReadFileSync.call(this, target, ...args);
  };

  try {
    const request = {
      headers: { "accept-encoding": "gzip, deflate" },
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
    };
    const first = await collectResponse((req, res) => staticAssets.serveFile(req, res, asset, 200, reqPath), request);
    const second = await collectResponse((req, res) => staticAssets.serveFile(req, res, asset, 200, reqPath), request);

    assert.equal(assetReads, 1);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.headers.etag, second.headers.etag);
    assert.equal(first.headers["content-encoding"], "gzip");
    assert.deepEqual(first.bodyBuffer, second.bodyBuffer);

    fs.writeFileSync(asset, `console.log(${JSON.stringify("首屏缓存已更新".repeat(500))});`);
    fs.utimesSync(asset, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    const third = await collectResponse((req, res) => staticAssets.serveFile(req, res, asset, 200, reqPath), request);

    assert.equal(assetReads, 2);
    assert.notEqual(third.headers.etag, first.headers.etag);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("official asset file listings are reused across renderer and precache lookups", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-asset-list-cache-"));
  const assetsDir = path.join(tempRoot, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "index.html"), "<!doctype html><html><head><title>Codex</title></head><body></body></html>");
  for (const fileName of [
    "app-main-cache-list.js",
    "app-shell-cache-list.js",
    "index-cache-list.js",
    "modulepreload-polyfill-cache-list.js",
    "preload-helper-cache-list.js",
    "app-main-cache-list.css",
    "app-shell-cache-list.css",
  ]) {
    fs.writeFileSync(path.join(assetsDir, fileName), fileName.endsWith(".js") ? "export default null;" : "body{}");
  }

  const staticAssets = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => ({ webviewDir: tempRoot }),
  });
  const originalReaddirSync = fs.readdirSync;
  let assetDirReads = 0;
  fs.readdirSync = function readdirSyncWithCounter(target, ...args) {
    if (path.resolve(String(target)) === assetsDir) assetDirReads += 1;
    return originalReaddirSync.call(this, target, ...args);
  };

  try {
    const desktop = staticAssets.createRendererResponse({ mobileTrafficMode: false });
    const mobile = staticAssets.createRendererResponse({ mobileTrafficMode: true });
    const manifest = staticAssets.createPrecacheManifest();
    const cachedManifest = staticAssets.createPrecacheManifest();

    assert.equal(assetDirReads, 1);
    assert.equal((desktop.match(/rel="modulepreload"/g) || []).length, 5);
    assert.equal((mobile.match(/rel="modulepreload"/g) || []).length, 1);
    // 预缓存清单只依赖官方 assets 文件列表；目录未变时直接复用，减少连续入口请求的清单拼装成本。
    assert.strictEqual(cachedManifest, manifest);
    assert.equal(Object.isFrozen(cachedManifest), true);
    assert.ok(manifest.includes("/official/assets/app-main-cache-list.css"));
    assert.ok(manifest.includes(`${PATCHED_OFFICIAL_PREFIX}assets/app-main-cache-list.js`));

    fs.writeFileSync(path.join(assetsDir, "zz-cache-list-new.js"), "export default 1;");
    fs.utimesSync(assetsDir, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    const refreshedManifest = staticAssets.createPrecacheManifest();

    assert.equal(assetDirReads, 2);
    assert.notStrictEqual(refreshedManifest, manifest);
    assert.ok(refreshedManifest.includes(`${PATCHED_OFFICIAL_PREFIX}assets/zz-cache-list-new.js`));
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("renderer html source is cached while request-specific transforms stay dynamic", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-html-source-cache-"));
  const indexFile = path.join(tempRoot, "index.html");
  fs.mkdirSync(path.join(tempRoot, "assets"), { recursive: true });
  fs.writeFileSync(indexFile, '<!doctype html><html><head><title>Codex</title></head><body><div id="root"></div></body></html>');

  const staticAssets = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => ({ webviewDir: tempRoot }),
  });
  const originalReadFileSync = fs.readFileSync;
  let indexReads = 0;
  fs.readFileSync = function readFileSyncWithCounter(target, ...args) {
    if (path.resolve(String(target)) === indexFile) indexReads += 1;
    return originalReadFileSync.call(this, target, ...args);
  };

  try {
    const first = staticAssets.createRendererResponse({ initialRoute: "/local/thread-a", mobileTrafficMode: true });
    const second = staticAssets.createRendererResponse({ initialRoute: "/local/thread-b", mobileTrafficMode: true });

    assert.equal(indexReads, 1);
    assert.match(first, /\/local\/thread-a/);
    assert.match(second, /\/local\/thread-b/);

    fs.writeFileSync(indexFile, '<!doctype html><html><head><title>Codex Updated</title></head><body></body></html>');
    fs.utimesSync(indexFile, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    const updated = staticAssets.createRendererResponse({ initialRoute: "/local/thread-c", mobileTrafficMode: true });

    assert.equal(indexReads, 2);
    assert.match(updated, /Codex Updated/);
    assert.match(updated, /\/local\/thread-c/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("web-shell bridge script versions reuse a short cache during renderer handoff", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-static-version-cache-"));
  fs.mkdirSync(path.join(tempRoot, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "index.html"),
    '<!doctype html><html><head><title>Codex</title></head><body><div id="root"></div></body></html>'
  );

  const staticAssets = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => ({ webviewDir: tempRoot }),
  });
  const versionedBridgeFiles = new Set(
    ["opencodex-fast-sync.js", "snapshot-repair-state.js", "codex-bridge-polyfill.js"].map((fileName) =>
      path.resolve(WEB_SHELL_DIR, fileName)
    )
  );
  const originalStatSync = fs.statSync;
  const originalNow = Date.now;
  let bridgeVersionStats = 0;
  let now = 1_000_000;
  fs.statSync = function statSyncWithCounter(target, ...args) {
    if (versionedBridgeFiles.has(path.resolve(String(target)))) bridgeVersionStats += 1;
    return originalStatSync.call(this, target, ...args);
  };
  Date.now = () => now;

  try {
    // 同一秒内连续 handoff 不应反复 stat 固定 bridge 脚本，避免手机端刷新时把入口生成卡在同步 IO 上。
    staticAssets.createRendererResponse({ initialRoute: "/local/thread-a", mobileTrafficMode: true });
    staticAssets.createRendererResponse({ initialRoute: "/local/thread-b", mobileTrafficMode: true });
    assert.equal(bridgeVersionStats, 3);

    now += 1_100;
    staticAssets.createRendererResponse({ initialRoute: "/local/thread-c", mobileTrafficMode: true });
    assert.equal(bridgeVersionStats, 6);
  } finally {
    fs.statSync = originalStatSync;
    Date.now = originalNow;
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
