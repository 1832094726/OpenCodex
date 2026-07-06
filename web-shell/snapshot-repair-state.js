(function attachSnapshotRepairState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenCodexSnapshotRepairState = api;
})(typeof globalThis !== "undefined" ? globalThis : undefined, function createSnapshotRepairStateModule() {
  function snapshotRepairDecisionSnapshot(decision) {
    if (!decision || typeof decision !== "object") {
      return {
        action: "ignored",
        reason: "empty",
        replaySent: 0,
        route: "",
        threadId: "",
      };
    }
    return {
      action: decision.action || "ignored",
      reason: decision.reason || "",
      replaySent: Math.max(0, Number(decision.replaySent) || 0),
      route: typeof decision.route === "string" ? decision.route : "",
      threadId: typeof decision.threadId === "string" ? decision.threadId : "",
    };
  }

  function decideSnapshotRepair(input) {
    const context = input && typeof input === "object" ? input : {};
    const message = context.message && typeof context.message === "object" ? context.message : {};
    const route = typeof context.route === "string" ? context.route : "";
    const threadId = typeof message.threadId === "string" ? message.threadId : "";
    const visible = context.visible !== false;
    const editing = context.editing === true;
    const replaySent = Math.max(0, Number(message.replaySent) || 0);

    // 状态机只关心恢复决策；route、visibility、editing 这些浏览器上下文由 polyfill 注入。
    if (!route) return snapshotRepairDecisionSnapshot({ action: "ignored", reason: "no-route", route: "", threadId });
    if (!visible) return snapshotRepairDecisionSnapshot({ action: "ignored", reason: "hidden", route, threadId });
    if (editing) return snapshotRepairDecisionSnapshot({ action: "ignored", reason: "editing", route, threadId });
    if (replaySent > 0 && message.replayGap !== true) {
      return snapshotRepairDecisionSnapshot({ action: "incremental-replay", reason: "replay-complete", replaySent, route, threadId });
    }
    if (message.replayGap === true) {
      return snapshotRepairDecisionSnapshot({ action: "snapshot-preload", reason: "replay-gap", replaySent, route, threadId });
    }
    // 普通快照 nudge 只表示同一路由有新全量状态可用；优先让桥层原地广播事件，避免整页刷新重跑官方 bundle。
    return snapshotRepairDecisionSnapshot({ action: "in-place-refresh", reason: "snapshot-nudge", route, threadId });
  }

  return { decideSnapshotRepair, snapshotRepairDecisionSnapshot };
});
