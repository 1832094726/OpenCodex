const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { recordFlowEvent, snapshotFlowState } = require("../runtime/core/flow-monitor.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");

test("turn flow events retain local pending send ids", () => {
  const clientId = `client-flow-${Date.now()}`;
  const localSendId = `local-flow-${Date.now()}`;

  recordFlowEvent({
    clientId,
    localSendId,
    method: "turn/start",
    requestId: "request-flow-1",
    scope: "turn",
    stage: "send_pending_created",
    threadId: "thread-flow-1",
  });

  const snapshot = snapshotFlowState({ clientId, limit: 5 });
  assert.equal(snapshot.turn.localSendId, localSendId);
  assert.equal(snapshot.turn.state, "send_pending_created");
  assert.equal(snapshot.events.at(-1).localSendId, localSendId);
});

test("client diagnostics feed fast sync flow events safely", () => {
  const serverSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "server.cjs"), "utf8");
  const wsHubSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "ipc", "ws-hub.cjs"), "utf8");

  // HTTP /api/client-log 是当前真实路径，WS 入口保留为同形态兼容。
  assert.match(serverSource, /event !== "fast-sync-flow"/);
  assert.match(serverSource, /recordFlowEvent\(flowEvent\)/);
  assert.match(serverSource, /safeFastSyncFlowData/);
  assert.match(serverSource, /typeof rawValue === "object"/);
  assert.match(wsHubSource, /message\.type !== "client-diagnostic"/);
  assert.match(wsHubSource, /message\.event !== "fast-sync-flow"/);
  assert.match(wsHubSource, /recordFlowEvent\(flowEvent\)/);
});
