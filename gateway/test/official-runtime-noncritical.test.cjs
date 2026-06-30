const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourcePath = path.join(__dirname, "../runtime/ipc/official-runtime.cjs");
const source = fs.readFileSync(sourcePath, "utf8");

function officialRuntimeFunctionSource(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0, `missing ${name}`);
  assert.ok(end > start, `missing ${nextName} after ${name}`);
  return source.slice(start, end);
}

test("account usage fetch is not treated as non-critical", () => {
  const body = officialRuntimeFunctionSource("nonCriticalFetchBodyForUrl", "sendFetchJsonResponse");
  // /wham/usage 驱动头像菜单里的剩余用量，不能像遥测接口一样返回空对象。
  assert.doesNotMatch(body, /pathname\s*===\s*["']\/wham\/usage["']/);
});

test("codex runtime watcher refreshes hidden official app-server on config changes", () => {
  const watcherBody = officialRuntimeFunctionSource("installCodexRuntimeWatcher", "setWsHub");
  // ccswitch 会更新这两个文件；OpenCodex 需要在不刷新前台页面的情况下重启隐藏官方 runtime。
  assert.match(source, /CODEX_RUNTIME_WATCH_FILENAMES\s*=\s*new Set\(\["config\.toml", "auth\.json"\]\)/);
  assert.match(source, /CC_SWITCH_SETTINGS_PATH\s*=\s*path\.join\(os\.homedir\(\), "\.cc-switch", "settings\.json"\)/);
  assert.match(source, /CODEX_HISTORY_WATCH_DIRS\s*=\s*\["sessions", "archived_sessions"\]/);
  assert.match(source, /fs\.watch\(targetPath/);
  assert.match(source, /scheduleHiddenOfficialRuntimeRefresh/);
  assert.match(watcherBody, /installCodexHistoryWatcher/);
  assert.match(watcherBody, /ccSwitchSettingsWatchPathFromFilename/);
});

test("hidden official runtime refresh closes app-host relays and reloads hidden webContents", () => {
  const refreshBody = officialRuntimeFunctionSource("refreshHiddenOfficialRuntime", "codexRuntimeWatchPathFromFilename");
  assert.match(refreshBody, /closeAllAppHostRelays\("official_runtime_refresh"\)/);
  assert.match(refreshBody, /terminateTrackedAppServerChildren\(reason\)/);
  assert.match(refreshBody, /reloadHiddenOfficialRuntime\(reason\)/);
  assert.match(source, /webContents\.reloadIgnoringCache\(\)/);
});
