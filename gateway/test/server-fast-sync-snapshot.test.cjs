const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverSource = fs.readFileSync(path.join(repoRoot, "gateway", "runtime", "server.cjs"), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test("fast-sync snapshot API can read by explicit snapshot key without rebuilding args", () => {
  const handlerBody = sourceBetween(serverSource, 'pathname === "/api/fast-sync/snapshot"', 'pathname === "/api/ipc/handlers"');

  // gap nudge 已经携带写入端 key，服务端必须允许直接按 key 读，避免弱网重连时再依赖完整 args 形状。
  assert.match(handlerBody, /const explicitKey = url\.searchParams\.get\("key"\) \|\| ""/);
  assert.match(handlerBody, /const threadId = url\.searchParams\.get\("threadId"\) \|\| ""/);
  assert.match(handlerBody, /let key = explicitKey/);
  assert.match(handlerBody, /if \(!key && !threadId\) \{/);
  assert.match(handlerBody, /parseFastSyncSnapshotArgsJson\(argsJson\)/);
  assert.match(handlerBody, /cache\.readSnapshot\(\{ key, method, threadId \}\)/);
});
