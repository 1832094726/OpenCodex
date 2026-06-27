(function () {
  var pluginSystem = window.OpenCodexPluginSystem || window.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;
  if (!("serviceWorker" in navigator)) return;

  pluginSystem.registerPlugin({
    id: "sw-cache",
    name: "SW Cache",
    label: "本地缓存加速",
    labelKey: "plugin.swCache.label",
    desc: "通过 Service Worker 缓存静态资源，大幅加速远程访问的页面加载速度。",
    descKey: "plugin.swCache.desc",
    defaultEnabled: true,
    order: 50,
    activate: function (context) {
      var scope = "/";
      var swUrl = "/sw-cache.js";

      // 仅在 http/https 下注册（localhost 也算）
      if (location.protocol !== "http:" && location.protocol !== "https:") return;

      var registered = false;

      function doRegister() {
        if (registered) return;
        registered = true;
        navigator.serviceWorker.register(swUrl, { scope: scope }).then(
          function (reg) {
            // 等待 controller 激活
            if (navigator.serviceWorker.controller) return;
            return new Promise(function (resolve) {
              navigator.serviceWorker.addEventListener("controllerchange", function () {
                resolve();
              });
            });
          }
        ).catch(function (err) {
          console.warn("[sw-cache] Service Worker 注册失败", err);
        });
      }

      // 页面加载完成后立即注册
      if (document.readyState === "complete" || document.readyState === "interactive") {
        doRegister();
      } else {
        window.addEventListener("DOMContentLoaded", doRegister);
      }

      return function () {};
    },
  });
})();