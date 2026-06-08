const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  CODEX_GENERATED_IMAGES_DIR,
  CODEX_WEB_PICKED_FILES_DIR,
  LOCAL_FILE_TOKEN_TTL_MS,
  isWithinRoot,
  mimeType,
  workspaceRootsFromEnv,
} = require("../core/config.cjs");
const { send } = require("./http-utils.cjs");

// 本模块只处理“浏览器临时预览本机文件”，所有入口都必须有 allowlist 或短期 token。
/** Content-Disposition 文件名兜底，避免特殊字符破坏 inline 预览 header。 */
function safeInlineFilename(filePath) {
  return path.basename(filePath).replace(/["\r\n]/g, "_") || "file";
}

/** 解析官方 renderer 里的 app://fs/@fs/... 图片 URL 到本机绝对路径。 */
function appFsPathFromRequestPath(pathname) {
  // 前端会把 app://fs/@fs/Users/a.png 改写为 /api/app-fs/@fs/Users/a.png。
  const prefix = "/api/app-fs/@fs/";
  if (!pathname.startsWith(prefix)) return null;
  try {
    const decoded = decodeURIComponent(pathname.slice(prefix.length));
    const filePath = path.normalize(`/${decoded}`);
    return path.isAbsolute(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

/** app://fs 只服务 Codex 生成图、Web 附件临时目录和当前允许的 workspace roots。 */
function isAllowedAppFsFile(filePath) {
  /**
   * app://fs 入口没有单独 token，因此必须限定目录：
   * - Codex 生成图片目录。
   * - Web 上传/选择文件临时目录。
   * - launcher 注入的 workspace roots。
   */
  const roots = [CODEX_GENERATED_IMAGES_DIR, CODEX_WEB_PICKED_FILES_DIR, ...workspaceRootsFromEnv()];
  return roots.some((root) => typeof root === "string" && root.length > 0 && isWithinRoot(filePath, root));
}

function createLocalFileService() {
  // token 仅保存在内存中，重启 gateway 后自动失效，不把本机绝对路径持久化到前端。
  const localFileTokens = new Map();

  /**
   * 生成本地文件预览 URL。
   *
   * 浏览器拿到的是带 token 的 /api/local-file/... URL，不能直接读取本机任意路径。
   */
  function createLocalFilePreview(filePath) {
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAtMs = Date.now() + LOCAL_FILE_TOKEN_TTL_MS;
    localFileTokens.set(token, { filePath, expiresAtMs });
    const name = encodeURIComponent(path.basename(filePath));
    return {
      opened: true,
      path: filePath,
      name: path.basename(filePath),
      url: `/api/local-file/${token}/${name}`,
      expiresAtMs,
    };
  }

  /** 定期清理本地文件预览 token，避免 token 长期有效。 */
  function pruneLocalFileTokens() {
    const now = Date.now();
    for (const [token, entry] of localFileTokens) {
      if (!entry || entry.expiresAtMs <= now) localFileTokens.delete(token);
    }
  }

  const localFileTokenTimer = setInterval(pruneLocalFileTokens, Math.min(60 * 1000, LOCAL_FILE_TOKEN_TTL_MS));
  if (localFileTokenTimer && typeof localFileTokenTimer.unref === "function") localFileTokenTimer.unref();

  /** 发送 app://fs 映射后的本机图片/文件；所有路径都必须先过 allowlist。 */
  function serveAppFsFile(pathname, res) {
    // 先解析并校验 allowlist，再 stat/read，避免错误信息泄露任意路径是否存在。
    const filePath = appFsPathFromRequestPath(pathname);
    if (!filePath || !isAllowedAppFsFile(filePath)) {
      return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not allowed.");
    }
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Not a file.");
      }
      return send(
        res,
        200,
        {
          "content-type": mimeType(filePath),
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${safeInlineFilename(filePath)}"`,
        },
        fs.readFileSync(filePath)
      );
    } catch {
      return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not found.");
    }
  }

  function serveLocalFile(pathname, res) {
    // /api/local-file/:token/:name 里的 name 只用于浏览器展示，真实路径只来自 token 映射。
    const parts = pathname.split("/");
    const token = parts[3] || "";
    const entry = localFileTokens.get(token);
    if (!entry || entry.expiresAtMs <= Date.now()) {
      // 过期 token 立即删除，防止同一链接反复探测本机文件状态。
      localFileTokens.delete(token);
      return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File preview expired.");
    }
    try {
      const stats = fs.statSync(entry.filePath);
      if (!stats.isFile()) {
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Not a file.");
      }
      const data = fs.readFileSync(entry.filePath);
      return send(
        res,
        200,
        {
          "content-type": mimeType(entry.filePath),
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${safeInlineFilename(entry.filePath)}"`,
        },
        data
      );
    } catch {
      localFileTokens.delete(token);
      return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not found.");
    }
  }

  function dispose() {
    // server shutdown 时清空 token，避免测试或重启时旧链接继续可用。
    clearInterval(localFileTokenTimer);
    localFileTokens.clear();
  }

  return {
    createLocalFilePreview,
    dispose,
    serveAppFsFile,
    serveLocalFile,
  };
}

module.exports = { createLocalFileService, safeInlineFilename };
