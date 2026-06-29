(function () {
  "use strict";

  const DB_NAME = "opencodex-fast-sync";
  const DB_VERSION = 1;
  const SNAPSHOT_STORE = "snapshots";
  const PENDING_STORE = "pendingSends";
  const LOCAL_STORAGE_PREFIX = "opencodex_fast_sync:";
  const FALLBACK_TTL_MS = 10 * 60 * 1000;
  const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_PENDING_SENDS = 100;
  const REDACTED_VALUE = "[redacted]";
  const SENSITIVE_FIELD_PARTS = ["token", "authorization", "password", "secret", "apikey", "cookie", "setcookie"];

  let dbPromise = null;

  function hostKey() {
    return `${window.location.protocol}//${window.location.host}`;
  }

  function nowMs() {
    return Date.now();
  }

  function ttlMs() {
    const config = window.__CODEX_WEB_CONFIG__ || {};
    const value = Number(config.fastSyncTtlMs);
    // TTL 与 gateway 默认 10 分钟对齐；配置非法时回退，避免快照永不过期。
    return Number.isFinite(value) && value > 0 ? value : FALLBACK_TTL_MS;
  }

  function normalizedFieldName(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isSensitiveFieldName(key) {
    const normalized = normalizedFieldName(key);
    return SENSITIVE_FIELD_PARTS.some((part) => normalized.includes(part));
  }

  function stablePart(value, seen, pathParts) {
    if (typeof value === "bigint") return { __type: "bigint", value: value.toString() };
    if (value == null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item, index) => stablePart(item, seen, pathParts.concat(String(index))));
    }

    const result = {};
    const hasRequestEnvelope = Object.prototype.hasOwnProperty.call(value, "request");
    for (const key of Object.keys(value).sort()) {
      const nextPath = pathParts.concat(key);
      const isTopLevelWrapper = pathParts.length === 1 && /^\d+$/.test(pathParts[0]);
      // 只忽略请求包络上的易变 id；业务对象里的 id 要保留，避免不同会话误命中。
      if (isTopLevelWrapper && hasRequestEnvelope && (key === "id" || key === "requestId")) continue;
      if (pathParts.length === 2 && /^\d+$/.test(pathParts[0]) && pathParts[1] === "request" && (key === "id" || key === "requestId")) continue;
      result[key] = stablePart(value[key], seen, nextPath);
    }
    seen.delete(value);
    return result;
  }

  function stableStringify(value) {
    return JSON.stringify(stablePart(value, new WeakSet(), []));
  }

  function fnv1aHash(text, seed) {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, "0");
  }

  function cacheKey(method, args) {
    const stable = stableStringify({ method: String(method || ""), args: args || [] });
    // 浏览器脚本保持同步 API；排序后的内容再取双 hash，避免把大参数直接塞进 storage key。
    return `v1:${hostKey()}:${fnv1aHash(stable, 0x811c9dc5)}${fnv1aHash(stable, 0x9e3779b9)}`;
  }

  function redactSensitiveFields(value) {
    if (value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item));

    const result = {};
    for (const [key, item] of Object.entries(value)) {
      // 本地快照可能长期留在浏览器存储中，常见凭证字段统一脱敏后再写入。
      result[key] = isSensitiveFieldName(key) ? REDACTED_VALUE : redactSensitiveFields(item);
    }
    return result;
  }

  function safeSnapshotValue(value) {
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== "string") return null;
      return redactSensitiveFields(JSON.parse(serialized));
    } catch {
      return null;
    }
  }

  function localStorageGet(key) {
    try {
      const raw = window.localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function localStorageSet(key, value) {
    try {
      window.localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${key}`, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function localStorageRemove(key) {
    try {
      window.localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${key}`);
    } catch {}
  }

  function openDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(PENDING_STORE)) db.createObjectStore(PENDING_STORE, { keyPath: "localSendId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  async function withStore(storeName, mode, callback) {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      let settled = false;
      function finish(value) {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      }
      try {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = callback(store);
        if (request && typeof request === "object" && "onsuccess" in request) {
          request.onsuccess = () => finish(request.result);
          request.onerror = () => finish(null);
        }
        tx.oncomplete = () => finish(request && "result" in request ? request.result : request);
        tx.onerror = () => finish(null);
        tx.onabort = () => finish(null);
      } catch {
        finish(null);
      }
    });
  }

  function isFreshRecord(record) {
    const capturedAtMs = Number(record && record.capturedAtMs) || 0;
    return capturedAtMs > 0 && nowMs() - capturedAtMs <= ttlMs();
  }

  function snapshotResult(record, source) {
    if (!record || !isFreshRecord(record)) return null;
    return {
      capturedAtMs: record.capturedAtMs,
      source,
      value: record.value,
    };
  }

  async function readSnapshot(method, args) {
    const key = cacheKey(method, args);
    const fromDb = await withStore(SNAPSHOT_STORE, "readonly", (store) => store.get(key));
    const dbResult = snapshotResult(fromDb, "indexeddb");
    if (dbResult) return dbResult;
    if (fromDb) {
      // 过期 IndexedDB 快照不立即阻塞清理；失败也不影响页面继续走实时链路。
      withStore(SNAPSHOT_STORE, "readwrite", (store) => store.delete(key));
    }

    const fromStorage = localStorageGet(key);
    const storageResult = snapshotResult(fromStorage, "localstorage");
    if (storageResult) return storageResult;
    if (fromStorage) localStorageRemove(key);
    return null;
  }

  async function writeSnapshot(method, args, value) {
    const safeValue = safeSnapshotValue(value);
    if (safeValue === null) return false;

    const key = cacheKey(method, args);
    const record = {
      capturedAtMs: nowMs(),
      key,
      method: String(method || ""),
      schemaVersion: 1,
      sourceHost: hostKey(),
      value: safeValue,
    };
    const wroteDb = await withStore(SNAPSHOT_STORE, "readwrite", (store) => store.put(record));
    if (wroteDb) return true;
    return localStorageSet(key, record);
  }

  function pendingStorageKey(localSendId) {
    return `pending:${localSendId}`;
  }

  function pendingIsAlive(record) {
    const createdAtMs = Number(record && record.createdAtMs) || 0;
    return createdAtMs > 0 && nowMs() - createdAtMs <= PENDING_TTL_MS;
  }

  async function listPendingFromDb() {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const result = [];
      try {
        const tx = db.transaction(PENDING_STORE, "readonly");
        const store = tx.objectStore(PENDING_STORE);
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          result.push(item.value);
          item.continue();
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  function listPendingFromStorage() {
    const records = [];
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key || !key.startsWith(`${LOCAL_STORAGE_PREFIX}pending:`)) continue;
        const raw = window.localStorage.getItem(key);
        if (raw) records.push(JSON.parse(raw));
      }
    } catch {
      return [];
    }
    return records;
  }

  async function prunePendingSends() {
    const records = (await listPendingFromDb()) || listPendingFromStorage();
    const sorted = records
      .filter((record) => record && record.localSendId)
      .sort((first, second) => Number(second.createdAtMs || 0) - Number(first.createdAtMs || 0));
    const keepIds = new Set(sorted.filter(pendingIsAlive).slice(0, MAX_PENDING_SENDS).map((record) => record.localSendId));

    for (const record of sorted) {
      if (keepIds.has(record.localSendId)) continue;
      withStore(PENDING_STORE, "readwrite", (store) => store.delete(record.localSendId));
      localStorageRemove(pendingStorageKey(record.localSendId));
    }
  }

  async function createPendingSend(payload) {
    const safePayload = safeSnapshotValue(payload);
    if (safePayload === null) return null;

    const localSendId = `local-${nowMs()}-${Math.random().toString(36).slice(2, 10)}`;
    const record = {
      createdAtMs: nowMs(),
      localSendId,
      payload: safePayload,
      schemaVersion: 1,
      sourceHost: hostKey(),
      status: "pending",
    };
    const wroteDb = await withStore(PENDING_STORE, "readwrite", (store) => store.put(record));
    const wroteStorage = wroteDb ? true : localStorageSet(pendingStorageKey(localSendId), record);
    prunePendingSends();
    return wroteStorage ? record : null;
  }

  async function completePendingSend(localSendId, patch) {
    if (!localSendId) return null;
    const current =
      (await withStore(PENDING_STORE, "readonly", (store) => store.get(localSendId))) ||
      localStorageGet(pendingStorageKey(localSendId));
    if (!current) return null;

    const safePatch = safeSnapshotValue(patch || {});
    if (safePatch === null) return null;
    const next = {
      ...current,
      ...safePatch,
      completedAtMs: nowMs(),
      createdAtMs: current.createdAtMs,
      localSendId: current.localSendId,
      payload: current.payload,
      status: safePatch.status || "completed",
    };
    const wroteDb = await withStore(PENDING_STORE, "readwrite", (store) => store.put(next));
    if (!wroteDb) localStorageSet(pendingStorageKey(localSendId), next);
    return next;
  }

  async function listPendingSends() {
    const records = (await listPendingFromDb()) || listPendingFromStorage();
    return records
      .filter((record) => record && pendingIsAlive(record))
      .sort((first, second) => Number(first.createdAtMs || 0) - Number(second.createdAtMs || 0));
  }

  window.__opencodexFastSync = {
    cacheKey,
    completePendingSend,
    createPendingSend,
    listPendingSends,
    readSnapshot,
    writeSnapshot,
  };
})();
