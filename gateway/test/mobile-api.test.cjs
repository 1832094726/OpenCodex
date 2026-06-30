const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  createMobileApi,
  createMobileBootstrapPayload,
  createMobileThreadPayload,
  createMobileThreadEventStream,
  createMobileTurnStartPayload,
  listLocalSessionThreadDetail,
  listLocalSessionThreads,
  mobileThreadDetailTailBytesForLimit,
  normalizeMobileThreads,
} = require("../runtime/http/mobile.cjs");
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");

function collectResponse(handler, req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      headers: {},
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        resolve({
          bodyBuffer: Buffer.concat(chunks),
          body: Buffer.concat(chunks).toString("utf8"),
          headers: this.headers,
          statusCode: this.statusCode,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-mobile-test-"));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonPostReq(body) {
  const events = {};
  return {
    headers: { "content-type": "application/json" },
    method: "POST",
    on(event, handler) {
      events[event] = handler;
      if (event === "data") process.nextTick(() => handler(Buffer.from(JSON.stringify(body))));
      if (event === "end") process.nextTick(handler);
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function createStreamHarness() {
  const events = {};
  const resEvents = {};
  const writes = [];
  const req = {
    on(event, handler) {
      events[event] = handler;
    },
  };
  const res = {
    headers: {},
    statusCode: 0,
    write(chunk) {
      writes.push(String(chunk));
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    on(event, handler) {
      resEvents[event] = handler;
    },
  };
  return {
    close() {
      if (events.close) events.close();
    },
    req,
    res,
    resClose() {
      if (resEvents.close) resEvents.close();
    },
    resError() {
      if (resEvents.error) resEvents.error(new Error("socket closed"));
    },
    writes,
  };
}

test("normalizeMobileThreads trims thread list to phone-safe fields", () => {
  const threads = normalizeMobileThreads({
    items: [
      {
        id: "thread-1",
        title: "实现手机轻量模式",
        cwd: "/Users/example/project",
        updatedAt: "2026-06-30T08:00:00.000Z",
        archived: false,
        mcpServerStatus: [{ name: "large-state" }],
        pluginList: [{ name: "unused-on-phone" }],
      },
    ],
  });

  assert.deepEqual(threads, [
    {
      archived: false,
      id: "thread-1",
      projectPath: "/Users/example/project",
      title: "实现手机轻量模式",
      updatedAt: "2026-06-30T08:00:00.000Z",
    },
  ]);
});

test("normalizeMobileThreads caps oversized thread fields to small scalars", () => {
  const threads = normalizeMobileThreads({
    threads: [
      {
        cwd: `/repo/${"deep/".repeat(120)}`,
        id: `thread-${"x".repeat(300)}`,
        title: "移动端列表标题".repeat(80),
        updatedAt: { nested: "drop-me", huge: "y".repeat(2_000) },
        updatedAtMs: 1_782_723_600_000,
      },
    ],
  });

  assert.equal(threads.length, 1);
  assert.equal(threads[0].id.length, 160);
  assert.equal(threads[0].title.length, 160);
  assert.equal(threads[0].projectPath.length, 320);
  assert.equal(threads[0].updatedAt, 1_782_723_600_000);
  assert.doesNotMatch(JSON.stringify(threads), /drop-me|yyyy/);
});

test("createMobileBootstrapPayload returns stale-first empty state without blocking on live runtime", async () => {
  const payload = await createMobileBootstrapPayload({
    readThreadListSnapshot: () => null,
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "mobile-lite");
  assert.equal(payload.source, "empty");
  assert.deepEqual(payload.threads, []);
  assert.equal(payload.deferredState, undefined);
  assert.equal(payload.metrics.deferredStateCount, 4);
});

test("createMobileBootstrapPayload only returns deferred state diagnostics when requested", async () => {
  const payload = await createMobileBootstrapPayload({
    includeDeferredState: true,
    readThreadListSnapshot: () => null,
  });

  assert.deepEqual(payload.deferredState, ["app/list", "mcpServerStatus/list", "plugin/list", "desktop-state"]);
});

test("createMobileBootstrapPayload uses cached thread list and records snapshot age", async () => {
  const payload = await createMobileBootstrapPayload({
    now: () => 1_000,
    readThreadListSnapshot: () => ({
      capturedAtMs: 400,
      source: "gateway-disk",
      value: {
        threads: [
          {
            threadId: "thread-2",
            name: "弱网下打开最近会话",
            workspace: "/repo/opencodex",
            updatedAtMs: 800,
            extraLargeField: "drop-me",
          },
        ],
      },
    }),
  });

  assert.equal(payload.source, "gateway-disk");
  assert.equal(payload.snapshotAgeMs, 600);
  assert.equal(payload.metrics.threadCount, 1);
  assert.equal(payload.metrics.deferredStateCount, 4);
  assert.equal(payload.metrics.listCacheTtlMs, 5_000);
  assert.ok(payload.metrics.estimatedPayloadBytes > 0);
  assert.deepEqual(payload.threads, [
    {
      archived: false,
      id: "thread-2",
      projectPath: "/repo/opencodex",
      title: "弱网下打开最近会话",
      updatedAt: 800,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /extraLargeField|large-state|unused-on-phone/);
});

test("listLocalSessionThreads builds a phone-safe list from Codex jsonl history", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-2026-06-30T08-00-00-019f-test.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/repo/mobile",
          session_id: "thread-local-1",
          timestamp: "2026-06-30T08:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          content: [{ text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>", type: "input_text" }],
          role: "user",
          type: "message",
        },
      }),
      JSON.stringify({
        type: "user_message",
        payload: {
          message: "太慢了，大部分状态其实手机不需要使用",
        },
      }),
    ].join("\n"),
    "utf8"
  );

  const threads = listLocalSessionThreads({ codexHome: root, limit: 10 });

  assert.deepEqual(threads, [
    {
      archived: false,
      id: "thread-local-1",
      projectPath: "/repo/mobile",
      title: "太慢了，大部分状态其实手机不需要使用",
      updatedAt: "2026-06-30T08:00:00.000Z",
    },
  ]);
});

test("listLocalSessionThreads reuses a short cache for repeated mobile opens", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const firstFile = path.join(sessionsDir, "rollout-2026-06-30T08-00-00-thread-cache-1.jsonl");
  fs.writeFileSync(
    firstFile,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/cache",
          session_id: "thread-cache-1",
        },
      }),
      JSON.stringify({
        type: "user_message",
        payload: {
          message: "第一次打开手机列表",
        },
      }),
    ].join("\n"),
    "utf8"
  );
  fs.utimesSync(firstFile, new Date("2026-06-30T08:00:00.000Z"), new Date("2026-06-30T08:00:00.000Z"));

  const first = listLocalSessionThreads({ cacheTtlMs: 1_000, codexHome: root, limit: 5, now: () => 10_000, staleCacheTtlMs: 0 });
  const secondFile = path.join(sessionsDir, "rollout-2026-06-30T08-01-00-thread-cache-2.jsonl");
  fs.writeFileSync(
    secondFile,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:01:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/cache",
          session_id: "thread-cache-2",
        },
      }),
      JSON.stringify({
        type: "user_message",
        payload: {
          message: "TTL 内新增但不重新扫描",
        },
      }),
    ].join("\n"),
    "utf8"
  );
  fs.utimesSync(secondFile, new Date("2026-06-30T08:01:00.000Z"), new Date("2026-06-30T08:01:00.000Z"));

  const cached = listLocalSessionThreads({ cacheTtlMs: 1_000, codexHome: root, limit: 5, now: () => 10_500, staleCacheTtlMs: 0 });
  const refreshed = listLocalSessionThreads({ cacheTtlMs: 1_000, codexHome: root, limit: 5, now: () => 11_500, staleCacheTtlMs: 0 });

  assert.deepEqual(first.map((thread) => thread.id), ["thread-cache-1"]);
  assert.deepEqual(cached.map((thread) => thread.id), ["thread-cache-1"]);
  assert.deepEqual(refreshed.map((thread) => thread.id), ["thread-cache-2", "thread-cache-1"]);
});

