const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { RUNNER_EXECUTABLE_NAME } = require("./shared/constants.cjs");
const {
  isFile,
  isDirectory,
  readJsonIfPresent,
  realpathSafe,
  statSummary,
  uniqueNonEmpty,
} = require("./shared/fs-utils.cjs");
const { logJsonLine } = require("./shared/logging.cjs");

function gatewayScannerModulePath() {
  return path.resolve(__dirname, "..", "dist", "official", "CodexAsarScanner.js");
}

function loadGatewayCodexAsarScanner() {
  const scannerModulePath = gatewayScannerModulePath();
  try {
    return require(scannerModulePath);
  } catch (error) {
    /**
     * 官方安装包扫描器属于 gateway 模块。runner 只依赖这一个扫描入口，
     * 避免 desktop / dev runner / 平台适配器各自维护候选路径。
     */
    const message = error instanceof Error ? error.message : String(error || "");
    throw new Error(`无法加载 gateway 官方安装包扫描器：${scannerModulePath}；请先运行 pnpm run build。${message}`);
  }
}

function cachedOfficialAsarPath(officialBundleDir) {
  const manifest = readJsonIfPresent(path.join(officialBundleDir || "", "manifest.json"));
  return manifest && typeof manifest.sourceAsarPath === "string" ? manifest.sourceAsarPath : "";
}

function scanOfficialInstallLayout({ officialBundleDir }) {
  const { CodexAsarScanner } = loadGatewayCodexAsarScanner();
  const scanner = new CodexAsarScanner({
    configuredPath: process.env.CODEX_DESKTOP_APP_PATH || "",
  });
  return scanner.find({ cachedAsarPath: cachedOfficialAsarPath(officialBundleDir) });
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readBundleExecutable(appRoot) {
  const infoPlistPath = path.join(appRoot, "Contents", "Info.plist");
  try {
    const text = fs.readFileSync(infoPlistPath, "utf8");
    const match = text.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return decodeXmlText(match[1]);
  } catch {}
  if (process.platform === "darwin" && isFile("/usr/bin/plutil")) {
    try {
      /**
       * Codex.app 的 Info.plist 可能是二进制 plist。直接读 XML 正则不一定可靠，
       * 这里用系统 plutil 兜底读取 CFBundleExecutable，避免未来官方包结构变化时误判可执行文件路径。
       */
      const output = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlistPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (output) return output;
    } catch {}
  }
  return path.basename(appRoot, ".app") || RUNNER_EXECUTABLE_NAME;
}

function macRuntimeLayoutFromAppRoot(appRoot, logger = null) {
  const resourcesDir = path.join(appRoot, "Contents", "Resources");
  const frameworksDir = path.join(appRoot, "Contents", "Frameworks");
  const asarPath = path.join(resourcesDir, "app.asar");
  const executablePath = path.join(appRoot, "Contents", "MacOS", readBundleExecutable(appRoot));
  const asar = statSummary(asarPath);
  const frameworks = statSummary(frameworksDir);
  const executable = statSummary(executablePath);
  if (!asar.isFile || !frameworks.isDirectory || !executable.isFile) {
    logJsonLine(logger, "official Electron candidate layout rejected:", {
      appRoot,
      resourcesDir,
      asarPath,
      frameworksDir,
      executablePath,
      asar,
      frameworks,
      executable,
    });
    return null;
  }
  return {
    platform: "darwin",
    appRoot,
    resourcesDir,
    frameworksDir,
    asarPath,
    executablePath,
  };
}

function resourcesDirForPortableAppRoot(appRoot) {
  if (isFile(path.join(appRoot, "resources", "app.asar"))) return path.join(appRoot, "resources");
  if (isFile(path.join(appRoot, "Resources", "app.asar"))) return path.join(appRoot, "Resources");
  if (isFile(path.join(appRoot, "app.asar"))) return appRoot;
  return path.join(appRoot, "resources");
}

function windowsElectronExecutableCandidates(appRoot) {
  return uniqueNonEmpty([
    process.env.CODEX_DESKTOP_EXECUTABLE_PATH,
    path.join(appRoot, "Codex.exe"),
    path.join(appRoot, "codex.exe"),
    path.join(appRoot, "OpenAI Codex.exe"),
    path.join(appRoot, "app", "Codex.exe"),
    path.join(appRoot, "app", "codex.exe"),
    path.join(path.dirname(appRoot), "Codex.exe"),
    path.join(path.dirname(appRoot), "codex.exe"),
  ]);
}

function linuxElectronExecutableCandidates(appRoot) {
  return uniqueNonEmpty([
    process.env.CODEX_DESKTOP_EXECUTABLE_PATH,
    path.join(appRoot, "codex"),
    path.join(appRoot, "Codex"),
    path.join(appRoot, "codex-desktop"),
    path.join(path.dirname(appRoot), "codex"),
    path.join(path.dirname(appRoot), "Codex"),
  ]);
}

function portableRuntimeLayoutFromInstallLayout(scannedLayout, logger = null) {
  const appRoot = scannedLayout.installRoot;
  const resourcesDir = scannedLayout.resourcesDir || resourcesDirForPortableAppRoot(appRoot);
  const asarPath = scannedLayout.asarPath || path.join(resourcesDir, "app.asar");
  const executableCandidates =
    process.platform === "win32" ? windowsElectronExecutableCandidates(appRoot) : linuxElectronExecutableCandidates(appRoot);
  const executablePath = executableCandidates.find(isFile) || "";
  const runtimeRoot = executablePath ? path.dirname(executablePath) : appRoot;
  const asar = statSummary(asarPath);
  const executable = statSummary(executablePath);
  const runtime = statSummary(runtimeRoot);
  if (!asar.isFile || !executable.isFile || !runtime.isDirectory) {
    logJsonLine(logger, "official Electron candidate layout rejected:", {
      platform: process.platform,
      appRoot,
      resourcesDir,
      asarPath,
      executableCandidates,
      executablePath,
      runtimeRoot,
      asar,
      executable,
      runtime,
    });
    return null;
  }
  return {
    platform: process.platform,
    appRoot,
    resourcesDir,
    asarPath,
    executablePath,
    runtimeRoot,
  };
}

function officialRuntimeLayoutFromScannedLayout(scannedLayout, logger = null) {
  if (process.platform === "darwin") return macRuntimeLayoutFromAppRoot(scannedLayout.installRoot, logger);
  if (process.platform === "win32" || process.platform === "linux") {
    return portableRuntimeLayoutFromInstallLayout(scannedLayout, logger);
  }
  return null;
}

function findOfficialRuntimeLayout({ officialBundleDir, logger }) {
  const scannedLayout = scanOfficialInstallLayout({ officialBundleDir });
  logJsonLine(logger, "official Electron install scanned:", {
    installRoot: scannedLayout.installRoot,
    resourcesDir: scannedLayout.resourcesDir,
    asarPath: scannedLayout.asarPath,
    layoutKind: scannedLayout.layoutKind,
    platformHint: scannedLayout.platformHint,
  });
  const layout = officialRuntimeLayoutFromScannedLayout(scannedLayout, logger);
  if (layout) return layout;
  throw new Error(
    `已找到 Codex 官方 app.asar，但未找到可复用的官方 Electron 运行时：${JSON.stringify({
      installRoot: scannedLayout.installRoot,
      resourcesDir: scannedLayout.resourcesDir,
      asarPath: scannedLayout.asarPath,
    })}`
  );
}

module.exports = {
  findOfficialRuntimeLayout,
};
