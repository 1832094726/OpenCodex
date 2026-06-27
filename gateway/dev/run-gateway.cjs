#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { prepareOfficialElectronRuntime } = require("../runner/index.cjs");

// dev runner 位于 gateway/dev 下，项目根目录需要回退两级。
const APP_ROOT = path.resolve(__dirname, "..", "..");
// 开发态所有运行时数据统一放到 .data 下，避免项目根目录散落 cache / official-user-data。
const DATA_DIR = path.join(APP_ROOT, ".data");
const runtimeDir = path.resolve(process.env.CODEX_WEB_RUNTIME_DIR || path.join(DATA_DIR, "runtime"));
const configPath = path.resolve(process.env.CODEX_WEB_CONFIG_PATH || path.join(APP_ROOT, "config.yaml"));
const reportsDir = path.resolve(process.env.CODEX_WEB_REPORTS_DIR || path.join(DATA_DIR, "reports"));
const officialBundleDir = path.resolve(
  process.env.CODEX_WEB_OFFICIAL_BUNDLE_DIR || path.join(DATA_DIR, "cache", "codex-official-bundle")
);
const officialUserDataDir = path.resolve(
  process.env.CODEX_WEB_OFFICIAL_USER_DATA_DIR || path.join(DATA_DIR, "official-user-data")
);
const gatewayEntry = path.join(APP_ROOT, "gateway", "main.cjs");
const serviceMode = process.env.OPENCODEX_GATEWAY_SERVICE_MODE === "1";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function logLauncher(line) {
  process.stdout.write(line);
}

async function main() {
  ensureDir(runtimeDir);
  ensureDir(reportsDir);
  ensureDir(officialBundleDir);
  ensureDir(officialUserDataDir);

  // 命令行开发入口也必须走官方 Electron runner，避免和 launcher 路径出现两套 ABI 行为。
  const officialRuntime = await prepareOfficialElectronRuntime({
    runtimeDir,
    officialBundleDir,
    logger: logLauncher,
  });

  const officialRuntimeArgs = [`--user-data-dir=${officialUserDataDir}`];
  const childEnv = {
    ...process.env,
    OPENCODEX_GATEWAY_ENTRY: gatewayEntry,
    // 命令行调试也保持和 launcher 一致：系统级隐藏 runner，不再触碰 Electron Dock API。
    OPENCODEX_GATEWAY_AGENT_MODE: "1",
    CODEX_WEB_RUNTIME_DIR: runtimeDir,
    // dev 入口固定使用 package.json 同级的 config.yaml；只有显式 CODEX_WEB_CONFIG_PATH 才允许覆盖。
    CODEX_WEB_CONFIG_PATH: configPath,
    CODEX_WEB_REPORTS_DIR: reportsDir,
    CODEX_WEB_OFFICIAL_BUNDLE_DIR: officialBundleDir,
    CODEX_WEB_OFFICIAL_USER_DATA_DIR: officialUserDataDir,
    CODEX_ELECTRON_USER_DATA_PATH: officialUserDataDir,
  };
  if (!serviceMode) {
    // 交互式开发入口保留生命周期 pipe；服务模式不能依赖父进程存活，
    // 否则 Windows 计划任务或 SSH 启动器退出时会把网关一起带走。
    childEnv.OPENCODEX_GATEWAY_LIFECYCLE_FD = "3";
  }

  const child = spawn(officialRuntime.executablePath, officialRuntimeArgs, {
    cwd: APP_ROOT,
    env: childEnv,
    // 交互式模式继承终端输出并保留生命周期 pipe；服务模式只继承日志输出。
    stdio: serviceMode ? ["ignore", "inherit", "inherit"] : ["inherit", "inherit", "inherit", "pipe"],
  });

  const stopChild = (signal) => {
    // Ctrl-C 时把信号转给后台 Electron runner，避免遗留占用端口的 gateway 进程。
    try {
      child.kill(signal);
    } catch {}
  };

  process.on("SIGINT", () => stopChild("SIGINT"));
  process.on("SIGTERM", () => stopChild("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) {
      // 子进程异常信号只作为失败结果上报；不要再发给当前 Node 进程，否则会生成误导性的二次崩溃报告。
      console.error(`[launcher] gateway exited by signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code == null ? 1 : code;
  });
  child.on("error", (error) => {
    console.error("[launcher] gateway spawn failed", error);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error("[launcher] gateway failed", error);
  process.exitCode = 1;
});
