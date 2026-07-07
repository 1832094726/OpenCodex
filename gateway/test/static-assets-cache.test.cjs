const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

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
