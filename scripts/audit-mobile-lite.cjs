#!/usr/bin/env node
const { request } = require("node:http");
const { request: secureRequest } = require("node:https");
const { URL } = require("node:url");
const zlib = require("node:zlib");

const DEFAULT_BASE_URL = "http://127.0.0.1:3737";
const DEFAULT_BOOTSTRAP_LIMIT = 50;
const DEFAULT_THREAD_LIMIT = 120;
const DEFAULT_WARN_BODY_BYTES = 256 * 1024;
const DEFAULT_WARN_DURATION_MS = 1_500;
const MOBILE_AUDIT_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function auditConfig() {
  return {
    baseUrl: process.env.OPENCODEX_MOBILE_AUDIT_BASE_URL || DEFAULT_BASE_URL,
    bootstrapLimit: numberFromEnv("OPENCODEX_MOBILE_AUDIT_BOOTSTRAP_LIMIT", DEFAULT_BOOTSTRAP_LIMIT),
    threadId: process.env.OPENCODEX_MOBILE_AUDIT_THREAD_ID || "",
    threadLimit: numberFromEnv("OPENCODEX_MOBILE_AUDIT_THREAD_LIMIT", DEFAULT_THREAD_LIMIT),
    warnBodyBytes: numberFromEnv("OPENCODEX_MOBILE_AUDIT_WARN_BODY_BYTES", DEFAULT_WARN_BODY_BYTES),
    warnDurationMs: numberFromEnv("OPENCODEX_MOBILE_AUDIT_WARN_DURATION_MS", DEFAULT_WARN_DURATION_MS),
  };
}

function resolveUrl(baseUrl, pathname) {
  return new URL(pathname, baseUrl).toString();
}

function decodeBody(buffer, encoding) {
  const normalized = String(encoding || "").toLowerCase();
  if (normalized.includes("gzip")) return zlib.gunzipSync(buffer);
  if (normalized.includes("br")) return zlib.brotliDecompressSync(buffer);
  if (normalized.includes("deflate")) return zlib.inflateSync(buffer);
  return buffer;
}

function requestOnce(url, headers = {}) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? secureRequest : request;
  const startedAt = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const req = client(
      target,
      {
        headers: {
          accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "accept-encoding": "gzip,br,deflate",
          "user-agent": MOBILE_AUDIT_USER_AGENT,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          let decodedBody = rawBody;
          try {
            decodedBody = decodeBody(rawBody, res.headers["content-encoding"]);
          } catch {}
          resolve({
            body: decodedBody,
            bodyBytes: rawBody.length,
            decodedBytes: decodedBody.length,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            etag: typeof res.headers.etag === "string" ? res.headers.etag : "",
            headers: res.headers,
            status: res.statusCode || 0,
            url,
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Request timed out after 10000ms: ${url}`));
    });
    req.end();
  });
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function summarizeResult(name, result, payload = null) {
  const metrics = payload && payload.metrics && typeof payload.metrics === "object" ? payload.metrics : {};
  return {
    bodyBytes: result.bodyBytes,
    decodedBytes: result.decodedBytes,
    durationMs: Math.round(result.durationMs),
    estimatedPayloadBytes: Number(metrics.estimatedPayloadBytes || 0),
    etag: result.etag || "",
    name,
    source: payload && payload.source ? payload.source : "",
    status: result.status,
    url: result.url,
  };
}

function isNotModified(result) {
  return result && result.status === 304;
}

function printSummary(summary, config) {
  const warnings = [];
  if (summary.status >= 500 || summary.status === 0) warnings.push("bad-status");
  if (summary.durationMs > config.warnDurationMs) warnings.push("slow");
  if (summary.bodyBytes > config.warnBodyBytes) warnings.push("large-body");
  const suffix = warnings.length ? ` WARN=${warnings.join(",")}` : "";
  console.log(
    `${summary.name}: status=${summary.status} durationMs=${summary.durationMs} bodyBytes=${summary.bodyBytes} decodedBytes=${summary.decodedBytes} estimatedPayloadBytes=${summary.estimatedPayloadBytes}${summary.etag ? ` etag=${summary.etag}` : ""}${summary.source ? ` source=${summary.source}` : ""}${suffix}`
  );
}

async function auditMobileLite() {
  const config = auditConfig();
  console.log(`Mobile official-shell audit base=${config.baseUrl}`);

  const shell = await requestOnce(resolveUrl(config.baseUrl, "/"));
  printSummary(summarizeResult("shell", shell), config);
  const shellText = shell.body.toString("utf8");
  if (!shellText.includes("mobileTrafficMode")) {
    throw new Error("Expected mobile official shell to enable mobileTrafficMode");
  }
  if (shellText.includes("data-opencodex-mobile-lite")) {
    throw new Error("Standalone mobile-lite shell should not be served from the phone root");
  }

  const bootstrapPath = `/api/mobile/bootstrap?limit=${encodeURIComponent(String(config.bootstrapLimit))}`;
  const bootstrap = await requestOnce(resolveUrl(config.baseUrl, bootstrapPath));
  const bootstrapPayload = parseJson(bootstrap.body);
  const bootstrapSummary = summarizeResult("bootstrap", bootstrap, bootstrapPayload);
  printSummary(bootstrapSummary, config);

  if (bootstrap.etag) {
    const cachedBootstrap = await requestOnce(resolveUrl(config.baseUrl, bootstrapPath), { "if-none-match": bootstrap.etag });
    const cachedSummary = summarizeResult("bootstrap-304", cachedBootstrap);
    printSummary(cachedSummary, config);
    if (!isNotModified(cachedBootstrap)) {
      throw new Error(`Expected bootstrap 304 with if-none-match, got ${cachedBootstrap.status}`);
    }
  }

  const firstThreadId =
    config.threadId ||
    (bootstrapPayload && Array.isArray(bootstrapPayload.threads) && bootstrapPayload.threads[0] && bootstrapPayload.threads[0].id) ||
    "";
  if (!firstThreadId) {
    console.log("thread: skipped no OPENCODEX_MOBILE_AUDIT_THREAD_ID or bootstrap thread");
    return;
  }

  const threadId = firstThreadId;
  const threadPath = `/api/mobile/thread/${encodeURIComponent(threadId)}?limit=${encodeURIComponent(String(config.threadLimit))}`;
  const thread = await requestOnce(resolveUrl(config.baseUrl, threadPath));
  const threadPayload = parseJson(thread.body);
  printSummary(summarizeResult("thread", thread, threadPayload), config);

  if (thread.etag && thread.status === 200) {
    const cachedThread = await requestOnce(resolveUrl(config.baseUrl, threadPath), { "if-none-match": thread.etag });
    const cachedThreadSummary = summarizeResult("thread-304", cachedThread);
    printSummary(cachedThreadSummary, config);
    if (!isNotModified(cachedThread)) {
      throw new Error(`Expected thread 304 with if-none-match, got ${cachedThread.status}`);
    }
  }
}

auditMobileLite().catch((error) => {
  console.error(`Mobile official-shell audit failed: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
