const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createMobileApi,
  createMobileBootstrapPayload,
  createMobileThreadPayload,
  createMobileThreadEventStream,
  createMobileTurnStartPayload,
  listLocalSessionThreadDetail,
  listLocalSessionThreads,
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
  };
  return {
    close() {
      if (events.close) events.close();
    },
    req,
    res,
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

test("createMobileBootstrapPayload returns stale-first empty state without blocking on live runtime", async () => {
  const payload = await createMobileBootstrapPayload({
    readThreadListSnapshot: () => null,
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "mobile-lite");
  assert.equal(payload.source, "empty");
  assert.deepEqual(payload.threads, []);
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

  const first = listLocalSessionThreads({ cacheTtlMs: 1_000, codexHome: root, limit: 5, now: () => 10_000 });
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

  const cached = listLocalSessionThreads({ cacheTtlMs: 1_000, codexHome: root, limit: 5, now: () => 10_500 });
  const refreshed = listLocalSessionThreads({ cacheTtlMs: 1_000, codexHome: root, limit: 5, now: () => 11_500 });

  assert.deepEqual(first.map((thread) => thread.id), ["thread-cache-1"]);
  assert.deepEqual(cached.map((thread) => thread.id), ["thread-cache-1"]);
  assert.deepEqual(refreshed.map((thread) => thread.id), ["thread-cache-2", "thread-cache-1"]);
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

test("request handler serves the mobile-lite shell at /m before the full app shell fallback", async () => {
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
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /data-opencodex-mobile-lite/);
  assert.match(response.body, /<style data-mobile-inline>/);
  assert.match(response.body, /<script data-mobile-inline>/);
  assert.doesNotMatch(response.body, /href="\/mobile\.css"/);
  assert.doesNotMatch(response.body, /src="\/mobile\.js"/);
});

test("request handler serves the mobile-lite shell for thread deep links", async () => {
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
    url: "/m/thread/thread-detail-1",
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /data-opencodex-mobile-lite/);
});
