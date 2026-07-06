const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const {
  PATCHED_OFFICIAL_PREFIX,
  WEB_SHELL_ASSETS_PREFIX,
  WEB_SHELL_DIR,
  exists,
  isWithinRoot,
  mimeType,
  readText,
} = require("../core/config.cjs");
const {
  OPENCODEX_PLUGIN_URL_PREFIX,
  listPluginEntries,
  pluginEntryFileFromRequestPath,
  withPluginI18nMessages,
} = require("../core/plugin-assets.cjs");
const { gzipIfUseful, send } = require("./http-utils.cjs");
const { OPENCODEX_VERSION_LABEL } = require("../../../shared/app-version.cjs");

const OPENCODEX_PLUGIN_LOADER_PATH = "/opencodex-plugin-loader.js";
const OPENCODEX_PLUGIN_SYSTEM_PATH = "/opencodex-plugin-system.js";
const OPENCODEX_FAST_SYNC_PATH = "/opencodex-fast-sync.js";
const OPENCODEX_SNAPSHOT_REPAIR_STATE_PATH = "/snapshot-repair-state.js";
const OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH = "/codex-token-usage-capability.js";
const OPENCODEX_WINDOW_CONTROLS_OVERLAY_CSS_PATH = "/codex-window-controls-overlay.css";
const OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH = "/codex-window-controls-overlay.js";
const CODEX_BRIDGE_POLYFILL_PATH = "/codex-bridge-polyfill.js";
const CODEX_TOOLTIP_DISMISS_GUARD_PATH = "/codex-tooltip-dismiss-guard.js";
const FAVICON_PATH = "/favicon.ico";
const PWA_MANIFEST_PATH = "/manifest.webmanifest";
const WEB_SHELL_ASSETS_DIR = path.join(WEB_SHELL_DIR, "assets");
// 壳页和 renderer 交接时允许短暂携带这些参数，但官方路由启动前必须擦掉，避免污染本地会话深链。
const RENDERER_HANDOFF_CLEANUP_QUERY_PARAMS = [
  "__opencodex_renderer",
  "full",
  "mobile",
  "probe",
  "_probe",
  "_deep",
  "_tail",
];
// 固定 web-shell 资源只在这里登记一次，白名单和文件映射共用同一份配置。
const WEB_SHELL_STATIC_FILES = new Map([
  [FAVICON_PATH, path.join(WEB_SHELL_ASSETS_DIR, "icon.png")],
  [PWA_MANIFEST_PATH, path.join(WEB_SHELL_DIR, "manifest.webmanifest")],
  [OPENCODEX_PLUGIN_SYSTEM_PATH, path.join(WEB_SHELL_DIR, "opencodex-plugin-system.js")],
  [OPENCODEX_FAST_SYNC_PATH, path.join(WEB_SHELL_DIR, "opencodex-fast-sync.js")],
  [OPENCODEX_SNAPSHOT_REPAIR_STATE_PATH, path.join(WEB_SHELL_DIR, "snapshot-repair-state.js")],
  [OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH, path.join(WEB_SHELL_DIR, "codex-token-usage-capability.js")],
  [OPENCODEX_WINDOW_CONTROLS_OVERLAY_CSS_PATH, path.join(WEB_SHELL_DIR, "codex-window-controls-overlay.css")],
  [OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH, path.join(WEB_SHELL_DIR, "codex-window-controls-overlay.js")],
  [CODEX_BRIDGE_POLYFILL_PATH, path.join(WEB_SHELL_DIR, "codex-bridge-polyfill.js")],
  [CODEX_TOOLTIP_DISMISS_GUARD_PATH, path.join(WEB_SHELL_DIR, "codex-tooltip-dismiss-guard.js")],
  ["/sw-cache.js", path.join(WEB_SHELL_DIR, "sw-cache.js")],
]);

