const { shortId } = require("./diagnostics.cjs");

const MAX_FLOW_EVENTS = Number(process.env.OPENCODEX_FLOW_EVENT_LIMIT || 300);
const STALE_TURN_WAIT_MS = Number(process.env.OPENCODEX_FLOW_TURN_WAIT_WARN_MS || 5000);

const events = [];
const connectionByClientId = new Map();
const threadByClientId = new Map();
const turnByClientId = new Map();
const relayByClientId = new Map();

function nowMs() {
  return Date.now();
}

function boundedText(value, max = 180) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function publicClientId(value) {
  return shortId(String(value || ""));
}

function normalizeEvent(input) {
  const atMs = Number(input && input.atMs) || nowMs();
  const level = ["info", "warn", "error"].includes(input && input.level) ? input.level : "info";
  const event = {
    at: new Date(atMs).toISOString(),
    atMs,
    clientId: publicClientId(input && input.clientId),
    durationMs: Number.isFinite(Number(input && input.durationMs)) ? Math.round(Number(input.durationMs)) : undefined,
    error: boundedText(input && input.error),
    hint: boundedText(input && input.hint),
    level,
    method: boundedText(input && input.method, 80),
    ok: typeof (input && input.ok) === "boolean" ? input.ok : undefined,
    requestId: boundedText(input && input.requestId, 120),
    scope: boundedText((input && input.scope) || "connection", 40),
    stage: boundedText((input && input.stage) || "unknown", 80),
    threadId: boundedText(input && input.threadId, 120),
    turnId: boundedText(input && input.turnId, 120),
  };
  for (const key of Object.keys(event)) {
    if (event[key] === "" || event[key] === undefined) delete event[key];
  }
  return event;
}

function remember(map, clientId, patch) {
  const key = publicClientId(clientId);
  if (!key) return;
  const previous = map.get(key) || {};
  map.set(key, { ...previous, ...patch, updatedAtMs: nowMs() });
}

function recordFlowEvent(input) {
  const event = normalizeEvent(input || {});
  events.push(event);
  while (events.length > MAX_FLOW_EVENTS) events.shift();

  const clientId = event.clientId;
  if (!clientId) return event;
  if (event.scope === "connection") {
    remember(connectionByClientId, clientId, {
      lastEventAtMs: event.atMs,
      lastHint: event.hint || "",
      state: event.stage,
      wsReady: event.stage === "ws_ready" || event.stage === "ready" ? true : undefined,
    });
  } else if (event.scope === "thread") {
    remember(threadByClientId, clientId, {
      lastDurationMs: event.durationMs,
      lastEventAtMs: event.atMs,
      lastHint: event.hint || "",
      lastMethod: event.method || "",
      state: event.stage,
      threadId: event.threadId || "",
    });
  } else if (event.scope === "turn") {
    remember(turnByClientId, clientId, {
      lastDurationMs: event.durationMs,
      lastEventAtMs: event.atMs,
      lastHint: event.hint || "",
      lastMethod: event.method || "",
      requestId: event.requestId || "",
      state: event.stage,
      threadId: event.threadId || "",
      turnId: event.turnId || "",
    });
  } else if (event.scope === "relay") {
    remember(relayByClientId, clientId, {
      lastEventAtMs: event.atMs,
      lastHint: event.hint || "",
      state: event.stage,
    });
  }
  return event;
}

function currentClientId(preferred) {
  const selected = publicClientId(preferred);
  if (selected) return selected;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].clientId) return events[index].clientId;
  }
  return "";
}

function readableAge(record) {
  if (!record || !record.updatedAtMs) return 0;
  return Math.max(0, nowMs() - record.updatedAtMs);
}

function normalizeTurnState(record) {
  if (!record) return { state: "idle", ageMs: 0 };
  const ageMs = readableAge(record);
  if (record.state === "turn_accepted" && ageMs >= STALE_TURN_WAIT_MS) {
    return { ...record, ageMs, state: "waiting_for_events", warnAfterMs: STALE_TURN_WAIT_MS };
  }
  return { ...record, ageMs };
}

function recentFlowEvents(limit = 80, filters = {}) {
  const count = Math.max(1, Math.min(200, Number(limit) || 80));
  const clientId = publicClientId(filters.clientId);
  const threadId = String(filters.threadId || "");
  const filtered = events.filter((event) => {
    if (clientId && event.clientId !== clientId) return false;
    if (threadId && event.threadId !== threadId) return false;
    return true;
  });
  return filtered.slice(Math.max(0, filtered.length - count));
}

function snapshotFlowState(options = {}) {
  const clientId = currentClientId(options.clientId);
  const threadId = String(options.threadId || "");
  const thread = threadByClientId.get(clientId) || { state: "idle" };
  const connection = connectionByClientId.get(clientId) || { state: clientId ? "seen" : "idle" };
  const turn = normalizeTurnState(turnByClientId.get(clientId));
  const relay = relayByClientId.get(clientId) || { state: "idle" };
  return {
    ok: true,
    clientId,
    generatedAt: new Date().toISOString(),
    connection,
    thread,
    turn,
    relay,
    events: recentFlowEvents(options.limit || 80, { clientId, threadId }),
  };
}

module.exports = {
  recentFlowEvents,
  recordFlowEvent,
  snapshotFlowState,
};
