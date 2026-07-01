const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRelayLifecycleTracker,
  relayLifecycleSnapshot,
} = require("../runtime/core/relay-lifecycle.cjs");

test("relay lifecycle tracker records ordered recovery transitions", () => {
  let nowMs = 1_000;
  const transitions = [];
  const tracker = createRelayLifecycleTracker({
    now: () => nowMs,
    onTransition: (transition) => transitions.push(transition),
  });

  tracker.markConnected("client-a", "port-a", { reason: "connect" });
  nowMs += 10;
  tracker.markMissing("client-a", "port-a", { queued: 1 });
  nowMs += 10;
  tracker.markRecreating("client-a", "port-a");
  nowMs += 10;
  tracker.markFlushed("client-a", "port-a", { queued: 1, sent: 1 });

  const snapshot = tracker.snapshot("client-a", "port-a");
  assert.equal(snapshot.state, "relay_flushed");
  assert.equal(snapshot.previousState, "relay_recreating");
  assert.equal(snapshot.queued, 1);
  assert.equal(snapshot.sent, 1);
  assert.equal(snapshot.transitionCount, 4);
  assert.deepEqual(transitions.map((item) => item.state), [
    "relay_connected",
    "relay_missing",
    "relay_recreating",
    "relay_flushed",
  ]);
});

test("relay lifecycle tracker preserves failure evidence until reconnect", () => {
  const tracker = createRelayLifecycleTracker({ now: () => 2_000 });

  tracker.markMissing("client-b", "port-b", { queued: 2 });
  tracker.markFailed("client-b", "port-b", { error: "boom" });
  tracker.markFlushed("client-b", "port-b", { queued: 2, sent: 2 });

  const failed = tracker.snapshot("client-b", "port-b");
  assert.equal(failed.state, "relay_failed");
  assert.equal(failed.error, "boom");
  assert.equal(failed.queued, 2);
  assert.equal(failed.sent, 0);

  tracker.markConnected("client-b", "port-b", { reason: "manual-reconnect" });
  const reconnected = tracker.snapshot("client-b", "port-b");
  assert.equal(reconnected.state, "relay_connected");
  assert.equal(reconnected.error, "");
  assert.equal(reconnected.reason, "manual-reconnect");
});

test("relay lifecycle snapshot returns sanitized defaults", () => {
  assert.deepEqual(relayLifecycleSnapshot(null), {
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
  });
});