// 静态资源层把官方 renderer/web-shell 的路径差异统一隐藏起来，server 只需要按 URL 取文件。
function createStaticAssetService({ getI18nSnapshot, getOfficialBundle }) {
  let hasWarnedHistoryPatchMiss = false;
  let hasWarnedTailHydrationPatchMiss = false;
  let hasWarnedLocalThreadCatalogPatchMiss = false;
  // 旧版本曾经使用 /official-patched/；浏览器缓存的旧 chunk 可能还会懒加载这个前缀。
  const patchedOfficialPrefixes = Array.from(new Set([PATCHED_OFFICIAL_PREFIX, "/official-patched/"]));

  function matchedPatchedOfficialPrefix(reqPath) {
    return patchedOfficialPrefixes.find((prefix) => reqPath.startsWith(prefix)) || "";
  }

  function patchedOfficialRelPath(reqPath) {
    const prefix = matchedPatchedOfficialPrefix(reqPath);
    return prefix ? reqPath.slice(prefix.length) : "";
  }

  function patchedOfficialAssetName(reqPath) {
    const prefix = matchedPatchedOfficialPrefix(reqPath);
    if (!prefix) return "";
    const assetPrefix = `${prefix}assets/`;
    return reqPath.startsWith(assetPrefix) ? reqPath.slice(assetPrefix.length) : "";
  }

  function isCurrentPatchedOfficialAsset(reqPath) {
    return reqPath.startsWith(`${PATCHED_OFFICIAL_PREFIX}assets/`);
  }

  function webShellStaticVersion(reqPath) {
    const file = WEB_SHELL_STATIC_FILES.get(reqPath);
    if (!file) return OPENCODEX_VERSION_LABEL;
    try {
      // 开发和手机端刷新时用文件 mtime 做版本号，避免旧 Service Worker/浏览器缓存继续执行过期 bridge。
      return String(Math.floor(fs.statSync(file).mtimeMs));
    } catch {
      return OPENCODEX_VERSION_LABEL;
    }
  }

  /** 给官方 renderer HTML 注入 web-shell polyfill 和运行时配置。 */
  function transformOfficialHtml(rawHtml, options = {}) {
    /**
     * 官方 index.html 原本跑在 Electron app:///file 环境。
     * 浏览器环境需要额外注入：
     * - base href，把官方相对资源定位到 /official/。
     * - codex-web-config.js，提供端口、workspace roots 等运行时信息。
     * - opencodex-plugin-system.js，提供插件 host。
     * - opencodex-plugin-loader.js，按目录扫描结果加载插件脚本。
     * - manifest/移动 Web App 元数据，允许入口安装为独立窗口壳。
     * - bridge polyfill，把 Electron API 转成 HTTP/WS 调用。
     */
    let html = rawHtml;
    // 官方 HTML 是 Electron renderer 用的，浏览器里需要补 locale、移动端 viewport 和站点图标。
    html = patchHtmlLang(html, currentI18n().locale);
    html = html.replace(
      /<meta([^>]*\bname=["']viewport["'][^>]*)>/i,
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />'
    );
    const iconLinks = [
      '<link rel="icon" type="image/png" href="/assets/icon.png" />',
      '<link rel="apple-touch-icon" href="/assets/icon.png" />',
    ].join("\n    ");
    if (!/<link[^>]+\brel=["'][^"']*icon/i.test(html)) {
      html = html.replace(/<title>/i, `${iconLinks}\n    <title>`);
    }
    // 官方产物里的相对路径统一映射到 /official/，避免和 web-shell 自己的 /assets 冲突。
    html = html.replace(/(src|href)=["']\/(?!(?:official|assets)\/)([^"'#?]+)["']/g, '$1="/official/$2"');
    html = html.replace(/(src|href)=["']\.\/([^"'#?]+)["']/g, '$1="/official/$2"');
    const initialRoute = typeof options.initialRoute === "string" ? options.initialRoute.trim() : "";
    const base = [
      '<base href="/official/">',
      initialRoute ? `<meta name="initial-route" content="${escapeHtml(initialRoute)}">` : "",
      createRendererHandoffCleanupScript(),
      createEarlyTelemetryPatchScript(),
      `<link rel="manifest" href="${PWA_MANIFEST_PATH}">`,
      '<meta name="theme-color" content="#ffffff">',
      '<meta name="application-name" content="OpenCodex">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-title" content="OpenCodex">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
      `<link id="codex-web-window-controls-overlay-styles" rel="stylesheet" href="${OPENCODEX_WINDOW_CONTROLS_OVERLAY_CSS_PATH}">`,
      '<script src="/codex-web-config.js"></script>',
      // mobile=1 是桌面调试手机链路的入口参数；cleanup 擦掉 query 后仍要把瘦身标志留给 bridge。
      options.mobileTrafficMode === true
        ? '<script>window.__OPENCODEX_MOBILE_TRAFFIC_MODE__=true;window.__CODEX_WEB_CONFIG__=Object.assign({},window.__CODEX_WEB_CONFIG__||{},{mobileTrafficMode:true});</script>'
        : "",
      `<script src="${OPENCODEX_PLUGIN_SYSTEM_PATH}"></script>`,
      options.mobileTrafficMode === true
        ? "<!-- OpenCodex 手机流量模式跳过插件 loader，减少首屏脚本和后台状态请求。 -->"
        : createDeferredPluginLoaderScript(),
      options.mobileTrafficMode === true
        ? "<!-- OpenCodex 手机流量模式跳过 token usage capability，避免进会话后逐条补统计阻塞渲染。 -->"
        : `<script src="${OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH}"></script>`,
      `<script src="${OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH}"></script>`,
      // fast-sync store 必须早于 bridge polyfill 初始化，后续 polyfill 才能首屏读取本地快照。
      `<script src="${OPENCODEX_FAST_SYNC_PATH}?v=${webShellStaticVersion(OPENCODEX_FAST_SYNC_PATH)}"></script>`,
      `<script src="${OPENCODEX_SNAPSHOT_REPAIR_STATE_PATH}?v=${webShellStaticVersion(OPENCODEX_SNAPSHOT_REPAIR_STATE_PATH)}"></script>`,
      `<script src="${CODEX_BRIDGE_POLYFILL_PATH}?v=${webShellStaticVersion(CODEX_BRIDGE_POLYFILL_PATH)}"></script>`,
      `<script src="${CODEX_TOOLTIP_DISMISS_GUARD_PATH}"></script>`,
    ].join("\n    ");
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${base}`);
    }
    return patchOfficialHtmlForWeb(html);
  }

  function createRendererHandoffCleanupScript() {
    const params = JSON.stringify(RENDERER_HANDOFF_CLEANUP_QUERY_PARAMS);
    return `<script>(function(){try{var u=new URL(location.href),p=${params},changed=false;for(var i=0;i<p.length;i++){if(u.searchParams.has(p[i])){u.searchParams.delete(p[i]);changed=true}}if(changed){history.replaceState(history.state,"",u.pathname+u.search+u.hash)}}catch(e){}})();</script>`;
  }

  function createDeferredPluginLoaderScript() {
    // 插件是增强能力，不应阻塞官方 renderer 首屏和本地会话恢复；等 load/idle 后再加载，注册后仍会被插件系统立即激活。
    return `<script>(function(){try{var w=window;if(w.__opencodexDeferredPluginLoaderInstalled)return;w.__opencodexDeferredPluginLoaderInstalled=true;function load(){try{if(w.__opencodexPluginLoaderLoaded)return;w.__opencodexPluginLoaderLoaded=true;var s=document.createElement("script");s.src="${OPENCODEX_PLUGIN_LOADER_PATH}";s.async=false;(document.head||document.documentElement).appendChild(s)}catch(e){console.warn("[opencodex-plugin] deferred loader failed",e)}}function schedule(){if("requestIdleCallback"in w)w.requestIdleCallback(load,{timeout:2500});else w.setTimeout(load,1200)}if(document.readyState==="complete")schedule();else w.addEventListener("load",schedule,{once:true})}catch(e){}})();</script>`;
  }

  function createEarlyTelemetryPatchScript() {
    // 官方 Statsig/Segment SDK 可能在 bridge 大文件跑完前抓住 fetch；最早期就短路纯遥测，避免弱网 10s timeout 卡首屏。
    const initializeBody = JSON.stringify({
      has_updates: true,
      time: Date.now(),
      hash_used: "djb2",
      feature_gates: {
        // tail hydration 依赖缺失的 resume.initialTurnsPage，Web 桥下必须关闭。
        "4261455886": { name: "4261455886", value: false, rule_id: "gateway_override", secondary_exposures: [] },
        // local thread resume gate 必须打开，否则深链只显示标题和输入框。
        "567837310": { name: "567837310", value: true, rule_id: "gateway_override", secondary_exposures: [] },
      },
      dynamic_configs: {},
      layer_configs: {
        "72216192": {
          name: "72216192",
          value: { enable_i18n: true, locale_source: "IDE" },
          rule_id: "gateway_override",
          secondary_exposures: [],
        },
      },
      param_stores: {},
      exposures: {},
      sdk_flags: {},
    });
    return `<script>(function(){try{var w=window;if(w.__opencodexEarlyTelemetryPatched)return;w.__opencodexEarlyTelemetryPatched=true;var init=${initializeBody};function b(v){try{var p=new URL(v,location.href),x=p.pathname.replace(/\\/+$/,""),h=p.hostname;if(h==="api.segment.io"&&x.indexOf("/v1/")===0)return{};if((h==="ab.chatgpt.com"||h==="featureassets.org")&&x==="/v1/initialize")return init;if((h==="chatgpt.com"&&x.indexOf("/ces/v1/")===0)||(h==="ab.chatgpt.com"&&x.indexOf("/v1/")===0)||(h==="statsigapi.net"&&x.indexOf("/v1/")===0)||(h==="prodregistryv2.org"&&x.indexOf("/v1/")===0)||(h==="featureassets.org"&&x.indexOf("/v1/")===0)||(h==="api.statsigcdn.com"&&x.indexOf("/v1/")===0))return{}}catch(e){}return null}function h(){return{"content-type":"application/json; charset=utf-8"}}function j(v){return JSON.stringify(v&&typeof v==="object"?v:{})}if(typeof w.fetch==="function"&&!w.__opencodexEarlyFetchTelemetryPatched){var f=w.fetch.bind(w);w.fetch=function(i,n){var v=typeof i==="string"?i:i&&typeof i==="object"&&"url"in i?String(i.url||""):"",r=b(v);if(r!==null)return Promise.resolve(new Response(j(r),{status:200,headers:h()}));return f(i,n)};w.__opencodexEarlyFetchTelemetryPatched=true}if(typeof navigator==="object"&&typeof navigator.sendBeacon==="function"&&!w.__opencodexEarlyBeaconTelemetryPatched){var B=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){if(b(String(u||""))!==null)return true;return B(u,d)};w.__opencodexEarlyBeaconTelemetryPatched=true}if(typeof w.XMLHttpRequest==="function"&&!w.__opencodexEarlyXhrTelemetryPatched){var X=w.XMLHttpRequest;w.XMLHttpRequest=function(){var r=new X,t=null,o=r.open,s=r.send;r.open=function(m,v){t=b(String(v||""));if(t!==null)return;return o.apply(r,arguments)};r.send=function(){if(t===null)return s.apply(r,arguments);setTimeout(function(){var v=j(t);try{Object.defineProperty(r,"readyState",{configurable:true,value:4});Object.defineProperty(r,"status",{configurable:true,value:200});Object.defineProperty(r,"responseText",{configurable:true,value:v});Object.defineProperty(r,"response",{configurable:true,value:v})}catch(e){}try{if(typeof r.onreadystatechange==="function")r.onreadystatechange(new Event("readystatechange"));r.dispatchEvent(new Event("readystatechange"));if(typeof r.onload==="function")r.onload(new Event("load"));r.dispatchEvent(new Event("load"));if(typeof r.onloadend==="function")r.onloadend(new Event("loadend"));r.dispatchEvent(new Event("loadend"))}catch(e){}},0)};return r};w.XMLHttpRequest.prototype=X.prototype;w.__opencodexEarlyXhrTelemetryPatched=true}}catch(e){}})();</script>`;
  }

  /** 给少量运行时 patch 过的官方 chunk 换路径命名空间，绕开浏览器 immutable 缓存。 */
  function patchOfficialAssetUrls(rawHtml) {
    // 只给 JS 资源改到 patched 命名空间，CSS/图片无需响应期 patch，继续走官方 immutable 缓存。
    return rawHtml.replace(
      /((?:src|href)=["']\/official\/assets\/[^"'?#]+\.js)(["'])/g,
      (_match, prefix, quote) => `${prefix.replace("/official/assets/", `${PATCHED_OFFICIAL_PREFIX}assets/`)}${quote}`
    );
  }

  /** desktop HTML 的 CSP 会拦截浏览器里部分依赖的 Function/eval 探测，需要在 gateway 层放开；同时补上 manifest-src 让 PWA 安装正常工作。 */
  function patchOfficialCspForWeb(rawHtml) {
    let html = rawHtml;
    // 补充 manifest-src 'self'，避免 default-src 'none' 拦截 manifest.webmanifest
    if (!html.includes("manifest-src")) {
      html = html.replace(
        /(Content-Security-Policy"\s+content=")/,
        "$1manifest-src 'self'; "
      );
    }
    // 放开 unsafe-eval，官方 renderer 依赖 Function/eval 探测
    if (!html.includes("&#39;unsafe-eval&#39;") && !html.includes("'unsafe-eval'")) {
      html = html
        .replace("&#39;wasm-unsafe-eval&#39;", "&#39;wasm-unsafe-eval&#39; &#39;unsafe-eval&#39;")
        .replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'");
    }
    // ab.chatgpt.com 只承载 Statsig/遥测；弱网下直连会卡 10s，CSP 层直接禁掉，fetch/XHR patch 仍做本地空响应兜底。
    html = html.replace(/\s+https:\/\/ab\.chatgpt\.com(?=[\s;])/g, "");
    return html;
  }

  function patchOfficialHtmlForWeb(rawHtml) {
    let html = patchOfficialCspForWeb(patchOfficialAssetUrls(rawHtml));
    // 注入 modulepreload 提示：仅预加载入口 chunk，避免洪泛 HTTP/2 连接
    // nginx proxy_cache 保证这些资源从服务器缓存秒回，浏览器 Cache-Control 保证二次访问命中
    // 入口 chunk 带 hash，不能写死文件名（官方 bundle 升级后 hash 会变导致 404 白屏），
    // 只能按构建稳定前缀在当前缓存中查找真实存在的文件。
    const preloadHints = ["app-main-", "app-shell-", "index-", "modulepreload-polyfill-", "preload-helper-"]
      .map(locateOfficialScriptAssetHref)
      .filter(Boolean)
      .map((href) => `<link rel="modulepreload" href="${href}">`)
      .join("\n    ");
    if (preloadHints) {
      html = html.replace("</head>", `    ${preloadHints}\n  </head>`);
    }
    return html;
  }

  function locateOfficialIndex() {
    // getOfficialBundle 由 runtime 层提供，便于资源层保持无状态并支持后续热替换缓存。
    const officialBundle = getOfficialBundle();
    if (!officialBundle || !officialBundle.webviewDir) return null;
    const srcIndex = path.join(officialBundle.webviewDir, "index.html");
    if (exists(srcIndex)) return { kind: "source", file: srcIndex };
    return null;
  }

  function locateOfficialAsset(filePath) {
    const officialBundle = getOfficialBundle();
    if (!officialBundle || !officialBundle.webviewDir) return null;
    const candidate = path.normalize(path.join(officialBundle.webviewDir, filePath));
    if (!exists(candidate)) return null;
    // URL path 必须落在官方 webview 根目录内，防止 /official/../../ 读取任意文件。
    return isWithinRoot(candidate, officialBundle.webviewDir) ? candidate : null;
  }

  function locateOfficialStyleAssetHref(prefix) {
    // 官方 CSS 带 hash，不能写死文件名，只能按构建稳定前缀查找当前缓存中的实际文件。
    const officialBundle = getOfficialBundle();
    if (!officialBundle || !officialBundle.webviewDir) return null;
    const assetsDir = path.join(officialBundle.webviewDir, "assets");
    if (!exists(assetsDir)) return null;
    const fileName = fs
      .readdirSync(assetsDir)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".css"))
      .sort()[0];
    return fileName ? `/official/assets/${fileName}` : null;
  }

  function locateOfficialScriptAssetHref(prefix) {
    // 官方入口 JS 带 hash，bundle 升级后文件名会变；按稳定前缀查找当前缓存中的真实文件，
    // 并走 patched 命名空间（与 patchOfficialAssetUrls 对 JS 的改写保持一致）。
    const officialBundle = getOfficialBundle();
    if (!officialBundle || !officialBundle.webviewDir) return null;
    const assetsDir = path.join(officialBundle.webviewDir, "assets");
    if (!exists(assetsDir)) return null;
    const fileName = fs
      .readdirSync(assetsDir)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js"))
      .sort()[0];
    return fileName ? `${PATCHED_OFFICIAL_PREFIX}assets/${fileName}` : null;
  }

  function officialStyleLinks() {
    return ["app-main-", "app-shell-"]
      .map(locateOfficialStyleAssetHref)
      .filter(Boolean)
      .map((href) => `<link rel="stylesheet" href="${href}" data-codex-official-style />`)
      .join("\n    ");
  }

  function currentI18n() {
    // web-shell 登录页在未认证时也需要知道语言；这里消费 runtime 注入的系统语言快照。
    const snapshot = typeof getI18nSnapshot === "function" ? getI18nSnapshot() : { locale: "en-US", messages: {} };
    return withPluginI18nMessages(snapshot);
  }

  function patchHtmlLang(rawHtml, locale) {
    let html = rawHtml.replace(/<html([^>]*)\blang=["'][^"']*["']([^>]*)>/i, `<html$1lang="${locale}"$2>`);
    if (!/<html[^>]*\blang=/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, `<html$1 lang="${locale}">`);
    }
    return html;
  }

  function webShellBootstrapScript(i18n, options = {}) {
    const publicConfig = {
      locale: i18n.locale,
      localeSource: i18n.source || "",
      localeMode: i18n.mode || "",
      messages: i18n.messages,
    };
    if (typeof options.initialRoute === "string" && options.initialRoute.trim()) {
      // 官方 renderer 和 bridge 共用同一份深链信息，防止刷新 /local/:id 时首屏回到 home。
      publicConfig.initialRoute = options.initialRoute.trim();
    }
    if (options.mobileTrafficMode === true) {
      // 手机流量模式仍保留官方界面，只在前端运行时裁剪插件、预缓存和非关键状态。
      publicConfig.mobileTrafficMode = true;
    }
    return `<script>window.__CODEX_WEB_CONFIG__=Object.assign(window.__CODEX_WEB_CONFIG__||{},${JSON.stringify(publicConfig)});</script>`;
  }

  function escapeHtml(value) {
    // 版本号来自同步脚本生成的静态文件，这里仍做 HTML 转义，避免未来格式扩展时污染登录页。
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function patchWebShellAppVersion(rawHtml) {
    // 认证入口必须展示 OpenCodex 自身版本，不能使用官方 Codex runtime 的版本。
    return rawHtml.replace(
      /(<span\b[^>]*\bdata-opencodex-version\b[^>]*>)([\s\S]*?)(<\/span>)/i,
      (_match, start, _content, end) => `${start}${escapeHtml(OPENCODEX_VERSION_LABEL)}${end}`
    );
  }

  function createPluginLoaderScript() {
    const pluginUrls = listPluginEntries().map(
      (entry) => `${OPENCODEX_PLUGIN_URL_PREFIX}${entry.urlPath}?v=${entry.version}`
    );
    return `(() => {
  const pluginUrls = ${JSON.stringify(pluginUrls)};
  // loader 由 gateway 生成；刷新页面即可重新扫描 web-shell/plugins 下的插件目录。
  function loadPlugin(url) {
    // 插件入口可能在 shell -> 官方 renderer 交接时运行，不能用同步写文档的方式破坏当前页面。
    const script = document.createElement("script");
    script.src = url;
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
  }
  for (const url of pluginUrls) loadPlugin(url);
})();\n`;
  }

  function createWebShellIndexResponse(options = {}) {
    const shell = path.join(WEB_SHELL_DIR, "index.html");
    const i18n = currentI18n();
    let html = patchWebShellAppVersion(patchHtmlLang(readText(shell), i18n.locale));
    const links = officialStyleLinks();
    if (links) {
      // web-shell 自己负责承载 UI，注入官方样式后视觉表现和桌面 renderer 保持一致。
      if (html.includes("<!-- codex-official-styles -->")) {
        html = html.replace("<!-- codex-official-styles -->", links);
      } else {
        html = html.replace(/<\/head>/i, `${links}\n  </head>`);
      }
    }
    const bootstrap = webShellBootstrapScript(i18n, options);
    if (html.includes("<!-- opencodex-runtime-config -->")) {
      html = html.replace("<!-- opencodex-runtime-config -->", bootstrap);
    } else {
      html = html.replace(/<\/head>/i, `    ${bootstrap}\n  </head>`);
    }
    return html;
  }

  function isPublicStaticPath(reqPath) {
    // 登录前必须可访问的资源限定在入口依赖和官方静态 asset，不包含任何 API。
    if (WEB_SHELL_STATIC_FILES.has(reqPath) || reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return true;
    if (reqPath === OPENCODEX_PLUGIN_LOADER_PATH) return true;
    if (matchedPatchedOfficialPrefix(reqPath)) return true;
    if (reqPath.startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) return true;
    return reqPath.startsWith("/official/");
  }

  function createRendererResponse(options = {}) {
    // 认证通过后直接返回官方 renderer，避免客户端 document.write 在浏览器里清空 body 后失败造成白屏。
    const located = locateOfficialIndex();
    if (!located) return null;
    const html = readText(located.file);
    return transformOfficialHtml(html, options);
  }

  /** 判断是否应该回退到 SPA shell；刷新 /local/:id 这类官方前端路由时不能返回 404。 */
  function isAppShellRoute(req, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (pathname.startsWith("/api/") || pathname === "/ws") return false;
    if (pathname === "/" || pathname === "") return true;
    if (path.extname(pathname)) return false;
    const accept = String(req.headers.accept || "");
    return !accept || accept.includes("text/html") || accept.includes("*/*");
  }

  /** 所有响应期 patch 过的官方 JS 统一从独立路径命名空间加载，避免和官方 immutable 缓存混用。 */
  function shouldPatchOfficialAsset(reqPath) {
    const rel = patchedOfficialAssetName(reqPath);
    if (!rel) return false;
    // 只 patch 当前官方 assets 目录下的 JS chunk，避免路径拼接穿透到子目录或非脚本资源。
    return rel.endsWith(".js") && !rel.includes("/");
  }

  /** 恢复历史 turn 时旧 renderer 转换漏了 firstTurnWorkItemStartedAtMs，导致折叠摘要退回“上 x 条消息”。 */
  function patchAppServerManagerSignalsChunk(source) {
    /**
     * 这是针对官方 chunk 的最小文本 patch：
     * 只修复历史 turn 缺少 firstTurnWorkItemStartedAtMs 的字段映射，不落盘修改官方缓存。
     */
    const alreadyPatched =
      /turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),durationMs:\2\.durationMs,firstTurnWorkItemStartedAtMs:\1\(\2\.firstTurnWorkItemStartedAt\?\?\2\.startedAt\),finalAssistantStartedAtMs:\1\(\2\.completedAt\)/;
    if (alreadyPatched.test(source)) return source;
    const historyTurnShape =
      /(turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),durationMs:\3\.durationMs,)(finalAssistantStartedAtMs:\2\(\3\.completedAt\),status:\3\.status)/;
    if (!historyTurnShape.test(source)) {
      if (!hasWarnedHistoryPatchMiss) {
        hasWarnedHistoryPatchMiss = true;
        console.warn("[gateway] app-server-manager history patch skipped: current bundle shape did not match");
      }
      return source;
    }
    return source.replace(historyTurnShape, (_match, prefix, secondsToMs, turnVar, suffix) =>
      `${prefix}firstTurnWorkItemStartedAtMs:${secondsToMs}(${turnVar}.firstTurnWorkItemStartedAt??${turnVar}.startedAt),${suffix}`
    );
  }

  /** 官方 tail hydration 实验会让首屏历史依赖 resume.initialTurnsPage；Web 桥下该字段缺失时会空屏到用户发消息。 */
  function patchTailHydrationGate(source) {
    if (!source.includes("4261455886")) return source;
    const tailHydrationGate =
      /[A-Za-z_$][\w$]*\?\.get\([A-Za-z_$][\w$]*\)\?\.checkGate\((["'`])4261455886\1\)\?\?!1/g;
    if (!tailHydrationGate.test(source)) {
      if (!hasWarnedTailHydrationPatchMiss) {
        hasWarnedTailHydrationPatchMiss = true;
        console.warn("[gateway] tail hydration gate patch skipped: current bundle shape did not match");
      }
      return source;
    }
    return source.replace(tailHydrationGate, "false");
  }

  /** 官方本地会话恢复 gate 必须开启，否则 /local/:id 不会挂载 resume 组件，也就不会发 thread/read。 */
  function patchLocalThreadResumeGate(source) {
    if (!source.includes("567837310")) return source;
    // Statsig bootstrap 在不同官方版本里可能走不同 IPC/内联路径；这里在响应期直接钉住恢复 gate。
    return source.replace(/\b[A-Za-z_$][\w$]*\((["'`])567837310\1\)/g, "true");
  }

  /** 官方本地会话页从 Electron preload 对象读取目录服务；浏览器桥需要回退到 window 上的 polyfill。 */
  function patchLocalThreadCatalogBridgeFallback(source) {
    if (!source.includes("localThreadCatalog")) return source;
    if (source.includes("window.electronBridge?.localThreadCatalog")) return source;
    // 负向后行断言排除前置标识符/成员访问字符，确保完整捕获压缩后的对象名（如 `$n`）。
    // 旧写法用 `\b` 前缀会把 `$n.localThreadCatalog` 误拆成 `n`，替换后得到 `$(n...)`，
    // 令官方 `$n` 变成函数调用，抛 `$ is not a function` 并崩到错误边界（白屏 Oops）。
    const localThreadCatalogAccess = /(?<![\w$.?])([A-Za-z_$][\w$]*)\.localThreadCatalog\b/g;
    if (!localThreadCatalogAccess.test(source)) {
      if (!hasWarnedLocalThreadCatalogPatchMiss) {
        hasWarnedLocalThreadCatalogPatchMiss = true;
        console.warn("[gateway] local thread catalog bridge patch skipped: current bundle shape did not match");
      }
      return source;
    }
    return source.replace(
      localThreadCatalogAccess,
      (_match, objectName) =>
        `(${objectName}.localThreadCatalog??window.electronBridge?.localThreadCatalog??window.codexBridge?.localThreadCatalog??window.electronAPI?.localThreadCatalog)`
    );
  }

  function localConversationResumeOnceExpression(conversationIdName = "e") {
    // 这个表达式会被注入官方 renderer 主世界；不能依赖 Web preload/polyfill 的全局函数跨上下文可见。
    return `${conversationIdName}!=null&&!((window.__opencodexLocalResumeOnce||(window.__opencodexLocalResumeOnce=new Set)).has(${conversationIdName}))&&!!window.__opencodexLocalResumeOnce.add(${conversationIdName})`;
  }

  /** 官方目录状态在 Web 桥下可能缺少 needs-resume 标记；本地会话页必须先触发 resume 才会拉正文。 */
  function patchLocalConversationResumeTrigger(source) {
    if (!source.includes("maybe-resume-conversation")) return source;
    const marker = "function yS(e){let t=ht(oe),n=xr(),{activeMode:i}=Ua(e),{data:a}=k(Bn),o=a?.roots,c=Y(In,e);Y(s,e);";
    let patched = source;
    if (source.includes(marker)) {
      patched = patched.replace(
        marker,
        `function yS(e){let t=ht(oe),n=xr(),{activeMode:i}=Ua(e),{data:a}=k(Bn),o=a?.roots,c=(${localConversationResumeOnceExpression("e")});Y(s,e);`
      );
    } else {
      if (!source.includes("localConversation.loadingThread")) return source;
      const localConversationResumeState =
        /(function\s+yS\(e\)\{let\s+[A-Za-z_$][\w$]*=[^;]+,\s*[A-Za-z_$][\w$]*=[^;]+,\{activeMode:[A-Za-z_$][\w$]*\}=[^,]+,\{data:[A-Za-z_$][\w$]*\}=[^,]+,\s*[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\?\.roots,\s*([A-Za-z_$][\w$]*)=)K\([A-Za-z_$][\w$]*,e\)(;K\([A-Za-z_$][\w$]*,e\);)/;
      if (!localConversationResumeState.test(patched)) {
        console.warn("[gateway] local conversation resume loader patch skipped: current bundle shape did not match");
        return source;
      }
      patched = patched.replace(
        localConversationResumeState,
        `$1(${localConversationResumeOnceExpression("e")})$3`
      );
    }
    // 本地会话恢复只需要 conversationId/hostId/workspaceRoots；省略 serviceTier，避免慢网预取阻塞或 null 被新版 app-server 判成非法请求。
    patched = patched.replace(/,serviceTier:await [A-Za-z_$][\w$]*\([^)]*\?\.settings\.model\?\?null\)/g, "");
    return patched;
  }

  /** 官方 LocalThreadCatalogProvider 默认延迟 5 秒启动；Web 侧已预热目录，响应期把固定等待压掉。 */
  function patchLocalThreadCatalogStartupDelay(source) {
    if (!source.includes("localThreadCatalog") || !source.includes("requestStartupSync") || !source.includes("LU=5e3")) {
      return source;
    }
    return source.replace(/\bLU=5e3\b/g, "LU=0");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function endpointExpression(quote, pathSuffix, base) {
    if (quote === "`") {
      return base === "host" ? "`${location.host}" + pathSuffix + "`" : "`${location.origin}" + pathSuffix + "`";
    }
    return base === "host"
      ? `(location.host+${JSON.stringify(pathSuffix)})`
      : `(location.origin+${JSON.stringify(pathSuffix)})`;
  }

  function replaceEndpointStringLiterals(source, endpoint, replacementPath, base) {
    const pattern = new RegExp(`(["'\`])${escapeRegExp(endpoint)}([^"'\\\`]*?)\\1`, "g");
    return source.replace(pattern, (_match, quote, suffix) => endpointExpression(quote, `${replacementPath}${suffix || ""}`, base));
  }

  /** 官方 Statsig/遥测外链在弱网会拖慢首屏；响应期改到同源 no-op 路由，避免等待外网超时。 */
  function patchStatsigNetworkEndpoints(source) {
    if (
      !/https:\/\/(?:ab\.chatgpt\.com|chatgpt\.com\/ces|statsigapi\.net|prodregistryv2\.org|featureassets\.org|api\.statsigcdn\.com|api\.segment\.io)|api\.segment\.io\/v1/.test(
        source
      )
    ) {
      return source;
    }
    // 官方代码会对部分 endpoint 执行 new URL(endpoint)，因此不能改成相对路径；普通字符串字面量要改成表达式。
    let patched = source
      .replace(/([A-Za-z_$][\w$]*)=`\$\{this\.protocol\}:\/\/\$\{this\.host\}\/m`/g, "$1=`${location.origin}/api/noncritical/statsig/segment/v1/m`");
    patched = replaceEndpointStringLiterals(patched, "https://ab.chatgpt.com", "/api/noncritical/statsig", "origin");
    patched = replaceEndpointStringLiterals(patched, "https://chatgpt.com/ces", "/api/noncritical/statsig/ces", "origin");
    patched = replaceEndpointStringLiterals(patched, "https://statsigapi.net", "/api/noncritical/statsig/statsigapi", "origin");
    // Statsig v3 默认域名会在不同官方构建间切换；统一收敛到本地非关键 no-op，弱网下不再等外链超时。
    patched = replaceEndpointStringLiterals(patched, "https://prodregistryv2.org", "/api/noncritical/statsig", "origin");
    patched = replaceEndpointStringLiterals(patched, "https://featureassets.org", "/api/noncritical/statsig", "origin");
    patched = replaceEndpointStringLiterals(patched, "https://api.statsigcdn.com", "/api/noncritical/statsig", "origin");
    patched = replaceEndpointStringLiterals(patched, "https://api.segment.io", "/api/noncritical/statsig/segment", "origin");
    patched = replaceEndpointStringLiterals(patched, "api.segment.io/v1", "/api/noncritical/statsig/segment/v1", "host");
    return patched;
  }

  /** 对官方 chunk 做响应期 patch，不落盘改 vendor/官方构建产物。 */
  function patchOfficialAsset(reqPath, data) {
    if (!shouldPatchOfficialAsset(reqPath)) return data;
    const source = data.toString("utf-8");
    const statsigPatched = patchStatsigNetworkEndpoints(source);
    const historyPatched = /\/app-server-manager-signals-[^/]+\.js$/.test(reqPath)
      ? patchAppServerManagerSignalsChunk(statsigPatched)
      : statsigPatched;
    const tailPatched = patchTailHydrationGate(historyPatched);
    const resumePatched = patchLocalThreadResumeGate(tailPatched);
    const catalogPatched = patchLocalThreadCatalogBridgeFallback(resumePatched);
    const catalogDelayPatched = patchLocalThreadCatalogStartupDelay(catalogPatched);
    const patched = patchLocalConversationResumeTrigger(catalogDelayPatched);
    return Buffer.from(patched, "utf-8");
  }

  /** 将 URL path 映射到 web-shell 或官方 asset 的真实文件。 */
  function staticFile(reqPath) {
    // 路径映射只接受固定前缀；不能把任意 URL path 直接拼到项目根目录。
    const fixedWebShellFile = WEB_SHELL_STATIC_FILES.get(reqPath);
    if (fixedWebShellFile) return fixedWebShellFile;
    if (reqPath.startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) {
      return pluginEntryFileFromRequestPath(reqPath);
    }
    if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) {
      const rel = reqPath.slice(WEB_SHELL_ASSETS_PREFIX.length);
      const candidate = rel ? path.normalize(path.join(WEB_SHELL_ASSETS_DIR, rel)) : "";
      // assets 目录也用真实路径校验，和官方资源分支保持同一套边界模型。
      if (candidate && isWithinRoot(candidate, WEB_SHELL_ASSETS_DIR)) return candidate;
    }
    if (matchedPatchedOfficialPrefix(reqPath)) {
      const rel = patchedOfficialRelPath(reqPath);
      return locateOfficialAsset(rel);
    }
    if (reqPath.startsWith("/official/")) {
      const rel = reqPath.slice("/official/".length);
      return locateOfficialAsset(rel);
    }
    return null;
  }

  /** 静态资源缓存策略：hash asset 长缓存，入口 HTML/no-store 保持可更新。 */
  function cacheControlForRequestPath(reqPath) {
    if (process.env.CODEX_WEB_DISABLE_ASSET_CACHE === "1") return "no-store";
    const patchedAssetName = patchedOfficialAssetName(reqPath);
    if (patchedAssetName) {
      if (isCurrentPatchedOfficialAsset(reqPath)) {
        // 当前 patched 前缀本身包含 OpenCodex 响应期 patch 版本；官方文件名也带 hash。
        // 允许手机浏览器长缓存，避免弱网下每次刷新都重新下载几十个 chunk。
        return "public, max-age=31536000, immutable";
      }
      // patched chunk 的内容由 gateway 响应期生成，旧前缀也必须 no-store，避免跨版本继续吃旧模块图。
      return "no-store";
    }
    if (reqPath.startsWith("/official/assets/")) return "public, max-age=31536000, immutable";
    if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return "public, max-age=86400";
    if (reqPath.startsWith("/official/")) return "public, max-age=3600";
    if (reqPath === CODEX_BRIDGE_POLYFILL_PATH) {
      // 手机远程访问链路吞吐低，no-cache + ETag 可在刷新时复用本地副本，同时仍能在文件变化后重新拉取。
      return "no-cache";
    }
    return "no-store";
  }

  function etagForResponseBody(body) {
    return `W/"${crypto.createHash("sha256").update(body).digest("base64url")}"`;
  }

  /** 发送静态文件，并按路径套用合适的缓存策略。 */
  function serveFile(req, res, file, status = 200, reqPath = "") {
    const data = patchOfficialAsset(reqPath, fs.readFileSync(file));
    const response = gzipIfUseful(
      req,
      { "content-type": mimeType(file), "cache-control": cacheControlForRequestPath(reqPath) },
      data
    );
    const etag = etagForResponseBody(response.body);
    const headers = { ...response.headers, etag };
    if (String(req.headers["if-none-match"] || "") === etag) {
      send(res, 304, headers, "");
      return;
    }
    send(res, status, headers, response.body);
  }

  function serveWebShellIndex(res, options = {}) {
    // web-shell index 总是 no-store，便于调试和升级时立即拿到新的 bridge/polyfill 引用。
    send(
      res,
      200,
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      createWebShellIndexResponse(options)
    );
  }

  function servePluginLoader(res) {
    send(
      res,
      200,
      { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      createPluginLoaderScript()
    );
  }

  /** 扫描官方 assets 目录，返回所有 JS/CSS 资源的完整 URL 路径，供 SW 预缓存。 */
  function createPrecacheManifest() {
    const officialBundle = getOfficialBundle();
    const manifest = [];
    if (officialBundle && officialBundle.webviewDir) {
      const assetsDir = path.join(officialBundle.webviewDir, "assets");
      if (exists(assetsDir)) {
       const files = fs.readdirSync(assetsDir);
       for (const file of files) {
         if (!file.endsWith(".css") && !file.endsWith(".js")) continue;
          // locale 文件（如 zh-CN-hash.js）是懒加载的，只有用户切换语言时才需要。
          // 排除 53 个 locale 文件可减少 ~36MB 预缓存数据，大幅缩短首次预热时间。
          if (/^[a-z]{2}-[A-Z]{2}-/.test(file)) continue;
         // CSS 走 /official/assets/ 不变；JS 在 HTML 中被改写到 patched 命名空间
          // 包含所有 chunk（含动态 import 的懒加载 chunk），供 prefetch 脚本预取
          if (file.endsWith(".js")) {
            manifest.push(`${PATCHED_OFFICIAL_PREFIX}assets/${file}`);
          } else {
            manifest.push(`/official/assets/${file}`);
          }
        }
      }
    }
    // web-shell 自己的静态资源
    for (const [urlPath] of WEB_SHELL_STATIC_FILES) {
      if (urlPath !== FAVICON_PATH) manifest.push(urlPath);
    }
   return manifest;
 }

  /**
   * 将全部预缓存资源打包成单个 gzip 压缩的 JSON，供 SW 一次性下载。
   * 解决 HTTP/2 多路复用大量小文件时带宽利用率极低（~20%）的问题。
   */
  function createPrecacheBundle(req) {
    const manifest = createPrecacheManifest();
    const bundle = {};
    for (const urlPath of manifest) {
      const file = staticFile(urlPath);
      if (!file || !exists(file)) continue;
      const data = patchOfficialAsset(urlPath, fs.readFileSync(file));
      bundle[urlPath] = data.toString("utf-8");
    }
    const buf = Buffer.from(JSON.stringify(bundle), "utf-8");
    return gzipIfUseful(
      req,
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      buf
    );
  }

  return {
    createPrecacheBundle,
    createPrecacheManifest,
    createRendererResponse,
    isAppShellRoute,
    isPublicStaticPath,
    serveFile,
    servePluginLoader,
    serveWebShellIndex,
    staticFile,
  };
}

module.exports = { createStaticAssetService };
