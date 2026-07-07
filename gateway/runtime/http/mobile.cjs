const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { cacheKeyForSnapshot } = require("../core/fast-sync-cache.cjs");
const { CODEX_HOME } = require("../core/config.cjs");
const { readBody, sendJsonCompressed } = require("./http-utils.cjs");

const MOBILE_DEFERRED_STATE = ["app/list", "mcpServerStatus/list", "plugin/list", "desktop-state"];
const MOBILE_THREAD_LIST_METHOD = "thread/list";
const MOBILE_THREAD_LIST_ARGS = [];
const MOBILE_TURN_TEXT_MAX_CHARS = 20_000;
const MOBILE_TURN_SEND_TTL_MS = 10 * 60 * 1000;
const MOBILE_THREAD_DETAIL_HEAD_BYTES = 64 * 1024;
const MOBILE_THREAD_DETAIL_TAIL_BYTES = 512 * 1024;
const MOBILE_THREAD_DETAIL_TAIL_BYTES_CELLULAR = 256 * 1024;
const MOBILE_THREAD_DETAIL_TAIL_BYTES_CONSTRAINED = 128 * 1024;
const MOBILE_MESSAGE_TEXT_MAX_CHARS = 12_000;
const MOBILE_THREAD_LIST_CACHE_TTL_MS = 5_000;
const MOBILE_THREAD_LIST_STALE_CACHE_TTL_MS = 30_000;
const MOBILE_THREAD_LIST_SCAN_MAX_MS = 250;
const MOBILE_THREAD_EVENT_CHUNK_BYTES = 64 * 1024;
const MOBILE_THREAD_EVENT_PENDING_MAX_BYTES = 256 * 1024;
const MOBILE_THREAD_EVENT_RETRY_MS = 5_000;
const MOBILE_THREAD_FIND_RECENT_FILE_LIMIT = 600;
const MOBILE_THREAD_HTTP_RECENT_FILE_LIMIT = 80;
const MOBILE_THREAD_DETAIL_CACHE_TTL_MS = 2_000;
const MOBILE_SESSION_META_HEAD_BYTES = 64 * 1024;
const MOBILE_THREAD_ID_MAX_CHARS = 160;
const MOBILE_THREAD_TITLE_MAX_CHARS = 160;
const MOBILE_THREAD_PATH_MAX_CHARS = 320;
const MOBILE_THREAD_TIME_MAX_CHARS = 80;
const localSessionFileCache = new Map();
const localThreadDetailCache = new Map();
const localThreadListCache = new Map();

function mobilePayloadEtag(payload) {
  try {
    // ETag 只覆盖手机可见 DTO；snapshotAgeMs/metrics 变化不迫使弱网重复下载同一屏内容。
    const thread = payload && payload.thread && typeof payload.thread === "object" ? payload.thread : {};
    const stable = JSON.stringify({
      messages: payload && Array.isArray(payload.messages) ? payload.messages : [],
      mode: payload && payload.mode,
      source: payload && payload.source,
      thread: {
        archived: Boolean(thread.archived),
        id: thread.id || "",
        projectPath: thread.projectPath || "",
        title: thread.title || "",
        updatedAt: thread.updatedAt || "",
      },
      threads: payload && Array.isArray(payload.threads) ? payload.threads : [],
    });
    return `"mobile-${crypto.createHash("sha1").update(stable).digest("base64url")}"`;
  } catch {
    return "";
  }
}

function mobileRequestEtag(req) {
  const value = req && req.headers && (req.headers["if-none-match"] || req.headers["If-None-Match"]);
  return typeof value === "string" ? value.trim() : "";
}

