(function () {
  const statusEl = document.getElementById("mobile-status");
  const titleEl = document.getElementById("mobile-title");
  const sectionTitleEl = document.getElementById("mobile-section-title");
  const backEl = document.getElementById("mobile-back");
  const sourceEl = document.getElementById("mobile-source");
  const countEl = document.getElementById("mobile-count");
  const bytesEl = document.getElementById("mobile-bytes");
  const listEl = document.getElementById("mobile-thread-list");
  const messageListEl = document.getElementById("mobile-message-list");
  const composeEl = document.getElementById("mobile-compose");
  const composeTextEl = document.getElementById("mobile-compose-text");
  const composeSendEl = document.getElementById("mobile-compose-send");
  const MOBILE_CACHE_PREFIX = "opencodex.mobile-lite.";
  const MOBILE_CACHE_TTL_MS = 60_000;
  const MOBILE_READ_TIMEOUT_MS = 8_000;
  const MOBILE_SEND_TIMEOUT_MS = 30_000;
  const MOBILE_BOOTSTRAP_LIMIT_DEFAULT = 50;
  const MOBILE_BOOTSTRAP_LIMIT_CONSTRAINED = 12;
  const MOBILE_BOOTSTRAP_LIMIT_CELLULAR = 24;
  let threadEvents = null;
  let activeThreadId = "";

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

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }

  function mobileCacheKey(kind, id) {
    return `${MOBILE_CACHE_PREFIX}${kind}:${id || "default"}`;
  }

  function bootstrapThreadLimit() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!connection) return MOBILE_BOOTSTRAP_LIMIT_DEFAULT;
    const effectiveType = String(connection.effectiveType || "").toLowerCase();
    // 省流量或极慢网络下只拉最近少量会话；当前会话详情和 SSE 增量仍按需单独加载。
    if (connection.saveData || effectiveType === "slow-2g" || effectiveType === "2g") return MOBILE_BOOTSTRAP_LIMIT_CONSTRAINED;
    if (effectiveType === "3g") return MOBILE_BOOTSTRAP_LIMIT_CELLULAR;
    return MOBILE_BOOTSTRAP_LIMIT_DEFAULT;
  }

  function mobileBootstrapUrl() {
    return `/api/mobile/bootstrap?limit=${encodeURIComponent(String(bootstrapThreadLimit()))}`;
  }

  function readMobileCache(kind, id) {
    try {
      const raw = sessionStorage.getItem(mobileCacheKey(kind, id));
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached || cached.version !== 1 || !cached.payload || Date.now() - Number(cached.savedAtMs || 0) > MOBILE_CACHE_TTL_MS) {
        sessionStorage.removeItem(mobileCacheKey(kind, id));
        return null;
      }
      return cached.payload;
    } catch {
      return null;
    }
  }

  function writeMobileCache(kind, id, payload) {
    if (!payload || payload.ok !== true) return;
    try {
      // 只缓存 mobile-lite API 已裁剪 DTO，不缓存完整官方 renderer 状态。
      sessionStorage.setItem(
        mobileCacheKey(kind, id),
        JSON.stringify({
          payload,
          savedAtMs: Date.now(),
          version: 1,
        })
      );
    } catch {}
  }

  async function fetchJsonWithTimeout(url, options, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : MOBILE_READ_TIMEOUT_MS;
    const timer = controller
      ? setTimeout(() => {
          // 弱网请求不能无限挂住；超时后交给缓存兜底或页面错误态处理。
          controller.abort();
        }, timeout)
      : null;
    try {
      const response = await fetch(url, {
        ...(options || {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status === 401) {
        location.href = "/";
        return null;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function renderThreads(threads) {
    listEl.innerHTML = "";
    listEl.hidden = false;
    messageListEl.hidden = true;
    if (composeEl) composeEl.hidden = true;
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
    if (composeEl) composeEl.hidden = false;
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

  function appendMessage(message, options) {
    const item = document.createElement("article");
    item.className = `message ${message.role === "user" ? "user" : "assistant"}`;
    if (options && options.pending) item.classList.add("pending");
    if (options && options.localSendId) item.dataset.localSendId = options.localSendId;

    const role = document.createElement("span");
    role.className = "message-role";
    const roleText = options && options.pending ? "你 · 发送中" : message.role === "user" ? "你" : "Codex";
    role.textContent = message.truncated ? `${roleText} · 已截断` : roleText;

    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text || "";

    item.append(role, text);
    messageListEl.append(item);
    item.scrollIntoView({ block: "end" });
  }

  function markPendingAccepted(localSendId) {
    if (!localSendId) return;
    const item = messageListEl.querySelector(`[data-local-send-id="${cssEscape(localSendId)}"]`);
    if (!item) return;
    item.classList.remove("pending");
    const role = item.querySelector(".message-role");
    if (role) role.textContent = "你";
  }

  function connectThreadEvents(threadId, sinceOffset) {
    if (!("EventSource" in window)) return;
    if (threadEvents) threadEvents.close();
    const offset = Number(sinceOffset);
    const query = Number.isFinite(offset) && offset >= 0 ? `?sinceOffset=${encodeURIComponent(String(Math.floor(offset)))}` : "";
    // 增量通道只订阅当前会话，避免手机端恢复完整官方 WS/app-host 状态流。
    threadEvents = new EventSource(`/api/mobile/thread/${encodeURIComponent(threadId)}/events${query}`);
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

  function resizeComposeText() {
    if (!composeTextEl) return;
    composeTextEl.style.height = "auto";
    composeTextEl.style.height = `${Math.min(composeTextEl.scrollHeight, 140)}px`;
  }

  async function submitMessage(event) {
    event.preventDefault();
    if (!activeThreadId || !composeTextEl || !composeSendEl) return;
    const text = composeTextEl.value.trim();
    if (!text) return;
    const localSendId = `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    composeSendEl.disabled = true;
    composeTextEl.value = "";
    resizeComposeText();
    const empty = messageListEl.querySelector(".empty");
    if (empty) empty.remove();
    // 手机端先显示本地 pending，真正的追加内容仍通过当前会话 SSE 收敛回来。
    appendMessage({ role: "user", text }, { localSendId, pending: true });
    try {
      const payload = await fetchJsonWithTimeout(`/api/mobile/thread/${encodeURIComponent(activeThreadId)}/turns`, {
        body: JSON.stringify({ localSendId, text }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      }, MOBILE_SEND_TIMEOUT_MS);
      if (!payload) return;
      if (!payload.ok) throw new Error(payload.error || "发送失败");
      if (statusEl) statusEl.classList.remove("error");
      markPendingAccepted(localSendId);
      setText(statusEl, payload.duplicate ? "消息已提交，重复请求已合并" : "消息已提交，等待增量回包");
    } catch (error) {
      setText(statusEl, `发送失败：${error && error.message ? error.message : String(error)}`);
      if (statusEl) statusEl.classList.add("error");
      if (composeTextEl && !composeTextEl.value) composeTextEl.value = text;
      const item = messageListEl.querySelector(`[data-local-send-id="${cssEscape(localSendId)}"]`);
      if (item) item.remove();
    } finally {
      if (composeSendEl) composeSendEl.disabled = false;
      if (composeTextEl) composeTextEl.focus();
    }
  }

  async function loadBootstrap() {
    const cached = readMobileCache("bootstrap", "list");
    if (cached) {
      renderBootstrapPayload(cached, "已加载本地快照，正在刷新");
    }
    // 手机入口只请求合并后的轻量状态，不加载官方 bridge，避免弱网下被插件/MCP/桌面状态拖慢。
    try {
      const payload = await fetchJsonWithTimeout(mobileBootstrapUrl(), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }, MOBILE_READ_TIMEOUT_MS);
      if (!payload) return;
      writeMobileCache("bootstrap", "list", payload);
      renderBootstrapPayload(payload);
    } catch (error) {
      if (cached) {
        setText(statusEl, `刷新失败，继续使用本地快照：${error && error.message ? error.message : String(error)}`);
        if (statusEl) statusEl.classList.add("error");
        return;
      }
      throw error;
    }
  }

  function renderBootstrapPayload(payload, statusText) {
    const threads = Array.isArray(payload.threads) ? payload.threads : [];
    // 渲染层只消费裁剪后的 DTO；会话详情和实时增量后续再按当前会话单独订阅。
    if (statusEl) statusEl.classList.remove("error");
    setText(statusEl, statusText || (payload.source === "empty" ? "未命中快照，可切换完整模式刷新" : "已加载轻量会话列表"));
    setText(sourceEl, payload.source || "-");
    setText(countEl, threads.length);
    setText(bytesEl, formatBytes(payload.metrics && payload.metrics.estimatedPayloadBytes));
    renderThreads(threads);
  }

  async function loadThread(threadId) {
    activeThreadId = threadId;
    const cached = readMobileCache("thread", threadId);
    if (cached) {
      renderThreadPayload(threadId, cached, "已加载本地快照，正在刷新");
      connectThreadEvents(threadId, cached.metrics && cached.metrics.nextEventOffset);
    }
    // 详情页只读取当前会话的轻量消息，实时增量会在这个边界上继续扩展。
    try {
      const payload = await fetchJsonWithTimeout(`/api/mobile/thread/${encodeURIComponent(threadId)}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }, MOBILE_READ_TIMEOUT_MS);
      if (!payload) return;
      writeMobileCache("thread", threadId, payload);
      renderThreadPayload(threadId, payload);
      connectThreadEvents(threadId, payload.metrics && payload.metrics.nextEventOffset);
    } catch (error) {
      if (cached) {
        setText(statusEl, `刷新失败，继续使用本地快照：${error && error.message ? error.message : String(error)}`);
        if (statusEl) statusEl.classList.add("error");
        return;
      }
      throw error;
    }
  }

  function renderThreadPayload(threadId, payload, statusText) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const thread = payload.thread || {};
    document.title = thread.title ? `${thread.title} - OpenCodex Mobile` : "OpenCodex Mobile";
    setText(titleEl, thread.title || "OpenCodex");
    setText(sectionTitleEl, "当前会话");
    if (statusEl) statusEl.classList.remove("error");
    setText(statusEl, statusText || "已加载当前会话轻量消息");
    setText(sourceEl, payload.source || "-");
    setText(countEl, messages.length);
    setText(bytesEl, formatBytes(payload.metrics && payload.metrics.estimatedPayloadBytes));
    if (backEl) backEl.hidden = false;
    renderMessages(messages);
  }

  function currentThreadId() {
    const prefix = "/m/thread/";
    return location.pathname.startsWith(prefix) ? decodeURIComponent(location.pathname.slice(prefix.length)) : "";
  }

  const threadId = currentThreadId();
  if (composeEl) composeEl.addEventListener("submit", submitMessage);
  if (composeTextEl) composeTextEl.addEventListener("input", resizeComposeText);
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
