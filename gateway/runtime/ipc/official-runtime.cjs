const childProcess = require("child_process");
const crypto = require("crypto");
const electron = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { AsyncLocalStorage } = require("async_hooks");
const {
  AUTH_CONFIG_PATH,
  CODEX_HOME,
  DEBUG_LOGS,
  HOST,
  MESSAGE_FOR_VIEW_CHANNEL,
  MESSAGE_FROM_VIEW_CHANNEL,
  PORT,
  PROJECT_ROOT,
  REPORTS_DIR,
  RUNTIME_DIR,
  TARGETED_MESSAGE_TYPES,
  UNKNOWN_IPC_PATH,
  WEB_SHELL_DIR,
  ensureDir,
  exists,
  officialDataDir,
  officialRuntimeUserDataDir,
  officialRuntimeTempDir,
  workspaceRootsFromEnv,
} = require("../core/config.cjs");
const { persistedAtomSnapshotForRenderer } = require("../state/desktop-state.cjs");
const { diagnosticLog, diagnosticWarn, shortId } = require("../core/diagnostics.cjs");
const { recordFlowEvent } = require("../core/flow-monitor.cjs");
const {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
  valueFromFastSyncFetchResponsePayload,
} = require("../core/fast-sync-cache.cjs");
const { resolveOpenCodexI18n } = require("../../../shared/i18n/index.cjs");
const { withPluginI18nMessages } = require("../core/plugin-assets.cjs");
const {
  handleOfficialNotificationEvent,
  installOfficialNotificationHook,
  officialNotificationHookStatus,
} = require("../electron/official-notification-hook.cjs");
const { hiddenTrayHookStatus, installOfficialTrayHook } = require("../electron/official-tray-hook.cjs");

const { app, ipcMain } = electron;

// 这个模块把官方 Electron main 当作“隐藏后台 runtime”加载，并拦截它注册的 IPC 能力。
// AsyncLocalStorage 用来把 HTTP 请求的 clientId 传给异步 IPC 回包路由。
const requestContext = new AsyncLocalStorage();
// requestRoutes 保存 requestId -> clientId，解决流式响应跨异步回调后仍要回到同一个浏览器连接的问题。
const requestRoutes = new Map();
// requestRouteSummaries 保存 requestId 对应的入站摘要，让出站 fetch-response 日志也能带上原始 URL。
const requestRouteSummaries = new Map();
const APP_SERVER_READ_ONLY_CACHE_TTL_MS = Number(process.env.OPENCODEX_APP_SERVER_READ_ONLY_CACHE_TTL_MS || 5 * 60 * 1000);
// plugin/list 会直接影响插件管理页和 agent 可见能力，安装/启用后必须实时读取，不能走只读缓存。
const APP_SERVER_READ_ONLY_METHODS = new Set(["app/list", "mcpServerStatus/list", "thread/list"]);
const APP_SERVER_STALE_READ_ONLY_METHODS = new Set(["app/list", "mcpServerStatus/list"]);
const APP_SERVER_STALE_READ_ONLY_CACHE_MAX_AGE_MS = Number(
  process.env.OPENCODEX_APP_SERVER_STALE_READ_ONLY_CACHE_MAX_AGE_MS || 24 * 60 * 60 * 1000
);
const APP_SERVER_READ_ONLY_CACHE_FILE = path.join(RUNTIME_DIR, "cache", "app-server-read-only-cache.json");
const DEFAULT_BROWSER_USE_AVAILABLE_BACKENDS = "chrome";
const appServerReadOnlyCache = new Map();
const fastSyncCache = createFastSyncCache({
  dir: path.join(RUNTIME_DIR, "cache", "fast-sync"),
});
let appServerReadOnlyCacheLoaded = false;
let appServerReadOnlyCacheSaveTimer = null;
let officialBundle = null;
let wsHub = null;

const officialIpc = {
  // 官方 main 调 ipcMain.handle/on 注册的 handler 会被这里记录，再由 HTTP IPC invoke 复用。
  handlers: new Map(),
  listeners: new Map(),
  hiddenWindow: null,
  hiddenWebContents: null,
};
let browserUseWindowCreationDepth = 0;

const appServerSpawnHook = {
  installed: false,
  patchedModules: 0,
  interceptCount: 0,
  lastInterceptAt: null,
  lastLauncher: null,
  lastCommand: null,
  lastArgs: null,
  replacementBinaryPath: null,
  lastError: null,
};
const COMPUTER_USE_AUTH_URLS = new Set([
  "computer-use-background-auth-read",
  "computer-use-background-auth-write",
]);
const COMPUTER_USE_INSTALLER_RELATIVE_PATH = [
  "computer-use",
  "Codex Computer Use.app",
  "Contents",
  "SharedSupport",
  "Codex Computer Use Installer.app",
  "Contents",
  "MacOS",
  "Codex Computer Use Installer",
];

