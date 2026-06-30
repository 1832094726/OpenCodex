const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createMobileBootstrapPayload,
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
  assert.deepEqual(payload.threads, [
    {
      archived: false,
      id: "thread-2",
      projectPath: "/repo/opencodex",
      title: "弱网下打开最近会话",
      updatedAt: 800,
    },
  ]);
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
});
