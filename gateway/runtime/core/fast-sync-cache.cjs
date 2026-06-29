const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FALLBACK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = normalizeTtlMs(process.env.OPENCODEX_FAST_SYNC_CACHE_TTL_MS, FALLBACK_TTL_MS);
const CACHEABLE_METHODS = new Set([
  "account/read",
  "config/read",
  "model/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
]);
const REDACTED_VALUE = "[redacted]";
const SENSITIVE_FIELD_NAMES = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "secret",
  "apikey",
  "cookie",
  "setcookie",
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeTtlMs(value, fallbackTtlMs = DEFAULT_TTL_MS) {
  const ttlMs = Number(value);
  // TTL 必须是有限正数；env 配错时回退到硬编码 10 分钟，避免 Infinity 让快照永不过期。
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : fallbackTtlMs;
}

function stablePart(value, seen = new WeakSet(), pathParts = []) {
  if (typeof value === "bigint") return { __type: "bigint", value: value.toString() };
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item, index) => stablePart(item, seen, pathParts.concat(String(index))));

  const result = {};
  const hasRequestEnvelope = Object.prototype.hasOwnProperty.call(value, "request");
  for (const key of Object.keys(value).sort()) {
    const nextPath = pathParts.concat(key);
    // 只忽略请求包络上的易变 id；业务对象里的 id 必须保留，避免不同业务对象误命中。
    const isTopLevelWrapper = pathParts.length === 1 && /^\d+$/.test(pathParts[0]);
    if (isTopLevelWrapper && hasRequestEnvelope && (key === "id" || key === "requestId")) continue;
    if (pathParts.length === 2 && /^\d+$/.test(pathParts[0]) && pathParts[1] === "request" && key === "id") continue;
    result[key] = stablePart(value[key], seen, nextPath);
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

function normalizedFieldName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactSensitiveFields(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    // 快照会落盘，常见凭证字段统一替换，避免弱网快速恢复缓存泄露敏感信息。
    result[key] = SENSITIVE_FIELD_NAMES.has(normalizedFieldName(key)) ? REDACTED_VALUE : redactSensitiveFields(item);
  }
  return result;
}

function createFastSyncCache(options = {}) {
  const dir = options.dir || path.join(process.cwd(), ".data", "runtime", "cache", "fast-sync");
  const ttlMs = normalizeTtlMs(options.ttlMs ?? DEFAULT_TTL_MS);

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

    let tmpPath = null;
    try {
      ensureDir(dir);
      const filePath = filePathForKey(key);
      tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      // 快照写入采用临时文件再 rename，避免 gateway 重启或弱网中断时留下半截 JSON。
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ capturedAtMs, key, method, schemaVersion: 1, value: redactSensitiveFields(safeClone(value)) }),
        "utf8"
      );
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch {
      if (tmpPath) {
        try {
          // 写入任一步失败都清掉临时文件，让调用方可以安全降级为无缓存路径。
          fs.unlinkSync(tmpPath);
        } catch {}
      }
      return false;
    }
  }

  return { filePathForKey, readSnapshot, writeSnapshot };
}

module.exports = {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
};
