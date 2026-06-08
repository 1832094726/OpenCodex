const fs = require("fs");
const path = require("path");
const {
  RUNNER_LINUX_EXECUTABLE_NAME,
  RUNNER_WINDOWS_EXECUTABLE_NAME,
} = require("../shared/constants.cjs");
const {
  fileFingerprint,
  isDirectory,
  isFile,
  realpathSafe,
  readJsonIfPresent,
  writeJson,
} = require("../shared/fs-utils.cjs");
const { logLine } = require("../shared/logging.cjs");
const { writeGatewayAsar } = require("../shared/runner-asar.cjs");
const { patchWindowsRunnerAsarIntegrity } = require("./windows-integrity.cjs");

function runnerExecutableNameForPlatform() {
  if (process.platform === "win32") return RUNNER_WINDOWS_EXECUTABLE_NAME;
  if (process.platform === "linux") return RUNNER_LINUX_EXECUTABLE_NAME;
  throw new Error(`portable runner 不支持平台：${process.platform}`);
}

function shouldSkipPortableRuntimeEntry(entry, sourcePath, layout) {
  const name = entry.name.toLowerCase();
  const sourceRealPath = realpathSafe(sourcePath);
  const runtimeRootRealPath = realpathSafe(layout.runtimeRoot);
  const appRootRealPath = realpathSafe(layout.appRoot);
  const asarRealPath = realpathSafe(layout.asarPath);
  // runner 自己生成 resources/app.asar；不能把官方 app.asar 或 app.asar.unpacked 复制进 OpenCodex runtime。
  if (entry.isDirectory() && name === "resources") return true;
  if (sourceRealPath === asarRealPath || sourcePath === `${layout.asarPath}.unpacked`) return true;
  if (sourceRealPath === realpathSafe(`${layout.asarPath}.unpacked`)) return true;
  // MSIX 可能是“包根目录放 exe，app/resources 放官方 bundle”；复制运行时时要避开这个 app 子目录。
  if (entry.isDirectory() && runtimeRootRealPath !== appRootRealPath && sourceRealPath === appRootRealPath) return true;
  if (sourceRealPath === realpathSafe(layout.executablePath)) return true;
  return false;
}

function portableRuntimeFingerprint(layout) {
  const entries = [];
  try {
    for (const entry of fs.readdirSync(layout.runtimeRoot, { withFileTypes: true })) {
      const sourcePath = path.join(layout.runtimeRoot, entry.name);
      if (shouldSkipPortableRuntimeEntry(entry, sourcePath, layout)) continue;
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        stat: fileFingerprint(sourcePath),
      });
    }
  } catch {}
  return {
    platform: process.platform,
    arch: process.arch,
    source: realpathSafe(layout.runtimeRoot),
    appRoot: realpathSafe(layout.appRoot),
    executable: fileFingerprint(layout.executablePath),
    asar: fileFingerprint(layout.asarPath),
    entries,
  };
}

function samePortableRuntimeFingerprint(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function ensurePortableRuntimeCopy({ layout, runnerRootDir, runnerExecutablePath, markerPath, logger }) {
  const nextFingerprint = portableRuntimeFingerprint(layout);
  const previous = readJsonIfPresent(markerPath);
  if (
    previous &&
    samePortableRuntimeFingerprint(previous.fingerprint, nextFingerprint) &&
    isDirectory(runnerRootDir) &&
    isFile(runnerExecutablePath)
  ) {
    logLine(logger, `official Electron runtime cache hit: ${runnerRootDir}`);
    return { copied: false };
  }

  /**
   * Windows/Linux 没有 macOS bundle 的 Frameworks 分层，Electron DLL/.pak/locales 等都在可执行文件同级目录。
   * 这里复制“运行时文件”，但跳过官方 resources 目录；官方 bundle 只作为外部资源路径复用，不进入 OpenCodex dist/cache。
   */
  fs.rmSync(runnerRootDir, { recursive: true, force: true });
  fs.mkdirSync(runnerRootDir, { recursive: true });
  for (const entry of fs.readdirSync(layout.runtimeRoot, { withFileTypes: true })) {
    const sourcePath = path.join(layout.runtimeRoot, entry.name);
    if (shouldSkipPortableRuntimeEntry(entry, sourcePath, layout)) continue;
    fs.cpSync(sourcePath, path.join(runnerRootDir, entry.name), {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
  fs.copyFileSync(layout.executablePath, runnerExecutablePath);
  if (process.platform !== "win32") fs.chmodSync(runnerExecutablePath, 0o755);
  writeJson(markerPath, {
    fingerprint: nextFingerprint,
    copiedAt: new Date().toISOString(),
  });
  logLine(logger, `official Electron runtime copied: ${layout.runtimeRoot} -> ${runnerRootDir}`);
  return { copied: true };
}

async function createPortableRunner({ layout, runtimeDir, logger }) {
  const workDir = path.join(runtimeDir, "official-electron-runner");
  const runnerRootDir = path.join(workDir, `${process.platform}-${process.arch}`);
  const runnerResourcesDir = path.join(runnerRootDir, "resources");
  const runnerExecutablePath = path.join(runnerRootDir, runnerExecutableNameForPlatform());
  const markerPath = path.join(workDir, `runtime-manifest-${process.platform}-${process.arch}.json`);

  ensurePortableRuntimeCopy({ layout, runnerRootDir, runnerExecutablePath, markerPath, logger });
  // app.asar 是 OpenCodex gateway 壳，必须每次按当前代码路径重写；官方资源目录只通过 env/process.resourcesPath 指回原安装包。
  fs.rmSync(runnerResourcesDir, { recursive: true, force: true });
  fs.mkdirSync(runnerResourcesDir, { recursive: true });
  const runnerAsarPath = await writeGatewayAsar({ runnerResourcesDir, workDir });
  patchWindowsRunnerAsarIntegrity({
    runnerRootDir,
    runnerExecutablePath,
    sourceExecutablePath: layout.executablePath,
    runnerAsarPath,
    logger,
  });

  logLine(logger, `prepared official Electron runner: root=${runnerRootDir}`);
  logLine(logger, `official Electron source: app=${layout.appRoot} asar=${layout.asarPath}`);

  return {
    executablePath: runnerExecutablePath,
    runnerAppPath: runnerRootDir,
    officialAppPath: layout.appRoot,
    officialAsarPath: layout.asarPath,
  };
}

module.exports = {
  createPortableRunner,
};
