const http = require("http");
const path = require("path");
const { app } = require("electron");
const {
  AUTH_PASSWORD_HASH,
  authRefreshHeaders,
  authResultForRequest,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthStatus,
  isAuthed,
  isLauncherRequest,
  sendUnauthorized,
} = require("./http/auth.cjs");
const {
  DEBUG_LOGS,
  HOST,
  IPC_SLOW_LOG_MS,
  PORT,
  PROJECT_ROOT,
  REPORTS_DIR,
  RUNTIME_DIR,
  UNKNOWN_IPC_PATH,
  ensureDir,
  exists,
} = require("./core/config.cjs");
const { readBody, send, sendJson } = require("./http/http-utils.cjs");
const {
  cacheKeyForSnapshot,
  createFastSyncCache,
  isFastSyncCacheableMethod,
  isFastSyncSnapshotMethod,
  memoryFastSyncCache,
  parseFastSyncSnapshotArgsJson,
} = require("./core/fast-sync-cache.cjs");
const { createLocalFileService } = require("./http/local-files.cjs");
const { handleTokenUsageRequest } = require("./http/token-usage.cjs");
const {
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
} = require("./ipc/official-runtime.cjs");
const { createPickedFilesService } = require("./ipc/picked-files.cjs");
const { createStaticAssetService } = require("./http/static-assets.cjs");
const { createMobileApi } = require("./http/mobile.cjs");
const { createWsHub } = require("./ipc/ws-hub.cjs");
const { diagnosticError, diagnosticLog, diagnosticWarn, sanitizeDiagnosticValue, shortId } = require("./core/diagnostics.cjs");
const { recordFlowEvent, snapshotFlowState } = require("./core/flow-monitor.cjs");
const { markGatewaySilentQuit } = require("./lifecycle/quit-confirmation-suppressor.cjs");

const fastSyncCache = createFastSyncCache({
  dir: path.join(RUNTIME_DIR, "cache", "fast-sync"),
});

// 这些 query 只控制 OpenCodex 入口诊断/模式切换，不能交给官方 renderer 当作会话路由语义。
const NON_RESTORABLE_ROUTE_QUERY_PARAMS = [
  "__opencodex_renderer",
  "full",
  "mobile",
  "probe",
  "_probe",
  "_deep",
  "_tail",
];
const NONCRITICAL_STATSIG_PREFIX = "/api/noncritical/statsig";

