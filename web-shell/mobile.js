(function () {
  const statusEl = document.getElementById("mobile-status");
  const titleEl = document.getElementById("mobile-title");
  const sectionTitleEl = document.getElementById("mobile-section-title");
  const backEl = document.getElementById("mobile-back");
  const sourceEl = document.getElementById("mobile-source");
  const countEl = document.getElementById("mobile-count");
  const listEl = document.getElementById("mobile-thread-list");
  const messageListEl = document.getElementById("mobile-message-list");
  let threadEvents = null;

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
    return `/m/thread/${id}`;
  }

  function renderThreads(threads) {
    listEl.innerHTML = "";
    listEl.hidden = false;
    messageListEl.hidden = true;
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

  function renderMessages(messages) {
    messageListEl.innerHTML = "";
    listEl.hidden = true;
    messageListEl.hidden = false;
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "当前会话没有可展示的轻量消息";
      messageListEl.append(empty);
      return;
    }
    for (const message of messages) {
      appendMessage(message);
    }
  }

  function appendMessage(message) {
    const item = document.createElement("article");
    item.className = `message ${message.role === "user" ? "user" : "assistant"}`;

    const role = document.createElement("span");
    role.className = "message-role";
    role.textContent = message.role === "user" ? "你" : "Codex";

    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text || "";

    item.append(role, text);
    messageListEl.append(item);
  }

  function connectThreadEvents(threadId) {
    if (!("EventSource" in window)) return;
    if (threadEvents) threadEvents.close();
    // 增量通道只订阅当前会话，避免手机端恢复完整官方 WS/app-host 状态流。
    threadEvents = new EventSource(`/api/mobile/thread/${encodeURIComponent(threadId)}/events`);
    threadEvents.addEventListener("ready", () => {
      setText(statusEl, "已连接当前会话增量");
    });
    threadEvents.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data || "{}");
        if (!message || !message.text) return;
        const empty = messageListEl.querySelector(".empty");
        if (empty) empty.remove();
        appendMessage(message);
        const count = Number(countEl.textContent || 0);
        setText(countEl, Number.isFinite(count) ? count + 1 : messageListEl.querySelectorAll(".message").length);
      } catch {}
    });
    threadEvents.addEventListener("error", () => {
      setText(statusEl, "增量连接已断开，浏览器会自动重连");
    });
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

  async function loadThread(threadId) {
    // 详情页只读取当前会话的轻量消息，实时增量会在这个边界上继续扩展。
    const response = await fetch(`/api/mobile/thread/${encodeURIComponent(threadId)}`, {
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
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const thread = payload.thread || {};
    document.title = thread.title ? `${thread.title} - OpenCodex Mobile` : "OpenCodex Mobile";
    setText(titleEl, thread.title || "OpenCodex");
    setText(sectionTitleEl, "当前会话");
    setText(statusEl, "已加载当前会话轻量消息");
    setText(sourceEl, payload.source || "-");
    setText(countEl, messages.length);
    if (backEl) backEl.hidden = false;
    renderMessages(messages);
    connectThreadEvents(threadId);
  }

  function currentThreadId() {
    const prefix = "/m/thread/";
    return location.pathname.startsWith(prefix) ? decodeURIComponent(location.pathname.slice(prefix.length)) : "";
  }

  const threadId = currentThreadId();
  if (threadId) {
    loadThread(threadId).catch((error) => {
      setText(statusEl, `读取失败：${error && error.message ? error.message : String(error)}`);
      if (statusEl) statusEl.classList.add("error");
      renderMessages([]);
    });
  } else {
    if (threadEvents) threadEvents.close();
    loadBootstrap().catch((error) => {
      setText(statusEl, `读取失败：${error && error.message ? error.message : String(error)}`);
      if (statusEl) statusEl.classList.add("error");
      renderThreads([]);
    });
  }
})();
