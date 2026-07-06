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
]);
const MEMORY_CACHEABLE_METHODS = new Set([
  "thread/read",
  "thread/turns/list",
]);
const REDACTED_VALUE = "[redacted]";
const SENSITIVE_FIELD_PARTS = [
  "token",
  "authorization",
  "password",
  "secret",
  "apikey",
  "cookie",
  "setcookie",
];

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

function isFastSyncMemoryCacheableMethod(method) {
  return MEMORY_CACHEABLE_METHODS.has(String(method || ""));
}

function isFastSyncSnapshotMethod(method) {
  return isFastSyncCacheableMethod(method) || isFastSyncMemoryCacheableMethod(method);
}

function cacheKeyForSnapshot(method, args) {
  return hashText(JSON.stringify({ method, args: stablePart(args || []) }));
}

function parseFastSyncSnapshotArgsJson(argsJson) {
  try {
    const args = JSON.parse(String(argsJson || "[]"));
    // 读取端必须和 IPC 写入端同样使用数组参数，避免对象/数组形状不同导致 key 漂移。
    return Array.isArray(args) ? { args, ok: true } : { error: "Invalid args JSON", ok: false };
  } catch {
    return { error: "Invalid args JSON", ok: false };
  }
}

function valueFromFastSyncFetchResponsePayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false };
  if (payload.type === "fetch-response") {
    if (payload.responseType !== "success") return { ok: false };
    // 只有明确 2xx 的成功响应才写快照；缺失 status、重定向和错误响应都交给官方实时链路处理。
    if (!Number.isFinite(payload.status) || payload.status < 200 || payload.status >= 300) return { ok: false };
    const raw = typeof payload.bodyJsonString === "string" ? payload.bodyJsonString : "";
    if (!raw) return { ok: false };
    try {
      // null 是合法 JSON 响应，不能和“不可缓存”共用同一个 sentinel。
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }
  if (payload.type !== "mcp-response") return { ok: false };
  const message =
    payload.message && typeof payload.message === "object"
      ? payload.message
      : payload.response && typeof payload.response === "object"
        ? payload.response
        : payload;
  // 官方 app-server 的 thread/read 等详情请求走 MCP 回包；成功 result 要进入内存快照供弱网补偿。
  if (!message || typeof message !== "object" || Object.prototype.hasOwnProperty.call(message, "error")) return { ok: false };
  if (Object.prototype.hasOwnProperty.call(message, "result")) return { ok: true, value: safeClone(message.result) };
  return { ok: false };
}

function safeClone(value) {
  if (value == null || typeof value !== "object") return value;
  // 只缓存可 JSON 序列化的数据，避免把运行时对象引用或函数写入磁盘。
  return JSON.parse(JSON.stringify(value));
}

function normalizedFieldName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveFieldName(key) {
  const normalized = normalizedFieldName(key);
  return SENSITIVE_FIELD_PARTS.some((part) => normalized.includes(part));
}

function redactSensitiveFields(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    // 快照会落盘，常见凭证字段统一替换，避免弱网快速恢复缓存泄露敏感信息。
    result[key] = isSensitiveFieldName(key) ? REDACTED_VALUE : redactSensitiveFields(item);
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

function createMemoryFastSyncCache(options = {}) {
  const ttlMs = normalizeTtlMs(options.ttlMs ?? process.env.OPENCODEX_FAST_SYNC_MEMORY_CACHE_TTL_MS, FALLBACK_TTL_MS);
  const maxEntries = Math.max(10, Number(options.maxEntries || process.env.OPENCODEX_FAST_SYNC_MEMORY_CACHE_MAX_ENTRIES) || 200);
  const snapshots = new Map();
  const keyByMethodThreadId = new Map();

  function methodThreadKey(method, threadId) {
    return `${method || ""}\n${threadId || ""}`;
  }

  function prune(nowMs = Date.now()) {
    for (const [key, entry] of snapshots) {
      if (!entry || nowMs - entry.capturedAtMs > ttlMs) {
        snapshots.delete(key);
        if (entry && entry.threadId) {
          const indexKey = methodThreadKey(entry.method, entry.threadId);
          if (keyByMethodThreadId.get(indexKey) === key) keyByMethodThreadId.delete(indexKey);
        }
      }
    }
    while (snapshots.size > maxEntries) {
      const first = snapshots.keys().next().value;
      const entry = snapshots.get(first);
      snapshots.delete(first);
      if (entry && entry.threadId) {
        const indexKey = methodThreadKey(entry.method, entry.threadId);
        if (keyByMethodThreadId.get(indexKey) === first) keyByMethodThreadId.delete(indexKey);
      }
    }
  }

  function readSnapshot({ key, method, threadId }) {
    const nowMs = Date.now();
    prune(nowMs);
    let resolvedKey = key;
    if (!resolvedKey && method && threadId) {
      // thread 详情快照需要支持“按会话取最新全量状态”，避免弱网重连时必须重建原始 IPC args。
      resolvedKey = keyByMethodThreadId.get(methodThreadKey(method, threadId)) || "";
    }
    if (!resolvedKey) return null;
    const entry = snapshots.get(resolvedKey);
    if (!entry || nowMs - entry.capturedAtMs > ttlMs) return null;
    return {
      capturedAtMs: entry.capturedAtMs,
      key: entry.key,
      method: entry.method,
      source: "gateway-memory",
      threadId: entry.threadId,
      threadSeq: Math.max(0, Number(entry.threadSeq) || 0),
      value: safeClone(entry.value),
    };
  }

  function writeSnapshot({ capturedAtMs = Date.now(), key, method, threadId = "", threadSeq = 0, value }) {
    if (!key || !isFastSyncMemoryCacheableMethod(method)) return false;
    try {
      // 详情快照只留在进程内，threadSeq 表示该全量状态覆盖到的 app-host 增量水位。
      snapshots.set(key, {
        capturedAtMs,
        key,
        method,
        threadId: typeof threadId === "string" ? threadId.slice(0, 160) : "",
        threadSeq: Math.max(0, Number(threadSeq) || 0),
        value: safeClone(value),
      });
      if (threadId) keyByMethodThreadId.set(methodThreadKey(method, threadId), key);
      prune(capturedAtMs);
      return true;
    } catch {
      return false;
    }
  }

  return { readSnapshot, writeSnapshot };
}

const memoryFastSyncCache = createMemoryFastSyncCache();

module.exports = {
  cacheKeyForSnapshot,
  createFastSyncCache,
  createMemoryFastSyncCache,
  isFastSyncCacheableMethod,
  isFastSyncMemoryCacheableMethod,
  isFastSyncSnapshotMethod,
  memoryFastSyncCache,
  parseFastSyncSnapshotArgsJson,
  valueFromFastSyncFetchResponsePayload,
};
