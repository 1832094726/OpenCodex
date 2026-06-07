const { app, BrowserWindow, Menu, clipboard, ipcMain, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { prepareOfficialElectronRuntime } = require("../gateway/runner/index.cjs");

const APP_ROOT = path.resolve(__dirname, "..");

const DEFAULT_HOST = process.env.OPENCODEX_HOST || "127.0.0.1";
const DEFAULT_PORT = normalizePort(process.env.OPENCODEX_PORT);

let mainWindow = null;
let statusTimer = null;
let isQuitting = false;

const gatewayState = {
  child: null,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT || 0,
  listenUrl: "",
  localUrl: "",
  primaryUrl: "",
  lanUrls: [],
  token: crypto.randomBytes(32).toString("hex"),
  paths: null,
  settings: null,
  status: null,
  lastError: "",
  startedAt: null,
  officialRuntime: null,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendLog(line) {
  if (!gatewayState.paths || !gatewayState.paths.logPath) return;
  try {
    fs.appendFileSync(gatewayState.paths.logPath, line);
  } catch {}
}

function runtimePaths() {
  const userDataDir = app.getPath("userData");
  const runtimeDir = path.join(userDataDir, "runtime");
  const reportsDir = path.join(runtimeDir, "reports");
  const cacheDir = path.join(runtimeDir, "cache");
  const logsDir = path.join(userDataDir, "logs");
  const officialBundleDir = path.join(cacheDir, "codex-official-bundle");

  return {
    userDataDir,
    runtimeDir,
    reportsDir,
    cacheDir,
    logsDir,
    officialBundleDir,
    configPath: path.join(runtimeDir, "config.yaml"),
    settingsPath: path.join(userDataDir, "launcher-settings.json"),
    logPath: path.join(logsDir, "gateway.log"),
    gatewayScriptPath: path.join(APP_ROOT, "gateway", "main.cjs"),
    officialElectronRunnerDir: path.join(runtimeDir, "official-electron-runner"),
  };
}

function ensureRuntimeLayout(paths) {
  ensureDir(paths.runtimeDir);
  ensureDir(paths.reportsDir);
  ensureDir(paths.cacheDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.officialBundleDir);
}

function normalizeHostMode(value) {
  return value === "lan" ? "lan" : "local";
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function defaultSettings() {
  return {
    hostMode: DEFAULT_HOST === "0.0.0.0" ? "lan" : "local",
    port: DEFAULT_PORT,
  };
}

function loadLauncherSettings(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.settingsPath, "utf8"));
    return {
      ...defaultSettings(),
      ...parsed,
      hostMode: normalizeHostMode(parsed.hostMode),
      port: normalizePort(parsed.port),
    };
  } catch {
    return defaultSettings();
  }
}

function saveLauncherSettings(paths, settings) {
  const nextSettings = {
    ...defaultSettings(),
    ...settings,
    hostMode: normalizeHostMode(settings && settings.hostMode),
    port: normalizePort(settings && settings.port),
  };
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
  return nextSettings;
}

function hostForMode(hostMode) {
  return normalizeHostMode(hostMode) === "lan" ? "0.0.0.0" : "127.0.0.1";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === "\"") {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "\"") quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseYamlStringScalar(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function readAuthEnabled(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const match = raw.match(/^\s*password\s*:\s*(.*)$/m);
    if (!match) return false;
    return !!parseYamlStringScalar(match[1]).trim();
  } catch {
    return false;
  }
}

function writeAuthConfig(paths, password) {
  const value = String(password || "").trim();
  const stored = value ? `sha256-v1:${sha256Hex(value)}` : "";
  fs.writeFileSync(paths.configPath, `auth:\n  password: ${JSON.stringify(stored)}\n`, "utf8");
}

function parseIpv4Parts(address) {
  const parts = String(address || "")
    .split(".")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function ipv4NetworkScore(address) {
  const parts = parseIpv4Parts(address);
  if (!parts) return -1000;

  const [first, second] = parts;
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
    return 500;
  }
  if (first === 100 && second >= 64 && second <= 127) return 350;
  if (first === 169 && second === 254) return 100;
  return 200;
}

function interfaceNameScore(name) {
  const normalizedName = String(name || "").toLowerCase();
  let score = 0;

  // 局域网访问地址优先选择真实 Wi-Fi / 以太网，避免虚拟网卡抢占展示的主地址。
  if (/wi-?fi|wlan|ethernet|以太网|无线|本地连接|^en\d|^eth\d/.test(normalizedName)) score += 120;
  if (/virtual|vmware|vbox|virtualbox|hyper-v|vethernet|wsl|docker|container/.test(normalizedName)) score -= 160;
  if (/loopback|npcap|tailscale|zerotier|hamachi|wireguard|wintun|vpn|openvpn|utun|tap|tun|ppp/.test(normalizedName)) {
    score -= 120;
  }
  if (/bluetooth|蓝牙/.test(normalizedName)) score -= 80;

  return score;
}

function lanCandidateScore(candidate) {
  return ipv4NetworkScore(candidate.address) + interfaceNameScore(candidate.name);
}

