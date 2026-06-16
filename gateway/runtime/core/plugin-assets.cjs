const fs = require("fs");
const path = require("path");
const { WEB_SHELL_DIR, exists, isWithinRoot, readText } = require("./config.cjs");
const { DEFAULT_LOCALE, EN_US, ZH_CN, normalizeLocale } = require("../../../shared/i18n/index.cjs");

const OPENCODEX_PLUGIN_URL_PREFIX = "/opencodex-plugins/";
const WEB_SHELL_PLUGINS_DIR = path.join(WEB_SHELL_DIR, "plugins");
const PLUGIN_ENTRY_FILE = "index.js";
const PLUGIN_I18N_FILES = {
  [ZH_CN]: "i18.zh.json",
  [EN_US]: "i18.en.json",
};
const SAFE_PLUGIN_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafePluginDirName(name) {
  return SAFE_PLUGIN_DIR_NAME.test(String(name || ""));
}

function pluginEntryFile(dirName) {
  return path.join(WEB_SHELL_PLUGINS_DIR, dirName, PLUGIN_ENTRY_FILE);
}

function pluginI18nFile(dirName, locale) {
  const fileName = PLUGIN_I18N_FILES[normalizeLocale(locale, DEFAULT_LOCALE)] || PLUGIN_I18N_FILES[DEFAULT_LOCALE];
  return path.join(WEB_SHELL_PLUGINS_DIR, dirName, fileName);
}

function pluginI18nFiles(dirName) {
  return Object.values(PLUGIN_I18N_FILES).map((fileName) => path.join(WEB_SHELL_PLUGINS_DIR, dirName, fileName));
}

function pluginVersionForFiles(files) {
  let latestMtime = 0;
  let totalSize = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      latestMtime = Math.max(latestMtime, Math.round(stat.mtimeMs));
      totalSize += stat.size;
    } catch {}
  }
  return `${latestMtime}-${totalSize}`;
}

function listPluginEntries() {
  if (!exists(WEB_SHELL_PLUGINS_DIR)) return [];
  return fs
    .readdirSync(WEB_SHELL_PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSafePluginDirName(entry.name))
    .map((entry) => {
      const entryFile = pluginEntryFile(entry.name);
      const i18nFiles = pluginI18nFiles(entry.name).filter(exists);
      if (!exists(entryFile)) return null;
      const versionFiles = [entryFile, ...i18nFiles];
      return {
        name: entry.name,
        entryFile,
        i18nFiles,
        version: pluginVersionForFiles(versionFiles),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function pluginEntryFileFromRequestPath(reqPath) {
  if (!String(reqPath || "").startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) return null;
  const rel = String(reqPath).slice(OPENCODEX_PLUGIN_URL_PREFIX.length);
  const parts = rel.split("/");
  // 插件公开资源目前只暴露目录入口 index.js，避免 URL 拼接读到任意插件内文件。
  if (parts.length !== 2 || parts[1] !== PLUGIN_ENTRY_FILE || !isSafePluginDirName(parts[0])) return null;
  const file = pluginEntryFile(parts[0]);
  if (!exists(file)) return null;
  return isWithinRoot(file, WEB_SHELL_PLUGINS_DIR) ? file : null;
}

function readPluginI18nFile(entry, file) {
  if (!entry || !file || !exists(file)) return {};
  try {
    return normalizeMessageMap(JSON.parse(readText(file)));
  } catch (error) {
    console.warn(
      "[gateway] plugin i18n skipped:",
      entry.name,
      path.basename(file),
      error instanceof Error ? error.message : String(error)
    );
    return {};
  }
}

function normalizeMessageMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, message] of Object.entries(value)) {
    if (typeof message === "string") result[key] = message;
  }
  return result;
}

function messagesForPluginLocale(entry, locale) {
  const normalizedLocale = normalizeLocale(locale, DEFAULT_LOCALE);
  const fallbackFile = pluginI18nFile(entry.name, DEFAULT_LOCALE);
  const localeFile = pluginI18nFile(entry.name, normalizedLocale);
  // 插件语言缺项时先回退到中文默认文件，再叠加当前语言文件，和宿主 i18n 的兜底策略保持一致。
  return {
    ...readPluginI18nFile(entry, fallbackFile),
    ...(localeFile === fallbackFile ? {} : readPluginI18nFile(entry, localeFile)),
  };
}

function pluginMessagesForLocale(locale) {
  const messages = {};
  for (const entry of listPluginEntries()) {
    Object.assign(messages, messagesForPluginLocale(entry, locale));
  }
  return messages;
}

function withPluginI18nMessages(i18n) {
  const snapshot = i18n && typeof i18n === "object" ? i18n : { locale: DEFAULT_LOCALE, messages: {} };
  const pluginMessages = pluginMessagesForLocale(snapshot.locale);
  return {
    ...snapshot,
    // 插件 i18n 只补充插件自己的 key；宿主已有 key 优先，避免插件覆盖宿主文案。
    messages: {
      ...pluginMessages,
      ...(snapshot.messages && typeof snapshot.messages === "object" ? snapshot.messages : {}),
    },
  };
}

module.exports = {
  OPENCODEX_PLUGIN_URL_PREFIX,
  listPluginEntries,
  pluginEntryFileFromRequestPath,
  pluginMessagesForLocale,
  withPluginI18nMessages,
};
