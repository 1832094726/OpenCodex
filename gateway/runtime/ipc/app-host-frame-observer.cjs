const { diagnosticLog, shortId } = require("../core/diagnostics.cjs");
const { recordFlowEvent } = require("../core/flow-monitor.cjs");

const SENSITIVE_KEYS = new Set([
  "base64",
  "content",
  "data",
  "file",
  "image",
  "input",
  "message",
  "output",
  "prompt",
  "stderr",
  "stdout",
  "text",
]);

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf-8");
}

function shapeOf(value) {
  if (value == null) return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length})`;
  return typeof value;
}

function parseJsonFrame(data) {
  if (typeof data !== "string" || data.trim() === "") return { ok: false, value: null };
  try {
    const value = JSON.parse(data);
    return value && typeof value === "object" ? { ok: true, value } : { ok: false, value: null };
  } catch {
    return { ok: false, value: null };
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function routeIdFromValue(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || depth > 5) return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = routeIdFromValue(item, depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }
  const direct = firstString(value.requestId, value.id);
  if (direct && (depth > 0 || value.method || value.type || value.jsonrpc)) return direct;
  if (value.request && typeof value.request === "object") {
    const nested = firstString(value.request.id, value.request.requestId) || routeIdFromValue(value.request, depth + 1, seen);
    if (nested) return nested;
  }
  for (const key of ["payload", "params", "message", "response", "body"]) {
    const nested = routeIdFromValue(value[key], depth + 1, seen);
    if (nested) return nested;
  }
  return "";
}

function methodFromValue(value) {
  if (!value || typeof value !== "object") return "";
  return firstString(
    value.method,
    value.type,
    value.request && typeof value.request === "object" ? value.request.method : "",
    value.payload && typeof value.payload === "object" ? value.payload.method : "",
    value.params && typeof value.params === "object" ? value.params.method : ""
  );
}

function collectRouteFields(value, result, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRouteFields(item, result, depth + 1, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
      result.redactedFields.add(key);
      continue;
    }
    if (key === "threadId") result.threadId ||= firstString(item);
    if (key === "turnId") result.turnId ||= firstString(item);
    if (key === "conversationId") result.conversationId ||= firstString(item);
    if (key === "sessionId" || key === "session_id") result.sessionId ||= firstString(item);
    if (item && typeof item === "object") collectRouteFields(item, result, depth + 1, seen);
  }
}

function summarizeAppHostFrame(data) {
  const bytes = byteLength(data);
  const parsed = parseJsonFrame(data);
  const result = {
    bytes,
    conversationId: "",
    method: "",
    parseOk: parsed.ok,
    payloadShape: parsed.ok ? shapeOf(parsed.value) : "unparsed",
    redactedFields: [],
    requestId: "",
    sessionId: "",
    threadId: "",
    turnId: "",
  };
  if (!parsed.ok) return result;
  const collected = {
    conversationId: "",
    redactedFields: new Set(),
    sessionId: "",
    threadId: "",
    turnId: "",
  };
  collectRouteFields(parsed.value, collected);
  result.conversationId = collected.conversationId;
  result.method = methodFromValue(parsed.value);
  result.redactedFields = Array.from(collected.redactedFields).sort();
  result.requestId = routeIdFromValue(parsed.value);
  result.sessionId = collected.sessionId;
  result.threadId = collected.threadId;
  result.turnId = collected.turnId;
  return result;
}

function createAppHostFrameState(options = {}) {
  const maxEntries = Math.max(10, Number(options.maxEntries) || 500);
  return {
    clientByThreadId: new Map(),
    framesByRpcId: new Map(),
    maxEntries,
    portByClientId: new Map(),
    rpcByPortKey: new Map(),
    threadStatesById: new Map(),
  };
}

function trimMap(map, maxEntries) {
  while (map.size > maxEntries) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function portKey(clientId, portId) {
  return `${clientId || ""}\n${portId || ""}`;
}

function ensureThreadState(state, threadId) {
  if (!state || !threadId) return null;
  let thread = state.threadStatesById.get(threadId);
  if (!thread) {
    thread = {
      activeClientIds: new Set(),
      activePortIds: new Set(),
      clientLastSeenAtMs: new Map(),
      conversationId: "",
      downstreamFrameCount: 0,
      frameCount: 0,
      lastDirection: "",
      lastFrameAtMs: 0,
      lastMethod: "",
      lastRequestId: "",
      lastThreadReplayAtMs: 0,
      lastThreadReplayQueued: 0,
      lastThreadReplaySent: 0,
      lastTurnId: "",
      portClientIdByPortId: new Map(),
      portLastSeenAtMs: new Map(),
      sessionId: "",
      threadId,
      threadReplayCount: 0,
      upstreamFrameCount: 0,
    };
    state.threadStatesById.set(threadId, thread);
  }
  trimMap(state.threadStatesById, state.maxEntries);
  return thread;
}

function rememberThreadParticipant(thread, clientId, portId, nowMs) {
  // thread 状态只保存路由身份和时间戳，正文内容仍由 summarize 阶段统一脱敏。
  if (!thread) return;
  if (clientId) {
    thread.clientLastSeenAtMs.set(clientId, nowMs);
    thread.activeClientIds.add(clientId);
  }
  if (portId) {
    thread.portLastSeenAtMs.set(portId, nowMs);
    thread.activePortIds.add(portId);
    if (clientId) thread.portClientIdByPortId.set(portId, clientId);
  }
}

function rememberThreadFrame(state, summary, context, nowMs) {
  if (!state || !summary || !summary.threadId) return null;
  const thread = ensureThreadState(state, summary.threadId);
  rememberThreadParticipant(thread, context.clientId || "", context.portId || "", nowMs);
  thread.conversationId ||= summary.conversationId;
  thread.sessionId ||= summary.sessionId;
  if (summary.conversationId) thread.conversationId = summary.conversationId;
  if (summary.sessionId) thread.sessionId = summary.sessionId;
  thread.frameCount += 1;
  if (context.direction === "official-to-browser") thread.downstreamFrameCount += 1;
  if (context.direction === "browser-to-official") thread.upstreamFrameCount += 1;
  thread.lastDirection = context.direction || "";
  thread.lastFrameAtMs = nowMs;
  thread.lastMethod = summary.method || thread.lastMethod;
  thread.lastRequestId = summary.requestId || thread.lastRequestId;
  thread.lastTurnId = summary.turnId || thread.lastTurnId;
  trimMap(thread.clientLastSeenAtMs, state.maxEntries);
  trimMap(thread.portLastSeenAtMs, state.maxEntries);
  return thread;
}

function rememberFrame(state, summary, context) {
  if (!state || !summary) return;
  const nowMs = Date.now();
  const clientId = context.clientId || "";
  const portId = context.portId || "";
  if (clientId && portId) state.portByClientId.set(clientId, portId);
  if (summary.threadId && clientId) state.clientByThreadId.set(summary.threadId, clientId);
  rememberThreadFrame(state, summary, context, nowMs);
  if (summary.requestId) {
    const entry = {
      clientId,
      conversationId: summary.conversationId,
      direction: context.direction,
      method: summary.method,
      portId,
      requestId: summary.requestId,
      sessionId: summary.sessionId,
      threadId: summary.threadId,
      turnId: summary.turnId,
      updatedAtMs: nowMs,
    };
    state.framesByRpcId.set(summary.requestId, entry);
    const key = portKey(clientId, portId);
    if (!state.rpcByPortKey.has(key)) state.rpcByPortKey.set(key, new Set());
    state.rpcByPortKey.get(key).add(summary.requestId);
    trimMap(state.framesByRpcId, state.maxEntries);
    trimMap(state.rpcByPortKey, state.maxEntries);
  }
  trimMap(state.clientByThreadId, state.maxEntries);
  trimMap(state.portByClientId, state.maxEntries);
}

function rememberAppHostThreadPort(state, details = {}) {
  const threadId = typeof details.threadId === "string" ? details.threadId : "";
  const clientId = typeof details.clientId === "string" ? details.clientId : "";
  const portId = typeof details.portId === "string" ? details.portId : "";
  if (!state || !threadId) return null;
  const nowMs = Date.now();
  const thread = ensureThreadState(state, threadId);
  rememberThreadParticipant(thread, clientId, portId, nowMs);
  thread.lastFrameAtMs ||= nowMs;
  if (clientId) state.clientByThreadId.set(threadId, clientId);
  if (clientId && portId) state.portByClientId.set(clientId, portId);
  trimMap(state.clientByThreadId, state.maxEntries);
  trimMap(state.portByClientId, state.maxEntries);
  return appHostThreadStateSnapshot(state, threadId);
}

function markAppHostClientInactive(state, clientId) {
  if (!state || !clientId || !state.threadStatesById) return 0;
  let touched = 0;
  for (const thread of state.threadStatesById.values()) {
    if (!thread || !thread.clientLastSeenAtMs.has(clientId)) continue;
    // 断线只改变活跃状态，不删除历史参与者；这样重连诊断仍能看到旧客户端曾接过该 thread。
    thread.activeClientIds.delete(clientId);
    for (const [portId, ownerClientId] of thread.portClientIdByPortId.entries()) {
      if (ownerClientId === clientId) thread.activePortIds.delete(portId);
    }
    touched += 1;
  }
  return touched;
}

function recordAppHostThreadReplay(state, details = {}) {
  const threadId = typeof details.threadId === "string" ? details.threadId : "";
  if (!state || !threadId) return null;
  const nowMs = Date.now();
  const thread = ensureThreadState(state, threadId);
  rememberThreadParticipant(thread, details.clientId || "", details.portId || "", nowMs);
  thread.threadReplayCount += 1;
  thread.lastThreadReplayAtMs = nowMs;
  thread.lastThreadReplayQueued = Math.max(0, Number(details.queued) || 0);
  thread.lastThreadReplaySent = Math.max(0, Number(details.sent) || 0);
  return appHostThreadStateSnapshot(state, threadId);
}

function appHostThreadStateSnapshot(state, threadId) {
  if (!state || !threadId || !state.threadStatesById) return null;
  const thread = state.threadStatesById.get(threadId);
  if (!thread) return null;
  return {
    activeClientCount: thread.activeClientIds.size,
    activeClientIds: Array.from(thread.activeClientIds.keys()),
    activePortCount: thread.activePortIds.size,
    activePortIds: Array.from(thread.activePortIds.keys()),
    clientCount: thread.clientLastSeenAtMs.size,
    clientIds: Array.from(thread.clientLastSeenAtMs.keys()),
    conversationId: thread.conversationId,
    downstreamFrameCount: thread.downstreamFrameCount,
    frameCount: thread.frameCount,
    lastDirection: thread.lastDirection,
    lastFrameAtMs: thread.lastFrameAtMs,
    lastMethod: thread.lastMethod,
    lastRequestId: thread.lastRequestId,
    lastThreadReplayAtMs: thread.lastThreadReplayAtMs,
    lastThreadReplayQueued: thread.lastThreadReplayQueued,
    lastThreadReplaySent: thread.lastThreadReplaySent,
    lastTurnId: thread.lastTurnId,
    portCount: thread.portLastSeenAtMs.size,
    portIds: Array.from(thread.portLastSeenAtMs.keys()),
    sessionId: thread.sessionId,
    threadId: thread.threadId,
    threadReplayCount: thread.threadReplayCount,
    upstreamFrameCount: thread.upstreamFrameCount,
  };
}

function observeAppHostFrame(context = {}) {
  const summary = summarizeAppHostFrame(context.data);
  rememberFrame(context.state, summary, context);
  const details = {
    bytes: summary.bytes,
    clientId: shortId(context.clientId || ""),
    conversationId: shortId(summary.conversationId),
    direction: context.direction || "",
    method: summary.method,
    parseOk: summary.parseOk,
    payloadShape: summary.payloadShape,
    portId: shortId(context.portId || ""),
    redactedFields: summary.redactedFields,
    requestId: shortId(summary.requestId),
    threadId: shortId(summary.threadId),
    turnId: shortId(summary.turnId),
  };
  if (context.log === true || (context.log === "routed" && (summary.method || summary.threadId || summary.requestId))) {
    diagnosticLog("app-host-frame", "observed", details);
  }
  if ((summary.threadId || summary.requestId || summary.method) && context.flow !== false) {
    recordFlowEvent({
      clientId: context.clientId || "",
      method: summary.method,
      requestId: summary.requestId,
      scope: "app-host",
      stage: context.direction || "observed",
      threadId: summary.threadId,
      turnId: summary.turnId,
    });
  }
  return { ...details, raw: summary };
}

function appHostStateContext(state, clientId, portId) {
  if (!state) return {};
  const key = portKey(clientId, portId);
  const ids = state.rpcByPortKey.get(key);
  const lastId = ids && ids.size > 0 ? Array.from(ids).at(-1) : "";
  const last = lastId ? state.framesByRpcId.get(lastId) : null;
  return {
    conversationId: last && last.conversationId ? shortId(last.conversationId) : "",
    lastDirection: last && last.direction ? last.direction : "",
    method: last && last.method ? last.method : "",
    requestId: last && last.requestId ? shortId(last.requestId) : "",
    threadId: last && last.threadId ? shortId(last.threadId) : "",
    turnId: last && last.turnId ? shortId(last.turnId) : "",
  };
}

module.exports = {
  appHostStateContext,
  appHostThreadStateSnapshot,
  createAppHostFrameState,
  markAppHostClientInactive,
  observeAppHostFrame,
  recordAppHostThreadReplay,
  rememberAppHostThreadPort,
  summarizeAppHostFrame,
};
