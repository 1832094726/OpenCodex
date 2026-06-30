const fs = require("fs");
const path = require("path");
const { cacheKeyForSnapshot } = require("../core/fast-sync-cache.cjs");
const { CODEX_HOME } = require("../core/config.cjs");
const { sendJson } = require("./http-utils.cjs");

const MOBILE_DEFERRED_STATE = ["app/list", "mcpServerStatus/list", "plugin/list", "desktop-state"];
const MOBILE_THREAD_LIST_METHOD = "thread/list";
const MOBILE_THREAD_LIST_ARGS = [];

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
  const id = firstString(thread.id, thread.threadId, thread.thread_id, thread.conversationId, thread.conversation_id);
  if (!id) return null;
  const title = firstString(thread.title, thread.name, thread.summary, thread.firstMessage) || "Untitled";
  const projectPath = firstString(
    thread.projectPath,
    thread.project_path,
    thread.cwd,
    thread.workspace,
    thread.workspacePath,
    thread.repoPath
  );
  const updatedAt = firstValue(
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

function walkJsonlFiles(root, files = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
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

function sessionThreadFromFile(filePath, archived) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const thread = {
    archived,
    id: path.basename(filePath, ".jsonl"),
    projectPath: "",
    title: "",
    updatedAt: stat.mtime.toISOString(),
  };
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(0, 40);
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

function parseSessionFile(filePath, archived, options = {}) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
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
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = firstValue(record.timestamp, record.payload && record.payload.timestamp, thread.updatedAt);
      if (record && record.type === "session_meta" && record.payload && typeof record.payload === "object") {
        // 详情页同样只抽元信息，不透传 session_meta 里的完整上下文和内部配置。
        thread.id = firstString(record.payload.session_id, record.payload.id, thread.id) || thread.id;
        thread.projectPath = firstString(record.payload.cwd, record.payload.workspace, thread.projectPath);
        thread.updatedAt = firstValue(record.payload.timestamp, record.timestamp, thread.updatedAt);
        continue;
      }
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
      if (!role || !text) continue;
      if (role === "user" && !isUsefulThreadTitle(text)) continue;
      if (!thread.title && role === "user") thread.title = text.slice(0, 80);
      messages.push({ role, text, timestamp });
      if (messages.length >= limit) break;
    }
  } catch {
    return null;
  }
  thread.title = thread.title || "Untitled";
  return { messages, ok: true, thread };
}

function listLocalSessionThreads(options = {}) {
  const codexHome = options.codexHome || CODEX_HOME;
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const roots = [
    { archived: false, dir: path.join(codexHome, "sessions") },
    { archived: true, dir: path.join(codexHome, "archived_sessions") },
  ];
  const files = [];
  for (const root of roots) {
    for (const filePath of walkJsonlFiles(root.dir)) files.push({ archived: root.archived, filePath });
  }
  const filesWithMtime = files
    .map((item) => {
      try {
        return { ...item, mtimeMs: fs.statSync(item.filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const threads = [];
  for (const item of filesWithMtime.slice(0, limit * 3)) {
    const thread = sessionThreadFromFile(item.filePath, item.archived);
    if (thread) threads.push(thread);
    if (threads.length >= limit) break;
  }
  return threads;
}

function findLocalSessionFile(options = {}) {
  const codexHome = options.codexHome || CODEX_HOME;
  const threadId = firstString(options.threadId);
  if (!threadId) return null;
  const roots = [
    { archived: false, dir: path.join(codexHome, "sessions") },
    { archived: true, dir: path.join(codexHome, "archived_sessions") },
  ];
  for (const root of roots) {
    for (const filePath of walkJsonlFiles(root.dir)) {
      if (path.basename(filePath, ".jsonl").endsWith(threadId)) return { archived: root.archived, filePath };
      try {
        const firstLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0] || "";
        const record = JSON.parse(firstLine);
        const payload = record && record.payload && typeof record.payload === "object" ? record.payload : {};
        if (firstString(payload.session_id, payload.id) === threadId) return { archived: root.archived, filePath };
      } catch {}
    }
  }
  return null;
}

function listLocalSessionThreadDetail(options = {}) {
  const match = findLocalSessionFile(options);
  if (!match) return { ok: false };
  const parsed = parseSessionFile(match.filePath, match.archived, options);
  return parsed || { ok: false };
}

function createMobileBootstrapPayload(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const snapshot = typeof options.readThreadListSnapshot === "function" ? options.readThreadListSnapshot() : null;
  const snapshotAgeMs = snapshot && Number(snapshot.capturedAtMs) > 0 ? Math.max(0, now() - Number(snapshot.capturedAtMs)) : null;
  const snapshotThreads = normalizeMobileThreads(snapshot ? snapshot.value : null, { limit: options.limit });
  const localThreads =
    snapshotThreads.length === 0 && typeof options.listLocalThreads === "function"
      ? normalizeMobileThreads(options.listLocalThreads(), { limit: options.limit })
      : [];
  return Promise.resolve({
    deferredState: MOBILE_DEFERRED_STATE,
    mode: "mobile-lite",
    ok: true,
    snapshotAgeMs,
    source: snapshotThreads.length > 0 ? snapshot.source || "snapshot" : localThreads.length > 0 ? "local-history" : "empty",
    threads: snapshotThreads.length > 0 ? snapshotThreads : localThreads,
  });
}

function createMobileThreadPayload(options = {}) {
  const detail = typeof options.readLocalThreadDetail === "function" ? options.readLocalThreadDetail() : null;
  if (!detail || detail.ok !== true) return Promise.resolve({ ok: false, error: "Thread not found" });
  return Promise.resolve({
    messages: Array.isArray(detail.messages) ? detail.messages : [],
    mode: "mobile-lite",
    ok: true,
    source: detail.source || "local-history",
    thread: detail.thread,
  });
}

function createMobileApi({ fastSyncCache }) {
  function readThreadListSnapshot() {
    const key = cacheKeyForSnapshot(MOBILE_THREAD_LIST_METHOD, MOBILE_THREAD_LIST_ARGS);
    return fastSyncCache.readSnapshot({ key });
  }

  async function handleBootstrap(_req, res, url) {
    const limit = Number(url.searchParams.get("limit") || 50);
    const payload = await createMobileBootstrapPayload({
      limit,
      listLocalThreads: () => listLocalSessionThreads({ limit }),
      readThreadListSnapshot,
    });
    return sendJson(res, 200, payload, { "cache-control": "no-store" });
  }

  async function handleThread(_req, res, url, threadId) {
    const limit = Number(url.searchParams.get("limit") || 120);
    const payload = await createMobileThreadPayload({
      readLocalThreadDetail: () => listLocalSessionThreadDetail({ limit, threadId }),
      threadId,
    });
    if (!payload.ok) return sendJson(res, 404, payload, { "cache-control": "no-store" });
    return sendJson(res, 200, payload, { "cache-control": "no-store" });
  }

  return { handleBootstrap, handleThread };
}

module.exports = {
  MOBILE_DEFERRED_STATE,
  MOBILE_THREAD_LIST_ARGS,
  MOBILE_THREAD_LIST_METHOD,
  createMobileApi,
  createMobileBootstrapPayload,
  createMobileThreadPayload,
  listLocalSessionThreadDetail,
  listLocalSessionThreads,
  normalizeMobileThreads,
};
