#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// 卸载当前用户的 OpenCodex launchd 常驻服务；不会删除 .data、config.yaml 或 Codex 登录态。
const LABEL = process.env.OPENCODEX_LAUNCHD_LABEL || "dev.opencodex.gateway";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error("uninstall-macos-launchd.cjs 只能在 macOS 上运行。");
  }
  const domain = `gui/${process.getuid()}`;
  run("launchctl", ["bootout", domain, plistPath]);
  run("launchctl", ["disable", `${domain}/${LABEL}`]);
  run("launchctl", ["unload", plistPath]);
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  console.log(`[opencodex-service] 已卸载常驻服务：${LABEL}`);
}

main();
