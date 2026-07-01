#!/usr/bin/env node
const fs = require("node:fs");
const { request } = require("node:http");
const { request: secureRequest } = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const DEFAULT_BASE_URL = "http://127.0.0.1:3737";
const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_OUTPUT_FILE = path.join(os.tmpdir(), `opencodex-weak-network-${Date.now()}.jsonl`);

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function configFromEnv() {
  return {
    baseUrl: process.env.OPENCODEX_WEAK_OBSERVER_BASE_URL || DEFAULT_BASE_URL,
    clientId: process.env.OPENCODEX_WEAK_OBSERVER_CLIENT_ID || "",
    durationMs: numberFromEnv("OPENCODEX_WEAK_OBSERVER_DURATION_MS", DEFAULT_DURATION_MS),
    intervalMs: numberFromEnv("OPENCODEX_WEAK_OBSERVER_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    outputFile: process.env.OPENCODEX_WEAK_OBSERVER_OUTPUT || DEFAULT_OUTPUT_FILE,
    threadId: process.env.OPENCODEX_WEAK_OBSERVER_THREAD_ID || "",
  };
}

function resolveUrl(baseUrl, pathname) {
  return new URL(pathname, baseUrl).toString();
}

function requestJson(url) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? secureRequest : request;
  const startedAt = process.hrtime.bigint();
  return new Promise((resolve) => {
    const req = client(
      target,
      {
        headers: {
          accept: "application/json,text/plain;q=0.8,*/*;q=0.5",
          "user-agent": "OpenCodexWeakNetworkObserver/1.0",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({
            bodyBytes: Buffer.byteLength(body),
            durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
            json,
            status: res.statusCode || 0,
            url,
          });
        });
      }
    );
    req.on("error", (error) => {
      resolve({
        bodyBytes: 0,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
        error: error && error.message ? error.message : String(error),
        json: null,
        status: 0,
        url,
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error(`timeout ${url}`)));
    req.end();
  });
}

function summarizeFlow(flow) {
  const json = flow && flow.json && typeof flow.json === "object" ? flow.json : {};
  return {
    connection: json.connection && json.connection.state ? json.connection.state : "",
    relay: json.relay && json.relay.state ? json.relay.state : "",
    thread: json.thread && json.thread.state ? json.thread.state : "",
    transport: json.connection && json.connection.transport ? json.connection.transport : "",
    turn: json.turn && json.turn.state ? json.turn.state : "",
  };
}

function summarizeThreadDiagnostics(threadDiagnostics) {
  const json = threadDiagnostics && threadDiagnostics.json && typeof threadDiagnostics.json === "object" ? threadDiagnostics.json : {};
  const thread = Array.isArray(json.threads) && json.threads[0] ? json.threads[0] : {};
  const latestKnownThreadSeq = Math.max(0, Number(thread.latestKnownThreadSeq) || 0);
  const watermarks = Array.isArray(thread.clientWatermarks) ? thread.clientWatermarks : [];
  return {
    clientCount: watermarks.length,
    latestKnownThreadSeq,
    maxLag: watermarks.reduce((max, item) => {
      const cursor = Math.max(0, Number(item && item.threadCursor) || 0);
      return Math.max(max, latestKnownThreadSeq - cursor);
    }, 0),
    missedByTransport: Math.max(0, Number(thread.missedByTransport) || 0),
    repairedBySnapshot: Math.max(0, Number(thread.repairedBySnapshot) || 0),
    repairedByThreadReplay: Math.max(0, Number(thread.repairedByThreadReplay) || 0),
  };
}

async function sample(config) {
  const flowParams = new URLSearchParams({ limit: "20" });
  if (config.clientId) flowParams.set("clientId", config.clientId);
  const health = await requestJson(resolveUrl(config.baseUrl, "/api/health"));
  const flow = await requestJson(resolveUrl(config.baseUrl, `/api/diagnostics/flow?${flowParams.toString()}`));
  const threadDiagnostics = config.threadId
    ? await requestJson(
        resolveUrl(config.baseUrl, `/api/diagnostics/threads?threadId=${encodeURIComponent(config.threadId)}&limit=1`)
      )
    : null;
  return {
    at: new Date().toISOString(),
    flow: {
      durationMs: flow.durationMs,
      status: flow.status,
      ...summarizeFlow(flow),
    },
    health: {
      durationMs: health.durationMs,
      status: health.status,
    },
    thread: threadDiagnostics
      ? {
          durationMs: threadDiagnostics.durationMs,
          status: threadDiagnostics.status,
          ...summarizeThreadDiagnostics(threadDiagnostics),
        }
      : null,
  };
}

async function observeWeakNetwork() {
  const config = configFromEnv();
  fs.mkdirSync(path.dirname(config.outputFile), { recursive: true });
  const startedAt = Date.now();
  console.log(`OpenCodex weak-network observer base=${config.baseUrl}`);
  console.log(`output=${config.outputFile}`);
  if (!config.threadId) console.log("thread diagnostics disabled: set OPENCODEX_WEAK_OBSERVER_THREAD_ID");

  do {
    const record = await sample(config);
    fs.appendFileSync(config.outputFile, `${JSON.stringify(record)}\n`, "utf8");
    // 控制台只打印高信号摘要，完整证据写入 JSONL。
    console.log(
      `${record.at} health=${record.health.status}/${record.health.durationMs}ms flow=${record.flow.status}/${record.flow.durationMs}ms relay=${record.flow.relay || "-"} turn=${record.flow.turn || "-"}${record.thread ? ` lag=${record.thread.maxLag} repair=${record.thread.repairedByThreadReplay}/${record.thread.repairedBySnapshot}` : ""}`
    );
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  } while (Date.now() - startedAt <= config.durationMs);
}

observeWeakNetwork().catch((error) => {
  console.error(`Weak-network observer failed: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
