// OpenCodex Service Worker — 运行时缓存 + 空闲预缓存
// 策略：
//   install:  立即激活，不预缓存（不与页面加载争抢带宽）
//   activate: 接管页面，延迟 30s 后在后台低并发预缓存
//   fetch:    静态资源 cache-first + 后台更新；HTML/API network-first

const CACHE_NAME = "opencodex-static-v6";
const PRECACHE_MANIFEST_URL = "/api/precache-manifest";
const PRECACHE_BUNDLE_URL = "/api/precache-bundle";
const PRECACHE_DELAY_MS = 0;
const PRECACHE_CONCURRENCY = 12;

// 缓存就绪状态，供页面 bootRenderer 做短等待判断；不能长期阻塞首屏。
let precacheComplete = false;

function isStaticAsset(url) {
  const path = new URL(url).pathname;
  // bridge polyfill 承载 IPC/WS 兼容逻辑，必须每次走网络校验，避免手机端长期吃旧路由代码。
  if (path === "/codex-bridge-polyfill.js") return false;
  if (path.startsWith("/official/assets/")) return true;
  if (path.startsWith("/official-patched-")) return true;
  if (path.startsWith("/assets/")) return true;
  if (path.startsWith("/codex-") || path.startsWith("/opencodex-")) return true;
  if (path === "/manifest.webmanifest") return true;
  return false;
}

/**
 * 优先用 bundle 一次性下载全部静态资源，失败时回退到逐文件下载。
 * bundle 方案把 1700+ 个 HTTP/2 请求压缩为 1 个大文件下载，
 * 在低带宽环境下总加载时间从 35s 降到 5-8s。
 */
async function backgroundPrecache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const manifestResp = await fetch(PRECACHE_MANIFEST_URL);
    if (!manifestResp || !manifestResp.ok) return;
    const urls = await manifestResp.json();
    if (!Array.isArray(urls) || urls.length === 0) return;

    // 检查已有缓存，只下载缺失项
    const need = [];
    for (const url of urls) {
      if (!(await cache.match(url))) need.push(url);
    }
    if (need.length === 0) { notifyPrecacheComplete(); return; }

    // 优先尝试 bundle 一次性下载
    let bundleOk = false;
    try {
      const resp = await fetch(PRECACHE_BUNDLE_URL);
      if (resp && resp.ok) {
        const bundle = await resp.json();
        for (const [url, body] of Object.entries(bundle)) {
          await cache.put(
            url,
            new Response(body, {
              headers: { "content-type": url.endsWith(".css") ? "text/css" : "application/javascript" },
            })
          );
        }
        bundleOk = true;
      }
    } catch {}

    // bundle 失败时回退到逐文件并发下载
    if (!bundleOk) {
      let idx = 0;
      async function worker() {
        while (idx < need.length) {
          const url = need[idx++];
          try {
            const r = await fetch(url, { credentials: "include" });
            if (r && r.ok) await cache.put(url, r);
          } catch {}
        }
      }
      const workers = [];
      for (let i = 0; i < Math.min(PRECACHE_CONCURRENCY, need.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
    }
    notifyPrecacheComplete();
  } catch {}
}

function notifyPrecacheComplete() {
  precacheComplete = true;
}

self.addEventListener("install", () => {
  // 立即激活，不等待预缓存
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() => {
        // 页面加载 30s 后在后台静默预缓存
        setTimeout(backgroundPrecache, PRECACHE_DELAY_MS);
      })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // HTML 导航：network-first，不缓存
  if (req.mode === "navigate") {
    event.respondWith(fetch(req));
    return;
  }

  // 静态资源：cache-first，后台更新
  if (isStaticAsset(req.url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) {
          return cached;
        }
        try {
          const resp = await fetch(req);
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        } catch {
          return new Response("", { status: 504 });
        }
      })
    );
    return;
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "cache-status") {
    // 立即返回当前状态：预缓存是优化项，不应在 DERP/弱网下把启动页卡到超时。
    event.ports[0].postMessage({ ready: precacheComplete });
  }
});
