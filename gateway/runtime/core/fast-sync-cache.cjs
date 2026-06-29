const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = Number(process.env.OPENCODEX_FAST_SYNC_CACHE_TTL_MS || 10 * 60 * 1000);
const CACHEABLE_METHODS = new Set([
  "account/read",
  "config/read",
  "model/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stablePart(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stablePart(item, seen));

  const result = {};
  for (const key of Object.keys(value).sort()) {
    // 请求 id 每次调用都会变化，不能参与缓存 key，否则同一个首屏读请求无法命中快照。
    if (key === "id" || key === "requestId") continue;
    result[key] = stablePart(value[key], seen);
  }
  return result;
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text)).digest("base64url");
}

function isFastSyncCacheableMethod(method) {
  return CACHEABLE_METHODS.has(String(method || ""));
}

function cacheKeyForSnapshot(method, args) {
  return hashText(JSON.stringify({ method, args: stablePart(args || []) }));
}

function safeClone(value) {
  if (value == null || typeof value !== "object") return value;
  // 只缓存可 JSON 序列化的数据，避免把运行时对象引用或函数写入磁盘。
  return JSON.parse(JSON.stringify(value));
}

function createFastSyncCache(options = {}) {
  const dir = options.dir || path.join(process.cwd(), ".data", "runtime", "cache", "fast-sync");
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);

  function filePathForKey(key) {
    return path.join(dir, `${hashText(key)}.json`);
  }

  function readSnapshot({ key }) {
    const filePath = filePathForKey(key);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;

      const capturedAtMs = Number(parsed.capturedAtMs) || 0;
      if (capturedAtMs <= 0 || Date.now() - capturedAtMs > ttlMs) return null;

      return {
        capturedAtMs,
        key: parsed.key,
        method: parsed.method,
        source: "gateway-disk",
        value: safeClone(parsed.value),
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        try {
          // 损坏快照直接删除，后续让官方响应重新填充，避免反复解析失败拖慢首屏。
          fs.unlinkSync(filePath);
        } catch {}
      }
      return null;
    }
  }

  function writeSnapshot({ capturedAtMs = Date.now(), key, method, value }) {
    if (!key || !isFastSyncCacheableMethod(method)) return false;

    ensureDir(dir);
    const filePath = filePathForKey(key);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    // 快照写入采用临时文件再 rename，避免 gateway 重启或弱网中断时留下半截 JSON。
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ capturedAtMs, key, method, schemaVersion: 1, value: safeClone(value) }),
      "utf8"
    );
    fs.renameSync(tmpPath, filePath);
    return true;
  }

  return { filePathForKey, readSnapshot, writeSnapshot };
}

module.exports = {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
};