// server.cjs 只负责编排 HTTP/WS 生命周期；官方 Electron hook 细节放在 official-runtime.cjs。
function gatewayUrl(req) {
  // Node 原生 req.url 只有 path，需要补 host 才能安全解析 query 参数。
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

function isMobileHtmlRequest(req, pathname, url) {
  if (!req || req.method !== "GET") return false;
  if (url && url.searchParams.get("full") === "1") return false;
  if (url && url.searchParams.get("mobile") === "1") return true;
  const accept = String(req.headers.accept || "");
  if (accept && !accept.includes("text/html") && !accept.includes("*/*")) return false;
  const userAgent = String(req.headers["user-agent"] || "");
  // 手机页面入口默认进入官方外观的瘦身模式，避免完整状态流压垮弱网首屏。
  // 从桌面/历史记录直接打开 /local/:id 也要瘦身，否则壳页会先按桌面模式加载插件和辅助统计。
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone|Mobi/i.test(userAgent);
}

function isMobileTrafficRequest(req, url) {
  if (url && url.searchParams.get("full") === "1") return false;
  // 允许桌面浏览器显式复现手机瘦身路径，方便排查弱网首屏和会话进入链路。
  if (url && url.searchParams.get("mobile") === "1") return true;
  const userAgent = String((req && req.headers && req.headers["user-agent"]) || "");
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone|Mobi/i.test(userAgent);
}

function rendererOptionsForRequest(req, url) {
  return {
    initialRoute: initialRouteForRequest(url),
    mobileTrafficMode: isMobileTrafficRequest(req, url),
  };
}

function normalizeInitialThreadRoute(route) {
  const text = typeof route === "string" ? route.trim() : "";
  if (!text || text.startsWith("//")) return "";
  try {
    const base = "http://opencodex.local";
    const parsed = new URL(text, base);
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && parsed.origin !== base) return "";
    for (const param of NON_RESTORABLE_ROUTE_QUERY_PARAMS) {
      parsed.searchParams.delete(param);
    }
    const cleanRoute = `${parsed.pathname || "/"}${parsed.search || ""}${parsed.hash || ""}`;
    // 只允许官方会话详情路由进入 initial-route，避免把诊断页或设置页写进 renderer 启动状态。
    return /^\/(?:local|thread|conversation|remote)\/[^/?#]+/.test(cleanRoute) ? cleanRoute : "";
  } catch {
    return "";
  }
}

function initialRouteForRequest(url) {
  if (!url) return "";
  const queryRoute = url.searchParams.get("route");
  const route = queryRoute || `${url.pathname || "/"}${url.search || ""}${url.hash || ""}`;
  return normalizeInitialThreadRoute(route);
}

function serveOfficialRendererOrShell(req, res, url, staticAssets) {
  if (url.searchParams.get("__opencodex_renderer") === "1") {
    // 壳页先完成认证、配置和 bridge 安装，再用保持原始 /local/:id 的地址切入官方 renderer。
    const html = staticAssets.createRendererResponse(rendererOptionsForRequest(req, url));
    if (!html) {
      return send(
        res,
        404,
        { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        "Official renderer bundle is not available yet."
      );
    }
    return send(res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, html);
  }
  // 页面入口保持 web-shell 壳页，让认证、运行时配置和 bridge polyfill 先稳定安装；
  // 官方 renderer 只由壳页带内部 handoff 参数切入，避免直接首页启动时脚本顺序/CSP 退化。
  return staticAssets.serveWebShellIndex(res, {
    initialRoute: initialRouteForRequest(url),
    mobileTrafficMode: isMobileHtmlRequest(req, url.pathname, url),
  });
}

function nonCriticalStatsigBodyForPathname(pathname) {
  const route = String(pathname || "")
    .slice(NONCRITICAL_STATSIG_PREFIX.length)
    .replace(/\/+$/, "");
  if (route === "/v1/initialize") {
    // Statsig 初始化只影响实验/遥测；给 SDK 一个完整空壳，避免它把本地短路当成网络错误。
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
  if (
    route === "/v1/rgstr" ||
    route === "/v1/log_event" ||
    route === "/v1/sdk_exception" ||
    route === "/ces/v1/rgstr" ||
    route === "/ces/v1/log_event" ||
    route === "/ces/v1/m" ||
    route === "/statsigapi/v1/sdk_exception" ||
    route.startsWith("/segment/v1/")
  ) {
    return {};
  }
  if (route.startsWith("/ces/v1/v1/projects/") && route.endsWith("/settings")) {
    // Segment/Statsig 的项目配置同样只影响埋点加载；返回空配置即可让 SDK 停止重试外链。
    return {
      integrations: {},
      middlewareSettings: {},
      plan: {},
    };
  }
  return null;
}

function handleNonCriticalStatsigRequest(req, res, pathname) {
  if (!pathname.startsWith(`${NONCRITICAL_STATSIG_PREFIX}/`)) return false;
  if (req.method === "OPTIONS") {
    send(res, 204, { "cache-control": "no-store", allow: "GET, POST, HEAD, OPTIONS" }, "");
    return true;
  }
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { "cache-control": "no-store", allow: "GET, POST, HEAD, OPTIONS" });
    return true;
  }
  const body = nonCriticalStatsigBodyForPathname(pathname);
  if (body == null) {
    sendJson(res, 404, { ok: false, error: "Not Found" }, { "cache-control": "no-store" });
    return true;
  }
  if (req.method === "HEAD") {
    send(res, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, "");
    return true;
  }
  sendJson(res, 200, body, { "cache-control": "no-store" });
  return true;
}

function remoteAddressFromRequest(req) {
  return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "");
}

function payloadFromArgs(args) {
  return args.length <= 1 ? (args[0] ?? null) : args;
}