function lanUrlsForPort(port) {
  const candidates = [];
  const interfaces = os.networkInterfaces();
  let order = 0;
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || (entry.family !== "IPv4" && entry.family !== 4) || !entry.address) continue;
      const parts = parseIpv4Parts(entry.address);
      if (!parts) continue;
      const [first] = parts;
      if (first === 0 || first === 127 || first >= 224) continue;
      candidates.push({
        address: entry.address,
        name,
        order: order++,
        url: `http://${entry.address}:${port}`,
      });
    }
  }
  const seen = new Set();
  return candidates
    .sort((left, right) => lanCandidateScore(right) - lanCandidateScore(left) || left.order - right.order)
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    })
    .map((candidate) => candidate.url);
}

function updateGatewayUrls() {
  gatewayState.listenUrl = gatewayState.host ? `http://${gatewayState.host}:${gatewayState.port}` : "";
  gatewayState.localUrl = gatewayState.port ? `http://127.0.0.1:${gatewayState.port}` : "";
  gatewayState.lanUrls = gatewayState.host === "0.0.0.0" ? lanUrlsForPort(gatewayState.port) : [];
  gatewayState.primaryUrl =
    gatewayState.host === "0.0.0.0" && gatewayState.lanUrls.length > 0
      ? gatewayState.lanUrls[0]
      : gatewayState.localUrl || gatewayState.listenUrl;
}

function findFreePort(startPort, host) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error && error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, host);
    };
    tryPort(startPort);
  });
}

async function findRandomFreePort(host) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = 20000 + Math.floor(Math.random() * 30000);
    try {
      return await findFreePort(candidate, host);
    } catch {}
  }
  return findFreePort(3737, host);
}

async function ensurePortSetting(paths, settings) {
  const port = normalizePort(settings && settings.port);
  if (port) return settings;
  const host = hostForMode(settings && settings.hostMode);
  return saveLauncherSettings(paths, {
    ...settings,
    port: await findRandomFreePort(host),
  });
}

function buildState() {
  return {
    running: !!gatewayState.child && !gatewayState.child.killed,
    pid: gatewayState.child ? gatewayState.child.pid : null,
    host: gatewayState.host,
    port: gatewayState.port,
    url: gatewayState.primaryUrl,
    urls: {
      primary: gatewayState.primaryUrl,
      local: gatewayState.localUrl,
      listen: gatewayState.listenUrl,
      lan: gatewayState.lanUrls,
    },
    paths: gatewayState.paths,
    settings: gatewayState.settings || defaultSettings(),
    auth: {
      enabled: gatewayState.paths ? readAuthEnabled(gatewayState.paths.configPath) : false,
    },
    status: gatewayState.status,
    lastError: gatewayState.lastError,
    startedAt: gatewayState.startedAt,
    officialRuntime: gatewayState.officialRuntime,
  };
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("launcher:state", buildState());
}

async function fetchGatewayStatus() {
  if (!gatewayState.localUrl) return null;
  const response = await fetch(`${gatewayState.localUrl}/api/launcher/status`, {
    headers: {
      "x-opencodex-launcher-token": gatewayState.token,
    },
  });
  if (!response.ok) {
    throw new Error(`gateway status failed: HTTP ${response.status}`);
  }
  return response.json();
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    try {
      gatewayState.status = await fetchGatewayStatus();
      gatewayState.lastError = "";
    } catch (error) {
      gatewayState.lastError = error instanceof Error ? error.message : String(error);
    }
    broadcastState();
  }, 1500);
  if (statusTimer.unref) statusTimer.unref();
}