function sendMobilePayload(req, res, status, payload, extraHeaders = {}) {
  const etag = payload && payload.ok === true ? mobilePayloadEtag(payload) : "";
  const headers = { "cache-control": "no-store", ...extraHeaders, ...(etag ? { etag } : {}) };
  if (status === 200 && etag && mobileRequestEtag(req) === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  return sendJsonCompressed(req, res, status, payload, headers);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function mobileScalar(value, maxChars) {
  // 移动端列表只展示短标量，避免官方快照里的复杂对象或异常长字段撑大弱网首屏。
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function firstMobileScalar(maxChars, ...values) {
  // 候选字段里可能混入复杂对象；跳过它们，继续寻找能安全下发到手机端的短标量。
  for (const value of values) {
    const normalized = mobileScalar(value, maxChars);
    if (normalized !== "") return normalized;
  }
  return "";
}

function estimatedJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function threadsArrayFromValue(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["threads", "items", "sessions", "entries", "data"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.value && value.value !== value) return threadsArrayFromValue(value.value);
  return [];
}

function normalizeMobileThread(thread) {
  if (!thread || typeof thread !== "object") return null;
  const id = mobileScalar(firstString(thread.id, thread.threadId, thread.thread_id, thread.conversationId, thread.conversation_id), MOBILE_THREAD_ID_MAX_CHARS);
  if (!id) return null;
  const title =
    mobileScalar(firstString(thread.title, thread.name, thread.summary, thread.firstMessage), MOBILE_THREAD_TITLE_MAX_CHARS) || "Untitled";
  const projectPath = mobileScalar(
    firstString(thread.projectPath, thread.project_path, thread.cwd, thread.workspace, thread.workspacePath, thread.repoPath),
    MOBILE_THREAD_PATH_MAX_CHARS
  );
  const updatedAt = firstMobileScalar(
    MOBILE_THREAD_TIME_MAX_CHARS,
    thread.updatedAt,
    thread.updated_at,
    thread.updatedAtMs,
    thread.lastUpdatedAt,
    thread.lastUpdatedAtMs,
    thread.createdAt,
    thread.createdAtMs
  );
  return {
    archived: Boolean(thread.archived),
    id,
    projectPath,
    title,
    updatedAt,
  };
}

function normalizeMobileThreads(value, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const result = [];
  // 手机首屏只需要会话列表的可展示字段；插件、MCP、桌面状态等大对象在这里主动丢弃。
  for (const thread of threadsArrayFromValue(value)) {
    const normalized = normalizeMobileThread(thread);
    if (!normalized) continue;
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function walkJsonlFiles(root, files = [], options = {}) {
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : 0;
  const minFiles = Math.max(0, Number(options.minFiles) || 0);
  const hasBudget = typeof options.hasBudget === "function" ? options.hasBudget : () => true;
  if (!hasBudget() && files.length >= minFiles) return files;
  if (maxFiles > 0 && files.length >= maxFiles) return files;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  if (options.newestFirst) entries.sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries) {
    if (!hasBudget() && files.length >= minFiles) break;
    if (maxFiles > 0 && files.length >= maxFiles) break;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, files, options);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

function rememberLocalSessionFile(threadId, item) {
  const id = firstString(threadId);
  if (!id || !item || !item.filePath) return;
  localSessionFileCache.set(id, {
    archived: Boolean(item.archived),
    filePath: item.filePath,
  });
}

function cachedLocalSessionFile(threadId) {
  const id = firstString(threadId);
  if (!id) return null;
  const cached = localSessionFileCache.get(id);
  if (!cached || !cached.filePath) return null;
  try {
    fs.accessSync(cached.filePath, fs.constants.R_OK);
    return cached;
  } catch {
    localSessionFileCache.delete(id);
    return null;
  }
}

function cloneMobileThreadList(threads) {
  return Array.isArray(threads) ? threads.map((thread) => ({ ...thread })) : [];
}

function cloneMobileThreadFileStats(files) {
  return Array.isArray(files) ? files.map((file) => ({ ...file })) : [];
}

function localThreadFilesUnchanged(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  for (const file of files) {
    if (!file || !file.filePath) return false;
    try {
      const stat = fs.statSync(file.filePath);
      if (stat.mtimeMs !== file.mtimeMs || stat.size !== file.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function localThreadListCacheKey(options = {}) {
  return [
    path.resolve(options.codexHome || CODEX_HOME),
    Math.max(1, Math.min(Number(options.limit) || 50, 200)),
    firstString(options.includeThreadId),
  ].join("|");
}

function cachedLocalThreadList(options = {}) {
  const ttlMs = Math.max(0, Number(options.cacheTtlMs ?? MOBILE_THREAD_LIST_CACHE_TTL_MS));
  if (ttlMs === 0) return null;
  const staleTtlMs = Math.max(0, Number(options.staleCacheTtlMs ?? MOBILE_THREAD_LIST_STALE_CACHE_TTL_MS));
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const key = localThreadListCacheKey(options);
  const cached = localThreadListCache.get(key);
  if (!cached) return null;
  if (cached.expiresAtMs > now) return cloneMobileThreadList(cached.threads);
  if (staleTtlMs > 0 && cached.staleExpiresAtMs > now && localThreadFilesUnchanged(cached.files)) {
    return cloneMobileThreadList(cached.threads);
  }
  if (cached.staleExpiresAtMs <= now || !localThreadFilesUnchanged(cached.files)) {
    localThreadListCache.delete(key);
  }
  return null;
}

function rememberLocalThreadList(options = {}, threads = [], files = []) {
  const ttlMs = Math.max(0, Number(options.cacheTtlMs ?? MOBILE_THREAD_LIST_CACHE_TTL_MS));
  if (ttlMs === 0) return;
  const staleTtlMs = Math.max(0, Number(options.staleCacheTtlMs ?? MOBILE_THREAD_LIST_STALE_CACHE_TTL_MS));
  const now = typeof options.now === "function" ? options.now() : Date.now();
  // 手机首页的会话列表不是实时关键路径；短 TTL 后只校验已知文件 stat，稳定时继续复用裁剪后的轻量 DTO。
  localThreadListCache.set(localThreadListCacheKey(options), {
    expiresAtMs: now + ttlMs,
    files: cloneMobileThreadFileStats(files),
    staleExpiresAtMs: now + ttlMs + staleTtlMs,
    threads: cloneMobileThreadList(threads),
  });
}

function cloneMobileThreadDetail(detail) {
  return detail && typeof detail === "object" ? JSON.parse(JSON.stringify(detail)) : detail;
}

function localThreadDetailCacheKey(options = {}, match = {}) {
  return [
    path.resolve(options.codexHome || CODEX_HOME),
    firstString(options.threadId),
    Math.max(1, Math.min(Number(options.limit) || 120, 500)),
    Math.max(1024, Number(options.headBytes) || MOBILE_THREAD_DETAIL_HEAD_BYTES),
    Math.max(1024, Number(options.tailBytes) || MOBILE_THREAD_DETAIL_TAIL_BYTES),
    match.filePath || "",
  ].join("|");
}

function cachedLocalThreadDetail(options = {}, match = {}, stat = null) {
  const ttlMs = Math.max(0, Number(options.detailCacheTtlMs ?? MOBILE_THREAD_DETAIL_CACHE_TTL_MS));
  if (ttlMs === 0 || !stat) return null;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const key = localThreadDetailCacheKey(options, match);
  const cached = localThreadDetailCache.get(key);
  if (!cached || cached.expiresAtMs <= now || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    localThreadDetailCache.delete(key);
    return null;
  }
  return cloneMobileThreadDetail(cached.detail);
}

function rememberLocalThreadDetail(options = {}, match = {}, stat = null, detail = null) {
  const ttlMs = Math.max(0, Number(options.detailCacheTtlMs ?? MOBILE_THREAD_DETAIL_CACHE_TTL_MS));
  if (ttlMs === 0 || !stat || !detail || detail.ok !== true) return;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  // 缓存的是已裁剪的 mobile-lite DTO；文件 stat 改变时立即失效，实时新增仍由 SSE 补齐。
  localThreadDetailCache.set(localThreadDetailCacheKey(options, match), {
    detail: cloneMobileThreadDetail(detail),
    expiresAtMs: now + ttlMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
}

function localSessionRoots(codexHome) {
  return [
    { archived: false, dir: path.join(codexHome, "sessions") },
    { archived: true, dir: path.join(codexHome, "archived_sessions") },
  ];
}

function matchLocalSessionFile(threadId, root, filePath) {
  if (path.basename(filePath, ".jsonl").endsWith(threadId)) {
    return { archived: root.archived, filePath };
  }
  try {
    const firstLine = readFileHeadLines(filePath, 1)[0] || "";
    const record = JSON.parse(firstLine);
    const payload = record && record.payload && typeof record.payload === "object" ? record.payload : {};
    if (firstString(payload.session_id, payload.id) === threadId) return { archived: root.archived, filePath };
  } catch {}
  return null;
}

function titleFromRecord(record) {
  if (!record || typeof record !== "object") return "";
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  const message = firstString(payload.message, payload.text, payload.content);
  if (message) return message.slice(0, 80);
  if (record.type === "response_item" && payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
    const item = payload.content.find((part) => part && part.type === "input_text" && typeof part.text === "string");
    if (item) return item.text.trim().slice(0, 80);
  }
  return "";
}

function textFromContentParts(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return firstString(part.text, part.content, part.value);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateMobileMessageText(text, maxChars = MOBILE_MESSAGE_TEXT_MAX_CHARS) {
  const value = firstString(text);
  if (!value) return { text: "", truncated: false };
  const limit = Math.max(200, Number(maxChars) || MOBILE_MESSAGE_TEXT_MAX_CHARS);
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

function mobileThreadDetailTailBytesForLimit(limit) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 120, 500));
  // 前端弱网会降低消息条数；后端同步缩小 tail 窗口，避免少量消息仍读取 512KB 历史。
  if (normalizedLimit <= 40) return MOBILE_THREAD_DETAIL_TAIL_BYTES_CONSTRAINED;
  if (normalizedLimit <= 80) return MOBILE_THREAD_DETAIL_TAIL_BYTES_CELLULAR;
  return MOBILE_THREAD_DETAIL_TAIL_BYTES;
}

function mobileMessageFromRecord(record, fallbackTimestamp = "") {
  if (!record || typeof record !== "object") return null;
  const timestamp = firstValue(record.timestamp, record.payload && record.payload.timestamp, fallbackTimestamp);
  let role = "";
  let text = "";
  if (record.type === "event_msg" && record.payload && record.payload.type === "user_message") {
    role = "user";
    text = firstString(record.payload.message, record.payload.text);
  } else if (
    record.type === "response_item" &&
    record.payload &&
    record.payload.type === "message" &&
    (record.payload.role === "user" || record.payload.role === "assistant")
  ) {
    role = record.payload.role;
    text = textFromContentParts(record.payload.content);
  }
  if (!role || !text) return null;
  if (role === "user" && !isUsefulThreadTitle(text)) return null;
  const normalized = truncateMobileMessageText(text);
  return {
    role,
    text: normalized.text,
    timestamp,
    ...(normalized.truncated ? { truncated: true } : {}),
  };
}

function isUsefulThreadTitle(title) {
  const text = firstString(title);
  if (!text) return false;
  // Codex jsonl 前几条常包含系统注入的 AGENTS/环境上下文；手机会话列表只展示用户真正发起的请求。
  return ![
    "# AGENTS.md instructions",
    "<environment_context>",
    "<codex_internal_context",
    "<turn_aborted>",
    "<permissions instructions>",
    "<app-context>",
    "<skills_instructions>",
    "<plugins_instructions>",
  ].some((prefix) => text.startsWith(prefix));
}

function sessionThreadFromFile(filePath, archived, knownStat = null) {
  let stat = knownStat;
  if (!stat) {
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
  }
  const thread = {
    archived,
    id: path.basename(filePath, ".jsonl"),
    projectPath: "",
    title: "",
    updatedAt: stat.mtime.toISOString(),
  };
  try {
    const lines = readFileHeadLines(filePath, 40);
    for (const line of lines) {
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record && record.type === "session_meta" && record.payload && typeof record.payload === "object") {
        // session_meta 通常在首行，读取它即可得到会话 ID、工作目录和创建时间，不需要解析整段历史。
        thread.id = firstString(record.payload.session_id, record.payload.id, thread.id) || thread.id;
        thread.projectPath = firstString(record.payload.cwd, record.payload.workspace, thread.projectPath);
        thread.updatedAt = firstValue(record.payload.timestamp, record.timestamp, thread.updatedAt);
      }
      if (!thread.title) {
        const title = titleFromRecord(record);
        if (isUsefulThreadTitle(title)) thread.title = title;
      }
      if (thread.projectPath && thread.title) break;
    }
  } catch {}
  thread.title = thread.title || "Untitled";
  return thread;
}

function readFileWindow(filePath, start, length) {
  if (length <= 0) return "";
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  }
}

function readFileHeadLines(filePath, maxLines, maxBytes = MOBILE_SESSION_META_HEAD_BYTES) {
  // 会话文件可能很大，读取元信息和标题时只需要头部窗口，不能为了第一行把整段历史读进内存。
  return jsonlLinesFromWindow(readFileWindow(filePath, 0, Math.max(1024, Number(maxBytes) || MOBILE_SESSION_META_HEAD_BYTES))).slice(
    0,
    Math.max(1, Number(maxLines) || 1)
  );
}

function jsonlLinesFromWindow(text, options = {}) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (options.dropFirstPartial) lines.shift();
  return lines.filter(Boolean);
}

function parseSessionFile(filePath, archived, options = {}, knownStat = null) {
  let stat = knownStat;
  if (!stat) {
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
  }
  const limit = Math.max(1, Math.min(Number(options.limit) || 120, 500));
  const thread = {
    archived,
    id: path.basename(filePath, ".jsonl"),
    projectPath: "",
    title: "",
    updatedAt: stat.mtime.toISOString(),
  };
  const messages = [];
  const headBytes = Math.max(1024, Number(options.headBytes) || MOBILE_THREAD_DETAIL_HEAD_BYTES);
  const tailBytes = Math.max(1024, Number(options.tailBytes) || MOBILE_THREAD_DETAIL_TAIL_BYTES);
  try {
    const headLength = Math.min(stat.size, headBytes);
    const head = readFileWindow(filePath, 0, headLength);
    const tailStart = Math.max(0, stat.size - tailBytes);
    const tail = tailStart === 0 ? head : readFileWindow(filePath, tailStart, stat.size - tailStart);
    const headLines = jsonlLinesFromWindow(head);
    const tailLines = jsonlLinesFromWindow(tail, { dropFirstPartial: tailStart > 0 });

    for (const line of headLines) {
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record && record.type === "session_meta" && record.payload && typeof record.payload === "object") {
        // 详情页同样只抽元信息，不透传 session_meta 里的完整上下文和内部配置。
        thread.id = firstString(record.payload.session_id, record.payload.id, thread.id) || thread.id;
        thread.projectPath = firstString(record.payload.cwd, record.payload.workspace, thread.projectPath);
        thread.updatedAt = firstValue(record.payload.timestamp, record.timestamp, thread.updatedAt);
        continue;
      }
      if (!thread.title) {
        const title = titleFromRecord(record);
        if (isUsefulThreadTitle(title)) thread.title = title;
      }
      if (thread.projectPath && thread.title) break;
    }

    for (const line of tailLines) {
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const message = mobileMessageFromRecord(record, firstValue(record.timestamp, record.payload && record.payload.timestamp, thread.updatedAt));
      if (!message) continue;
      if (!thread.title && message.role === "user") thread.title = message.text.slice(0, 80);
      // 详情页面向手机弱网，只保留最近可见消息，避免大历史一次性压过链路。
      messages.push(message);
      if (messages.length > limit) messages.shift();
    }
  } catch {
    return null;
  }
  thread.title = thread.title || "Untitled";
  return {
    messages,
    metrics: {
      fileBytes: stat.size,
      headBytesRead: Math.min(stat.size, headBytes),
      messageCount: messages.length,
      nextEventOffset: stat.size,
      tailBytesRead: Math.min(stat.size, tailBytes),
      truncatedCount: messages.filter((message) => message && message.truncated).length,
      windowed: stat.size > headBytes + tailBytes,
    },
    ok: true,
    thread,
  };
}

function listLocalSessionThreads(options = {}) {
  const cached = cachedLocalThreadList(options);
  if (cached) return cached;
  const codexHome = options.codexHome || CODEX_HOME;
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const scanMaxMs = Math.max(0, Number(options.scanMaxMs ?? MOBILE_THREAD_LIST_SCAN_MAX_MS));
  const scanStartedAtMs = now();
  const hasScanBudget = () => scanMaxMs === 0 || now() - scanStartedAtMs <= scanMaxMs;
  const roots = localSessionRoots(codexHome);
  const files = [];
  const minimumCandidateFiles = Math.min(limit, 3);
  for (const root of roots) {
    if (!hasScanBudget() && files.length >= minimumCandidateFiles) break;
    // 手机首屏只需要最近候选；按日期目录/文件名倒序提前停止，避免每次弱网打开都遍历全部历史。
    for (const filePath of walkJsonlFiles(root.dir, [], { hasBudget: hasScanBudget, maxFiles: limit * 6, minFiles: minimumCandidateFiles, newestFirst: true })) {
      files.push({ archived: root.archived, filePath });
      if (!hasScanBudget() && files.length >= minimumCandidateFiles) break;
    }
  }
  const filesWithMtime = [];
  for (const item of files) {
    if (!hasScanBudget() && filesWithMtime.length >= limit) break;
    try {
      const stat = fs.statSync(item.filePath);
      // 排序时已经拿到 stat；后续解析标题/元信息复用它，避免手机首页对每个候选重复 syscall。
      filesWithMtime.push({ ...item, mtimeMs: stat.mtimeMs, size: stat.size, stat });
    } catch {}
  }
  filesWithMtime.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const threads = [];
  const cachedFileStats = [];
  for (const item of filesWithMtime.slice(0, limit * 3)) {
    if (!hasScanBudget() && threads.length > 0) break;
    const thread = sessionThreadFromFile(item.filePath, item.archived, item.stat);
    if (thread) {
      // 列表页已经定位过文件，缓存映射后详情页无需再次全量扫描历史目录。
      rememberLocalSessionFile(thread.id, item);
      cachedFileStats.push({ filePath: item.filePath, mtimeMs: item.mtimeMs, size: item.size });
      threads.push(thread);
    }
    if (threads.length >= limit) break;
  }
  const includeThreadId = firstString(options.includeThreadId);
  if (includeThreadId && !threads.some((thread) => thread && thread.id === includeThreadId)) {
    const includeMatch = findLocalSessionFile({
      allowFullScan: options.includeAllowFullScan === true,
      codexHome,
      recentFileLimit: Math.max(limit * 6, Number(options.includeRecentFileLimit) || 0, MOBILE_THREAD_HTTP_RECENT_FILE_LIMIT),
      threadId: includeThreadId,
    });
    let includeStat = null;
    if (includeMatch) {
      try {
        includeStat = fs.statSync(includeMatch.filePath);
      } catch {}
    }
    const includedThread = includeMatch && includeStat ? sessionThreadFromFile(includeMatch.filePath, includeMatch.archived, includeStat) : null;
    if (includedThread) {
      // 手机 catalog 可以只下发少量最近会话，但直达 /local/:id 必须包含当前会话，官方 renderer 才能恢复正文。
      rememberLocalSessionFile(includedThread.id, includeMatch);
      cachedFileStats.push({ filePath: includeMatch.filePath, mtimeMs: includeStat.mtimeMs, size: includeStat.size });
      threads.unshift(includedThread);
      while (threads.length > limit) threads.pop();
    }
  }
  // 手机弱网首屏宁可先返回已拿到的最近会话，也不要为了补全全部候选阻塞页面可交互。
  rememberLocalThreadList({ ...options, limit }, threads, cachedFileStats);
  return threads;
}

function findLocalSessionFile(options = {}) {
  const codexHome = options.codexHome || CODEX_HOME;
  const threadId = firstString(options.threadId);
  if (!threadId) return null;
  const cached = cachedLocalSessionFile(threadId);
  if (cached) return { ...cached, lookupSource: "cache" };
  const roots = localSessionRoots(codexHome);
  const recentFileLimit = Math.max(1, Number(options.recentFileLimit) || MOBILE_THREAD_FIND_RECENT_FILE_LIMIT);
  for (const root of roots) {
    // 冷启动直达会话时，先按日期目录倒序查最近候选，避免为了一个深链扫描多年历史。
    for (const filePath of walkJsonlFiles(root.dir, [], { maxFiles: recentFileLimit, newestFirst: true })) {
      const item = matchLocalSessionFile(threadId, root, filePath);
      if (item) {
        const result = { ...item, lookupSource: "recent" };
        rememberLocalSessionFile(threadId, result);
        return result;
      }
    }
  }
  if (options.allowFullScan === false) {
    // 手机 HTTP 入口不做无界历史扫描；列表页定位过的会话会命中缓存，冷门老深链则快速失败让页面保持可操作。
    return null;
  }
  for (const root of roots) {
    for (const filePath of walkJsonlFiles(root.dir)) {
      const item = matchLocalSessionFile(threadId, root, filePath);
      if (item) {
        const result = { ...item, lookupSource: "scan" };
        rememberLocalSessionFile(threadId, result);
        return result;
      }
    }
  }
  return null;
}

function listLocalSessionThreadDetail(options = {}) {
  const match = findLocalSessionFile(options);
  if (!match) return { ok: false };
  let stat = null;
  try {
    stat = fs.statSync(match.filePath);
  } catch {
    return { ok: false };
  }
  const cached = cachedLocalThreadDetail(options, match, stat);
  if (cached) return cached;
  const parsed = parseSessionFile(match.filePath, match.archived, options, stat);
  if (parsed && parsed.metrics && match.lookupSource) parsed.metrics.lookupSource = match.lookupSource;
  rememberLocalThreadDetail(options, match, stat, parsed);
  return parsed || { ok: false };
}

function sseWrite(res, { data, event, id, retry }) {
  if (id != null) res.write(`id: ${String(id)}\n`);
  if (event) res.write(`event: ${event}\n`);
  if (retry != null) res.write(`retry: ${String(retry)}\n`);
  const body = data == null ? "" : JSON.stringify(data);
  for (const line of body.split(/\r?\n/)) res.write(`data: ${line}\n`);
  res.write("\n");
}

function parseJsonBody(rawBody) {
  try {
    return { ok: true, value: JSON.parse(rawBody || "{}") };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

function normalizeMobileTurnText(value) {
  const text = firstString(value);
  if (!text) return "";
  return text.slice(0, MOBILE_TURN_TEXT_MAX_CHARS);
}

function mobileTurnLocalSendId(value) {
  const text = firstString(value);
  return text ? text.slice(0, 120) : "";
}

function createMobileTurnStartPayload({ localSendId, text, threadId }) {
  const requestId = `mobile-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    method: "turn/start",
    request: {
      id: requestId,
      method: "turn/start",
      params: {
        input: text,
        localSendId,
        prompt: text,
        source: "opencodex-mobile-lite",
        threadId,
      },
    },
  };
}

function createMobileTurnSender(options = {}) {
  const invokeTurnStart =
    typeof options.invokeTurnStart === "function" ? options.invokeTurnStart : async () => ({ ok: false, skipped: true });
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sentByKey = new Map();

  function pruneSent() {
    const threshold = now() - MOBILE_TURN_SEND_TTL_MS;
    for (const [key, entry] of sentByKey) {
      if (!entry || Number(entry.createdAtMs) < threshold) sentByKey.delete(key);
    }
  }

  async function sendTurn({ localSendId, text, threadId }) {
    pruneSent();
    const idempotencyKey = localSendId ? `${threadId}:${localSendId}` : "";
    if (idempotencyKey && sentByKey.has(idempotencyKey)) {
      return { ...sentByKey.get(idempotencyKey).value, duplicate: true };
    }
    const payload = createMobileTurnStartPayload({ localSendId, text, threadId });
    // 手机端先快速确认“已接收”，后台再投递官方 runtime；真正结果由当前会话 JSONL/SSE 增量回到手机。
    Promise.resolve()
      .then(() => invokeTurnStart(payload))
      .catch((error) => {
        console.warn(`[mobile-lite] queued turn delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    const result = {
      accepted: true,
      delivery: "queued",
      localSendId,
      mode: "mobile-lite",
      ok: true,
      requestId: payload.request.id,
    };
    if (idempotencyKey) sentByKey.set(idempotencyKey, { createdAtMs: now(), value: result });
    return result;
  }

  return { sendTurn };
}

function createMobileThreadEventStream(options = {}) {
  const req = options.req;
  const res = options.res;
  const filePath = options.filePath;
  const pollMs = Math.max(10, Number(options.pollMs) || 1000);
  const heartbeatMs = Math.max(pollMs, Number(options.heartbeatMs) || 30_000);
  const chunkBytes = Math.max(1024, Number(options.chunkBytes) || MOBILE_THREAD_EVENT_CHUNK_BYTES);
  const pendingMaxBytes = Math.max(chunkBytes, Number(options.pendingMaxBytes) || MOBILE_THREAD_EVENT_PENDING_MAX_BYTES);
  let closed = false;
  let offset = 0;
  let pending = "";
  let pollTimer = null;
  let heartbeatTimer = null;

  function close() {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  function writeSseEvent(payload) {
    if (closed) return false;
    try {
      sseWrite(res, payload);
      return true;
    } catch {
      close();
      return false;
    }
  }

  function readNewBytes() {
    if (closed) return;
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      close();
      return;
    }
    if (stat.size < offset) offset = stat.size;
    if (stat.size === offset) return;
    let chunk = "";
    try {
      const fd = fs.openSync(filePath, "r");
      const length = Math.min(chunkBytes, stat.size - offset);
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      fs.closeSync(fd);
      offset += bytesRead;
      chunk = buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return;
    }
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = pending.endsWith("\n") || pending.endsWith("\r") ? "" : lines.pop() || "";
    if (Buffer.byteLength(pending, "utf8") > pendingMaxBytes) {
      // 超大内部状态行不会下发到手机端；截断半行后等待后续换行恢复 JSONL 边界。
      pending = "";
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const message = mobileMessageFromRecord(record);
      if (message && !writeSseEvent({ data: message, event: "message", id: offset })) return;
    }
  }

  try {
    const stat = fs.statSync(filePath);
    const rawSinceOffset = options.sinceOffset == null || options.sinceOffset === "" ? "" : String(options.sinceOffset);
    const sinceOffset = rawSinceOffset ? Number(rawSinceOffset) : NaN;
    offset = Number.isFinite(sinceOffset) && sinceOffset >= 0 && sinceOffset <= stat.size ? sinceOffset : stat.size;
  } catch {
    res.writeHead(404, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    sseWrite(res, { data: { error: "Thread not found" }, event: "error" });
    close();
    return { closed: () => closed };
  }

  res.writeHead(200, {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  // ready 只同步文件游标，避免手机端一连上 SSE 就重复接收全量历史。
  // 明确放慢手机弱网断线后的 EventSource 重连节奏，避免抖动网络反复建立无效连接。
  writeSseEvent({ data: { offset, threadId: options.threadId || "" }, event: "ready", id: offset, retry: MOBILE_THREAD_EVENT_RETRY_MS });
  pollTimer = setInterval(readNewBytes, pollMs);
  heartbeatTimer = setInterval(() => {
    if (!closed) writeSseEvent({ data: { at: Date.now() }, event: "ping", id: offset });
  }, heartbeatMs);
  if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  if (req && typeof req.on === "function") req.on("close", close);
  if (res && typeof res.on === "function") {
    // 手机切网、锁屏或代理断开时，响应侧可能先收到关闭事件；立即释放轮询计时器。
    res.on("close", close);
    res.on("error", close);
  }
  return { closed: () => closed };
}

function createMobileBootstrapPayload(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const snapshot = typeof options.readThreadListSnapshot === "function" ? options.readThreadListSnapshot() : null;
  const snapshotAgeMs = snapshot && Number(snapshot.capturedAtMs) > 0 ? Math.max(0, now() - Number(snapshot.capturedAtMs)) : null;
  const snapshotThreads = normalizeMobileThreads(snapshot ? snapshot.value : null, { limit: options.limit });
  const includeThreadId = firstString(options.includeThreadId);
  const needsLocalInclude =
    includeThreadId &&
    !snapshotThreads.some((thread) => thread && String(thread.id || "") === includeThreadId);
  const localThreads =
    (snapshotThreads.length === 0 || needsLocalInclude) && typeof options.listLocalThreads === "function"
      ? normalizeMobileThreads(options.listLocalThreads(), { limit: options.limit })
      : [];
  let threads = snapshotThreads.length > 0 ? snapshotThreads : localThreads;
  if (snapshotThreads.length > 0 && needsLocalInclude) {
    const includedThread = localThreads.find((thread) => thread && String(thread.id || "") === includeThreadId);
    if (includedThread) {
      // 快照可能来自完整桌面 thread/list，但低流量入口指定的当前会话必须保留在手机 catalog 里。
      threads = [includedThread, ...snapshotThreads.filter((thread) => thread && String(thread.id || "") !== includeThreadId)];
      threads = threads.slice(0, Math.max(1, Math.min(Number(options.limit) || 50, 200)));
    }
  }
  const payload = {
    mode: "mobile-lite",
    ok: true,
    snapshotAgeMs,
    source: snapshotThreads.length > 0 ? snapshot.source || "snapshot" : localThreads.length > 0 ? "local-history" : "empty",
    threads,
  };
  if (options.includeDeferredState === true) {
    // 默认不向手机传诊断态；需要排查时再显式打开，避免弱网首屏携带用不到的桌面状态说明。
    payload.deferredState = MOBILE_DEFERRED_STATE;
  }
  payload.metrics = {
    deferredStateCount: MOBILE_DEFERRED_STATE.length,
    estimatedPayloadBytes: estimatedJsonBytes(payload),
    listCacheTtlMs: MOBILE_THREAD_LIST_CACHE_TTL_MS,
    threadCount: payload.threads.length,
  };
  return Promise.resolve(payload);
}

function createMobileThreadPayload(options = {}) {
  const detail = typeof options.readLocalThreadDetail === "function" ? options.readLocalThreadDetail() : null;
  if (!detail || detail.ok !== true) return Promise.resolve({ ok: false, error: "Thread not found" });
  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  const payload = {
    messages: Array.isArray(detail.messages) ? detail.messages : [],
    mode: "mobile-lite",
    ok: true,
    source: detail.source || "local-history",
    thread: detail.thread,
  };
  payload.metrics = {
    ...(detail.metrics && typeof detail.metrics === "object" ? detail.metrics : {}),
    estimatedPayloadBytes: estimatedJsonBytes(payload),
    messageCount: messages.length,
    truncatedCount: messages.filter((message) => message && message.truncated).length,
  };
  return Promise.resolve(payload);
}

function createMobileApi({ codexHome, fastSyncCache, invokeTurnStart, mobileRecentFileLimit } = {}) {
  const turnSender = createMobileTurnSender({ invokeTurnStart });
  const mobileLookupOptions = {
    allowFullScan: false,
    ...(codexHome ? { codexHome } : {}),
    recentFileLimit: Math.max(1, Number(mobileRecentFileLimit) || MOBILE_THREAD_HTTP_RECENT_FILE_LIMIT),
  };

  function readThreadListSnapshot() {
    const key = cacheKeyForSnapshot(MOBILE_THREAD_LIST_METHOD, MOBILE_THREAD_LIST_ARGS);
    return fastSyncCache.readSnapshot({ key });
  }

  async function handleBootstrap(req, res, url) {
    const limit = Number(url.searchParams.get("limit") || 50);
    const includeThreadId = firstString(url.searchParams.get("includeThreadId"));
    const payload = await createMobileBootstrapPayload({
      includeDeferredState: url.searchParams.get("debugState") === "1",
      includeThreadId,
      limit,
      listLocalThreads: () => listLocalSessionThreads({ ...(codexHome ? { codexHome } : {}), includeThreadId, limit }),
      readThreadListSnapshot,
    });
    return sendMobilePayload(req, res, 200, payload);
  }

  async function handleThread(req, res, url, threadId) {
    const limit = Number(url.searchParams.get("limit") || 120);
    const tailBytes = mobileThreadDetailTailBytesForLimit(limit);
    const payload = await createMobileThreadPayload({
      readLocalThreadDetail: () => listLocalSessionThreadDetail({ ...mobileLookupOptions, limit, tailBytes, threadId }),
      threadId,
    });
    if (!payload.ok) return sendMobilePayload(req, res, 404, payload);
    return sendMobilePayload(req, res, 200, payload);
  }

  function handleThreadEvents(req, res, url, threadId) {
    const match = findLocalSessionFile({ ...mobileLookupOptions, threadId });
    if (!match) {
      res.writeHead(404, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      sseWrite(res, { data: { error: "Thread not found" }, event: "error" });
      res.end();
      return null;
    }
    const lastEventId = firstString(req.headers && req.headers["last-event-id"], req.headers && req.headers["Last-Event-ID"]);
    return createMobileThreadEventStream({
      filePath: match.filePath,
      req,
      res,
      sinceOffset: url.searchParams.get("sinceOffset") || lastEventId,
      threadId,
    });
  }

  async function handleThreadTurn(req, res, _url, threadId) {
    let parsedBody = null;
    try {
      parsedBody = parseJsonBody(await readBody(req, { maxBytes: 128 * 1024 }));
    } catch (error) {
      const status = error && typeof error.statusCode === "number" ? error.statusCode : 500;
      return sendJsonCompressed(req, res, status, { ok: false, error: error instanceof Error ? error.message : String(error) }, { "cache-control": "no-store" });
    }
    if (!parsedBody.ok) return sendJsonCompressed(req, res, 400, { ok: false, error: parsedBody.error }, { "cache-control": "no-store" });
    const body = parsedBody.value && typeof parsedBody.value === "object" ? parsedBody.value : {};
    const text = normalizeMobileTurnText(body.text || body.message || body.prompt);
    if (!firstString(threadId)) {
      return sendJsonCompressed(req, res, 400, { ok: false, error: "Missing threadId" }, { "cache-control": "no-store" });
    }
    if (!text) return sendJsonCompressed(req, res, 400, { ok: false, error: "Missing message text" }, { "cache-control": "no-store" });

    try {
      const payload = await turnSender.sendTurn({
        localSendId: mobileTurnLocalSendId(body.localSendId),
        text,
        threadId,
      });
      return sendJsonCompressed(req, res, 202, payload, { "cache-control": "no-store" });
    } catch (error) {
      return sendJsonCompressed(
        req,
        res,
        502,
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { "cache-control": "no-store" }
      );
    }
  }

  return { handleBootstrap, handleThread, handleThreadEvents, handleThreadTurn };
}

module.exports = {
  MOBILE_DEFERRED_STATE,
  MOBILE_THREAD_LIST_ARGS,
  MOBILE_THREAD_LIST_METHOD,
  createMobileApi,
  createMobileBootstrapPayload,
  createMobileThreadEventStream,
  createMobileThreadPayload,
  createMobileTurnSender,
  createMobileTurnStartPayload,
  listLocalSessionThreadDetail,
  listLocalSessionThreads,
  mobileThreadDetailTailBytesForLimit,
  normalizeMobileThreads,
};