function ipcArgsFromRequestBody(parsed) {
  if (Array.isArray(parsed.args)) return parsed.args;
  // 兼容旧版 web-shell：没有 args 时仍接受单 payload 字段。
  if (Object.prototype.hasOwnProperty.call(parsed, "payload")) return [parsed.payload];
  return [];
}

function ipcPayloadSummary(payload) {
  if (!payload || typeof payload !== "object") return {};
  const summary = {};
  // 慢 IPC 日志只打印路由字段，不打印正文内容，避免把用户消息或文件内容写进日志。
  for (const key of ["type", "requestId", "hostId", "url", "method"]) {
    if (typeof payload[key] === "string" && payload[key]) summary[key] = payload[key];
  }
  if (payload.request && typeof payload.request === "object") {
    if (payload.request.id != null) summary.requestId = String(payload.request.id);
    if (typeof payload.request.method === "string") summary.requestMethod = payload.request.method;
  }
  return summary;
}

function formatIpcPayloadSummary(payload) {
  const summary = ipcPayloadSummary(payload);
  return Object.keys(summary).length > 0 ? ` ${JSON.stringify(summary)}` : "";
}

function isConnectorLogoFetchPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.type !== "fetch" || typeof payload.url !== "string") return false;
  try {
    const parsed = new URL(payload.url, "http://opencodex.local");
    return /^\/aip\/connectors\/[^/]+\/logo\/?$/.test(parsed.pathname);
  } catch {
    return /^\/aip\/connectors\/[^/?#]+\/logo(?:[?#]|$)/.test(payload.url);
  }
}

function shouldSuppressRoutineIpcLog(payload) {
  // 官方 renderer 会高频发送 log-message 和 connector logo fetch；默认不打印 start/end，避免淹没有价值的慢请求。
  return (
    payload &&
    typeof payload === "object" &&
    (payload.type === "log-message" || isConnectorLogoFetchPayload(payload))
  );
}

function safeClientLogData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  // 浏览器诊断日志只保留排障字段，避免把 prompt、文件内容或完整响应写进日志。
  for (const key of [
    "ageMs",
    "activeCount",
    "attempt",
    "cacheKey",
    "cacheSize",
    "clientAt",
    "channel",
    "clientId",
    "count",
    "elapsedMs",
    "error",
    "errorName",
    "event",
    "handledBy",
    "handleMs",
    "href",
    "inFlightCount",
    "method",
    "ok",
    "payloadType",
    "portId",
    "parseMs",
    "queuedCount",
    "rawChars",
    "ready",
    "reason",
    "recovered",
    "requestId",
    "requestMethod",
    "responseType",
    "serverSocketId",
    "serverTransport",
    "socketId",
    "status",
    "startedCount",
    "target",
    "totalQueuedCount",
    "fallbackTransport",
    "transport",
    "type",
    "url",
    "waitMs",
    "waiterCount",
    "wsReady",
    "wsState",
  ]) {
    const nestedValue = value[key];
    const sanitized = sanitizeDiagnosticValue(key, nestedValue);
    if (sanitized !== undefined) result[key] = key === "clientId" ? shortId(String(sanitized)) : sanitized;
  }
  return result;
}

