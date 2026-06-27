#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// 这个脚本把 OpenCodex gateway 注册成当前用户的 launchd 常驻服务，避免手机访问时触发冷启动。
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LABEL = process.env.OPENCODEX_LAUNCHD_LABEL || "dev.opencodex.gateway";
const PORT = process.env.PORT || process.env.OPENCODEX_PORT || "3737";
const HOST = process.env.HOST || process.env.OPENCODEX_HOST || "0.0.0.0";
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${LABEL}.plist`);
const logsDir = path.join(PROJECT_ROOT, ".data", "logs");
const stdoutPath = path.join(logsDir, "opencodex-gateway.out.log");
const stderrPath = path.join(logsDir, "opencodex-gateway.err.log");
const gatewayScript = path.join(PROJECT_ROOT, "gateway", "dev", "run-gateway.cjs");
const buildMarker = path.join(PROJECT_ROOT, "gateway", "dist", "official", "LocalCodexBundleProvider.js");

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status === 0) return result;
  if (options.allowFailure) return result;
  const stderr = result.stderr ? `\n${result.stderr.trim()}` : "";
  throw new Error(`${command} ${args.join(" ")} 执行失败，退出码 ${result.status}${stderr}`);
}

function launchctlDomain() {
  return `gui/${process.getuid()}`;
}

function launchctlPrintService() {
  return run("launchctl", ["print", `${launchctlDomain()}/${LABEL}`], { quiet: true, allowFailure: true });
}

function unloadExistingService() {
  if (launchctlPrintService().status !== 0 && !fs.existsSync(plistPath)) return;
  // macOS 新旧版本 launchctl 行为略有差异；bootout 失败时继续尝试 unload 兼容旧系统。
  run("launchctl", ["bootout", launchctlDomain(), plistPath], { allowFailure: true, quiet: true });
  run("launchctl", ["unload", plistPath], { allowFailure: true, quiet: true });
}

function plistSource() {
  const nodePath = process.execPath;
  const pathEnv = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const configPath = process.env.CODEX_WEB_CONFIG_PATH || path.join(PROJECT_ROOT, "config.yaml");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(gatewayScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(PROJECT_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CI</key>
    <string>true</string>
    <key>OPENCODEX_GATEWAY_SERVICE_MODE</key>
    <string>1</string>
    <key>HOST</key>
    <string>${xmlEscape(HOST)}</string>
    <key>PORT</key>
    <string>${xmlEscape(PORT)}</string>
    <key>CODEX_WEB_CONFIG_PATH</key>
    <string>${xmlEscape(configPath)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error("install-macos-launchd.cjs 只能在 macOS 上运行。");
  }
  if (!fs.existsSync(gatewayScript)) {
    throw new Error(`找不到 gateway 启动脚本：${gatewayScript}`);
  }
  if (!fs.existsSync(buildMarker)) {
    throw new Error("找不到 gateway 构建产物。请先运行 `pnpm run build:gateway` 再安装常驻服务。");
  }
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  unloadExistingService();
  fs.writeFileSync(plistPath, plistSource(), "utf8");
  run("launchctl", ["bootstrap", launchctlDomain(), plistPath]);
  run("launchctl", ["enable", `${launchctlDomain()}/${LABEL}`], { allowFailure: true, quiet: true });
  run("launchctl", ["kickstart", "-k", `${launchctlDomain()}/${LABEL}`]);
  console.log(`[opencodex-service] 已安装常驻服务：${LABEL}`);
  console.log(`[opencodex-service] 访问地址：http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
  console.log(`[opencodex-service] launchd 配置：${plistPath}`);
  console.log(`[opencodex-service] 日志文件：${stdoutPath} ${stderrPath}`);
}

main();