test("listLocalSessionThreads reuses stale lightweight state when recent files are unchanged", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-2026-06-30T08-02-00-thread-stable-cache.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:02:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/stable-cache",
          session_id: "thread-stable-cache",
        },
      }),
      JSON.stringify({
        type: "user_message",
        payload: {
          message: "稳定列表状态可以合并复用",
        },
      }),
    ].join("\n"),
    "utf8"
  );
  fs.utimesSync(file, new Date("2026-06-30T08:02:00.000Z"), new Date("2026-06-30T08:02:00.000Z"));

  const first = listLocalSessionThreads({
    cacheTtlMs: 1_000,
    codexHome: root,
    limit: 5,
    now: () => 10_000,
    staleCacheTtlMs: 30_000,
  });
  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(target, ...args) {
    if (path.resolve(String(target)) === file) throw new Error("unchanged list state should not reopen jsonl");
    return originalOpenSync.call(this, target, ...args);
  };
  try {
    const stale = listLocalSessionThreads({
      cacheTtlMs: 1_000,
      codexHome: root,
      limit: 5,
      now: () => 12_000,
      staleCacheTtlMs: 30_000,
    });

    assert.deepEqual(stale, first);
  } finally {
    fs.openSync = originalOpenSync;
  }

  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:02:01.000Z",
        type: "event_msg",
        payload: {
          message: "文件变化后列表可重新解析",
          type: "user_message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const refreshed = listLocalSessionThreads({
    cacheTtlMs: 1_000,
    codexHome: root,
    limit: 5,
    now: () => 12_500,
    staleCacheTtlMs: 30_000,
  });

  assert.deepEqual(refreshed.map((thread) => thread.id), ["thread-stable-cache"]);
});