function safeConnectionFlowData(value, event, fallbackClientId = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clientId = sanitizeDiagnosticValue("clientId", value.clientId || fallbackClientId);
  if (!clientId) return null;
  const result = {
    clientId: shortId(String(clientId)),
    scope: "connection",
    stage: event === "ws-hello-ack" ? "ws_ready" : "transport_selected",
  };
  for (const key of ["fallbackTransport", "socketId", "transport"]) {
    const sanitized = sanitizeDiagnosticValue(key, value[key]);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  if (typeof value.recovered === "boolean") result.recovered = value.recovered;
  return result;
}

function safeFastSyncFlowData(value, fallbackClientId = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {
    // fast-sync-flow 只描述发送链路，不允许浏览器把 prompt/body 等大字段写入 flow monitor。
    scope: "turn",
  };
  for (const key of ["clientId", "error", "localSendId", "method", "requestId", "stage", "threadId", "turnId"]) {
    const rawValue = value[key];
    if (rawValue != null && typeof rawValue === "object") continue;
    const sanitized = sanitizeDiagnosticValue(key, value[key]);
    if (sanitized !== undefined) result[key] = key === "clientId" ? shortId(String(sanitized)) : sanitized;
  }
  if (!result.clientId && fallbackClientId) result.clientId = shortId(fallbackClientId);
  if (!result.clientId || !result.stage) return null;
  if (!result.method) result.method = "turn/start";
  if (result.error) result.level = "error";
  return result;
}

async function handleClientLog(req, res) {
  const body = await readBody(req);
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body" }, { "cache-control": "no-store" });
  }

  // 浏览器端会批量上报诊断事件，减少日志本身对真实 IPC 请求的干扰；旧单事件格式继续兼容。
  const entries = Array.isArray(parsed.events) ? parsed.events.slice(0, 200) : [parsed];
  for (const entry of entries) {
    const event = entry && typeof entry.event === "string" ? entry.event.slice(0, 120) : "unknown";
    let flowEvent = null;
    if (event === "fast-sync-flow") {
      flowEvent = safeFastSyncFlowData(entry && entry.data, parsed.clientId);
    } else if (event === "ws-transport-selected" || event === "ws-hello-ack") {
      flowEvent = safeConnectionFlowData(entry && entry.data, event, parsed.clientId);
    }
    if (flowEvent) recordFlowEvent(flowEvent);
  }
  if (DEBUG_LOGS) {
    // client-diagnostic 是浏览器侧辅助埋点，正常渲染会大量触发；默认只接收不落盘，排查前端链路时再打开。
    for (const entry of entries) {
      const event = entry && typeof entry.event === "string" ? entry.event.slice(0, 120) : "unknown";
      const data = safeClientLogData(entry && entry.data);
      if (!data.clientId && typeof parsed.clientId === "string") data.clientId = shortId(parsed.clientId);
      diagnosticLog("client-diagnostic", event, data);
    }
  }
  return sendJson(res, 200, { ok: true }, { "cache-control": "no-store" });
}

function installShutdownHandlers(server, localFiles, pickedFiles) {
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    // 退出时先释放短期 token 和待处理的官方内部请求，避免请求一直挂起。
    localFiles.dispose();
    if (pickedFiles && typeof pickedFiles.dispose === "function") pickedFiles.dispose();
    rejectPendingInternalResponses(new Error("gateway shutting down"));
    const exit = () => {
      if (signal) {
        markGatewaySilentQuit(signal);
        app.quit();
      }
    };
    try {
      server.close(exit);
    } catch {
      exit();
    }
    if (signal) {
      // 信号退出时给 Electron 一小段清理时间，避免隐藏窗口阻塞进程结束。
      const forceExitTimer = setTimeout(() => process.exit(0), 1500);
      if (forceExitTimer && typeof forceExitTimer.unref === "function") forceExitTimer.unref();
    }
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  app.once("before-quit", () => shutdown());
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    // http.Server.listen 没有 Promise 版本，封装一次便于 createGateway 按顺序启动。
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(PORT, HOST);
  });
}

