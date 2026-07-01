const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decideSnapshotRepair,
  snapshotRepairDecisionSnapshot,
} = require("../snapshot-repair-state.js");

test("snapshot repair state chooses ignored states for unsafe page contexts", () => {
  assert.equal(decideSnapshotRepair({ route: "", visible: true }).action, "ignored");
  assert.equal(decideSnapshotRepair({ route: "/thread/a", visible: false }).reason, "hidden");
  assert.equal(decideSnapshotRepair({ editing: true, route: "/thread/a", visible: true }).reason, "editing");
});

test("snapshot repair state prefers replay when retained increments were delivered", () => {
  const decision = decideSnapshotRepair({
    message: { replayGap: false, replaySent: 2, threadId: "thread-a" },
    route: "/thread/thread-a",
    visible: true,
  });

  assert.equal(decision.action, "incremental-replay");
  assert.equal(decision.reason, "replay-complete");
  assert.equal(decision.replaySent, 2);
  assert.equal(decision.threadId, "thread-a");
});

test("snapshot repair state uses snapshot preload for replay gaps", () => {
  const decision = decideSnapshotRepair({
    message: { replayGap: true, replaySent: 1, threadId: "thread-b" },
    route: "/thread/thread-b",
    visible: true,
  });

  assert.equal(decision.action, "snapshot-preload");
  assert.equal(decision.reason, "replay-gap");
});

test("snapshot repair state falls back to route refresh for ordinary nudges", () => {
  const decision = decideSnapshotRepair({
    message: { threadId: "thread-c" },
    route: "/thread/thread-c",
    visible: true,
  });

  assert.equal(decision.action, "route-refresh");
  assert.equal(decision.reason, "snapshot-nudge");
});

test("snapshot repair decision snapshot is sanitized", () => {
  assert.deepEqual(snapshotRepairDecisionSnapshot(null), {
    action: "ignored",
    reason: "empty",
    replaySent: 0,
    route: "",
    threadId: "",
  });
});
