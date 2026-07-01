const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "server.cjs"), "utf8");

function collectResponse(handler, req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      headers: {},
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: this.headers,
          statusCode: this.statusCode,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test("fast-sync snapshot API can read by explicit snapshot key without rebuilding args", () => {
  const handlerBody = sourceBetween(serverSource, 'pathname === "/api/fast-sync/snapshot"', 'pathname === "/api/ipc/handlers"');

  // gap nudge 已经携带写入端 key，服务端必须允许直接按 key 读，避免弱网重连时再依赖完整 args 形状。
  assert.match(handlerBody, /const explicitKey = url\.searchParams\.get\("key"\) \|\| ""/);
  assert.match(handlerBody, /const threadId = url\.searchParams\.get\("threadId"\) \|\| ""/);
  assert.match(handlerBody, /let key = explicitKey/);
  assert.match(handlerBody, /if \(!key && !threadId\) \{/);
  assert.match(handlerBody, /parseFastSyncSnapshotArgsJson\(argsJson\)/);
  assert.match(handlerBody, /cache\.readSnapshot\(\{ key, method, threadId \}\)/);
});

test("fast-sync snapshot API reads latest thread detail snapshot by thread id", async () => {
  const { createRequestHandler } = require("../runtime/server.cjs");
  const { memoryFastSyncCache } = require("../runtime/core/fast-sync-cache.cjs");
  const threadId = `thread-api-${Date.now()}`;
  assert.equal(
    memoryFastSyncCache.writeSnapshot({
      key: `snapshot-${threadId}`,
      method: "thread/read",
      threadId,
      value: { threadId, title: "中间层全量状态" },
    }),
    true
  );
  const handler = createRequestHandler({
    localFiles: {},
    mobileApi: {},
    pickedFiles: {},
    staticAssets: {
      isAppShellRoute: () => false,
      isPublicStaticPath: () => false,
      staticFile: () => null,
    },
  });

  // 不传 snapshot key，也不依赖同形 args；服务端应按 threadId 命中 gateway 维护的最新全量状态。
  const response = await collectResponse(handler, {
    headers: { host: "127.0.0.1:8080" },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: `/api/fast-sync/snapshot?method=thread%2Fread&threadId=${encodeURIComponent(threadId)}`,
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.snapshot.source, "gateway-memory");
  assert.deepEqual(body.snapshot.value, { threadId, title: "中间层全量状态" });
});