function createRequestHandler({ getWsHub = () => null, localFiles, mobileApi, pickedFiles, staticAssets }) {
  /**
   * 路由顺序很关键：
   * 1. 认证和 launcher 探活先处理。
   * 2. 登录页依赖的公开静态资源先放行。
   * 3. SPA shell 可公开返回，真正敏感数据在后续 API/WS 才校验 token。
   * 4. 其余 API、官方 renderer 和本地文件入口必须通过 auth gate。
   */
  return async (req, res) => {
    const url = gatewayUrl(req);
    const pathname = url.pathname;

    // 认证接口必须在通用 auth gate 之前处理，否则首次登录会被拦截。
    if (pathname === "/api/auth/status") return handleAuthStatus(req, res, url);
    if (pathname === "/api/auth/login") return handleAuthLogin(req, res);
    if (pathname === "/api/auth/logout") return handleAuthLogout(req, res, url);
    if (pathname === "/login") return send(res, 302, { location: "/" }, "");
    if (pathname === "/api/launcher/status") {
      // launcher/status 只给桌面壳进程探活，不接受普通浏览器请求。
      if (!isLauncherRequest(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, { "cache-control": "no-store" });
      }
      return sendJson(res, 200, buildGatewayStatus(), { "cache-control": "no-store" });
    }
    if (handleNonCriticalStatsigRequest(req, res, pathname)) return;

    // 公开静态资源先返回，保证登录页和 web-shell polyfill 在未登录时也能加载。
    if (pathname === "/opencodex-plugin-loader.js" && req.method === "GET") {
      // loader 是目录扫描结果，登录页设置面板也依赖它，所以必须在 auth gate 前动态生成。
      return staticAssets.servePluginLoader(res);
    }
    if (pathname === "/api/precache-manifest" && req.method === "GET") {
      // SW install 阶段需要匿名获取资源列表，不能放在 auth gate 后面。
     return sendJson(res, 200, staticAssets.createPrecacheManifest(), { "cache-control": "no-store" });
   }
    if (pathname === "/api/precache-bundle" && req.method === "GET") {
      // SW 一次性下载全部静态资源，避免 1700+ 个 HTTP/2 请求导致带宽利用率过低
      const bundle = staticAssets.createPrecacheBundle(req);
      return send(res, 200, bundle.headers, bundle.body);
    }
    if (staticAssets.isPublicStaticPath(pathname)) {
      const file = staticAssets.staticFile(pathname);
      if (file && exists(file)) return staticAssets.serveFile(req, res, file, 200, pathname);
    }

    if (staticAssets.isAppShellRoute(req, pathname)) {
      // index shell 允许公开返回；后续 renderer 资源、API 和 WS 再走 token 校验。
      // 这么做可以让未登录用户刷新任意前端路由时仍回到登录体验，而不是直接 401 文本页。
      return serveOfficialRendererOrShell(req, res, url, staticAssets);
    }

    // 从这里开始进入受保护区：官方 renderer、IPC API、本地文件和诊断接口都不能匿名访问。
    const requestAuthForRefresh = AUTH_PASSWORD_HASH ? authResultForRequest(req, url) : null;
    if (AUTH_PASSWORD_HASH && !requestAuthForRefresh.authenticated) return sendUnauthorized(req, res);
    const requestAuthRefreshHeaders = authRefreshHeaders(requestAuthForRefresh);
    // 对已登录请求顺手刷新 cookie TTL，浏览器长时间使用时不需要频繁重新登录。
    for (const [name, value] of Object.entries(requestAuthRefreshHeaders)) {
      res.setHeader(name, value);
    }

    if (pathname === "/codex-web-config.js") {
      // 运行时配置必须动态生成，因为端口、workspace roots 和 locale 都来自当前进程环境。
      return send(
        res,
        200,
        {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          ...requestAuthRefreshHeaders,
        },
        await webConfigScript(rendererOptionsForRequest(req, url))
      );
    }

    if (pathname === "/api/health") {
      return sendJson(res, 200, buildGatewayStatus());
    }

    if (pathname === "/api/mobile/bootstrap" && req.method === "GET") {
      // 手机首屏只读裁剪后的快照；完整插件、MCP 和桌面状态留给完整模式按需加载。
      return mobileApi.handleBootstrap(req, res, url);
    }

    if (pathname.startsWith("/api/mobile/thread/") && pathname.endsWith("/events") && req.method === "GET") {
      const rawThreadId = pathname.slice("/api/mobile/thread/".length, -"/events".length);
      const threadId = decodeURIComponent(rawThreadId);
      // SSE 只订阅当前会话文件追加内容，避免手机端挂上完整官方 WS 状态流。
      return mobileApi.handleThreadEvents(req, res, url, threadId);
    }

    if (pathname.startsWith("/api/mobile/thread/") && pathname.endsWith("/turns") && req.method === "POST") {
      const rawThreadId = pathname.slice("/api/mobile/thread/".length, -"/turns".length);
      const threadId = decodeURIComponent(rawThreadId);
      // 手机发送只走一条轻量 turn/start，避免为了提交消息恢复完整官方页面状态。
      return mobileApi.handleThreadTurn(req, res, url, threadId);
    }

    if (pathname.startsWith("/api/mobile/thread/") && req.method === "GET") {
      const threadId = decodeURIComponent(pathname.slice("/api/mobile/thread/".length));
      // 只读取当前会话的轻量消息列表，为后续按会话增量订阅留出边界。
      return mobileApi.handleThread(req, res, url, threadId);
    }

    if (pathname === "/api/diagnostics/flow" && req.method === "GET") {
      // 链路状态只返回阶段、耗时和短 ID，不包含用户消息正文，方便手机端排障时直接查看。
      return sendJson(
        res,
        200,
        snapshotFlowState({
          clientId: url.searchParams.get("clientId") || "",
          limit: url.searchParams.get("limit") || 80,
          threadId: url.searchParams.get("threadId") || "",
        }),
        { "cache-control": "no-store" }
      );
    }

    if (pathname === "/api/diagnostics/threads" && req.method === "GET") {
      const hub = typeof getWsHub === "function" ? getWsHub() : null;
      // 这里暴露的是 app-host 中间层状态摘要，用来定位多客户端同步和补偿刷新问题。
      const snapshot = hub && typeof hub.snapshotThreads === "function"
        ? hub.snapshotThreads({
            limit: url.searchParams.get("limit") || 100,
            threadId: url.searchParams.get("threadId") || "",
          })
        : { ok: true, threads: [] };
      return sendJson(res, 200, snapshot, { "cache-control": "no-store" });
    }

    if (pathname === "/api/fast-sync/snapshot" && req.method === "GET") {
      const method = url.searchParams.get("method") || "";
      const argsJson = url.searchParams.get("args") || "[]";
      if (!isFastSyncSnapshotMethod(method)) {
        return sendJson(res, 400, { ok: false, error: "Method is not fast-sync cacheable" }, { "cache-control": "no-store" });
      }

      const explicitKey = url.searchParams.get("key") || "";
      const threadId = url.searchParams.get("threadId") || "";
      // gap nudge 已经知道写入端生成的快照 key，可以直接按 key 读中间层全量状态，避免弱网下再重建同形 args。
      let key = explicitKey;
      if (!key && !threadId) {
        // args 与官方 IPC 入站参数保持同形，确保浏览器读取和 gateway 写入使用同一个快照 key。
        const parsedArgs = parseFastSyncSnapshotArgsJson(argsJson);
        if (!parsedArgs.ok) {
          return sendJson(res, 400, { ok: false, error: parsedArgs.error }, { "cache-control": "no-store" });
        }
        key = cacheKeyForSnapshot(method, parsedArgs.args);
      }
      // thread/read 和 thread/turns/list 只读 gateway 进程内快照，不落盘也不回退到磁盘缓存。
      const cache = isFastSyncCacheableMethod(method) ? fastSyncCache : memoryFastSyncCache;
      const snapshot = cache.readSnapshot({ key, method, threadId });
      return sendJson(res, 200, { ok: true, snapshot }, { "cache-control": "no-store" });
    }

    if (pathname === "/api/ipc/handlers") {
      // 这个端点主要用于排查官方 bundle 是否注册了预期 IPC handler。
      return sendJson(res, 200, listOfficialIpcChannels(), { "cache-control": "no-store" });
    }

    if (pathname === "/api/token-usage") {
      return handleTokenUsageRequest(req, res, url);
    }

    if (pathname.startsWith("/api/app-fs/@fs/") && req.method === "GET") {
      // 官方 renderer 里的 app://fs 图片会被前端改写到这个 HTTP 入口。
      return localFiles.serveAppFsFile(pathname, res);
    }

    if (pathname.startsWith("/api/local-file/") && req.method === "GET") {
      // 只有官方 openFile 生成的短期 token 可以走这里预览本机文件。
      return localFiles.serveLocalFile(pathname, res);
    }

    if (pathname === "/api/ipc/invoke" && req.method === "POST") {
      return handleIpcInvoke(req, res, localFiles, pickedFiles);
    }

    if (pathname === "/api/client-log" && req.method === "POST") {
      // Web 端启动期诊断日志走独立端点，避免混入官方 IPC 语义或触发额外官方 handler。
      return handleClientLog(req, res);
    }

    if (pathname === "/official-index.patched.html") {
      // 保留这个调试入口，便于单独查看官方 renderer HTML 的注入和 CSP patch 结果。
      const html = staticAssets.createRendererResponse(rendererOptionsForRequest(req, url));
      if (!html) {
        return send(
          res,
          404,
          { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          "Official renderer bundle is not available yet."
        );
      }
      return send(res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, html);
    }

    const file = staticAssets.staticFile(pathname);
    if (file && exists(file)) return staticAssets.serveFile(req, res, file, 200, pathname);

    if (staticAssets.isAppShellRoute(req, pathname)) {
      // 受保护区内再兜底一次 SPA shell，覆盖登录后深链刷新场景。
      return serveOfficialRendererOrShell(req, res, url, staticAssets);
    }

    return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
  };
}

async function handleIpcInvoke(req, res, localFiles, pickedFiles) {
  /**
   * 浏览器把 Electron ipcRenderer.invoke/send 折叠成 HTTP POST。
   * gateway 在这里恢复 channel/args，并伪造 IpcMainEvent 交给官方 handler。
   */
  const body = await readBody(req);
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
  }

  const channel = typeof parsed.channel === "string" ? parsed.channel : "";
  if (!channel) {
    // channel 是官方 IPC 的唯一路由键，缺失时不能继续调用隐藏 runtime。
    return sendJson(res, 400, { ok: false, error: "Invalid IPC channel" });
  }

  const args = ipcArgsFromRequestBody(parsed);
  const payload = payloadFromArgs(args);
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
  const remoteAddress = remoteAddressFromRequest(req);
  const startedAtMs = Date.now();
  const diagnosticBase = {
    ...ipcPayloadSummary(payload),
    argsCount: args.length,
    channel,
    clientId: shortId(clientId),
    remoteAddress,
  };
  const suppressRoutineLog = shouldSuppressRoutineIpcLog(payload);
  // 成功 IPC start/end 会跟随前端渲染频率放大；默认保留慢调用和失败日志，DEBUG 时再展开完整链路。
  if (DEBUG_LOGS && !suppressRoutineLog) diagnosticLog("gateway-ipc", "invoke_start", diagnosticBase);
  try {
    if (channel === "pick-files") {
      // Web 端 pick-files 必须在浏览器侧选文件，再由 gateway 落盘；不能继续转给官方 Electron dialog。
      const value = pickedFiles.handlePickFilesPayload(payload);
      const elapsedMs = Date.now() - startedAtMs;
      if (DEBUG_LOGS && !suppressRoutineLog) {
        diagnosticLog("gateway-ipc", "invoke_end", { ...diagnosticBase, elapsedMs, ok: true });
      }
      return sendJson(res, 200, { ok: true, value });
    }
    // AsyncLocalStorage 让后续官方 webContents.send 能知道这次 HTTP IPC 属于哪个浏览器 client。
    const value = await requestContext.run({ clientId, remoteAddress }, () =>
      invokeOfficialIpc(channel, args, {
        clientId,
        remoteAddress,
        setTitle: () => true,
        openExternal: (urlToOpen) => {
          if (urlToOpen) console.log(`[openExternal] ${urlToOpen}`);
          return true;
        },
        // 官方 openFile 在桌面里会打开系统应用；Web 端改成短期 token 的浏览器预览链接。
        openFile: (filePath) => localFiles.createLocalFilePreview(filePath),
      })
    );
    const elapsedMs = Date.now() - startedAtMs;
    if (DEBUG_LOGS && !suppressRoutineLog) diagnosticLog("gateway-ipc", "invoke_end", { ...diagnosticBase, elapsedMs, ok: true });
    if (DEBUG_LOGS || elapsedMs >= IPC_SLOW_LOG_MS) {
      diagnosticLog("gateway-ipc", "invoke_slow", { ...diagnosticBase, elapsedMs, slowThresholdMs: IPC_SLOW_LOG_MS });
    }
    return sendJson(res, 200, { ok: true, value });
  } catch (error) {
    const elapsedMs = Date.now() - startedAtMs;
    diagnosticWarn("gateway-ipc", "invoke_failed", {
      ...diagnosticBase,
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    });
    const status = error && typeof error.status === "number" ? error.status : 500;
    return sendJson(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createGateway() {
  /**
   * 启动顺序：
   * 1. 准备 reports 目录。
   * 2. 启动官方 hidden runtime 并完成 IPC hook。
   * 3. 创建本地文件服务、静态资源服务和 HTTP server。
   * 4. 把 WebSocket hub 注入 runtime，用于官方异步回包转发。
   */
  ensureDir(REPORTS_DIR);
  // 先启动官方 runtime，确保后续 health/IPC 路由能看到官方 handler 注册状态。
  await startOfficialRuntime();

  const localFiles = createLocalFileService();
  const pickedFiles = createPickedFilesService();
  const staticAssets = createStaticAssetService({ getI18nSnapshot, getOfficialBundle });
  const mobileApi = createMobileApi({
    fastSyncCache,
    invokeTurnStart: (payload) =>
      requestContext.run({ clientId: "mobile-lite", remoteAddress: "mobile-lite" }, () =>
        invokeOfficialIpc("codex_desktop:message-from-view", [payload], {
          clientId: "mobile-lite",
          remoteAddress: "mobile-lite",
          setTitle: () => true,
          openExternal: (urlToOpen) => {
            if (urlToOpen) console.log(`[openExternal] ${urlToOpen}`);
            return true;
          },
          openFile: (filePath) => localFiles.createLocalFilePreview(filePath),
        })
      ),
  });
  let webSocketHub = null;
  const requestHandler = createRequestHandler({ getWsHub: () => webSocketHub, localFiles, mobileApi, pickedFiles, staticAssets });
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      diagnosticError("gateway", "request_failed", {
        error: error instanceof Error ? error.message : String(error),
        method: req.method,
        url: req.url || "",
      });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error.message || error) });
    });
  });

 // 注入 app-host relay 工厂：WS hub 只管理浏览器连接，真正的官方 MessagePort 仍由 official-runtime 创建。

  /**
   * 从 HTTP handleIpcInvoke 中提取的核心调用逻辑，WS 通道复用同一段代码。
   * 省掉了 HTTP body 解析和 res 写回，只保留 channel → invokeOfficialIpc 的核心路径。
   */
  async function invokeIpcCore({ channel, args, clientId, remoteAddress }) {
    if (channel === "pick-files") {
      // pick-files 必须在浏览器侧选文件，再由 gateway 落盘；两条通道共用同一逻辑。
      return pickedFiles.handlePickFilesPayload(payloadFromArgs(args));
    }
    return requestContext.run({ clientId, remoteAddress }, () =>
      invokeOfficialIpc(channel, args, {
        clientId,
        remoteAddress,
        setTitle: () => true,
        openExternal: (urlToOpen) => {
          if (urlToOpen) console.log(`[openExternal] ${urlToOpen}`);
          return true;
        },
        openFile: (filePath) => localFiles.createLocalFilePreview(filePath),
      })
    );
  }

  webSocketHub = createWsHub(server, {
    createAppHostRelay: createOfficialAppHostRelay,
    handleNotificationEvent: handleOfficialNotificationEvent,
    isAuthed,
    invokeIpc: invokeIpcCore,
  });
  // official-runtime 通过这个 hub 把官方 renderer 的异步消息转发给浏览器。
  setWsHub(webSocketHub);
  installShutdownHandlers(server, localFiles, pickedFiles);
  await listen(server);

  diagnosticLog("gateway", "listening", { url: `http://${HOST}:${PORT}` });
  diagnosticLog("gateway", "health_endpoint", { url: `http://${HOST}:${PORT}/api/health` });
  diagnosticLog("gateway", "unknown_ipc_log", { path: path.relative(PROJECT_ROOT, UNKNOWN_IPC_PATH) });

  return { localFiles, server, staticAssets, wsHub: webSocketHub };
}

module.exports = { createGateway, createRequestHandler };
