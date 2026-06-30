const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const test = require("node:test");
const zlib = require("node:zlib");
const { isRequestBodyTooLargeError, readBody, sendJsonCompressed } = require("../runtime/http/http-utils.cjs");

function requestFromChunks(chunks) {
  return Readable.from(chunks);
}

test("readBody keeps existing behavior when maxBytes is not exceeded", async () => {
  const req = requestFromChunks([Buffer.from("hello"), Buffer.from(" world")]);

  assert.equal(await readBody(req, { maxBytes: 32 }), "hello world");
});

test("readBody rejects with a recognizable error when maxBytes is exceeded", async () => {
  const req = requestFromChunks([Buffer.alloc(8_193)]);

  // 登录接口依赖这个错误类型转换为 413，避免大 body 被完整缓存到内存。
  await assert.rejects(readBody(req, { maxBytes: 8 * 1_024 }), (error) => {
    assert.equal(isRequestBodyTooLargeError(error), true);
    assert.equal(error.statusCode, 413);
    assert.equal(error.maxBytes, 8 * 1_024);
    return true;
  });
});

test("sendJsonCompressed gzips sizeable JSON when the client accepts it", () => {
  const chunks = [];
  const res = {
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
  };

  sendJsonCompressed(
    { headers: { "accept-encoding": "gzip, deflate" } },
    res,
    200,
    { ok: true, text: "手机弱网 JSON 压缩".repeat(200) },
    { "cache-control": "no-store" }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(res.headers.vary, "Accept-Encoding");
  assert.equal(JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString("utf8")).ok, true);
});
