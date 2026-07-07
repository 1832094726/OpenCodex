const fs = require("fs");
const path = require("path");
const { CODEX_HOME } = require("../core/config.cjs");

// 官方 Desktop 把 Electron UI 状态放在 CODEX_HOME 下；OpenCodex 只读取它来生成首屏快照。
const DESKTOP_GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const DESKTOP_GLOBAL_STATE_BACKUP_PATH = `${DESKTOP_GLOBAL_STATE_PATH}.bak`;
const DESKTOP_PERSISTED_ATOMS_KEY = "electron-persisted-atom-state";
const COMPOSER_PERMISSION_MODE_VISIBILITY_KEY = "composer-permission-mode-visibility";
const SELECTED_REMOTE_HOST_ID_KEY = "selected-remote-host-id";
let desktopGlobalStateCache = null;
let persistedAtomSnapshotCache = null;
const DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY = {
  "guardian-approvals": true,
  "full-access": true,
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function loadDesktopGlobalState() {
  const primarySignature = fileSignature(DESKTOP_GLOBAL_STATE_PATH);
  const backupSignature = fileSignature(DESKTOP_GLOBAL_STATE_BACKUP_PATH);
  if (
    desktopGlobalStateCache &&
    desktopGlobalStateCache.primarySignature === primarySignature &&
    desktopGlobalStateCache.backupSignature === backupSignature
  ) {
    return desktopGlobalStateCache.value;
  }
  // 官方会同时维护主文件和 .bak；主文件损坏时按官方思路读取备份，避免首屏状态直接丢失。
  const value = readJsonObject(DESKTOP_GLOBAL_STATE_PATH) || readJsonObject(DESKTOP_GLOBAL_STATE_BACKUP_PATH) || {};
  // 入口配置脚本可能被多端连续请求；文件未变化时复用解析结果，避免每次首屏都同步读整份 JSON。
  desktopGlobalStateCache = { primarySignature, backupSignature, value };
  return value;
}

function normalizePromptHistoryForRenderer(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (!isPlainObject(value)) return [];
  if (Array.isArray(value.global)) return value.global.filter((item) => typeof item === "string");
  if (Array.isArray(value["new-conversation"])) {
    return value["new-conversation"].filter((item) => typeof item === "string");
  }
  return [];
}

function normalizePersistedAtomForRenderer(key, value) {
  // 这两个兼容转换沿用旧 gateway 逻辑，保证官方 renderer 拿到的是自己期望的形态。
  if (key === "prompt-history") return normalizePromptHistoryForRenderer(value);
  if (key === COMPOSER_PERMISSION_MODE_VISIBILITY_KEY) {
    return {
      ...DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY,
      ...(isPlainObject(value) ? value : {}),
    };
  }
  return value;
}

function desktopPersistedAtoms() {
  const atoms = loadDesktopGlobalState()[DESKTOP_PERSISTED_ATOMS_KEY];
  return isPlainObject(atoms) ? atoms : {};
}

function persistedAtomSnapshotForRenderer() {
  const atoms = desktopPersistedAtoms();
  const cacheKey = desktopGlobalStateCache
    ? `${desktopGlobalStateCache.primarySignature}|${desktopGlobalStateCache.backupSignature}`
    : "";
  if (persistedAtomSnapshotCache && persistedAtomSnapshotCache.cacheKey === cacheKey && persistedAtomSnapshotCache.atoms === atoms) {
    return { ...persistedAtomSnapshotCache.snapshot };
  }
  const snapshot = Object.fromEntries(
    Object.entries(atoms).map(([key, value]) => [key, normalizePersistedAtomForRenderer(key, value)])
  );
  // 不注入 localeOverride：官方 i18n 在该 atom 存在时会跳过语言包解析，导致 locale 为中文但文案仍是英文。
  delete snapshot.localeOverride;
  // OpenCodex 采用域名隔离模型；清理官方 Desktop 里遗留的远程 host 状态，避免 Win/Mac 页面互相恢复。
  delete snapshot[SELECTED_REMOTE_HOST_ID_KEY];
  for (const key of Object.keys(snapshot)) {
    if (key.startsWith("remote-thread-summaries:")) delete snapshot[key];
  }
  // runtime config 会在多端刷新时重复生成；文件和 atoms 未变时复用清理后的快照，避免重复归一化大对象。
  persistedAtomSnapshotCache = { atoms, cacheKey, snapshot };
  return { ...snapshot };
}

module.exports = {
  DESKTOP_GLOBAL_STATE_PATH,
  DESKTOP_PERSISTED_ATOMS_KEY,
  persistedAtomSnapshotForRenderer,
};
