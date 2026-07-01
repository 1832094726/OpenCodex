function relayKey(clientId, portId) {
  return `${clientId || ""}\n${portId || ""}`;
}

function relayLifecycleSnapshot(record, nowMs = Date.now()) {
  if (!record || typeof record !== "object") {
    return {
      ageMs: 0,
      atMs: 0,
      clientId: "",
      error: "",
      portId: "",
      previousState: "",
      queued: 0,
      reason: "",
      sent: 0,
      state: "idle",
      transitionCount: 0,
    };
  }
  const atMs = Math.max(0, Number(record.atMs) || 0);
  return {
    ageMs: atMs > 0 ? Math.max(0, nowMs - atMs) : 0,
    atMs,
    clientId: record.clientId || "",
    error: record.error || "",
    portId: record.portId || "",
    previousState: record.previousState || "",
    queued: Math.max(0, Number(record.queued) || 0),
    reason: record.reason || "",
    sent: Math.max(0, Number(record.sent) || 0),
    state: record.state || "idle",
    transitionCount: Math.max(0, Number(record.transitionCount) || 0),
  };
}

function createRelayLifecycleTracker(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onTransition = typeof options.onTransition === "function" ? options.onTransition : null;
  const recordsByKey = new Map();

  function transition(clientId, portId, state, details = {}) {
    if (!clientId || !portId) return relayLifecycleSnapshot(null);
    const key = relayKey(clientId, portId);
    const current = recordsByKey.get(key) || {};
    if (current.state === "relay_failed" && state !== "relay_connected" && state !== "relay_closed") {
      return relayLifecycleSnapshot(current, now());
    }
    const atMs = now();
    const next = {
      atMs,
      clientId,
      error: details.error ? String(details.error) : state === "relay_connected" ? "" : current.error || "",
      portId,
      previousState: current.state || "",
      queued: Math.max(0, Number(details.queued ?? current.queued) || 0),
      reason: details.reason ? String(details.reason) : "",
      sent: Math.max(0, Number(details.sent ?? (state === "relay_failed" ? 0 : current.sent)) || 0),
      state,
      transitionCount: Math.max(0, Number(current.transitionCount) || 0) + 1,
    };
    recordsByKey.set(key, next);
    const snapshot = relayLifecycleSnapshot(next, atMs);
    if (onTransition) {
      try {
        onTransition(snapshot);
      } catch {}
    }
    return snapshot;
  }

  return {
    markClosed(clientId, portId, details) {
      return transition(clientId, portId, "relay_closed", details);
    },
    markConnected(clientId, portId, details) {
      return transition(clientId, portId, "relay_connected", details);
    },
    markFailed(clientId, portId, details) {
      return transition(clientId, portId, "relay_failed", details);
    },
    markFlushed(clientId, portId, details = {}) {
      const state = Math.max(0, Number(details.sent) || 0) === Math.max(0, Number(details.queued) || 0)
        ? "relay_flushed"
        : "relay_partial_flush";
      return transition(clientId, portId, state, details);
    },
    markMissing(clientId, portId, details) {
      return transition(clientId, portId, "relay_missing", details);
    },
    markRecreating(clientId, portId, details) {
      return transition(clientId, portId, "relay_recreating", details);
    },
    snapshot(clientId, portId) {
      return relayLifecycleSnapshot(recordsByKey.get(relayKey(clientId, portId)), now());
    },
  };
}

module.exports = { createRelayLifecycleTracker, relayLifecycleSnapshot };