async function startGateway() {
  if (gatewayState.child) return buildState();

  const paths = runtimePaths();
  gatewayState.paths = paths;
  ensureRuntimeLayout(paths);
  gatewayState.settings = await ensurePortSetting(paths, loadLauncherSettings(paths));
  gatewayState.host = hostForMode(gatewayState.settings.hostMode);

  if (!fs.existsSync(paths.gatewayScriptPath)) {
    gatewayState.lastError = `Missing gateway entry: ${paths.gatewayScriptPath}`;
    broadcastState();
    return buildState();
  }

  gatewayState.port = await findFreePort(gatewayState.settings.port, gatewayState.host);
  updateGatewayUrls();
  gatewayState.status = null;
  gatewayState.lastError = "";
  gatewayState.startedAt = new Date().toISOString();
  gatewayState.officialRuntime = null;

  appendLog(`\n[launcher] starting gateway ${gatewayState.listenUrl} at ${gatewayState.startedAt}\n`);

  let officialRuntime;
  try {
    // gateway 必须运行在官方 Electron ABI 下，否则官方 native addon（例如 better-sqlite3）会随 Codex 升级失配。
    officialRuntime = await prepareOfficialElectronRuntime({
      runtimeDir: paths.runtimeDir,
      officialBundleDir: paths.officialBundleDir,
      logger: appendLog,
    });
    gatewayState.officialRuntime = officialRuntime;
  } catch (error) {
    gatewayState.lastError = error instanceof Error ? error.message : String(error);
    appendLog(`[launcher] official Electron runtime prepare failed: ${gatewayState.lastError}\n`);
    broadcastState();
    return buildState();
  }

  const officialUserDataDir = path.join(paths.runtimeDir, "official-user-data");
  const officialRuntimeArgs = [`--user-data-dir=${officialUserDataDir}`];
  const child = spawn(officialRuntime.executablePath, officialRuntimeArgs, {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      OPENCODEX_GATEWAY_ENTRY: paths.gatewayScriptPath,
      // runner 的 Info.plist 已经用 LSBackgroundOnly 隐藏；该标记让业务入口不要再调用 Dock API。
      OPENCODEX_GATEWAY_AGENT_MODE: "1",
      // 第 4 个 stdio fd 是生命周期 pipe；gateway 会监听它判断 launcher 是否已退出。
      OPENCODEX_GATEWAY_LIFECYCLE_FD: "3",
      // Chromium profile 必须和官方 Desktop 隔离；核心数据继续通过 CODEX_HOME 共享。
      CODEX_WEB_OFFICIAL_USER_DATA_DIR: officialUserDataDir,
      CODEX_ELECTRON_USER_DATA_PATH: officialUserDataDir,
      HOST: gatewayState.host,
      PORT: String(gatewayState.port),
      CODEX_WEB_RUNTIME_DIR: paths.runtimeDir,
      CODEX_WEB_CONFIG_PATH: paths.configPath,
      CODEX_WEB_REPORTS_DIR: paths.reportsDir,
      CODEX_WEB_OFFICIAL_BUNDLE_DIR: paths.officialBundleDir,
      CODEX_WEB_GATEWAY_BASE_URL: gatewayState.primaryUrl,
      CODEX_WEB_LAUNCHER_TOKEN: gatewayState.token,
    },
    // 第 4 个 fd 是生命周期 pipe：launcher 退出时 OS 会关闭写端，gateway watchdog 会自杀。
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });

  gatewayState.child = child;

  child.stdout.on("data", (chunk) => appendLog(`[gateway] ${chunk.toString()}`));
  child.stderr.on("data", (chunk) => appendLog(`[gateway:err] ${chunk.toString()}`));
  child.on("error", (error) => {
    gatewayState.lastError = error instanceof Error ? error.message : String(error);
    appendLog(`[launcher] gateway spawn error: ${gatewayState.lastError}\n`);
    broadcastState();
  });
  child.on("exit", (code, signal) => {
    appendLog(`[launcher] gateway exited: code=${code} signal=${signal}\n`);
    gatewayState.child = null;
    gatewayState.status = null;
    if (!isQuitting) {
      gatewayState.lastError = `gateway exited: code=${code} signal=${signal}`;
    }
    broadcastState();
  });

  startStatusPolling();
  broadcastState();
  return buildState();
}

function stopGateway() {
  return new Promise((resolve) => {
    const child = gatewayState.child;
    if (!child) {
      resolve(buildState());
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(buildState());
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(buildState());
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolve(buildState());
    }
  });
}

async function restartGateway() {
  await stopGateway();
  gatewayState.child = null;
  return startGateway();
}

function createWindow() {
  // Windows/Linux 默认会显示 Electron 应用菜单；启动器不需要菜单栏，创建窗口前统一关闭。
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: "OpenCodex",
    backgroundColor: "#f7f6f2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function revealPath(targetPath) {
  if (!targetPath) return false;
  if (!fs.existsSync(targetPath)) return false;
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    shell.openPath(targetPath);
  } else {
    shell.showItemInFolder(targetPath);
  }
  return true;
}

ipcMain.handle("launcher:get-state", () => buildState());
ipcMain.handle("launcher:start", () => startGateway());
ipcMain.handle("launcher:restart", () => restartGateway());
ipcMain.handle("launcher:open-url", () => {
  if (gatewayState.primaryUrl) shell.openExternal(gatewayState.primaryUrl);
  return buildState();
});
ipcMain.handle("launcher:open-logs", () => {
  if (gatewayState.paths) revealPath(gatewayState.paths.logPath);
  return buildState();
});
ipcMain.handle("launcher:reveal-path", (_event, targetPath) => revealPath(targetPath));
ipcMain.handle("launcher:copy", (_event, value) => {
  clipboard.writeText(String(value || ""));
  return true;
});
ipcMain.handle("launcher:update-host-mode", async (_event, hostMode) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    hostMode: normalizeHostMode(hostMode),
  });
  return restartGateway();
});
ipcMain.handle("launcher:update-port", async (_event, port) => {
  const nextPort = normalizePort(port);
  if (!nextPort) {
    gatewayState.lastError = "端口必须是 1 到 65535 之间的整数";
    broadcastState();
    return buildState();
  }
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    port: nextPort,
  });
  return restartGateway();
});
ipcMain.handle("launcher:update-password", async (_event, password) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  writeAuthConfig(paths, password);
  return restartGateway();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    createWindow();
    await startGateway();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (statusTimer) clearInterval(statusTimer);
    if (gatewayState.child) {
      try {
        gatewayState.child.kill("SIGTERM");
      } catch {}
    }
  });
}
