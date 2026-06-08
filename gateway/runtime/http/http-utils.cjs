const zlib = require("zlib");

// HTTP helper 保持无业务状态，供认证、静态资源和 server 路由复用。
function headerValue(headers, name) {
  // Node 会把大多数 header 规范化为小写，但这里仍做一次大小写无关查找，兼容测试构造对象。
  const normalized = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

function send(res, status, headers, body) {
  // 所有响应都走这个出口，便于后续统一加安全 header 或日志。
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value, extraHeaders = {}) {
  // 统一 JSON 缩进，方便直接 curl /api/health 时读状态。
  send(
    res,
    status,
    { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    JSON.stringify(value, null, 2)
  );
}

function gzipIfUseful(req, headers, body) {
  // 小响应压缩收益低，且会增加调试成本，只对较大的文本/wasm 类资源启用 gzip。
  if (process.env.CODEX_WEB_DISABLE_GZIP === "1" || !Buffer.isBuffer(body) || body.length < 1024) return { headers, body };
  if (!String(req.headers["accept-encoding"] || "").includes("gzip")) return { headers, body };
  const contentType = String(headers["content-type"] || "");
  if (!/javascript|css|html|json|svg|wasm/i.test(contentType)) return { headers, body };
  return {
    headers: { ...headers, "content-encoding": "gzip", vary: "Accept-Encoding" },
    body: zlib.gzipSync(body),
  };
}

/** 读取完整请求体，用于 JSON POST 和登录表单。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

module.exports = {
  gzipIfUseful,
  headerValue,
  readBody,
  send,
  sendJson,
};
