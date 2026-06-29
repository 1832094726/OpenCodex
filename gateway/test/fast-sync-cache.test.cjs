const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
} = require("../runtime/core/fast-sync-cache.cjs");

const cacheModulePath = require.resolve("../runtime/core/fast-sync-cache.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-fast-sync-test-"));
}

test("allows only first-screen read methods", () => {
  assert.equal(isFastSyncCacheableMethod("thread/list"), true);
  assert.equal(isFastSyncCacheableMethod("thread/read"), true);
  assert.equal(isFastSyncCacheableMethod("thread/turns/list"), true);
  assert.equal(isFastSyncCacheableMethod("config/read"), true);
  assert.equal(isFastSyncCacheableMethod("model/list"), true);
  assert.equal(isFastSyncCacheableMethod("plugin/list"), false);
  assert.equal(isFastSyncCacheableMethod("turn/start"), false);
});

test("cache keys ignore volatile request ids", () => {
  const first = cacheKeyForSnapshot("thread/read", [{ id: "a", threadId: "t1" }]);
  const second = cacheKeyForSnapshot("thread/read", [{ id: "b", threadId: "t1" }]);
  assert.equal(first, second);
});

test("cache keys keep nested business ids", () => {
  const first = cacheKeyForSnapshot("thread/read", [{ request: { id: "r1" }, thread: { id: "t1" } }]);
  const second = cacheKeyForSnapshot("thread/read", [{ request: { id: "r1" }, thread: { id: "t2" } }]);
  assert.notEqual(first, second);
});

test("cache keys ignore nested request ids", () => {
  const first = cacheKeyForSnapshot("thread/read", [{ request: { id: "r1" }, threadId: "t1" }]);
  const second = cacheKeyForSnapshot("thread/read", [{ request: { id: "r2" }, threadId: "t1" }]);
  assert.equal(first, second);
});

test("cache keys handle non-json args without throwing", () => {
  const args = [{ threadId: 1n }];
  args[0].self = args[0];
  assert.doesNotThrow(() => cacheKeyForSnapshot("thread/read", args));
  assert.equal(cacheKeyForSnapshot("thread/read", args), cacheKeyForSnapshot("thread/read", args));
});

test("writes and reads a snapshot from disk", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: 60_000 });
  const key = cacheKeyForSnapshot("thread/read", [{ threadId: "t1" }]);
  cache.writeSnapshot({ key, method: "thread/read", value: { threadId: "t1", title: "Hello" } });
  assert.deepEqual(cache.readSnapshot({ key })?.value, { threadId: "t1", title: "Hello" });
});

test("writeSnapshot returns false for circular or bigint values", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: 60_000 });
  const circular = { threadId: "t1" };
  circular.self = circular;

  assert.equal(
    cache.writeSnapshot({ key: cacheKeyForSnapshot("thread/read", [{ threadId: "t1" }]), method: "thread/read", value: circular }),
    false
  );
  assert.equal(
    cache.writeSnapshot({ key: cacheKeyForSnapshot("thread/read", [{ threadId: "t2" }]), method: "thread/read", value: { count: 1n } }),
    false
  );
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }), []);
});

test("expired snapshots are ignored", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: 1 });
  const key = cacheKeyForSnapshot("thread/list", []);
  cache.writeSnapshot({ key, method: "thread/list", value: { items: [] }, capturedAtMs: Date.now() - 10_000 });
  assert.equal(cache.readSnapshot({ key }), null);
});

test("invalid ttl options fall back to the default ttl", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: -1 });
  const key = cacheKeyForSnapshot("thread/list", []);
  cache.writeSnapshot({ key, method: "thread/list", value: { items: [] } });
  assert.deepEqual(cache.readSnapshot({ key })?.value, { items: [] });
});

test("invalid env default ttl falls back to ten minutes", () => {
  const dir = tempDir();
  const previousTtl = process.env.OPENCODEX_FAST_SYNC_CACHE_TTL_MS;

  try {
    process.env.OPENCODEX_FAST_SYNC_CACHE_TTL_MS = "Infinity";
    delete require.cache[cacheModulePath];

    const freshModule = require("../runtime/core/fast-sync-cache.cjs");
    const cache = freshModule.createFastSyncCache({ dir });
    const key = freshModule.cacheKeyForSnapshot("thread/list", []);
    cache.writeSnapshot({ key, method: "thread/list", value: { items: [] }, capturedAtMs: Date.now() - 11 * 60 * 1000 });

    assert.equal(cache.readSnapshot({ key }), null);
  } finally {
    if (previousTtl == null) {
      delete process.env.OPENCODEX_FAST_SYNC_CACHE_TTL_MS;
    } else {
      process.env.OPENCODEX_FAST_SYNC_CACHE_TTL_MS = previousTtl;
    }
    delete require.cache[cacheModulePath];
  }
});

test("corrupt snapshots are deleted and treated as missing", () => {
  const dir = tempDir();
  const cache = createFastSyncCache({ dir, ttlMs: 60_000 });
  const key = cacheKeyForSnapshot("thread/read", [{ threadId: "t1" }]);
  fs.writeFileSync(cache.filePathForKey(key), "{not-json", "utf8");
  assert.equal(cache.readSnapshot({ key }), null);
  assert.equal(fs.existsSync(cache.filePathForKey(key)), false);
});