test("listLocalSessionThreads returns partial recent results when scan budget is exhausted", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    const id = `thread-budget-${String(index).padStart(2, "0")}`;
    const file = path.join(sessionsDir, `rollout-2026-06-30T08-${String(index).padStart(2, "0")}-00-${id}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          timestamp: `2026-06-30T08:${String(index).padStart(2, "0")}:00.000Z`,
          type: "session_meta",
          payload: {
            cwd: "/repo/budget",
            session_id: id,
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            message: `预算内最近会话 ${index}`,
            type: "user_message",
          },
        }),
      ].join("\n"),
      "utf8"
    );
    fs.utimesSync(file, new Date(`2026-06-30T08:${String(index).padStart(2, "0")}:00.000Z`), new Date(`2026-06-30T08:${String(index).padStart(2, "0")}:00.000Z`));
  }
  let nowMs = -50;
  const threads = listLocalSessionThreads({
    cacheTtlMs: 0,
    codexHome: root,
    limit: 20,
    now: () => {
      nowMs += 50;
      return nowMs;
    },
    scanMaxMs: 250,
  });

  assert.ok(threads.length > 0);
  assert.ok(threads.length < 20);
});

test("createMobileBootstrapPayload falls back to local history when thread snapshot is missing", async () => {
  const payload = await createMobileBootstrapPayload({
    listLocalThreads: () => [
      {
        archived: false,
        id: "thread-local-2",
        projectPath: "/repo/mobile",
        title: "本地历史兜底",
        updatedAt: "2026-06-30T08:10:00.000Z",
      },
    ],
    readThreadListSnapshot: () => null,
  });

  assert.equal(payload.source, "local-history");
  assert.equal(payload.threads.length, 1);
});

test("mobile bootstrap handler gzips sizeable lightweight JSON payloads", async () => {
  const api = createMobileApi({
    fastSyncCache: {
      readSnapshot: () => ({
        capturedAtMs: 1_000,
        source: "test-snapshot",
        value: {
          threads: Array.from({ length: 80 }, (_, index) => ({
            id: `thread-gzip-${index}`,
            projectPath: `/repo/mobile-${index}`,
            title: `手机弱网压缩会话 ${index}`,
            updatedAt: `2026-06-30T08:${String(index % 60).padStart(2, "0")}:00.000Z`,
          })),
        },
      }),
    },
    invokeTurnStart: async () => ({ ok: true }),
  });

  const response = await collectResponse(
    (req, res) => api.handleBootstrap(req, res, new URL("http://127.0.0.1/api/mobile/bootstrap?limit=80")),
    {
      headers: { accept: "application/json", "accept-encoding": "gzip" },
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
    }
  );
  const body = JSON.parse(zlib.gunzipSync(response.bodyBuffer).toString("utf8"));

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers.vary, "Accept-Encoding");
  assert.equal(body.ok, true);
  assert.equal(body.threads.length, 80);
  assert.ok(response.bodyBuffer.length < body.metrics.estimatedPayloadBytes);
});

test("mobile bootstrap handler returns 304 when visible state etag matches", async () => {
  const api = createMobileApi({
    fastSyncCache: {
      readSnapshot: () => ({
        capturedAtMs: 1_000,
        source: "test-snapshot",
        value: {
          threads: [
            {
              id: "thread-etag-1",
              projectPath: "/repo/mobile",
              title: "相同快照不重复下发",
              updatedAt: "2026-06-30T08:00:00.000Z",
            },
          ],
        },
      }),
    },
    invokeTurnStart: async () => ({ ok: true }),
  });
  const url = new URL("http://127.0.0.1/api/mobile/bootstrap?limit=10");
  const first = await collectResponse((req, res) => api.handleBootstrap(req, res, url), {
    headers: { accept: "application/json" },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
  });
  const second = await collectResponse((req, res) => api.handleBootstrap(req, res, url), {
    headers: { accept: "application/json", "if-none-match": first.headers.etag },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
  });

  assert.equal(first.statusCode, 200);
  assert.ok(first.headers.etag);
  assert.equal(second.statusCode, 304);
  assert.equal(second.headers.etag, first.headers.etag);
  assert.equal(second.body, "");
});

test("mobile thread handler limits cold deep-link lookup to recent candidates", async () => {
  const root = tempDir();
  const olderDir = path.join(root, "sessions", "2026", "06", "29");
  const recentDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(recentDir, { recursive: true });
  const recentFile = path.join(recentDir, "rollout-2026-06-30T08-00-00-thread-handler-recent.jsonl");
  fs.writeFileSync(
    recentFile,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/recent-handler", session_id: "thread-handler-recent" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "handler 最近会话", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );
  const olderFile = path.join(olderDir, "rollout-2026-06-29T08-00-00-thread-handler-old.jsonl");
  fs.writeFileSync(
    olderFile,
    [
      JSON.stringify({
        timestamp: "2026-06-29T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/old-handler", session_id: "thread-handler-old" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "handler 不扫老会话", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );
  const api = createMobileApi({
    codexHome: root,
    fastSyncCache: { readSnapshot: () => null },
    mobileRecentFileLimit: 1,
    invokeTurnStart: async () => ({ ok: true }),
  });

  const recent = await collectResponse(
    (req, res) => api.handleThread(req, res, new URL("http://127.0.0.1/api/mobile/thread/thread-handler-recent"), "thread-handler-recent"),
    { headers: {}, method: "GET" }
  );
  assert.equal(recent.statusCode, 200);
  assert.equal(JSON.parse(recent.body).thread.id, "thread-handler-recent");

  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(target, ...args) {
    if (path.resolve(String(target)) === olderFile) throw new Error("mobile handler must not scan old deep-link candidates");
    return originalOpenSync.call(this, target, ...args);
  };
  try {
    const old = await collectResponse(
      (req, res) => api.handleThread(req, res, new URL("http://127.0.0.1/api/mobile/thread/thread-handler-old"), "thread-handler-old"),
      { headers: {}, method: "GET" }
    );

    assert.equal(old.statusCode, 404);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("listLocalSessionThreadDetail returns only visible user and assistant messages", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-2026-06-30T08-00-00-thread-detail-1.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/mobile",
          session_id: "thread-detail-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T08:00:01.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "<environment_context>\n  <cwd>/repo/mobile</cwd>", type: "input_text" }],
          role: "user",
          type: "message",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T08:00:02.000Z",
        type: "event_msg",
        payload: {
          message: "页面还是尽量保持官方的样子",
          type: "user_message",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T08:00:03.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "我会保持官方浅色列表，并只同步当前会话。", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
    ].join("\n"),
    "utf8"
  );

  const detail = listLocalSessionThreadDetail({ codexHome: root, threadId: "thread-detail-1" });

  assert.equal(detail.ok, true);
  assert.deepEqual(detail.thread, {
    archived: false,
    id: "thread-detail-1",
    projectPath: "/repo/mobile",
    title: "页面还是尽量保持官方的样子",
    updatedAt: "2026-06-30T08:00:00.000Z",
  });
  assert.deepEqual(detail.messages, [
    {
      role: "user",
      text: "页面还是尽量保持官方的样子",
      timestamp: "2026-06-30T08:00:02.000Z",
    },
    {
      role: "assistant",
      text: "我会保持官方浅色列表，并只同步当前会话。",
      timestamp: "2026-06-30T08:00:03.000Z",
    },
  ]);
});

test("listLocalSessionThreadDetail checks recent files before full history scans", () => {
  const root = tempDir();
  const olderDir = path.join(root, "sessions", "2026", "06", "29");
  const recentDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(
    path.join(olderDir, "rollout-2026-06-29T08-00-00-thread-older.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-06-29T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/older", session_id: "thread-older" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "旧会话", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(recentDir, "rollout-2026-06-30T08-00-00-thread-recent.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/recent", session_id: "thread-recent" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "最近会话", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );

  const detail = listLocalSessionThreadDetail({
    cacheTtlMs: 0,
    codexHome: root,
    recentFileLimit: 1,
    threadId: "thread-recent",
  });

  assert.equal(detail.ok, true);
  assert.equal(detail.thread.id, "thread-recent");
  assert.equal(detail.metrics.lookupSource, "recent");
});

test("listLocalSessionThreadDetail keeps a full-scan fallback for older deep links", () => {
  const root = tempDir();
  const olderDir = path.join(root, "sessions", "2026", "06", "29");
  const recentDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(
    path.join(recentDir, "rollout-2026-06-30T08-00-00-thread-recent-fallback.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/recent", session_id: "thread-recent-fallback" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "最近候选", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(olderDir, "rollout-2026-06-29T08-00-00-thread-old-deeplink.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-06-29T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/old", session_id: "thread-old-deeplink" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "老会话深链", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );

  const detail = listLocalSessionThreadDetail({
    cacheTtlMs: 0,
    codexHome: root,
    recentFileLimit: 1,
    threadId: "thread-old-deeplink",
  });

  assert.equal(detail.ok, true);
  assert.equal(detail.thread.id, "thread-old-deeplink");
  assert.equal(detail.metrics.lookupSource, "scan");
});

test("listLocalSessionThreadDetail can skip full scans for mobile traffic", () => {
  const root = tempDir();
  const olderDir = path.join(root, "sessions", "2026", "06", "29");
  const recentDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(
    path.join(recentDir, "rollout-2026-06-30T08-00-00-thread-fast-recent.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/recent", session_id: "thread-fast-recent" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "最近候选", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );
  const olderFile = path.join(olderDir, "rollout-2026-06-29T08-00-00-thread-skip-full-scan.jsonl");
  fs.writeFileSync(
    olderFile,
    [
      JSON.stringify({
        timestamp: "2026-06-29T08:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/repo/old", session_id: "thread-skip-full-scan" },
      }),
      JSON.stringify({ type: "event_msg", payload: { message: "手机弱网不做无界扫描", type: "user_message" } }),
      "",
    ].join("\n"),
    "utf8"
  );

  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(target, ...args) {
    if (path.resolve(String(target)) === olderFile) throw new Error("mobile lookup must not full-scan old session files");
    return originalOpenSync.call(this, target, ...args);
  };
  try {
    const detail = listLocalSessionThreadDetail({
      allowFullScan: false,
      cacheTtlMs: 0,
      codexHome: root,
      recentFileLimit: 1,
      threadId: "thread-skip-full-scan",
    });

    assert.equal(detail.ok, false);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("local mobile history reads avoid loading whole large session files", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-2026-06-30T10-00-00-large-alias.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T10:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/window-read",
          session_id: "thread-window-read",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T10:00:01.000Z",
        type: "event_msg",
        payload: {
          message: "大文件也只读头尾窗口",
          type: "user_message",
        },
      }),
      ...Array.from({ length: 1200 }, (_, index) =>
        JSON.stringify({
          type: "internal_state",
          payload: { index, blob: "x".repeat(1024) },
        })
      ),
      JSON.stringify({
        timestamp: "2026-06-30T10:20:00.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "尾部消息仍然可见", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    if (path.resolve(String(target)) === file) throw new Error("mobile path must not read the whole session file");
    return originalReadFileSync.call(this, target, ...args);
  };
  try {
    const threads = listLocalSessionThreads({ cacheTtlMs: 0, codexHome: root, limit: 5 });
    const detail = listLocalSessionThreadDetail({
      cacheTtlMs: 0,
      codexHome: root,
      limit: 5,
      threadId: "thread-window-read",
    });

    assert.equal(threads[0].id, "thread-window-read");
    assert.equal(detail.ok, true);
    assert.equal(detail.thread.id, "thread-window-read");
    assert.equal(detail.thread.title, "大文件也只读头尾窗口");
    assert.deepEqual(
      detail.messages.map((message) => message.text),
      ["尾部消息仍然可见"]
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("listLocalSessionThreadDetail reuses a short cache while the session file is unchanged", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-2026-06-30T10-30-00-thread-detail-cache.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T10:30:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/detail-cache",
          session_id: "thread-detail-cache",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T10:30:01.000Z",
        type: "event_msg",
        payload: {
          message: "详情短缓存",
          type: "user_message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  let nowMs = 10_000;
  const first = listLocalSessionThreadDetail({
    codexHome: root,
    detailCacheTtlMs: 1_000,
    now: () => nowMs,
    threadId: "thread-detail-cache",
  });
  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(target, ...args) {
    if (path.resolve(String(target)) === file) throw new Error("unchanged detail should come from mobile cache");
    return originalOpenSync.call(this, target, ...args);
  };
  try {
    const cached = listLocalSessionThreadDetail({
      codexHome: root,
      detailCacheTtlMs: 1_000,
      now: () => nowMs + 500,
      threadId: "thread-detail-cache",
    });

    assert.equal(first.ok, true);
    assert.deepEqual(cached.messages, first.messages);
  } finally {
    fs.openSync = originalOpenSync;
  }

  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T10:30:02.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "文件变化后重新读取", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  nowMs += 600;
  const refreshed = listLocalSessionThreadDetail({
    codexHome: root,
    detailCacheTtlMs: 1_000,
    now: () => nowMs,
    threadId: "thread-detail-cache",
  });

  assert.deepEqual(
    refreshed.messages.map((message) => message.text),
    ["详情短缓存", "文件变化后重新读取"]
  );
});

test("listLocalSessionThreadDetail reads recent messages from the tail of large histories", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-2026-06-30T09-00-00-thread-large-1.jsonl");
  const filler = Array.from({ length: 80 }, (_, index) =>
    JSON.stringify({
      type: "internal_state",
      payload: {
        index,
        blob: "x".repeat(180),
      },
    })
  );
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T09:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/large-mobile",
          session_id: "thread-large-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T09:00:01.000Z",
        type: "event_msg",
        payload: {
          message: "这是很早之前的消息，不应该压到手机详情",
          type: "user_message",
        },
      }),
      ...filler,
      JSON.stringify({
        timestamp: "2026-06-30T09:10:01.000Z",
        type: "event_msg",
        payload: {
          message: "最近用户消息",
          type: "user_message",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T09:10:02.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "最近助手回复", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );

  const detail = listLocalSessionThreadDetail({
    codexHome: root,
    headBytes: 2048,
    limit: 5,
    tailBytes: 2048,
    threadId: "thread-large-1",
  });

  assert.equal(detail.ok, true);
  assert.equal(detail.thread.id, "thread-large-1");
  assert.equal(detail.thread.projectPath, "/repo/large-mobile");
  assert.equal(detail.thread.title, "这是很早之前的消息，不应该压到手机详情");
  assert.equal(detail.metrics.nextEventOffset, fs.statSync(file).size);
  assert.deepEqual(
    detail.messages.map((message) => message.text),
    ["最近用户消息", "最近助手回复"]
  );
});

test("listLocalSessionThreadDetail truncates very large visible messages", () => {
  const root = tempDir();
  const sessionsDir = path.join(root, "sessions", "2026", "06", "30");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-2026-06-30T09-20-00-thread-huge-message.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T09:20:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/repo/huge-message",
          session_id: "thread-huge-message",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T09:20:01.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "a".repeat(14_000), type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );

  const detail = listLocalSessionThreadDetail({ codexHome: root, threadId: "thread-huge-message" });

  assert.equal(detail.ok, true);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].text.length, 12_000);
  assert.equal(detail.messages[0].truncated, true);
});

test("createMobileThreadPayload reports not found without falling back to desktop state", async () => {
  const payload = await createMobileThreadPayload({
    readLocalThreadDetail: () => ({ ok: false }),
    threadId: "missing-thread",
  });

  assert.deepEqual(payload, { ok: false, error: "Thread not found" });
});

test("createMobileThreadPayload reports lightweight transfer metrics", async () => {
  const payload = await createMobileThreadPayload({
    readLocalThreadDetail: () => ({
      messages: [
        { role: "user", text: "只同步这一条", timestamp: "2026-06-30T10:00:00.000Z" },
        { role: "assistant", text: "收到", timestamp: "2026-06-30T10:00:01.000Z", truncated: true },
      ],
      metrics: {
        fileBytes: 900_000,
        headBytesRead: 65_536,
        tailBytesRead: 524_288,
        windowed: true,
      },
      ok: true,
      thread: { id: "thread-metrics", title: "指标" },
    }),
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.metrics.messageCount, 2);
  assert.equal(payload.metrics.truncatedCount, 1);
  assert.equal(payload.metrics.windowed, true);
  assert.ok(payload.metrics.estimatedPayloadBytes > 0);
});

test("mobile thread detail tail window follows requested message limit", () => {
  assert.equal(mobileThreadDetailTailBytesForLimit(40), 128 * 1024);
  assert.equal(mobileThreadDetailTailBytesForLimit(80), 256 * 1024);
  assert.equal(mobileThreadDetailTailBytesForLimit(120), 512 * 1024);
  assert.equal(mobileThreadDetailTailBytesForLimit("bad-limit"), 512 * 1024);
});

test("createMobileThreadEventStream emits only appended visible messages and cleans up on close", async () => {
  const root = tempDir();
  const file = path.join(root, "thread.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "event_msg",
        payload: { message: "旧消息不应该重复推送", type: "user_message" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const harness = createStreamHarness();

  const stream = createMobileThreadEventStream({
    filePath: file,
    pollMs: 10,
    req: harness.req,
    res: harness.res,
    sinceOffset: null,
    threadId: "thread-sse-1",
  });

  assert.equal(harness.res.statusCode, 200);
  assert.equal(harness.res.headers["content-type"], "text/event-stream; charset=utf-8");
  const readyOutput = harness.writes.join("");
  assert.match(readyOutput, /event: ready/);
  assert.match(readyOutput, /retry: 5000/);
  assert.match(readyOutput, new RegExp(`id: ${fs.statSync(file).size}\\n`));

  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:01.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "<environment_context>skip", type: "input_text" }],
          role: "user",
          type: "message",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T08:00:02.000Z",
        type: "event_msg",
        payload: { message: "只推当前会话新增消息", type: "user_message" },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T08:00:03.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "收到，继续只推增量。", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );

  await wait(40);
  const output = harness.writes.join("");
  assert.match(output, /event: message/);
  assert.match(output, /只推当前会话新增消息/);
  assert.match(output, /收到，继续只推增量。/);
  assert.doesNotMatch(output, /旧消息不应该重复推送/);
  assert.doesNotMatch(output, /environment_context/);

  harness.close();
  assert.equal(stream.closed(), true);
});

test("createMobileThreadEventStream resumes from detail snapshot offset", async () => {
  const root = tempDir();
  const file = path.join(root, "thread-offset.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "event_msg",
        payload: { message: "详情快照里已有的消息", type: "user_message" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const snapshotOffset = fs.statSync(file).size;
  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:01.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "连接前写入，也必须补发", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const harness = createStreamHarness();

  const stream = createMobileThreadEventStream({
    filePath: file,
    pollMs: 10,
    req: harness.req,
    res: harness.res,
    sinceOffset: snapshotOffset,
    threadId: "thread-sse-offset",
  });

  await wait(40);
  const output = harness.writes.join("");
  assert.match(output, new RegExp(`id: ${snapshotOffset}\\n`));
  assert.match(output, /连接前写入，也必须补发/);
  assert.doesNotMatch(output, /详情快照里已有的消息/);

  harness.close();
  assert.equal(stream.closed(), true);
});

test("createMobileThreadEventStream reads large appends in bounded chunks", async () => {
  const root = tempDir();
  const file = path.join(root, "thread-large-stream.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "event_msg",
        payload: { message: "初始快照", type: "user_message" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const harness = createStreamHarness();
  const stream = createMobileThreadEventStream({
    chunkBytes: 128,
    filePath: file,
    pendingMaxBytes: 256,
    pollMs: 10,
    req: harness.req,
    res: harness.res,
    sinceOffset: null,
    threadId: "thread-large-stream",
  });

  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        type: "internal_state",
        payload: { blob: "x".repeat(2_000) },
      }),
      JSON.stringify({
        timestamp: "2026-06-30T08:00:01.000Z",
        type: "response_item",
        payload: {
          content: [{ text: "大块内部状态后仍能恢复增量", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      }),
      "",
    ].join("\n"),
    "utf8"
  );

  await wait(260);
  const output = harness.writes.join("");
  assert.match(output, /大块内部状态后仍能恢复增量/);
  assert.doesNotMatch(output, /x{200}/);

  harness.close();
  assert.equal(stream.closed(), true);
});

test("createMobileThreadEventStream releases timers when the response closes", () => {
  const root = tempDir();
  const file = path.join(root, "thread-response-close.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-06-30T08:00:00.000Z",
        type: "event_msg",
        payload: { message: "初始快照", type: "user_message" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const harness = createStreamHarness();
  const stream = createMobileThreadEventStream({
    filePath: file,
    pollMs: 10,
    req: harness.req,
    res: harness.res,
    sinceOffset: null,
    threadId: "thread-response-close",
  });

  assert.equal(stream.closed(), false);
  harness.resClose();
  assert.equal(stream.closed(), true);
});

test("createMobileTurnStartPayload keeps phone send payload minimal", () => {
  const payload = createMobileTurnStartPayload({
    localSendId: "local-1",
    text: "手机流量下只发送当前增量",
    threadId: "thread-send-1",
  });

  assert.equal(payload.method, "turn/start");
  assert.equal(payload.request.method, "turn/start");
  assert.equal(payload.request.params.threadId, "thread-send-1");
  assert.equal(payload.request.params.input, "手机流量下只发送当前增量");
  assert.equal(payload.request.params.localSendId, "local-1");
  assert.equal(payload.request.params.source, "opencodex-mobile-lite");
  assert.deepEqual(Object.keys(payload.request.params).sort(), ["input", "localSendId", "prompt", "source", "threadId"]);
});

test("mobile turn handler validates text and sends through injected turn/start bridge", async () => {
  const calls = [];
  const api = createMobileApi({
    fastSyncCache: { readSnapshot: () => null },
    invokeTurnStart: async (payload) => {
      calls.push(payload);
      return { acceptedByMock: true };
    },
  });

  const response = await collectResponse(
    (req, res) => api.handleThreadTurn(req, res, new URL("http://127.0.0.1/api/mobile/thread/thread-send-1/turns"), "thread-send-1"),
    jsonPostReq({ localSendId: "local-2", text: "继续压缩手机端状态" })
  );

  assert.equal(response.statusCode, 202);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "mobile-lite");
  assert.equal(body.localSendId, "local-2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.params.threadId, "thread-send-1");
  assert.equal(calls[0].request.params.input, "继续压缩手机端状态");
});

test("mobile turn handler accepts quickly without waiting for official runtime delivery", async () => {
  const calls = [];
  let releaseDelivery = null;
  const delivery = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  const api = createMobileApi({
    fastSyncCache: { readSnapshot: () => null },
    invokeTurnStart: async (payload) => {
      calls.push(payload);
      await delivery;
      return { acceptedByMock: true };
    },
  });

  const responsePromise = collectResponse(
    (req, res) => api.handleThreadTurn(req, res, new URL("http://127.0.0.1/api/mobile/thread/thread-send-fast/turns"), "thread-send-fast"),
    jsonPostReq({ localSendId: "local-fast", text: "手机先恢复可操作，后续靠当前会话增量同步" })
  );
  const response = await Promise.race([responsePromise, wait(25).then(() => null)]);

  assert.ok(response, "mobile handler should respond before official runtime delivery resolves");
  assert.equal(response.statusCode, 202);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.delivery, "queued");
  assert.equal(body.localSendId, "local-fast");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.params.threadId, "thread-send-fast");
  releaseDelivery({ acceptedByMock: true });
});

test("mobile turn handler coalesces repeated local send ids", async () => {
  let invokeCount = 0;
  const api = createMobileApi({
    fastSyncCache: { readSnapshot: () => null },
    invokeTurnStart: async () => {
      invokeCount += 1;
      return { acceptedByMock: true };
    },
  });
  const url = new URL("http://127.0.0.1/api/mobile/thread/thread-send-2/turns");
  const first = await collectResponse(
    (req, res) => api.handleThreadTurn(req, res, url, "thread-send-2"),
    jsonPostReq({ localSendId: "same-send", text: "第一次提交" })
  );
  const second = await collectResponse(
    (req, res) => api.handleThreadTurn(req, res, url, "thread-send-2"),
    jsonPostReq({ localSendId: "same-send", text: "第一次提交" })
  );

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(JSON.parse(second.body).duplicate, true);
  assert.equal(invokeCount, 1);
});

test("mobile turn handler rejects empty message text", async () => {
  const api = createMobileApi({
    fastSyncCache: { readSnapshot: () => null },
    invokeTurnStart: () => assert.fail("empty text should not invoke official runtime"),
  });

  const response = await collectResponse(
    (req, res) => api.handleThreadTurn(req, res, new URL("http://127.0.0.1/api/mobile/thread/thread-send-3/turns"), "thread-send-3"),
    jsonPostReq({ text: "   " })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "Missing message text");
});

test("request handler keeps the official shell for mobile browsers and enables traffic slimming", async () => {
  const { createRequestHandler } = require("../runtime/server.cjs");
  const staticAssets = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => null,
  });
  const handler = createRequestHandler({
    localFiles: {},
    mobileApi: { handleBootstrap: () => assert.fail("mobile bootstrap should not handle shell HTML") },
    pickedFiles: {},
    staticAssets,
  });

  const response = await collectResponse(handler, {
    headers: {
      accept: "text/html",
      host: "127.0.0.1:8080",
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/",
  });

  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /data-opencodex-mobile-lite/);
  assert.match(response.body, /mobileTrafficMode":true/);
  assert.match(response.body, /opencodex-plugin-system/);
  assert.match(response.body, /config\.mobileTrafficMode\) return/);
});

test("request handler serves the official renderer directly when it is available", async () => {
  const { createRequestHandler } = require("../runtime/server.cjs");
  const calls = [];
  const staticAssets = {
    createRendererResponse(options) {
      calls.push(options);
      // 已认证/免密入口直接返回官方 renderer，避免登录壳再 document.write 造成空白页。
      return options && options.mobileTrafficMode
        ? '<html><head><script src="/codex-web-config.js"></script><!-- mobile renderer --></head><body><div id="root">official mobile</div></body></html>'
        : '<html><head><script src="/opencodex-plugin-loader.js"></script></head><body><div id="root">official desktop</div></body></html>';
    },
    isAppShellRoute: (req, pathname) => req.method === "GET" && (pathname === "/" || pathname === "/m"),
    isPublicStaticPath: () => false,
    staticFile: () => null,
    serveWebShellIndex: () => assert.fail("authenticated app shell should not fall back to login shell"),
  };
  const handler = createRequestHandler({
    localFiles: {},
    mobileApi: { handleBootstrap: () => assert.fail("mobile bootstrap should not handle shell HTML") },
    pickedFiles: {},
    staticAssets,
  });

  const desktop = await collectResponse(handler, {
    headers: { accept: "text/html", host: "127.0.0.1:8080", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/",
  });
  const mobile = await collectResponse(handler, {
    headers: {
      accept: "text/html",
      host: "127.0.0.1:8080",
      "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36",
    },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/",
  });

  assert.equal(desktop.statusCode, 200);
  assert.equal(mobile.statusCode, 200);
  assert.match(desktop.body, /official desktop/);
  assert.match(mobile.body, /official mobile/);
  assert.equal(calls[0].mobileTrafficMode, false);
  assert.equal(calls[1].mobileTrafficMode, true);
});

test("request handler no longer serves a standalone mobile-lite shell at /m", async () => {
  const { createRequestHandler } = require("../runtime/server.cjs");
  const staticAssets = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => null,
  });
  const handler = createRequestHandler({
    localFiles: {},
    mobileApi: { handleBootstrap: () => assert.fail("mobile bootstrap should not handle shell HTML") },
    pickedFiles: {},
    staticAssets,
  });

  const response = await collectResponse(handler, {
    headers: { accept: "text/html", host: "127.0.0.1:8080" },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/m",
  });

  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /data-opencodex-mobile-lite/);
  assert.match(response.body, /opencodex-plugin-loader/);
});

test("request handler keeps desktop and explicit mobile full mode on the full extension profile", async () => {
  const { createRequestHandler } = require("../runtime/server.cjs");
  const staticAssets = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => null,
  });
  const handler = createRequestHandler({
    localFiles: {},
    mobileApi: { handleBootstrap: () => assert.fail("mobile bootstrap should not handle shell HTML") },
    pickedFiles: {},
    staticAssets,
  });
  const desktop = await collectResponse(handler, {
    headers: { accept: "text/html", host: "127.0.0.1:8080", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/",
  });
  const explicitFull = await collectResponse(handler, {
    headers: {
      accept: "text/html",
      host: "127.0.0.1:8080",
      "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36",
    },
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/?full=1",
  });

  assert.equal(desktop.statusCode, 200);
  assert.equal(explicitFull.statusCode, 200);
  assert.doesNotMatch(desktop.body, /data-opencodex-mobile-lite/);
  assert.doesNotMatch(explicitFull.body, /data-opencodex-mobile-lite/);
  assert.doesNotMatch(desktop.body, /mobileTrafficMode":true/);
  assert.doesNotMatch(explicitFull.body, /mobileTrafficMode":true/);
  assert.match(desktop.body, /opencodex-plugin-loader/);
  assert.match(explicitFull.body, /opencodex-plugin-loader/);
});