function realpathSafeLocal(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function sameRealpath(left, right) {
  const leftReal = realpathSafeLocal(left);
  const rightReal = realpathSafeLocal(right);
  return !!leftReal && !!rightReal && leftReal === rightReal;
}

function computerUseAuthActionFromUrl(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    const parsed = new URL(url, "http://opencodex.local");
    const action = parsed.pathname.replace(/^\/+/, "");
    return COMPUTER_USE_AUTH_URLS.has(action) ? action : "";
  } catch {
    const match = String(url).match(/computer-use-background-auth-(?:read|write)(?:[/?#]|$)/);
    return match ? match[0].replace(/[/?#]$/g, "") : "";
  }
}

function computerUseInstallerPath() {
  // 官方 read/write handler 也是从 CODEX_HOME/computer-use 下找 Installer；诊断必须走同一条路径。
  return path.join(process.env.CODEX_HOME || CODEX_HOME, ...COMPUTER_USE_INSTALLER_RELATIVE_PATH);
}

function readComputerUseInstallerStatusForDiagnostics() {
  if (process.platform !== "darwin") {
    return { installerStatusSupported: false, installerStatusReason: "unsupported_platform" };
  }
  const installerPath = computerUseInstallerPath();
  if (!exists(installerPath)) {
    return {
      installerStatusSupported: true,
      installerPath,
      installerStatusReason: "missing_installer",
      installerInstalled: false,
    };
  }
  const startedAt = Date.now();
  try {
    const result = childProcess.spawnSync(installerPath, ["status"], {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    return {
      installerStatusSupported: true,
      installerPath,
      installerExitCode: result.status,
      installerSignal: result.signal || "",
      installerStdout: stdout,
      installerStderr: stderr,
      installerError: result.error ? result.error.message : "",
      installerInstalled: stdout === "OK: installed",
      installerElapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      installerStatusSupported: true,
      installerPath,
      installerStatusReason: "status_failed",
      installerError: error instanceof Error ? error.message : String(error),
      installerInstalled: false,
      installerElapsedMs: Date.now() - startedAt,
    };
  }
}

function spawnOptionsFromArgs(args, options) {
  return Array.isArray(args) ? options : args;
}

function spawnArgList(args) {
  return Array.isArray(args) ? args.map((item) => String(item)) : [];
}

function execFileOptionsFromArgs(args, options) {
  if (Array.isArray(args)) return typeof options === "function" ? undefined : options;
  return typeof args === "function" ? undefined : args;
}

function execFileCallbackFromArgs(args, options, callback) {
  if (Array.isArray(args)) return typeof options === "function" ? options : callback;
  if (typeof args === "function") return args;
  if (typeof options === "function") return options;
  return callback;
}

function appServerSpawnOptions(spawnOptions) {
  /**
   * hidden Electron runtime 需要隔离 TMPDIR 来避免抢官方 Desktop 的 live IPC owner；
   * app-server 也必须留在同一个隔离 TMPDIR，Browser 技能才会连接 OpenCodex 自己的 Browser backend，
   * 避免误控正在承载 OpenCodex 网页的官方 Codex 应用内浏览器标签页。
   */
  const env = { ...((spawnOptions && spawnOptions.env) || process.env) };
  // Browser native pipe 会校验调用方 build flavor；官方传入精简 env 时需要补回这组生产环境标识。
  env.BUILD_FLAVOR = env.BUILD_FLAVOR || process.env.BUILD_FLAVOR || "prod";
  env.npm_package_codexBuildFlavor =
    env.npm_package_codexBuildFlavor || process.env.npm_package_codexBuildFlavor || env.BUILD_FLAVOR;
  env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR = env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR || env.npm_package_codexBuildFlavor;
  // Web 入口不能把宿主 OpenCodex 页面暴露成 IAB 控制目标；默认仅开放 Chrome，仍允许环境变量显式启用 iab 调试。
  env.BROWSER_USE_AVAILABLE_BACKENDS =
    env.BROWSER_USE_AVAILABLE_BACKENDS ||
    process.env.OPENCODEX_BROWSER_USE_AVAILABLE_BACKENDS ||
    DEFAULT_BROWSER_USE_AVAILABLE_BACKENDS;
  if (officialBundle && officialBundle.version && officialBundle.version !== "unknown") {
    env.BROWSER_USE_CODEX_APP_VERSION = env.BROWSER_USE_CODEX_APP_VERSION || String(officialBundle.version);
  }
  if (process.env.npm_package_codexBuildNumber && !env.npm_package_codexBuildNumber) {
    env.npm_package_codexBuildNumber = process.env.npm_package_codexBuildNumber;
  }
  return { ...(spawnOptions || {}), env };
}

function looksLikeOfficialCodexBinary(command, bundle, spawnOptions) {
  if (!bundle || typeof command !== "string" || !bundle.codexBinaryPath) return false;
  if (sameRealpath(command, bundle.codexBinaryPath)) return true;

  const cwd = spawnOptions && typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : process.cwd();
  // 官方实现可能传绝对路径、相对路径或裸命令；只在 app-server 参数命中时才替换，避免误伤其他子进程。
  if (sameRealpath(path.resolve(cwd, command), bundle.codexBinaryPath)) return true;
  return path.basename(command) === path.basename(bundle.codexBinaryPath);
}

function isHiddenOfficialAppServerArgs(args) {
  /**
   * 只识别官方 codex app-server 入口，不理解后续子命令或业务参数。
   * 参数保持原样透传给官方 Desktop 的 codex 二进制，保证官方新增/修改 app-server 参数时自动兼容。
   */
  if (!Array.isArray(args) || args[0] !== "app-server") return false;
  return true;
}

function looksLikeComputerUseInstaller(command) {
  if (typeof command !== "string" || !command) return false;
  const normalized = command.replace(/\\/g, "/");
  return normalized.includes("/computer-use/") && path.basename(command) === "Codex Computer Use Installer";
}

function summarizeInstallerOutput(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return String(value || "").trim();
}

function wrapComputerUseInstallerExecCallback(command, normalizedArgs, callback) {
  if (typeof callback !== "function") return callback;
  const startedAt = Date.now();
  // 官方 read/write 会吞掉部分异常；这里把真实 Installer 子进程结果单独打出来，便于定位授权状态误判。
  diagnosticLog("computer-use-auth", "installer_execfile_start", {
    command,
    args: normalizedArgs,
  });
  return (error, stdout, stderr) => {
    diagnosticLog("computer-use-auth", "installer_execfile_end", {
      command,
      args: normalizedArgs,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : error ? String(error) : "",
      stdout: summarizeInstallerOutput(stdout),
      stderr: summarizeInstallerOutput(stderr),
    });
    return callback(error, stdout, stderr);
  };
}

function recordHiddenAppServerRedirect(launcher, command, normalizedArgs, replacementBinaryPath) {
  appServerSpawnHook.interceptCount += 1;
  appServerSpawnHook.lastInterceptAt = new Date().toISOString();
  appServerSpawnHook.lastLauncher = launcher;
  appServerSpawnHook.lastCommand = command;
  appServerSpawnHook.lastArgs = normalizedArgs;
  appServerSpawnHook.replacementBinaryPath = replacementBinaryPath;
  appServerSpawnHook.lastError = null;
  diagnosticLog("official-runtime", "app_server_spawn_hook_redirected", {
    launcher,
    command,
    args: normalizedArgs,
    replacementBinaryPath,
  });
}

function redirectHiddenAppServerSpawn(originalSpawn, bundle, self, command, args, options, rawArguments) {
  const spawnOptions = spawnOptionsFromArgs(args, options);
  const normalizedArgs = spawnArgList(args);
  if (looksLikeOfficialCodexBinary(command, bundle, spawnOptions) && isHiddenOfficialAppServerArgs(normalizedArgs)) {
    recordHiddenAppServerRedirect("spawn", command, normalizedArgs, bundle.codexBinaryPath);
    return originalSpawn.call(self, bundle.codexBinaryPath, normalizedArgs, appServerSpawnOptions(spawnOptions));
  }
  return originalSpawn.apply(self, rawArguments);
}

function redirectHiddenAppServerExecFile(originalExecFile, bundle, self, command, args, options, callback, rawArguments) {
  const execOptions = execFileOptionsFromArgs(args, options);
  const normalizedArgs = spawnArgList(args);
  if (looksLikeOfficialCodexBinary(command, bundle, execOptions) && isHiddenOfficialAppServerArgs(normalizedArgs)) {
    const execCallback = execFileCallbackFromArgs(args, options, callback);
    recordHiddenAppServerRedirect("execFile", command, normalizedArgs, bundle.codexBinaryPath);
    return originalExecFile.call(self, bundle.codexBinaryPath, normalizedArgs, appServerSpawnOptions(execOptions), execCallback);
  }
  if (looksLikeComputerUseInstaller(command)) {
    const execCallback = execFileCallbackFromArgs(args, options, callback);
    const wrappedCallback = wrapComputerUseInstallerExecCallback(command, normalizedArgs, execCallback);
    if (wrappedCallback) {
      return originalExecFile.call(self, command, normalizedArgs, execOptions, wrappedCallback);
    }
  }
  return originalExecFile.apply(self, rawArguments);
}

function patchChildProcessModule(moduleRef, bundle) {
  if (!moduleRef || typeof moduleRef.spawn !== "function") return false;
  if (moduleRef.__opencodexAppServerSpawnHookPatched) return false;

  const originalSpawn = moduleRef.spawn;
  moduleRef.spawn = function opencodexAppServerSpawnHook(command, args, options) {
    return redirectHiddenAppServerSpawn(originalSpawn, bundle, this, command, args, options, arguments);
  };
  if (typeof moduleRef.execFile === "function") {
    const originalExecFile = moduleRef.execFile;
    const wrappedExecFile = function opencodexAppServerExecFileHook(command, args, options, callback) {
      return redirectHiddenAppServerExecFile(originalExecFile, bundle, this, command, args, options, callback, arguments);
    };
    wrappedExecFile[util.promisify.custom] = function opencodexPromisifiedExecFile(command, args, options) {
      /**
       * 官方 main 大量使用 promisify(child_process.execFile)，并依赖返回值是 { stdout, stderr }。
       * 如果只替换 execFile 而不补回 custom promisify，Node 会退化成“只返回第一个成功参数”，
       * 进而让官方 Computer Use 的 status 结果从 OK 误判成 false。
       */
      let child = null;
      const promise = new Promise((resolve, reject) => {
        child = wrappedExecFile.call(this, command, args, options, (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      });
      promise.child = child;
      return promise;
    };
    moduleRef.execFile = wrappedExecFile;
  }
  moduleRef.__opencodexAppServerSpawnHookPatched = true;
  return true;
}

function installAppServerSpawnHook(bundle) {
  try {
    const modules = new Set([childProcess]);
    try {
      modules.add(require("node:child_process"));
    } catch {}
    let patched = 0;
    for (const moduleRef of modules) {
      if (patchChildProcessModule(moduleRef, bundle)) patched += 1;
    }
    appServerSpawnHook.installed = true;
    appServerSpawnHook.patchedModules += patched;
    appServerSpawnHook.replacementBinaryPath = bundle.codexBinaryPath;
    appServerSpawnHook.lastError = null;
    diagnosticLog("official-runtime", "app_server_spawn_hook_ready", {
      codexBinaryPath: bundle.codexBinaryPath,
      patchedModules: appServerSpawnHook.patchedModules,
    });
  } catch (error) {
    appServerSpawnHook.lastError = error instanceof Error ? error.message : String(error);
    diagnosticWarn("official-runtime", "app_server_spawn_hook_failed", { error: appServerSpawnHook.lastError });
    throw error;
  }
}

function appServerSpawnHookStatus() {
  return {
    installed: appServerSpawnHook.installed,
    patchedModules: appServerSpawnHook.patchedModules,
    interceptCount: appServerSpawnHook.interceptCount,
    lastInterceptAt: appServerSpawnHook.lastInterceptAt,
    lastLauncher: appServerSpawnHook.lastLauncher,
    lastCommand: appServerSpawnHook.lastCommand,
    lastArgs: appServerSpawnHook.lastArgs,
    replacementBinaryPath: appServerSpawnHook.replacementBinaryPath,
    lastError: appServerSpawnHook.lastError,
  };
}

function setWsHub(nextWsHub) {
  // server.cjs 创建 WebSocket hub 后再注入，避免 runtime 层反向依赖 HTTP server。
  wsHub = nextWsHub;
}

function getOfficialBundle() {
  return officialBundle;
}

function requireOfficialBundleProvider() {
  // provider 是 TypeScript build 产物；缺失时直接提示先 build gateway。
  const providerPath = path.join(PROJECT_ROOT, "gateway", "dist", "official", "LocalCodexBundleProvider.js");
  if (!exists(providerPath)) {
    throw new Error(`Missing gateway build: ${providerPath}. Run pnpm run build:gateway first.`);
  }
  return require(providerPath);
}

function setProcessResourcesPath(resourcesPath) {
  if (!resourcesPath) return;
  try {
    // 官方代码会读取 process.resourcesPath 拼接二进制和资源路径，这里对齐到 Codex.app 的 Resources。
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      enumerable: true,
      value: resourcesPath,
    });
  } catch {
    process.resourcesPath = resourcesPath;
  }
}

function setOfficialAppPath(bundleDir) {
  if (!bundleDir) return;
  try {
    // 官方 bootstrap 会通过 app.getAppPath() 读取 package metadata，这里指回抽取后的官方 bundle。
    app.getAppPath = () => bundleDir;
  } catch {}
}

function setOfficialPackagedMode() {
  try {
    // gateway 复用的是已安装 Codex.app 的生产资源，不能让官方 main 走 localhost dev server。
    Object.defineProperty(app, "isPackaged", {
      configurable: true,
      get: () => true,
    });
  } catch {}
}

function browserUseClientEnv(bundle) {
  const buildFlavor = process.env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR || process.env.npm_package_codexBuildFlavor || "prod";
  const version =
    process.env.BROWSER_USE_CODEX_APP_VERSION ||
    (bundle && bundle.version && bundle.version !== "unknown" ? String(bundle.version) : "");
  return {
    BROWSER_USE_AVAILABLE_BACKENDS:
      process.env.BROWSER_USE_AVAILABLE_BACKENDS ||
      process.env.OPENCODEX_BROWSER_USE_AVAILABLE_BACKENDS ||
      DEFAULT_BROWSER_USE_AVAILABLE_BACKENDS,
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: buildFlavor,
    ...(version ? { BROWSER_USE_CODEX_APP_VERSION: version } : {}),
  };
}

function patchBrowserUseClientEnvInFile(filePath, env) {
  if (!exists(filePath)) return false;
  const original = fs.readFileSync(filePath, "utf-8");
  let next = original;
  const envLiteral = JSON.stringify(env);
  // 官方 browser-client 在 node_repl 环境里会读 nodeRepl.env；OpenCodex 当前该对象为空，需要给模块自身兜底。
  if (!next.includes("OPEN_CODEX_BROWSER_USE_ENV")) {
    next = next.replace(
      "const listeners = new Map();\n",
      `const listeners = new Map();\nconst OPEN_CODEX_BROWSER_USE_ENV = ${envLiteral};\n`
    );
  } else {
    next = next.replace(/const OPEN_CODEX_BROWSER_USE_ENV = \{[^;]*\};/, `const OPEN_CODEX_BROWSER_USE_ENV = ${envLiteral};`);
  }
  // process shim 保留给依赖 process.env 的第三方逻辑，但不再作为唯一 fallback。
  next = next.replace("    env: {},\n    version:", `    env: ${envLiteral},\n    version:`);
  next = next.replace(/    env: \{"BROWSER_USE_[^}]*\},\n    version:/, `    env: ${envLiteral},\n    version:`);
  // Browser Use 的配置读取函数只看 nodeRepl.env；这里补 process.env 与模块常量 fallback，保持官方优先级不变。
  const patchedCu =
    'function cu(t){let e=globalThis.nodeRepl?.env?.[t]??globalThis.process?.env?.[t]??OPEN_CODEX_BROWSER_USE_ENV[t];return typeof e=="string"?e:void 0}';
  next = next.replace(
    'function cu(t){let e=globalThis.nodeRepl?.env?.[t];return typeof e=="string"?e:void 0}',
    patchedCu
  );
  next = next.replace(
    'function cu(t){let e=globalThis.nodeRepl?.env?.[t]??globalThis.process?.env?.[t];return typeof e=="string"?e:void 0}',
    patchedCu
  );
  if (next === original) return false;
  fs.writeFileSync(filePath, next, "utf-8");
  return true;
}

function patchBrowserUsePluginClients(bundle) {
  /**
   * OpenCodex 复用官方 bundled Browser 插件，但官方 node_repl MCP 在 Web gateway 下没有填充 nodeRepl.env。
   * Browser native pipe 需要 build flavor 才允许连接，因此启动时给本机插件缓存补一个可重复应用的小补丁。
   */
  const env = browserUseClientEnv(bundle);
  const roots = [
    path.join(CODEX_HOME, "plugins", "cache", "openai-bundled", "browser"),
    path.join(CODEX_HOME, "plugins", "cache", "openai-bundled", "chrome"),
  ];
  for (const root of roots) {
    if (!exists(root)) continue;
    let versions = [];
    try {
      versions = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const version of versions) {
      const clientPath = path.join(root, version, "scripts", "browser-client.mjs");
      try {
        if (patchBrowserUseClientEnvInFile(clientPath, env)) {
          diagnosticLog("browser-use", "client_env_patch_applied", {
            clientPath,
            envKeys: Object.keys(env).sort(),
          });
        }
      } catch (error) {
        diagnosticWarn("browser-use", "client_env_patch_failed", {
          clientPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function patchOfficialBrowserUsePeerAuthorization(bundle) {
  /**
   * 官方 macOS release 版会要求 native pipe 对端具备官方签名身份。
   * OpenCodex 运行的是本机自托管 gateway，进程没有官方签名；这里仅补丁抽取后的官方 runtime 缓存，
   * 让 Browser/Chrome 插件能在 OpenCodex 内连接同进程启动的 Browser Use pipe。
   */
  if (!bundle || !bundle.bundleDir || process.platform !== "darwin") return;
  const buildDir = path.join(bundle.bundleDir, ".vite", "build");
  if (!exists(buildDir)) return;
  let files = [];
  try {
    files = fs.readdirSync(buildDir).filter((fileName) => /^main-.*\.js$/.test(fileName));
  } catch {
    return;
  }
  for (const fileName of files) {
    const filePath = path.join(buildDir, fileName);
    try {
      const original = fs.readFileSync(filePath, "utf-8");
      const marker = "/* OpenCodex: skip Browser Use peer code-signing authorization for local gateway runtime. */";
      if (original.includes(marker)) continue;
      const next = original.replace(
        /function cd\(\)\{[\s\S]*?\}function ld\(e\)\{/,
        `function cd(){${marker}return()=>({authorized:!0})}function ld(e){`
      );
      if (next === original) continue;
      fs.writeFileSync(filePath, next, "utf-8");
      diagnosticLog("browser-use", "peer_authorization_patch_applied", { filePath });
    } catch (error) {
      diagnosticWarn("browser-use", "peer_authorization_patch_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function patchOfficialBrowserUseHeadlessWebview(bundle) {
  /**
   * Web 版没有 Electron <webview>，官方 Browser Use 打开标签时会一直等 did-attach-webview。
   * 这里只补丁本地抽取出的官方 runtime：当 Browser Use 需要新页面时，直接创建一个隐藏 BrowserWindow，
   * 作为真实可被 CDP 控制的后台页面交给官方 browser-sidebar manager。
   */
  if (!bundle || !bundle.bundleDir) return;
  const buildDir = path.join(bundle.bundleDir, ".vite", "build");
  if (!exists(buildDir)) return;
  let files = [];
  try {
    files = fs.readdirSync(buildDir).filter((fileName) => /^main-.*\.js$/.test(fileName));
  } catch {
    return;
  }
  const marker = "/* OpenCodex: create hidden BrowserWindow for Browser Use web runtime. */";
  const originalFragment =
    "return i!=null&&JL(l)!==i&&e.navigatePageToUrl(l,i,`browser_use`,`browser_use`),e.syncThreadState(o,n,c),sR(o,n,l)??(qH().info(`IAB_LIFECYCLE waiting for browser sidebar webview attachment`,{safe:{conversationId:n,ownerWebContentsId:o.owner.id,windowId:a},sensitive:{}}),e.browserUseOpenRequests.waitForOpen(o.owner,n,s,t=>{eU(e,{conversationId:n,windowId:a},s,t)}))";
  const patchedFragment =
    `return i!=null&&JL(l)!==i&&e.navigatePageToUrl(l,i,\`browser_use\`,\`browser_use\`),${marker}(async()=>{e.syncThreadState(o,n,c);let u=sR(o,n,l);if(u!=null)return u;if(globalThis.__OPEN_CODEX_ENABLE_HEADLESS_BROWSER_USE__!==!1)try{let d=globalThis.__OPEN_CODEX_CREATE_BROWSER_USE_WINDOW__?.();if(d==null)throw Error(\`OpenCodex Browser Use window factory is unavailable\`);if(l.view==null)throw Error(\`OpenCodex Browser Use page route has no view\`);l.view.webContents=d.webContents,i!=null&&d.webContents.loadURL?.(i),e.syncThreadState(o,n,c),e.resolveBrowserUseOpenRequests?.(o),u=sR(o,n,l);if(u!=null)return u}catch(d){qH().warning(\`IAB_LIFECYCLE opencodex browser webview attach failed\`,{safe:{conversationId:n,windowId:a},sensitive:{error:d}})}return qH().info(\`IAB_LIFECYCLE waiting for browser sidebar webview attachment\`,{safe:{conversationId:n,ownerWebContentsId:o.owner.id,windowId:a},sensitive:{}}),e.browserUseOpenRequests.waitForOpen(o.owner,n,s,t=>{eU(e,{conversationId:n,windowId:a},s,t)})})()`;
  const brokenFragment =
    "return i!=null&&JL(l)!==i&&e.navigatePageToUrl(l,i,`browser_use`,`browser_use`),/* OpenCodex: create hidden BrowserWindow for Browser Use web runtime. */e.syncThreadState(o,n,c);let u=sR(o,n,l);";
  for (const fileName of files) {
    const filePath = path.join(buildDir, fileName);
    try {
      const original = fs.readFileSync(filePath, "utf-8");
      let next = original;
      if (next.includes(brokenFragment)) {
        next = next.replace(
          /return i!=null&&JL\(l\)!==i&&e\.navigatePageToUrl\(l,i,`browser_use`,`browser_use`\),\/\* OpenCodex: create hidden BrowserWindow for Browser Use web runtime\. \*\/e\.syncThreadState\(o,n,c\);let u=sR\(o,n,l\);if\(u!=null\)return u;if\(globalThis\.__OPEN_CODEX_ENABLE_HEADLESS_BROWSER_USE__!==!1\)try\{let d=new a\.BrowserWindow\(\{__opencodexBrowserUsePage:!0,show:!1,width:1280,height:720,webPreferences:\{sandbox:!0,contextIsolation:!0,nodeIntegration:!1,nodeIntegrationInSubFrames:!1,nodeIntegrationInWorker:!1,webSecurity:!0,devTools:!0,backgroundThrottling:!1\}\}\);d\.setSkipTaskbar\?\.\(!0\),d\.setPosition\?\.\(-32000,-32000,!1\),e\.attachPageWebContents\(o,l,d\.webContents,c\.themeVariant\),u=sR\(o,n,l\);if\(u!=null\)return u\}catch\(d\)\{qH\(\)\.warning\(`IAB_LIFECYCLE opencodex headless browser webview attach failed`,\{safe:\{conversationId:n,windowId:a\},sensitive:\{error:d\}\}\)\}return qH\(\)\.info\(`IAB_LIFECYCLE waiting for browser sidebar webview attachment`,\{safe:\{conversationId:n,ownerWebContentsId:o\.owner\.id,windowId:a\},sensitive:\{\}\}\),e\.browserUseOpenRequests\.waitForOpen\(o\.owner,n,s,t=>\{eU\(e,\{conversationId:n,windowId:a\},s,t\)\}\)/,
          patchedFragment
        );
      } else if (!next.includes(marker)) {
        next = next.replace(originalFragment, patchedFragment);
      }
      next = next.replace(
        /let d=new a\.BrowserWindow\(\{__opencodexBrowserUsePage:!0,show:!1,width:1280,height:720,webPreferences:\{sandbox:!0,contextIsolation:!0,nodeIntegration:!1,nodeIntegrationInSubFrames:!1,nodeIntegrationInWorker:!1,webSecurity:!0,devTools:!0,backgroundThrottling:!1\}\}\);d\.setSkipTaskbar\?\.\(!0\),d\.setPosition\?\.\(-32000,-32000,!1\),/,
        "let d=globalThis.__OPEN_CODEX_CREATE_BROWSER_USE_WINDOW__?.();if(d==null)throw Error(`OpenCodex Browser Use window factory is unavailable`);"
      );
      next = next.replace(
        "e.attachPageWebContents(o,l,d.webContents,c.themeVariant),",
        "vX(e,o,l,d.webContents,c.themeVariant),"
      );
      next = next.replace(
        "vX(e,o,l,d.webContents,c.themeVariant),u=sR(o,n,l);",
        "vX(e,o,l,d.webContents,c.themeVariant),e.resolveBrowserUseOpenRequests?.(o),u=sR(o,n,l);"
      );
      next = next.replace(
        "if(d==null)throw Error(`OpenCodex Browser Use window factory is unavailable`);vX(e,o,l,d.webContents,c.themeVariant),",
        "if(d==null)throw Error(`OpenCodex Browser Use window factory is unavailable`);e.onBrowserSidebarStateChanged??=()=>{};vX(e,o,l,d.webContents,c.themeVariant),"
      );
      next = next.replace(
        "if(d==null)throw Error(`OpenCodex Browser Use window factory is unavailable`);e.onBrowserSidebarStateChanged??=()=>{};vX(e,o,l,d.webContents,c.themeVariant),e.resolveBrowserUseOpenRequests?.(o),u=sR(o,n,l);",
        "if(d==null)throw Error(`OpenCodex Browser Use window factory is unavailable`);if(l.view==null)throw Error(`OpenCodex Browser Use page route has no view`);l.view.webContents=d.webContents,i!=null&&d.webContents.loadURL?.(i),e.syncThreadState(o,n,c),e.resolveBrowserUseOpenRequests?.(o),u=sR(o,n,l);"
      );
      next = next.replace(
        "IAB_LIFECYCLE opencodex headless browser webview attach failed",
        "IAB_LIFECYCLE opencodex browser webview attach failed"
      );
      if (next === original) continue;
      fs.writeFileSync(filePath, next, "utf-8");
      diagnosticLog("browser-use", "headless_webview_patch_applied", { filePath });
    } catch (error) {
      diagnosticWarn("browser-use", "headless_webview_patch_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function alignOfficialElectronEnvironment(bundle) {
  /**
   * 官方 main 认为自己运行在已打包 Codex.app 中。
   * gateway 需要把 app path、resourcesPath、userData 和 build flavor 都伪装成官方生产环境，
   * 否则官方 bootstrap 会尝试连接开发服务器或找不到内置 codex 二进制。
   */
  const runtimeUserDataDir = officialRuntimeUserDataDir();
  const runtimeTempDir = officialRuntimeTempDir();
  // CODEX_HOME 才是需要共享的核心数据；Electron profile 只保存运行态缓存，不能和官方桌面端抢同一把锁。
  ensureDir(runtimeUserDataDir);
  // 官方跨进程 live IPC bus 基于 os.tmpdir() 建 socket；这里必须和官方 Desktop 隔离，避免抢会话 owner。
  ensureDir(runtimeTempDir);
  try {
    fs.chmodSync(runtimeTempDir, 0o700);
  } catch {}
  process.env.CODEX_ELECTRON_USER_DATA_PATH = process.env.CODEX_ELECTRON_USER_DATA_PATH || runtimeUserDataDir;
  process.env.CODEX_HOME = process.env.CODEX_HOME || CODEX_HOME;
  if (bundle.codexBinaryPath) {
    process.env.CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || bundle.codexBinaryPath;
  }
  process.env.TMPDIR = runtimeTempDir;
  process.env.TMP = runtimeTempDir;
  process.env.TEMP = runtimeTempDir;
  process.env.NODE_ENV = process.env.NODE_ENV || "production";
  // 官方 main 在开发态会从环境/package metadata 推导 build flavor；gateway 明确按 prod 对齐。
  process.env.BUILD_FLAVOR = process.env.BUILD_FLAVOR || "prod";
  process.env.npm_package_codexBuildFlavor = process.env.npm_package_codexBuildFlavor || "prod";
  // Browser Use native pipe 的服务端和 node_repl 客户端都要看到同一组官方构建标识。
  process.env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR =
    process.env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR || process.env.npm_package_codexBuildFlavor;
  process.env.BROWSER_USE_AVAILABLE_BACKENDS =
    process.env.BROWSER_USE_AVAILABLE_BACKENDS ||
    process.env.OPENCODEX_BROWSER_USE_AVAILABLE_BACKENDS ||
    DEFAULT_BROWSER_USE_AVAILABLE_BACKENDS;
  if (bundle.version && bundle.version !== "unknown") {
    process.env.BROWSER_USE_CODEX_APP_VERSION = process.env.BROWSER_USE_CODEX_APP_VERSION || String(bundle.version);
  }
  if (bundle.build && bundle.build !== "unknown") {
    process.env.npm_package_codexBuildNumber = process.env.npm_package_codexBuildNumber || String(bundle.build);
  }
  const officialResourcesPath = bundle.sourceResourcesPath || path.dirname(bundle.sourceAsarPath || "");
  if (officialResourcesPath) {
    /**
     * 官方 bundled plugin 管理器支持这个 env 作为资源源目录。
     * 这里指回已安装 Codex.app 的 Resources/plugins，保持“复用官方资源”，不把插件复制进 OpenCodex cache/dist。
     */
    process.env.CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH =
      process.env.CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH || officialResourcesPath;
  }
  app.setName("Codex");
  if (bundle.version && bundle.version !== "unknown") app.setVersion(bundle.version);
  setOfficialPackagedMode();
  try {
    app.setPath("userData", runtimeUserDataDir);
  } catch {}
  diagnosticLog("official-runtime", "official_runtime_temp_dir_configured", {
    runtimeTempDir,
    reason: "isolate official live ipc bus from Codex Desktop",
  });
  diagnosticLog("official-runtime", "official_runtime_resources_configured", {
    resourcesPath: officialResourcesPath,
    bundledPluginsMarketplacePath: path.join(
      officialResourcesPath || "",
      "plugins",
      "openai-bundled",
      ".agents",
      "plugins",
      "marketplace.json"
    ),
    bundledPluginsMarketplaceExists: exists(
      path.join(officialResourcesPath || "", "plugins", "openai-bundled", ".agents", "plugins", "marketplace.json")
    ),
  });
  setProcessResourcesPath(officialResourcesPath);
  setOfficialAppPath(bundle.bundleDir);
}

function addOfficialListener(channel, listener) {
  const set = officialIpc.listeners.get(channel) || new Set();
  set.add(listener);
  officialIpc.listeners.set(channel, set);
}

function removeOfficialListener(channel, listener) {
  const set = officialIpc.listeners.get(channel);
  if (!set) return;
  set.delete(listener);
  if (set.size === 0) officialIpc.listeners.delete(channel);
}

function listenerCount() {
  return Array.from(officialIpc.listeners.values()).reduce((sum, set) => sum + set.size, 0);
}

function installIpcMainHooks() {
  /**
   * 官方 bootstrap 会在加载时调用 ipcMain.handle/on 注册能力。
   * 我们不改官方源码，只 monkey patch 注册入口，把 handler/listener 复制一份到 officialIpc。
   */
  if (ipcMain.__opencodexOfficialGatewayPatched) return;
  ipcMain.__opencodexOfficialGatewayPatched = true;

  // 先保存原生方法，记录官方 handler 的同时仍让 Electron 自己保持原有注册语义。
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = typeof ipcMain.handleOnce === "function" ? ipcMain.handleOnce.bind(ipcMain) : null;
  const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);
  const originalAddListener = typeof ipcMain.addListener === "function" ? ipcMain.addListener.bind(ipcMain) : null;
  const originalOnce = ipcMain.once.bind(ipcMain);
  const originalPrependListener =
    typeof ipcMain.prependListener === "function" ? ipcMain.prependListener.bind(ipcMain) : null;
  const originalPrependOnceListener =
    typeof ipcMain.prependOnceListener === "function" ? ipcMain.prependOnceListener.bind(ipcMain) : null;
  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);
  const originalOff = typeof ipcMain.off === "function" ? ipcMain.off.bind(ipcMain) : null;
  const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain);

  ipcMain.handle = (channel, listener) => {
    officialIpc.handlers.set(String(channel), listener);
    return originalHandle(channel, listener);
  };
  if (originalHandleOnce) {
    ipcMain.handleOnce = (channel, listener) => {
      const wrapped = async (...args) => {
        officialIpc.handlers.delete(String(channel));
        return listener(...args);
      };
      officialIpc.handlers.set(String(channel), wrapped);
      return originalHandleOnce(channel, wrapped);
    };
  }
  ipcMain.removeHandler = (channel) => {
    officialIpc.handlers.delete(String(channel));
    return originalRemoveHandler(channel);
  };
  ipcMain.on = (channel, listener) => {
    addOfficialListener(String(channel), listener);
    return originalOn(channel, listener);
  };
  if (originalAddListener) {
    ipcMain.addListener = (channel, listener) => {
      addOfficialListener(String(channel), listener);
      return originalAddListener(channel, listener);
    };
  }
  ipcMain.once = (channel, listener) => {
    const wrapped = (...args) => {
      removeOfficialListener(String(channel), wrapped);
      return listener(...args);
    };
    addOfficialListener(String(channel), wrapped);
    return originalOnce(channel, wrapped);
  };
  if (originalPrependListener) {
    ipcMain.prependListener = (channel, listener) => {
      addOfficialListener(String(channel), listener);
      return originalPrependListener(channel, listener);
    };
  }
  if (originalPrependOnceListener) {
    ipcMain.prependOnceListener = (channel, listener) => {
      const wrapped = (...args) => {
        removeOfficialListener(String(channel), wrapped);
        return listener(...args);
      };
      addOfficialListener(String(channel), wrapped);
      return originalPrependOnceListener(channel, wrapped);
    };
  }
  ipcMain.removeListener = (channel, listener) => {
    removeOfficialListener(String(channel), listener);
    return originalRemoveListener(channel, listener);
  };
  if (originalOff) {
    ipcMain.off = (channel, listener) => {
      removeOfficialListener(String(channel), listener);
      return originalOff(channel, listener);
    };
  }
  ipcMain.removeAllListeners = (channel) => {
    if (typeof channel === "string") {
      officialIpc.listeners.delete(channel);
    } else {
      officialIpc.listeners.clear();
    }
    return originalRemoveAllListeners(channel);
  };
}

function hideOfficialWindow(win) {
  // 官方窗口仍要真实创建，因为官方 renderer 会初始化 app-server 连接；这里只把它从用户视野里移走。
  try {
    win.setOpacity(0);
  } catch {}
  try {
    win.setPosition(-32000, -32000, false);
  } catch {}
  try {
    win.hide();
  } catch {}
  try {
    win.setSkipTaskbar(true);
  } catch {}
}

function payloadFromArgs(args) {
  return args.length <= 1 ? (args[0] ?? null) : args;
}

function normalizeIpcArgs(args) {
  return Array.isArray(args) ? args : [args];
}

function normalizeDesktopFeatureAvailabilityForBundledPlugins(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return;
  const message = payloadFromArgs(args);
  if (!message || typeof message !== "object" || message.type !== "electron-desktop-features-changed") return;
  /**
   * 官方 bundled plugin 管理器根据 desktop feature 位决定哪些内置插件可见/可安装。
   * Web gateway 没有完整 Electron renderer 宿主能力探测，这里补齐本机 runner 已承载的能力，
   * 让 sites、Browser、Chrome、Computer Use、Record & Replay 等插件继续走官方 reconcile 流程。
   */
  Object.assign(message, {
    browserPane: true,
    computerUse: true,
    computerUseNodeRepl: true,
    externalBrowserUse: true,
    externalBrowserUseAllowed: true,
    inAppBrowserUse: true,
    inAppBrowserUseAllowed: true,
    multiBrowserTabs: true,
    recordAndReplay: true,
    sites: true,
  });
}

function stringRouteId(value) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function routeIdFromValue(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 5) return "";
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = routeIdFromValue(item, depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }

  // 协议升级时优先按 shape 找 requestId / JSON-RPC id，而不是按固定 type 白名单判断。
  const requestId = stringRouteId(value.requestId);
  if (requestId) return requestId;
  for (const key of ["request", "message", "response", "payload", "body"]) {
    const nested = routeIdFromValue(value[key], depth + 1, seen);
    if (nested) return nested;
  }
  if (value.id != null && (depth > 0 || value.method || value.jsonrpc || value.type)) {
    return stringRouteId(value.id);
  }
  return "";
}

function requestRouteIdFromIncoming(_channel, args) {
  // 浏览器发来的任意 IPC 参数都可能带 requestId；用通用 shape 提取提升官方升级适配性。
  return routeIdFromValue(args);
}

function responseRouteIdFromOutgoing(_channel, args) {
  // 官方出站消息可能是 message-for-view 包裹，也可能是直接 channel；统一从 args 里找 id。
  return routeIdFromValue(args);
}

function responsePayloadType(channel, args) {
  const payload = payloadFromArgs(args);
  if (payload && typeof payload === "object" && typeof payload.type === "string") return payload.type;
  return channel;
}

function incomingIpcDiagnosticSummary(channel, payload) {
  const message = payloadFromArgs(payload);
  const summary = {
    channel,
  };
  if (message && typeof message === "object") {
    // invokeArgs 常是单元素数组；摘要要先拆出真实 payload，出站回包才能带上原始 URL。
    if (typeof message.type === "string") summary.sourceType = message.type;
    if (typeof message.url === "string") summary.url = message.url;
    if (typeof message.method === "string") summary.method = message.method;
    if (message.request && typeof message.request === "object") {
      if (message.request.id != null) summary.requestId = String(message.request.id);
      if (typeof message.request.method === "string") summary.requestMethod = message.request.method;
      // 官方 app-host 兼容层有时把真实方法放在 request.method；缓存层统一看 summary.method。
      if (!summary.method && typeof message.request.method === "string") summary.method = message.request.method;
    }
    if (message.params && typeof message.params === "object" && typeof message.params.method === "string") {
      // 某些 JSON-RPC 包装会把 app-server 方法藏在 params.method，这里也归一化到 method。
      if (!summary.method) summary.method = message.params.method;
    }
  }
  return summary;
}

function valueStringAtKeys(value, keys, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || depth > 5) return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = valueStringAtKeys(item, keys, depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = valueStringAtKeys(nested, keys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function flowThreadIdFromPayload(payload) {
  // 官方不同版本会把对话 ID 放在 threadId、conversationId 或 params 里，递归提取只保留 ID，不读取正文。
  return valueStringAtKeys(payload, ["threadId", "conversationId", "conversation_id"]);
}

function flowStageForMethod(method, phase) {
  const name = String(method || "");
  const start = phase === "start";
  if (name === "thread/read") return start ? "thread_reading" : "thread_read";
  if (name === "thread/resume") return start ? "thread_resuming" : "thread_resumed";
  if (name === "thread/turns/list") return start ? "turns_loading" : "thread_ready";
  if (name === "turn/start") return start ? "turn_starting" : "turn_accepted";
  return "";
}

function flowScopeForMethod(method) {
  return String(method || "") === "turn/start" ? "turn" : "thread";
}

function shouldTrackFlowMethod(method) {
  return !!flowStageForMethod(method, "start");
}

function recordOfficialFlowStart(clientId, summary, payload) {
  const method = summary && summary.method;
  if (!clientId || !shouldTrackFlowMethod(method)) return;
  recordFlowEvent({
    clientId,
    hint: method === "turn/start" ? "消息正在提交到官方 runtime" : "正在拉取对话历史状态",
    method,
    requestId: summary.requestId || "",
    scope: flowScopeForMethod(method),
    stage: flowStageForMethod(method, "start"),
    threadId: flowThreadIdFromPayload(payload),
  });
}

function recordOfficialFlowResponse(clientId, routeBase, payload, requestSummary) {
  const method = routeBase && routeBase.method;
  if (!clientId || !shouldTrackFlowMethod(method)) return;
  const startedAtMs = requestSummary && Number(requestSummary.startedAtMs);
  const durationMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : undefined;
  const ok = !(payload && typeof payload === "object" && (payload.error || payload.status >= 400));
  recordFlowEvent({
    clientId,
    durationMs,
    error: ok ? "" : (payload && (payload.error || payload.status)) || "",
    hint: ok
      ? method === "turn/start"
        ? "消息已提交到官方 runtime"
        : "对话历史阶段完成"
      : "官方 runtime 返回失败",
    level: ok ? "info" : "error",
    method,
    ok,
    requestId: routeBase.requestId || "",
    scope: flowScopeForMethod(method),
    stage: ok ? flowStageForMethod(method, "end") : `${flowStageForMethod(method, "start")}_failed`,
    threadId: flowThreadIdFromPayload(payload) || flowThreadIdFromPayload(requestSummary),
  });
}

function stableReadOnlyCachePart(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableReadOnlyCachePart(item, seen));
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "id" || key === "requestId") continue;
    result[key] = stableReadOnlyCachePart(value[key], seen);
  }
  return result;
}

function readOnlyAppServerMethodFromSummary(summary) {
  const method = summary && typeof summary.method === "string" ? summary.method : "";
  return APP_SERVER_READ_ONLY_METHODS.has(method) ? method : "";
}

function readOnlyAppServerMethodFromCacheKey(cacheKey) {
  try {
    const parsed = JSON.parse(String(cacheKey || ""));
    const method = parsed && typeof parsed.method === "string" ? parsed.method : "";
    return APP_SERVER_READ_ONLY_METHODS.has(method) ? method : "";
  } catch {
    for (const method of APP_SERVER_READ_ONLY_METHODS) {
      if (String(cacheKey || "").includes(method)) return method;
    }
    return "";
  }
}

function readOnlyAppServerCacheKey(channel, invokeArgs, summary) {
  const method = readOnlyAppServerMethodFromSummary(summary);
  if (!method) return "";
  try {
    return JSON.stringify({
      channel,
      method,
      args: stableReadOnlyCachePart(invokeArgs),
    });
  } catch {
    return `${channel}:${method}`;
  }
}

function fastSyncMethodFromRequestSummary(summary) {
  const method = summary && typeof summary.method === "string" ? summary.method : "";
  return isFastSyncCacheableMethod(method) ? method : "";
}

function attachFastSyncSnapshotKey(summary, invokeArgs) {
  const method = fastSyncMethodFromRequestSummary(summary);
  if (!method) return;
  // 快照 key 必须基于入站请求参数生成；出站 fetch-response 已经没有完整请求 args。
  summary.fastSyncSnapshotKey = cacheKeyForSnapshot(method, invokeArgs);
}

function canServeStaleReadOnlyCache(method, entry, nowMs = Date.now()) {
  if (!APP_SERVER_STALE_READ_ONLY_METHODS.has(method)) return false;
  if (!entry || typeof entry.expiresAtMs !== "number") return false;
  // app/plugin/MCP 状态只是辅助 UI。Win 上这些扫描可能十几秒，允许短期过期缓存先撑住对话加载。
  return entry.expiresAtMs + APP_SERVER_STALE_READ_ONLY_CACHE_MAX_AGE_MS > nowMs;
}

function readOnlyCacheDiskKey(cacheKey) {
  return crypto.createHash("sha256").update(String(cacheKey)).digest("base64url");
}

function loadReadOnlyAppServerCache() {
  if (appServerReadOnlyCacheLoaded) return;
  appServerReadOnlyCacheLoaded = true;
  try {
    const raw = fs.readFileSync(APP_SERVER_READ_ONLY_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const entries = parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object"
      ? parsed.entries
      : {};
    const nowMs = Date.now();
    for (const entry of Object.values(entries)) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.cacheKey !== "string" || typeof entry.expiresAtMs !== "number") continue;
      if (!entry.response || typeof entry.response !== "object") continue;
      const method = readOnlyAppServerMethodFromSummary({ method: entry.method || "" }) || readOnlyAppServerMethodFromCacheKey(entry.cacheKey);
      if (entry.expiresAtMs <= nowMs && !canServeStaleReadOnlyCache(method, entry, nowMs)) continue;
      appServerReadOnlyCache.set(entry.cacheKey, {
        expiresAtMs: entry.expiresAtMs,
        method,
        response: entry.response,
      });
    }
  } catch (error) {
    if (error && error.code !== "ENOENT" && DEBUG_LOGS) {
      diagnosticWarn("official-runtime", "read_only_cache_load_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function saveReadOnlyAppServerCacheNow() {
  appServerReadOnlyCacheSaveTimer = null;
  try {
    ensureDir(path.dirname(APP_SERVER_READ_ONLY_CACHE_FILE));
    const nowMs = Date.now();
    const entries = {};
    for (const [cacheKey, entry] of appServerReadOnlyCache) {
      if (!entry) continue;
      if (entry.expiresAtMs <= nowMs && !canServeStaleReadOnlyCache(entry.method || "", entry, nowMs)) continue;
      entries[readOnlyCacheDiskKey(cacheKey)] = {
        cacheKey,
        expiresAtMs: entry.expiresAtMs,
        method: entry.method || readOnlyAppServerMethodFromCacheKey(cacheKey),
        response: entry.response,
      };
    }
    const tmpFile = `${APP_SERVER_READ_ONLY_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ version: 1, entries }), "utf-8");
    fs.renameSync(tmpFile, APP_SERVER_READ_ONLY_CACHE_FILE);
  } catch (error) {
    if (DEBUG_LOGS) {
      diagnosticWarn("official-runtime", "read_only_cache_save_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function scheduleReadOnlyAppServerCacheSave() {
  if (appServerReadOnlyCacheSaveTimer) return;
  appServerReadOnlyCacheSaveTimer = setTimeout(saveReadOnlyAppServerCacheNow, 500);
  if (appServerReadOnlyCacheSaveTimer && typeof appServerReadOnlyCacheSaveTimer.unref === "function") {
    appServerReadOnlyCacheSaveTimer.unref();
  }
}

function cloneWithReplacement(value, oldRequestId, nextRequestId) {
  if (value == null || typeof value !== "object") {
    return value === oldRequestId ? nextRequestId : value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneWithReplacement(item, oldRequestId, nextRequestId));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] =
      (key === "id" || key === "requestId") && String(item) === String(oldRequestId)
        ? nextRequestId
        : cloneWithReplacement(item, oldRequestId, nextRequestId);
  }
  return result;
}

function cachedResponseForRequest(entry, requestId) {
  const response = entry && entry.response;
  if (!response || typeof response !== "object") return null;
  return {
    channel: response.channel,
    args: cloneWithReplacement(response.args, response.requestId, requestId),
  };
}

function maybeSendFallbackMcpResponse(channel, invokeArgs, context, summary, result) {
  if (!wsHub || !context || !context.clientId) return false;
  const requestId = requestRouteIdFromIncoming(channel, invokeArgs);
  if (!requestId) return false;
  const incoming = payloadFromArgs(invokeArgs);
  const args = [
    {
      type: "mcp-response",
      hostId: (incoming && typeof incoming === "object" && incoming.hostId) || "local",
      message: {
        id: requestId,
        result,
      },
    },
  ];
  const payload = payloadFromArgs(args);
  const routeBase = {
    ...outgoingIpcDiagnosticSummary(MESSAGE_FOR_VIEW_CHANNEL, args, summary),
    fallback: true,
    mapped: true,
    targetClientId: shortId(context.clientId),
  };
  return wsHub.sendTo(
    context.clientId,
    { channel: MESSAGE_FOR_VIEW_CHANNEL, payload, args },
    { suppressDiagnostic: shouldSuppressRoutineRouteDiagnostic(routeBase), diagnosticSummary: routeBase }
  );
}

function cloneCacheableResponseArgs(args) {
  try {
    // 缓存只保存可序列化的回包快照，避免后续路由过程意外改动内存对象。
    return JSON.parse(JSON.stringify(args));
  } catch {
    return null;
  }
}

function maybeServeReadOnlyAppServerCache(channel, invokeArgs, context, summary, cacheKey) {
  if (!cacheKey || !wsHub || !context || !context.clientId) return false;
  loadReadOnlyAppServerCache();
  const method = readOnlyAppServerMethodFromSummary(summary);
  const cached = appServerReadOnlyCache.get(cacheKey);
  const nowMs = Date.now();
  const isFresh = cached && cached.expiresAtMs > nowMs;
  const isStaleUsable = cached && canServeStaleReadOnlyCache(method, cached, nowMs);
  if (!cached || (!isFresh && !isStaleUsable)) {
    if (method === "mcpServerStatus/list") {
      // MCP 状态只是工具面板辅助信息；没有缓存时用空列表兜底，避免 Win 慢扫描阻塞会话正文。
      return maybeSendFallbackMcpResponse(channel, invokeArgs, context, summary, { data: [], nextCursor: null });
    }
    return false;
  }
  const requestId = requestRouteIdFromIncoming(channel, invokeArgs);
  if (!requestId) return false;
  const response = cachedResponseForRequest(cached, requestId);
  if (!response || typeof response.channel !== "string" || !Array.isArray(response.args)) return false;
  const payload = payloadFromArgs(response.args);
  const routeBase = {
    ...outgoingIpcDiagnosticSummary(response.channel, response.args, summary),
    cached: true,
    mapped: true,
    targetClientId: shortId(context.clientId),
  };
  const sent = wsHub.sendTo(
    context.clientId,
    { channel: response.channel, payload, args: response.args },
    { suppressDiagnostic: shouldSuppressRoutineRouteDiagnostic(routeBase), diagnosticSummary: routeBase }
  );
  if (sent) {
    if (DEBUG_LOGS) {
      diagnosticLog("official-runtime", "read_only_cache_hit", {
        method: summary.method,
        requestId: shortId(requestId),
        stale: !isFresh,
      });
    }
    return true;
  }
  return false;
}

function rememberReadOnlyAppServerResponse(channel, args, requestSummary, requestId) {
  const method = readOnlyAppServerMethodFromSummary(requestSummary);
  if (!method || !requestId) return;
  const cacheKey = requestSummary && requestSummary.cacheKey;
  if (!cacheKey) return;
  const payload = payloadFromArgs(args);
  if (payload && typeof payload === "object" && payload.error) return;
  const cacheableArgs = cloneCacheableResponseArgs(args);
  if (!cacheableArgs) return;
  appServerReadOnlyCache.set(cacheKey, {
    expiresAtMs: Date.now() + APP_SERVER_READ_ONLY_CACHE_TTL_MS,
    method,
    response: {
      args: cacheableArgs,
      channel,
      requestId,
    },
  });
  scheduleReadOnlyAppServerCacheSave();
}

function fetchMessageFromIpcArgs(args) {
  const payload = payloadFromArgs(args);
  if (!payload || typeof payload !== "object") return null;
  if (payload.type !== "fetch") return null;
  return typeof payload.url === "string" ? payload : null;
}

function isStatsigBootstrapFetchMessage(message) {
  if (!message || typeof message !== "object") return false;
  return String(message.url || "").replace(/^vscode:\/\/codex/i, "") === "/wham/statsig/bootstrap";
}

function isLocaleInfoFetchMessage(message) {
  if (!message || typeof message !== "object") return false;
  return /(?:^|\/)locale-info$/i.test(String(message.url || ""));
}

function nonCriticalFetchBodyForUrl(url) {
  try {
    const parsed = new URL(String(url || ""), "https://chatgpt.com");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (parsed.hostname === "ab.chatgpt.com" && pathname === "/v1/initialize") {
      return {
        has_updates: false,
        time: Date.now(),
        feature_gates: {},
        dynamic_configs: {},
        layer_configs: {},
        param_stores: {},
        exposures: {},
        sdk_flags: {},
      };
    }
    if (parsed.hostname === "chatgpt.com" && (pathname === "/ces/v1/rgstr" || pathname === "/ces/v1/log_event")) {
      return {};
    }
    if (pathname === "/beacons/home") return {};
    if (pathname === "/wham/usage") return {};
    if (pathname === "/wham/tasks/list") {
      return {
        items: [],
        tasks: [],
      };
    }
  } catch {}
  return null;
}

function sendFetchJsonResponse(message, body) {
  const requestId = stringRouteId(message && message.requestId);
  if (!requestId) return false;
  routeOfficialWebContentsSend(MESSAGE_FOR_VIEW_CHANNEL, [
    {
      type: "fetch-response",
      responseType: "success",
      requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify(body && typeof body === "object" ? body : {}),
    },
  ]);
  return true;
}

function maybeHandleNonCriticalFetch(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return false;
  const message = fetchMessageFromIpcArgs(args);
  const body = nonCriticalFetchBodyForUrl(message && message.url);
  if (body === null) return false;
  // 这些请求只影响遥测、实验和首页辅助信息；弱网下本地短路，避免它们挤占会话读取和发消息的 IPC 通道。
  return sendFetchJsonResponse(message, body);
}

function normalizeOfficialI18nFetchRequest(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return;
  const message = fetchMessageFromIpcArgs(args);
  if (!isStatsigBootstrapFetchMessage(message)) return;
  const locale = getI18nSnapshot().locale || "zh-CN";
  // 这里修改的是即将交给官方 fetch handler 的真实请求，确保官方 Statsig 服务按中文策略返回 i18n layer。
  message.headers = {
    ...(message.headers && typeof message.headers === "object" ? message.headers : {}),
    "OAI-Language": locale,
  };
  try {
    const body = message.body ? JSON.parse(message.body) : {};
    if (body && typeof body === "object") {
      body.locale = locale;
      message.body = JSON.stringify(body);
    }
  } catch {}
}

function parseJsonLike(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function desiredComputerUseAuthEnabled(message) {
  const body = parseJsonLike(message && message.body) || parseJsonLike(message && message.bodyJsonString);
  return body && typeof body.enabled === "boolean" ? body.enabled : null;
}

function logComputerUseAuthRequest(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return;
  const message = fetchMessageFromIpcArgs(args);
  const action = message ? computerUseAuthActionFromUrl(message.url) : "";
  if (!action) return;
  diagnosticLog("computer-use-auth", "official_fetch_request", {
    action,
    requestId: shortId(stringRouteId(message.requestId)),
    method: message.method || "",
    url: message.url,
    ...readComputerUseInstallerStatusForDiagnostics(),
  });
}

function sendComputerUseAuthWriteNoopResponse(message, enabled) {
  const requestId = stringRouteId(message && message.requestId);
  if (!requestId) return false;
  routeOfficialWebContentsSend(MESSAGE_FOR_VIEW_CHANNEL, [
    {
      type: "fetch-response",
      responseType: "success",
      requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify({ enabled }),
    },
  ]);
  return true;
}

function maybeHandleComputerUseAuthWriteNoop(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return false;
  const message = fetchMessageFromIpcArgs(args);
  if (!message || computerUseAuthActionFromUrl(message.url) !== "computer-use-background-auth-write") return false;
  const desiredEnabled = desiredComputerUseAuthEnabled(message);
  if (typeof desiredEnabled !== "boolean") return false;

  const status = readComputerUseInstallerStatusForDiagnostics();
  if (typeof status.installerInstalled !== "boolean" || status.installerInstalled !== desiredEnabled) return false;

  /**
   * 官方 write 会无条件调用 install/uninstall。OpenCodex runner 是临时签名进程，macOS 授权启动
   * 可能返回 -60006；当 Installer status 已经和目标一致时，直接返回官方 fetch-response 形状即可。
   */
  diagnosticLog("computer-use-auth", "write_noop_current_status", {
    desiredEnabled,
    requestId: shortId(stringRouteId(message.requestId)),
    installerInstalled: status.installerInstalled,
    installerStdout: status.installerStdout || "",
    installerError: status.installerError || "",
  });
  return sendComputerUseAuthWriteNoopResponse(message, desiredEnabled);
}

function logDesktopFeatureAvailability(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return;
  const message = payloadFromArgs(args);
  if (!message || typeof message !== "object" || message.type !== "electron-desktop-features-changed") return;
  /**
   * bundled plugins 和 Computer Use 管理器都依赖这组 feature 位。
   * 这里只记录关键布尔值，避免把整份 renderer 状态刷进日志。
   */
  diagnosticLog("desktop-features", "electron_desktop_features_changed", {
    ambientSuggestions: message.ambientSuggestions,
    browserPane: message.browserPane,
    inAppBrowserUse: message.inAppBrowserUse,
    inAppBrowserUseAllowed: message.inAppBrowserUseAllowed,
    externalBrowserUse: message.externalBrowserUse,
    externalBrowserUseAllowed: message.externalBrowserUseAllowed,
    computerUse: message.computerUse,
    computerUseNodeRepl: message.computerUseNodeRepl,
    sites: message.sites,
    control: message.control,
    deviceAttestation: message.deviceAttestation,
    multiWindow: message.multiWindow,
  });
}

function maybeHandleBrowserUseWebShimLifecycle(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return false;
  const message = payloadFromArgs(args);
  if (!message || typeof message !== "object") return false;
  /**
   * Web 入口里的 <webview> shim 只是 DOM/布局兼容层，没有 Electron guest webContents。
   * Browser Use 现在由 gateway 后台真实 BrowserWindow 承载，因此不能把 shim 的 hidden-browser-use
   * 生命周期交给官方 main，否则官方会把真实 route 当作前端伪 webview 的销毁流程关闭。
   */
  if (
    message.hostKind === "hidden-browser-use" &&
    message.type === "browser-sidebar-webview-destroyed"
  ) {
    diagnosticLog("browser-use", "web_shim_lifecycle_ignored", {
      type: message.type,
      conversationId: message.conversationId || "",
      browserTabId: message.browserTabId || "",
    });
    return true;
  }
  return false;
}

function parseFetchResponseBodyJson(payload) {
  if (!payload || typeof payload !== "object") return null;
  const raw = typeof payload.bodyJsonString === "string" ? payload.bodyJsonString : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getI18nSnapshot() {
  // OpenCodex 自有文案统一由 shared/i18n 解析，gateway 只负责发布解析后的快照。
  return resolveOpenCodexI18n();
}

function sendLocaleInfoFetchResponse(message) {
  const requestId = stringRouteId(message && message.requestId);
  if (!requestId) return false;
  const locale = getI18nSnapshot().locale || "zh-CN";
  routeOfficialWebContentsSend(MESSAGE_FOR_VIEW_CHANNEL, [
    {
      type: "fetch-response",
      responseType: "success",
      requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify({ ideLocale: locale, systemLocale: locale }),
    },
  ]);
  return true;
}

function maybeHandleLocaleInfoFetch(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return false;
  const message = fetchMessageFromIpcArgs(args);
  if (!isLocaleInfoFetchMessage(message)) return false;
  /**
   * 官方 renderer 的 i18n provider 通过 vscode://codex/locale-info 获取 IDE/系统语言。
   * OpenCodex 没有外部 IDE 宿主，这里用官方 fetch-response 形状返回本地语言，让官方语言包解析继续走原生路径。
   */
  return sendLocaleInfoFetchResponse(message);
}

function fetchUrlPath(message) {
  try {
    return new URL(String(message && message.url ? message.url : ""), "vscode://codex").pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function fetchParamValue(message, name) {
  try {
    const parsed = new URL(String(message && message.url ? message.url : ""), "vscode://codex");
    const value = parsed.searchParams.get(name);
    if (value != null) return value;
  } catch {}
  const body = parseJsonLike(message && message.body) || parseJsonLike(message && message.bodyJsonString);
  const params = body && typeof body.params === "object" ? body.params : null;
  return String((params && params[name]) || (body && body[name]) || "");
}

function isDomainIsolationRemoteStateKey(key) {
  // OpenCodex 使用域名隔离，不能把官方 Desktop 上次选择的 remote-control host 带进网页入口。
  return key === "selected-remote-host-id" || String(key || "").startsWith("remote-thread-summaries:");
}

function maybeHandleDomainIsolationGlobalStateFetch(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return false;
  const message = fetchMessageFromIpcArgs(args);
  if (!message) return false;
  const pathname = fetchUrlPath(message);
  const key = fetchParamValue(message, "key");
  if (pathname === "/get-global-state" && isDomainIsolationRemoteStateKey(key)) {
    return sendFetchJsonResponse(message, { value: null });
  }
  if (pathname === "/set-global-state" && isDomainIsolationRemoteStateKey(key)) {
    return sendFetchJsonResponse(message, {});
  }
  if (pathname === "/set-remote-control-connections-enabled") {
    return sendFetchJsonResponse(message, { enabled: false });
  }
  return false;
}

function logComputerUseAuthResponse(routeBase, payload) {
  const action = computerUseAuthActionFromUrl(routeBase && routeBase.url);
  if (!action || !payload || typeof payload !== "object") return;
  const body = parseFetchResponseBodyJson(payload);
  diagnosticLog("computer-use-auth", "official_fetch_response", {
    action,
    requestId: shortId(routeBase.requestId),
    responseType: payload.responseType || "",
    status: payload.status,
    enabled: body && typeof body.enabled === "boolean" ? body.enabled : null,
    bodyKeys: body && typeof body === "object" ? Object.keys(body).sort().join(",") : "",
    mapped: !!routeBase.mapped,
    route: routeBase.targetClientId ? "target" : "broadcast",
  });
}

function rememberFastSyncSnapshot(channel, _args, requestSummary, responseResult, context = {}) {
  void channel;
  const method = fastSyncMethodFromRequestSummary(requestSummary);
  const key = requestSummary && typeof requestSummary.fastSyncSnapshotKey === "string" ? requestSummary.fastSyncSnapshotKey : "";
  if (!method || !key || !responseResult || responseResult.ok !== true) return;
  const responseValue = responseResult.value;
  if (!fastSyncCache.writeSnapshot({ key, method, value: responseValue })) return;
  recordFlowEvent({
    clientId: context.clientId || "",
    hint: "已写入 gateway 快照",
    method,
    scope: "thread",
    stage: "gateway_snapshot_store",
    threadId: flowThreadIdFromPayload(responseValue) || flowThreadIdFromPayload(requestSummary),
  });
}

function outgoingIpcDiagnosticSummary(channel, args, requestSummary = null) {
  const payload = payloadFromArgs(args);
  const summary = {
    ...(requestSummary && typeof requestSummary === "object" ? requestSummary : {}),
    channel,
    payloadType: payload && typeof payload === "object" ? `object(${Object.keys(payload).length})` : typeof payload,
    requestId: responseRouteIdFromOutgoing(channel, args),
  };
  if (payload && typeof payload === "object") {
    if (typeof payload.type === "string") summary.type = payload.type;
    if (payload.request && typeof payload.request === "object") {
      if (payload.request.id != null) summary.requestId = String(payload.request.id);
      if (typeof payload.request.method === "string") summary.requestMethod = payload.request.method;
    }
    if (typeof payload.url === "string") summary.url = payload.url;
    if (typeof payload.method === "string") summary.method = payload.method;
  }
  return summary;
}

function isConnectorLogoUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url, "http://opencodex.local");
    return /^\/aip\/connectors\/[^/]+\/logo\/?$/.test(parsed.pathname);
  } catch {
    return /^\/aip\/connectors\/[^/?#]+\/logo(?:[?#]|$)/.test(url);
  }
}

function shouldSuppressRoutineRouteDiagnostic(summary) {
  // connector logo 的 fetch-response 数量很大，常规路由日志默认压下去；慢 IPC 仍会在 server.cjs 侧暴露。
  return summary && summary.type === "fetch-response" && isConnectorLogoUrl(summary.url);
}

function isCrossClientSyncCandidate(summary, payload) {
  if (!summary || !payload || typeof payload !== "object") return false;
  const type = String(payload.type || summary.type || "");
  if (!/fetch-(?:response|stream-event)|stream/i.test(type)) return false;
  const method = String(summary.method || payload.method || "").toUpperCase();
  const url = String(summary.url || payload.url || "");
  // 只把会改变会话状态的请求作为跨屏同步源；静态资源、i18n、logo 和只读 GET 不触发刷新。
  if (method === "GET") return false;
  if (/\/(?:wham|locale-info|aip\/connectors\/[^/]+\/logo)(?:[/?#]|$)/i.test(url)) return false;
  return /vscode:\/\/codex|\/api\/|\/backend-api\/|\/conversation|\/thread|\/message|\/chat|\/run/i.test(url);
}

function notifyOtherClientsForSync(sourceClientId, summary, payload) {
  if (!sourceClientId || !wsHub || typeof wsHub.broadcastExcept !== "function") return;
  if (!isCrossClientSyncCandidate(summary, payload)) return;
  wsHub.broadcastExcept(
    sourceClientId,
    {
      type: "opencodex:sync-nudge",
      sourceClientId,
      reason: "conversation-mutated",
      requestId: summary.requestId || "",
      at: Date.now(),
    },
    { suppressDiagnostic: true }
  );
}

function shouldKeepRequestRoute(channel, args) {
  const type = responsePayloadType(channel, args);
  // 只有流式中间事件保留路由；complete/error 或普通响应到达后即可释放映射。
  return /(?:^|[-/:])stream[-/:](?:event|chunk|delta|data)$/i.test(type) || /fetch-stream-event/i.test(type);
}

function summarizeIpcValue(value) {
  try {
    const json = JSON.stringify(value, (_key, nextValue) => {
      if (typeof nextValue === "string" && nextValue.length > 400) return `${nextValue.slice(0, 400)}...`;
      return nextValue;
    });
    return json && json.length > 2000 ? `${json.slice(0, 2000)}...` : json;
  } catch {
    return "[unserializable]";
  }
}

function isTargetedOutgoing(channel, payload) {
  // 这类消息如果找不到 requestId，也应该优先发回当前 HTTP IPC 对应的 client。
  if (channel === MESSAGE_FOR_VIEW_CHANNEL && payload && typeof payload === "object") {
    return TARGETED_MESSAGE_TYPES.has(String(payload.type || ""));
  }
  return TARGETED_MESSAGE_TYPES.has(channel);
}

function rememberRequestRoute(channel, payload, clientId, summary = null) {
  if (!clientId) return;
  const requestId = requestRouteIdFromIncoming(channel, payload);
  const routeSummary = {
    ...(summary || incomingIpcDiagnosticSummary(channel, payload)),
    startedAtMs: Date.now(),
  };
  recordOfficialFlowStart(clientId, routeSummary, payload);
  if (requestId) {
    requestRoutes.set(requestId, clientId);
    requestRouteSummaries.set(requestId, routeSummary);
  }
}

function logUnknownIpc(kind, details) {
  try {
    ensureDir(REPORTS_DIR);
    fs.appendFileSync(
      UNKNOWN_IPC_PATH,
      `${JSON.stringify({
        at: new Date().toISOString(),
        kind,
        ...details,
      })}\n`,
      "utf-8"
    );
  } catch {}
}

function routeOfficialWebContentsSend(channel, args) {
  /**
   * 官方代码以为自己在给 Electron renderer 发消息。
   * gateway 需要把这些 webContents.send 拦下来，并转换成浏览器 WebSocket 消息。
   */
  const payload = payloadFromArgs(args);
  if (!wsHub) {
    diagnosticWarn("official-ipc-route", "before_ws_ready", outgoingIpcDiagnosticSummary(channel, args));
    logUnknownIpc("webcontents-send-before-ws-ready", {
      channel,
      requestId: responseRouteIdFromOutgoing(channel, args),
      args: summarizeIpcValue(args),
    });
    return false;
  }

  // 先按 requestId 找历史路由；没有 requestId 时再退回当前 AsyncLocalStorage 的 clientId。
  const requestId = responseRouteIdFromOutgoing(channel, args);
  const mappedClientId = requestId ? requestRoutes.get(requestId) : "";
  const requestSummary = requestId ? requestRouteSummaries.get(requestId) : null;
  const store = (requestContext && requestContext.getStore && requestContext.getStore()) || {};
  const targetClientId = mappedClientId || (isTargetedOutgoing(channel, payload) ? store.clientId : "");
  const routeBase = {
    ...outgoingIpcDiagnosticSummary(channel, args, requestSummary),
    mapped: !!mappedClientId,
    targetClientId: shortId(targetClientId),
  };
  // 这些 app-server 列表是只读初始化数据；成功回包落盘后，重启网关也能先用热缓存撑住弱网首屏。
  rememberReadOnlyAppServerResponse(channel, args, requestSummary, requestId);
  // fast-sync 快照只记录 allowlist 的官方成功只读回包，供浏览器首屏独立读取。
  rememberFastSyncSnapshot(channel, args, requestSummary, valueFromFastSyncFetchResponsePayload(payload), {
    clientId: mappedClientId || targetClientId,
  });
  recordOfficialFlowResponse(mappedClientId || targetClientId, routeBase, payload, requestSummary);
  // 只对锁屏授权相关回包做结构化摘要，避免把大图标 dataURL 打进日志。
  logComputerUseAuthResponse(routeBase, payload);
  const suppressRouteDiagnostic = shouldSuppressRoutineRouteDiagnostic(routeBase);
  if (requestId && mappedClientId && !shouldKeepRequestRoute(channel, args)) {
    // 流式中间事件在 complete/error 前可能有多次分片，不能提前删除路由。
    requestRoutes.delete(requestId);
    requestRouteSummaries.delete(requestId);
  }
  const wsDiagnosticOptions = {
    suppressDiagnostic: suppressRouteDiagnostic,
    diagnosticSummary: routeBase,
  };
  if (targetClientId && wsHub.sendTo(targetClientId, { channel, payload, args }, wsDiagnosticOptions)) {
    // 发送端使用自己的 requestId 接流；其它屏幕只收到同步提示，由前端主动刷新当前会话状态。
    notifyOtherClientsForSync(targetClientId, routeBase, payload);
    if (DEBUG_LOGS && !suppressRouteDiagnostic) {
      // 官方 IPC 定向成功投递会随每个请求回包出现，默认不落盘；DEBUG 时用于确认 requestId/clientId 路由。
      diagnosticLog("official-ipc-route", "send_to_client", { ...routeBase, route: "target" });
    }
    return true;
  }
  // 没有 requestId 或 clientId 的通知类消息广播给所有在线浏览器。
  const broadcastCount = wsHub.broadcast({ channel, payload, args }, wsDiagnosticOptions);
  if (DEBUG_LOGS && !suppressRouteDiagnostic) {
    // 成功广播只是常规路由摘要，数量会随会话状态同步放大；默认压下，DEBUG 时用于追路由。
    diagnosticLog("official-ipc-route", "broadcast", {
      ...routeBase,
      broadcastCount,
      route: targetClientId ? "target_fallback_broadcast" : "broadcast",
    });
  }
  if (targetClientId && broadcastCount === 0) {
    // 定向回包没有命中任何 WS 客户端时要打日志，这通常表示前端过早发送 IPC 或 WS 已断开。
    diagnosticWarn("official-ipc-route", "ws_target_missing_for_ipc_response", {
      channel,
      requestId,
      targetClientId: shortId(targetClientId),
      payloadType: payload && typeof payload === "object" ? payload.type : typeof payload,
    });
  }
  return true;
}

function shouldSuppressHiddenRendererSend(channel, args) {
  const payload = payloadFromArgs(args);
  // 浏览器代理的消息已经通过 WS 转发，继续送进隐藏 renderer 会造成重复消费。
  return channel === MESSAGE_FOR_VIEW_CHANNEL && payload && typeof payload === "object";
}

function patchOfficialWebContents(webContents) {
  // patch send 是异步事件转发的核心：官方 main -> hidden webContents -> WebSocket -> 浏览器。
  if (!webContents || webContents.__opencodexOfficialGatewayPatched) return;
  webContents.__opencodexOfficialGatewayPatched = true;
  const originalSend = webContents.send.bind(webContents);
  webContents.send = (channel, ...args) => {
    routeOfficialWebContentsSend(String(channel), args);
    // 官方隐藏 renderer 不需要消费这些消息，避免 Web 发起的 requestId 再回到隐藏页。
    if (shouldSuppressHiddenRendererSend(String(channel), args)) return true;
    return originalSend(channel, ...args);
  };
  if (typeof webContents.postMessage === "function") {
    const originalPostMessage = webContents.postMessage.bind(webContents);
    webContents.postMessage = (channel, message, transfer) => {
      routeOfficialWebContentsSend(String(channel), [message]);
      if (shouldSuppressHiddenRendererSend(String(channel), [message])) return true;
      return originalPostMessage(channel, message, transfer);
    };
  }
  if (typeof webContents.sendToFrame === "function") {
    const originalSendToFrame = webContents.sendToFrame.bind(webContents);
    webContents.sendToFrame = (frameId, channel, ...args) => {
      routeOfficialWebContentsSend(String(channel), args);
      if (shouldSuppressHiddenRendererSend(String(channel), args)) return true;
      return originalSendToFrame(frameId, channel, ...args);
    };
  }
  if (webContents.mainFrame && typeof webContents.mainFrame.postMessage === "function") {
    const originalFramePostMessage = webContents.mainFrame.postMessage.bind(webContents.mainFrame);
    webContents.mainFrame.postMessage = (channel, message, transfer) => {
      routeOfficialWebContentsSend(String(channel), [message]);
      if (shouldSuppressHiddenRendererSend(String(channel), [message])) return true;
      return originalFramePostMessage(channel, message, transfer);
    };
  }
}

function registerOfficialWindow(win) {
  if (!win || win.__opencodexOfficialGatewayRegistered) return;
  if (win.__opencodexBrowserUsePage || browserUseWindowCreationDepth > 0) return;
  win.__opencodexOfficialGatewayRegistered = true;
  // 第一扇官方窗口作为 IPC event.sender；后续窗口仍统一隐藏，避免桌面上弹出界面。
  if (!officialIpc.hiddenWindow || officialIpc.hiddenWindow.isDestroyed()) {
    officialIpc.hiddenWindow = win;
    officialIpc.hiddenWebContents = win.webContents;
  }
  hideOfficialWindow(win);
  patchOfficialWebContents(win.webContents);
  win.on("show", () => hideOfficialWindow(win));
  win.on("ready-to-show", () => hideOfficialWindow(win));
  win.on("closed", () => {
    if (officialIpc.hiddenWindow === win) {
      officialIpc.hiddenWindow = null;
      officialIpc.hiddenWebContents = null;
    }
  });
}

function installBrowserWindowHooks() {
  /**
   * 不能禁止官方 BrowserWindow 创建：
   * 官方 renderer 会在窗口加载后初始化 app-server、注册状态同步和 IPC 桥。
   * 因此这里让窗口真实存在，但不可见、屏幕外、跳过任务栏。
   */
  if (electron.__opencodexOfficialGatewayBrowserWindowPatched) return;
  electron.__opencodexOfficialGatewayBrowserWindowPatched = true;
  const NativeBrowserWindow = electron.BrowserWindow;

  globalThis.__OPEN_CODEX_CREATE_BROWSER_USE_WINDOW__ = function createOpenCodexBrowserUseWindow() {
    /**
     * Browser 插件只需要一个真实 webContents 供 CDP/截图/DOM 操作使用。
     * 这里用原生 BrowserWindow 创建可见窗口，保持官方 Browser 使用时会在 Mac 侧显示浏览器的体验。
     */
    browserUseWindowCreationDepth += 1;
    let win;
    try {
      win = new NativeBrowserWindow({
        show: true,
        width: 1280,
        height: 720,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          devTools: true,
          backgroundThrottling: false,
        },
      });
    } finally {
      browserUseWindowCreationDepth = Math.max(0, browserUseWindowCreationDepth - 1);
    }
    win.__opencodexBrowserUsePage = true;
    win.show();
    win.focus();
    return win;
  };

  function GatewayBrowserWindow(options = {}) {
    const isOpenCodexBrowserUsePage = options && options.__opencodexBrowserUsePage === true;
    const normalizedOptions = { ...options };
    delete normalizedOptions.__opencodexBrowserUsePage;
    // 官方 main 仍创建真实 BrowserWindow，但默认不可见并放到屏幕外。
    if (isOpenCodexBrowserUsePage) browserUseWindowCreationDepth += 1;
    let win;
    try {
      win = new NativeBrowserWindow({
        ...normalizedOptions,
        show: false,
        opacity: 0,
        x: -32000,
        y: -32000,
      });
    } finally {
      if (isOpenCodexBrowserUsePage) browserUseWindowCreationDepth = Math.max(0, browserUseWindowCreationDepth - 1);
    }
    if (isOpenCodexBrowserUsePage) {
      // Browser Use 页面需要保留原生 webContents.send，不能套官方主窗口的 IPC 转发 shim。
      win.__opencodexBrowserUsePage = true;
      win.show();
      win.focus();
    } else {
      registerOfficialWindow(win);
    }
    return win;
  }

  Object.setPrototypeOf(GatewayBrowserWindow, NativeBrowserWindow);
  GatewayBrowserWindow.prototype = NativeBrowserWindow.prototype;
  try {
    // 替换 electron.BrowserWindow 后，官方 bootstrap 里 new BrowserWindow 会自动进入隐藏模式。
    electron.BrowserWindow = GatewayBrowserWindow;
  } catch (error) {
    diagnosticWarn("official-runtime", "browser_window_patch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  app.on("browser-window-created", (_event, win) => registerOfficialWindow(win));
}

function patchOfficialAppSingleton() {
  if (app.__opencodexOfficialGatewaySingletonPatched) return;
  app.__opencodexOfficialGatewaySingletonPatched = true;
  const originalRequestSingleInstanceLock = app.requestSingleInstanceLock.bind(app);
  app.requestSingleInstanceLock = (...args) => {
    try {
      originalRequestSingleInstanceLock(...args);
    } catch {}
    // gateway 需要能和真实 Codex Desktop 并存，因此不让官方单例锁退出当前进程。
    return true;
  };
}

function createOfficialIpcEvent(context = {}) {
  const sender = officialIpc.hiddenWebContents;
  if (!sender || sender.isDestroyed()) {
    throw new Error("Official BrowserWindow is not ready yet");
  }
  // 模拟 Electron IpcMainInvokeEvent 的关键字段，保证官方 handler 能按桌面端路径执行。
  return {
    sender,
    senderFrame: sender.mainFrame || null,
    processId: typeof sender.getOSProcessId === "function" ? sender.getOSProcessId() : 0,
    frameId: 0,
    returnValue: undefined,
    reply(channel, ...args) {
      // ipcMain.on 风格的 handler 会调用 event.reply，这里也统一接到 WebSocket 转发链路。
      routeOfficialWebContentsSend(String(channel), args);
    },
    // MessagePort 类 IPC 需要保留官方 event.ports 语义，app-host RPC 首屏握手依赖它。
    ports: Array.isArray(context.ports) ? context.ports : [],
    remoteAddress: context.remoteAddress || "",
  };
}

async function waitForOfficialBridgeReady(timeoutMs = 20_000) {
  // 官方 renderer 加载和 app-server 初始化是异步的，IPC 调用前必须等任意官方 IPC 注册完成。
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      officialIpc.hiddenWebContents &&
      !officialIpc.hiddenWebContents.isDestroyed() &&
      (officialIpc.handlers.size > 0 || listenerCount() > 0)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Official IPC bridge was not ready before timeout");
}

async function invokeOfficialIpc(channel, args = [], context = {}) {
  await waitForOfficialBridgeReady();
  const event = createOfficialIpcEvent(context);
  const invokeArgs = normalizeIpcArgs(args);
  normalizeOfficialI18nFetchRequest(channel, invokeArgs);
  normalizeDesktopFeatureAvailabilityForBundledPlugins(channel, invokeArgs);
  const requestSummary = incomingIpcDiagnosticSummary(channel, invokeArgs);
  const readOnlyCacheKey = readOnlyAppServerCacheKey(channel, invokeArgs, requestSummary);
  if (readOnlyCacheKey) requestSummary.cacheKey = readOnlyCacheKey;
  attachFastSyncSnapshotKey(requestSummary, invokeArgs);
  if (maybeServeReadOnlyAppServerCache(channel, invokeArgs, context, requestSummary, readOnlyCacheKey)) return true;
  // 先记录请求归属，再调用官方 handler，这样同步和异步回包都能找到目标 client。
  rememberRequestRoute(channel, invokeArgs, context.clientId || "", requestSummary);
  // 会话列表保持官方原生链路，避免跨环境实验影响 Win/Mac 本地历史显示。
  if (maybeHandleDomainIsolationGlobalStateFetch(channel, invokeArgs)) return true;
  if (maybeHandleNonCriticalFetch(channel, invokeArgs)) return true;
  if (maybeHandleLocaleInfoFetch(channel, invokeArgs)) return true;
  if (maybeHandleBrowserUseWebShimLifecycle(channel, invokeArgs)) return true;
  // Computer Use 锁屏授权由官方 Installer 决定；这里额外记录同进程直接 status，方便和官方回包对照。
  logComputerUseAuthRequest(channel, invokeArgs);
  if (maybeHandleComputerUseAuthWriteNoop(channel, invokeArgs)) return true;
  logDesktopFeatureAvailability(channel, invokeArgs);
  const handler = officialIpc.handlers.get(channel);
  if (handler) {
    return handler(event, ...invokeArgs);
  }
  const listeners = officialIpc.listeners.get(channel);
  if (listeners && listeners.size > 0) {
    for (const listener of [...listeners]) {
      await listener(event, ...invokeArgs);
    }
    return event.returnValue === undefined ? true : event.returnValue;
  }
  logUnknownIpc("missing-ipc-handler", {
    channel,
    requestId: requestRouteIdFromIncoming(channel, invokeArgs),
    args: summarizeIpcValue(invokeArgs),
    registeredHandlers: Array.from(officialIpc.handlers.keys()).sort(),
    registeredListeners: Array.from(officialIpc.listeners.keys()).sort(),
  });
  throw new Error(`No official Electron IPC handler for ${channel}`);
}

async function connectOfficialAppHostPort(port, context = {}) {
  /**
   * 官方新版 renderer 启动时不再只走 electronBridge.invoke，而是通过 MessageChannel
   * 建立 app-host RPC。这里只补齐官方 preload 的转发动作，把 MessagePort 原样交给
   * 官方 main listener，服务对象和 RPC 协议仍完全由官方 bundle 负责。
   */
  await waitForOfficialBridgeReady();
  const listeners = officialIpc.listeners.get("codex_desktop:connect-app-host");
  if (!listeners || listeners.size === 0) {
    throw new Error("No official Electron IPC listener for codex_desktop:connect-app-host");
  }
  // 等价于官方 preload 的 ipcRenderer.postMessage(channel, undefined, [port])。
  const event = createOfficialIpcEvent({ ...context, ports: [port] });
  for (const listener of [...listeners]) {
    await listener(event);
  }
  return true;
}

/**
 * 在 gateway 进程里创建一条“浏览器 MessagePort <-> 官方 MessagePort”的透明中继。
 * 这里不解析 app-host RPC 的 JSON 内容，只保证字符串帧和关闭信号按顺序穿过边界。
 */
function createOfficialAppHostRelay(options = {}) {
  const { clientId = "", onClose, onError, onMessage, portId = "", remoteAddress = "" } = options;
  if (typeof electron.MessageChannelMain !== "function") {
    throw new Error("Electron MessageChannelMain is unavailable");
  }

  // port1 交给官方 IPC listener；port2 留在 gateway，用来和浏览器 WebSocket 互转消息。
  const { port1, port2 } = new electron.MessageChannelMain();
  let closed = false;

  function close(reason = "closed") {
    if (closed) return;
    closed = true;
    try {
      port1.close();
    } catch {}
    try {
      port2.close();
    } catch {}
    try {
      onClose && onClose(reason);
    } catch {}
  }

  port2.on("message", (event) => {
    // Electron MessageEvent.data 可能挂在原型 getter 上，必须直接读取，不能用 hasOwnProperty 判断。
    const data = event ? event.data : undefined;
    if (data == null) {
      // app-host 约定 null 表示端口关闭，收到后要同步释放两端资源。
      close("official_closed");
      return;
    }
    if (typeof data !== "string") {
      diagnosticWarn("official-app-host", "non_string_message_from_official", {
        clientId: shortId(clientId),
        payloadType: typeof data,
        portId: shortId(portId),
      });
      return;
    }
    try {
      onMessage && onMessage(data);
    } catch (error) {
      diagnosticWarn("official-app-host", "forward_to_browser_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
    }
  });
  port2.on("close", () => close("official_port_closed"));
  port2.start();

  connectOfficialAppHostPort(port1, { clientId, portId, remoteAddress }).then(
    () => {
      if (DEBUG_LOGS) {
        // app-host 正常连接只是生命周期事件；失败仍保持常规日志，方便排查终端/侧栏能力不可用。
        diagnosticLog("official-app-host", "connected", {
          clientId: shortId(clientId),
          portId: shortId(portId),
        });
      }
    },
    (error) => {
      diagnosticWarn("official-app-host", "connect_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
      try {
        onError && onError(error);
      } catch {}
      close("connect_failed");
    }
  );

  return {
    close,
    postMessage(data) {
      if (closed) return false;
      try {
        // 浏览器侧也用 null 作为关闭信号；其它 payload 必须保持官方 RPC 字符串原样。
        port2.postMessage(data);
        if (data == null) close("browser_closed");
        return true;
      } catch (error) {
        diagnosticWarn("official-app-host", "forward_to_official_failed", {
          clientId: shortId(clientId),
          error: error instanceof Error ? error.message : String(error),
          portId: shortId(portId),
        });
        try {
          onError && onError(error);
        } catch {}
        close("forward_to_official_failed");
        return false;
      }
    },
  };
}

function officialIpcStatus() {
  // health 接口暴露 handler/listener 列表，方便判断官方 bundle 是否成功启动。
  return {
    ready:
      !!officialIpc.hiddenWebContents &&
      !officialIpc.hiddenWebContents.isDestroyed() &&
      officialIpc.handlers.has(MESSAGE_FROM_VIEW_CHANNEL),
    hiddenWebContentsId: officialIpc.hiddenWebContents ? officialIpc.hiddenWebContents.id : null,
    handlerCount: officialIpc.handlers.size,
    listenerCount: listenerCount(),
    handlers: Array.from(officialIpc.handlers.keys()).sort(),
    listeners: Array.from(officialIpc.listeners.keys()).sort(),
  };
}

function officialBundleStatus() {
  // 只返回路径和版本等诊断信息，不读取或暴露官方 bundle 的具体源码内容。
  return officialBundle
    ? {
        version: officialBundle.version,
        build: officialBundle.build,
        sourceAppPath: officialBundle.sourceAppPath,
        sourceAsarPath: officialBundle.sourceAsarPath,
        sourceResourcesPath: officialBundle.sourceResourcesPath,
        codexBinaryPath: officialBundle.codexBinaryPath,
        bundleDir: officialBundle.bundleDir,
        webviewDir: officialBundle.webviewDir,
        bootstrapPath: officialBundle.bootstrapPath,
        cacheProcessedAt: officialBundle.manifest && officialBundle.manifest.processedAt ? officialBundle.manifest.processedAt : null,
      }
    : null;
}

function buildGatewayStatus() {
  const listenUrl = `http://${HOST}:${PORT}`;
  const localUrl = `http://127.0.0.1:${PORT}`;
  return {
    ok: true,
    gateway: {
      kind: "official",
      host: HOST,
      port: PORT,
      listenUrl,
      localUrl,
      pid: process.pid,
      projectRoot: PROJECT_ROOT,
      webShellDir: WEB_SHELL_DIR,
      nodeVersion: process.version,
      electronVersion: process.versions && process.versions.electron ? process.versions.electron : null,
    },
    runtime: {
      runtimeDir: RUNTIME_DIR,
      configPath: AUTH_CONFIG_PATH,
      reportsDir: REPORTS_DIR,
      unknownIpcPath: UNKNOWN_IPC_PATH,
      officialUserDataPath: officialRuntimeUserDataDir(),
      officialTempPath: officialRuntimeTempDir(),
      officialCodexUserDataPath: officialDataDir(),
      codexHome: CODEX_HOME,
    },
    officialBundle: officialBundleStatus(),
    officialIpc: officialIpcStatus(),
    officialAppServer: appServerSpawnHookStatus(),
    officialNotification: officialNotificationHookStatus(),
    officialTray: hiddenTrayHookStatus(),
    i18n: getI18nSnapshot(),
    workspaceRoots: workspaceRootsFromEnv(),
  };
}

async function webConfigScript() {
  // 这个脚本由浏览器入口动态加载，避免把本机路径和端口写死到 web-shell 构建产物里。
  const i18n = withPluginI18nMessages(getI18nSnapshot());
  return `(() => {
  window.__CODEX_WEB_CONFIG__ = {
    gatewayBaseUrl: location.origin,
    gatewayWsUrl: location.origin.replace(/^http/, "ws") + "/ws",
    workspaceRoots: ${JSON.stringify(workspaceRootsFromEnv())},
    homeDir: ${JSON.stringify(os.homedir())},
    locale: ${JSON.stringify(i18n.locale)},
    localeSource: ${JSON.stringify(i18n.source || "")},
    localeMode: ${JSON.stringify(i18n.mode || "")},
    messages: ${JSON.stringify(i18n.messages)},
    // debugWs 只控制浏览器侧诊断采集，不控制 WS 压缩；压缩属于 gateway 传输层优化。
    // OPENCODEX_DEBUG_WS=1 时才开启 WS 大包/慢解析诊断，平时不采集。
    debugWs: ${JSON.stringify(process.env.OPENCODEX_DEBUG_WS === "1")},
    appServer: ${JSON.stringify({ kind: "official-electron-ipc", spawnHook: appServerSpawnHookStatus() })},
    sharedObjectSnapshot: ${JSON.stringify({
      host_config: { id: "local", kind: "local" },
      // 各自域名只服务各自机器，避免官方 runtime 在 Win/Mac 页面里自动恢复远程环境。
      remote_ssh_connections: [],
      remote_control_connections: [],
      // 官方 renderer 的 i18n 开关来自 Statsig layer；首帧注入可避免弱网下订阅回包太晚。
      "72216192": { enable_i18n: true, locale_source: "IDE" },
    })},
    // persistedAtomSnapshot 用于首屏同步：renderer 会很早请求它，此时 WebSocket 可能还没连上。
    persistedAtomSnapshot: ${JSON.stringify(persistedAtomSnapshotForRenderer())}
  };
})();`;
}

function startOfficialRuntime() {
  /**
   * 官方 runtime 启动点：
   * - ensureOfficialBundle 负责从已安装 Codex.app 抽取白名单资源。
   * - 环境伪装必须发生在 require(bootstrapPath) 之前。
   * - hook 必须先安装，才能捕获 bootstrap 注册的 IPC handler、官方 app-server 子进程，并隐藏官方 UI。
   */
  const { ensureOfficialBundle } = requireOfficialBundleProvider();
  officialBundle = ensureOfficialBundle({ projectRoot: PROJECT_ROOT });
  alignOfficialElectronEnvironment(officialBundle);
  patchOfficialBrowserUsePeerAuthorization(officialBundle);
  patchOfficialBrowserUseHeadlessWebview(officialBundle);
  patchBrowserUsePluginClients(officialBundle);
  installAppServerSpawnHook(officialBundle);
  installIpcMainHooks();
  installBrowserWindowHooks();
  installOfficialNotificationHook(electron, {
    publishNotification: (payload) => (wsHub ? wsHub.broadcast(payload, { suppressDiagnostic: true }) : 0),
  });
  installOfficialTrayHook(electron);
  patchOfficialAppSingleton();

  // 官方 build-flavor 解析器会从 process.cwd()/package.json 读取构建元信息，需让 cwd 指向抽取后的官方 bundle。
  if (officialBundle.bundleDir) {
    process.chdir(officialBundle.bundleDir);
  }

  // 官方 bootstrap 负责注册 IPC handler、创建隐藏 BrowserWindow 和启动自己的 app-server 连接。
  require(officialBundle.bootstrapPath);
}

function rejectPendingInternalResponses(error) {
  // 当前没有 gateway 自己发起的官方 IPC 请求；保留出口让 shutdown 路径无需关心内部实现。
  void error;
}

function listOfficialIpcChannels() {
  return {
    handlers: Array.from(officialIpc.handlers.keys()).sort(),
    listeners: Array.from(officialIpc.listeners.keys()).sort(),
  };
}

module.exports = {
  buildGatewayStatus,
  createOfficialAppHostRelay,
  getI18nSnapshot,
  getOfficialBundle,
  handleOfficialNotificationEvent,
  invokeOfficialIpc,
  listOfficialIpcChannels,
  rejectPendingInternalResponses,
  requestContext,
  setWsHub,
  startOfficialRuntime,
  webConfigScript,
};
