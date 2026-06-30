(function () {
  const statusEl = document.getElementById("mobile-status");
  const sourceEl = document.getElementById("mobile-source");
  const countEl = document.getElementById("mobile-count");
  const listEl = document.getElementById("mobile-thread-list");

  function setText(node, value) {
    if (node) node.textContent = String(value == null ? "" : value);
  }

  function formatProject(thread) {
    const projectPath = thread && typeof thread.projectPath === "string" ? thread.projectPath : "";
    if (!projectPath) return "";
    const parts = projectPath.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || projectPath;
  }

  function threadHref(thread) {
    const id = encodeURIComponent(thread.id);
    return `/local/${id}`;
  }

  function renderThreads(threads) {
    listEl.innerHTML = "";
    if (!threads.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "没有可用的会话快照";
      listEl.append(empty);
      return;
    }
    for (const thread of threads) {
      const item = document.createElement("a");
      item.className = "thread-card";
      item.href = threadHref(thread);

      const title = document.createElement("span");
      title.className = "thread-title";
      title.textContent = thread.title || "Untitled";

      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = [formatProject(thread), thread.updatedAt || ""].filter(Boolean).join(" · ");

      item.append(title, meta);
      listEl.append(item);
    }
  }

  async function loadBootstrap() {
    // 手机入口只请求合并后的轻量状态，不加载官方 bridge，避免弱网下被插件/MCP/桌面状态拖慢。
    const response = await fetch("/api/mobile/bootstrap", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) {
      location.href = "/";
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const threads = Array.isArray(payload.threads) ? payload.threads : [];
    // 渲染层只消费裁剪后的 DTO；会话详情和实时增量后续再按当前会话单独订阅。
    setText(statusEl, payload.source === "empty" ? "未命中快照，可切换完整模式刷新" : "已加载轻量会话列表");
    setText(sourceEl, payload.source || "-");
    setText(countEl, threads.length);
    renderThreads(threads);
  }

  loadBootstrap().catch((error) => {
    setText(statusEl, `读取失败：${error && error.message ? error.message : String(error)}`);
    if (statusEl) statusEl.classList.add("error");
    renderThreads([]);
  });
})();
