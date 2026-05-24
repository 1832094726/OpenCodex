// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");

let nodePty = null;
try {
  nodePty = require("node-pty");
} catch {}

const TERMINAL_REPLAY_BUFFER_LIMIT = 128 * 1024;
const TERMINAL_SNAPSHOT_BUFFER_LIMIT = 16 * 1024;
const TERMINAL_IDLE_CLEANUP_MS = Math.max(
  1_000,
  Number(process.env.CODEX_WEB_TERMINAL_IDLE_CLEANUP_MS || 30 * 60 * 1000)
);
const TERMINAL_IDLE_SWEEP_MS = Math.max(
  1_000,
  Number(process.env.CODEX_WEB_TERMINAL_IDLE_SWEEP_MS || Math.min(60 * 1000, TERMINAL_IDLE_CLEANUP_MS))
);
const WINDOWS_BASE_SHELL_OPTIONS = ["powershell", "commandPrompt"];

function chmodExecutableIfPresent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if ((stat.mode & 0o111) !== 0o111) {
      fs.chmodSync(filePath, stat.mode | 0o755);
    }
    return true;
  } catch {
    return false;
  }
}

/** 列出 node-pty 可能使用的 Unix spawn-helper；pnpm/预编译/源码构建路径都要覆盖。 */
function listNodePtySpawnHelperPaths(nodePtyRoot) {
  const helperPaths = [
    path.join(nodePtyRoot, "build", "Release", "spawn-helper"),
    path.join(nodePtyRoot, "build", "Debug", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
  const prebuildsDir = path.join(nodePtyRoot, "prebuilds");
  try {
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        helperPaths.push(path.join(prebuildsDir, entry.name, "spawn-helper"));
      }
    }
  } catch {}
  return [...new Set(helperPaths)];
}

/** Unix 平台需要 spawn-helper 有执行位；部分包管理/解压流程会把它还原成 0644。 */
function ensureNodePtySpawnHelperExecutable(logger) {
  if (process.platform === "win32") return;
  let nodePtyRoot = null;
  try {
    nodePtyRoot = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  } catch {
    return;
  }
  let fixed = false;
  for (const helperPath of listNodePtySpawnHelperPaths(nodePtyRoot)) {
    fixed = chmodExecutableIfPresent(helperPath) || fixed;
  }
  if (fixed && logger && typeof logger.info === "function") {
    logger.info("[terminal] ensured node-pty spawn-helper is executable");
  }
}

/** 兼容 renderer 直接传 params 或 fetchFromHost 包一层 params 的两种 payload。 */
function paramsFromPayload(payload) {
  return payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
    ? payload.params
    : payload;
}

/** 官方不同入口会用 conversationId/threadId/sessionId 指代同一个 thread 维度。 */
function conversationIdFromPayload(payload) {
  const params = paramsFromPayload(payload);
  if (!params || typeof params !== "object") return "";
  const value = params.conversationId || params.threadId || params.sessionId || "";
  return typeof value === "string" ? value : "";
}

/** terminal title 不能带控制字符，否则会污染 tab 标题和快照。 */
function cleanTerminalTitle(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, "").trim() : null;
}

function executableFileExists(filePath) {
  try {
    return !!filePath && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pathEnvironmentEntries() {
  const rawPath = process.env.Path || process.env.PATH || "";
  return rawPath.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function executablesOnPath(fileName) {
  return pathEnvironmentEntries()
    .map((entry) => path.join(entry, fileName))
    .filter(executableFileExists);
}

function windowsGitBashCandidates() {
  const installRoots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
  ].filter(Boolean);
  const candidates = [];
  for (const root of installRoots) {
    candidates.push(
      path.join(root, "Git", "git-bash.exe"),
      path.join(root, "Git", "bin", "bash.exe"),
      path.join(root, "Git", "usr", "bin", "bash.exe")
    );
  }
  return candidates;
}

function looksLikeGitForWindowsPath(filePath) {
  const normalized = String(filePath || "").replace(/\//g, "\\");
  return /\\Git\\(git-bash\.exe|bin\\bash\.exe|usr\\bin\\bash\.exe)$/i.test(normalized);
}

function hasGitBashShell() {
  // 官方设置页只需要知道 Git Bash 选项是否可展示，这里按常见安装路径和 PATH 做本地探测。
  if (windowsGitBashCandidates().some(executableFileExists)) return true;
  if (executablesOnPath("git-bash.exe").some(looksLikeGitForWindowsPath)) return true;
  return executablesOnPath("bash.exe").some(looksLikeGitForWindowsPath);
}

function hasWslShell() {
  // 32 位宿主访问 64 位 System32 时需要 Sysnative；两者都检查可以贴近官方桌面端的可用性判断。
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidates = [
    path.join(systemRoot, "System32", "wsl.exe"),
    path.join(systemRoot, "Sysnative", "wsl.exe"),
    ...executablesOnPath("wsl.exe"),
  ];
  return candidates.some(executableFileExists);
}

function createTerminalIpcHandlers(deps) {
  const terminalSessions = new Map();
  const conversationSessions = new Map();
  ensureNodePtySpawnHelperExecutable(deps.logger);

  /** 终端事件广播给 web-shell，最终由 renderer 的终端组件消费。 */
  function broadcastTerminal(channel, payload) {
    if (typeof deps.broadcast === "function") {
      deps.broadcast({ channel, payload });
    }
  }


  /** 选择 PTY shell，默认跟随用户 SHELL。 */
  function getTerminalShell() {
    return process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  }

  function terminalShellOptions() {
    if (process.platform !== "win32") return { availableShells: [] };
    const availableShells = [...WINDOWS_BASE_SHELL_OPTIONS];
    if (hasGitBashShell()) availableShells.push("gitBash");
    if (hasWslShell()) availableShells.push("wsl");
    return { availableShells };
  }

  /** 从 invoke context 中取浏览器 clientId。 */
  function contextClientId(context) {
    return context && typeof context === "object" && typeof context.clientId === "string"
      ? context.clientId
      : "";
  }

  /** 更新终端会话活跃时间，并记录最近使用它的浏览器 clientId。 */
  function touchTerminalSession(session, context) {
    if (!session) return;
    session.lastActivityMs = Date.now();
    const clientId = contextClientId(context);
    if (clientId) session.clientIds.add(clientId);
  }

  function rememberConversationSession(sessionId, conversationId) {
    if (!sessionId || !conversationId) return;
    conversationSessions.set(String(conversationId), sessionId);
  }

  function forgetConversationSession(sessionId) {
    if (!sessionId) return;
    for (const [conversationId, mappedSessionId] of conversationSessions) {
      if (mappedSessionId === sessionId) conversationSessions.delete(conversationId);
    }
  }

  /** 判断终端会话是否仍有任何在线浏览器在使用。 */
  function terminalSessionHasConnectedClient(session) {
    if (!session || !session.clientIds || session.clientIds.size === 0) return false;
    for (const clientId of session.clientIds) {
      if (deps.isClientConnected(clientId)) return true;
    }
    return false;
  }

  /** 浏览器断开后，超过 idle 时间无人使用的 PTY 会被自动释放。 */
  function cleanupIdleTerminalSessions() {
    const now = Date.now();
    for (const [sessionId, session] of terminalSessions) {
      if (!session || session.clientIds.size === 0) continue;
      if (terminalSessionHasConnectedClient(session)) continue;
      if (now - session.lastActivityMs < TERMINAL_IDLE_CLEANUP_MS) continue;
      terminalSessions.delete(sessionId);
      forgetConversationSession(sessionId);
      try {
        session.ptyProcess.kill();
      } catch {}
      deps.logger &&
        deps.logger.info &&
        deps.logger.info(
          `[terminal] cleaned up idle disconnected session ${sessionId} after ${TERMINAL_IDLE_CLEANUP_MS}ms`
        );
    }
  }

  const terminalIdleCleanupTimer = setInterval(cleanupIdleTerminalSessions, TERMINAL_IDLE_SWEEP_MS);
  if (terminalIdleCleanupTimer && typeof terminalIdleCleanupTimer.unref === "function") {
    terminalIdleCleanupTimer.unref();
  }

  /** 创建或重新附着到 PTY 会话，并回放已有输出缓冲。 */
  function createTerminalSession(payload, context = {}) {
    if (!nodePty || typeof nodePty.spawn !== "function") {
      broadcastTerminal("terminal-error", {
        sessionId: payload && typeof payload === "object" ? payload.sessionId : null,
        message: "node-pty is not available",
      });
      return false;
    }
    if (!payload || typeof payload !== "object" || typeof payload.sessionId !== "string") return false;
    const existing = terminalSessions.get(payload.sessionId);
    if (existing) {
      touchTerminalSession(existing, context);
      rememberConversationSession(payload.sessionId, conversationIdFromPayload(payload));
      const cols = Number.isFinite(Number(payload.cols)) ? Math.max(2, Number(payload.cols)) : null;
      const rows = Number.isFinite(Number(payload.rows)) ? Math.max(2, Number(payload.rows)) : null;
      if (cols && rows) {
        try {
          existing.ptyProcess.resize(cols, rows);
        } catch {}
      }
      broadcastTerminal("terminal-attached", {
        sessionId: payload.sessionId,
        cwd: existing.cwd,
        shell: existing.shell,
      });
      if (existing.outputBuffer) {
        broadcastTerminal("terminal-init-log", {
          sessionId: payload.sessionId,
          log: existing.outputBuffer,
        });
      }
      return true;
    }

    const cwd = deps.resolveGatewayTerminalCwd(payload);
    const shell = getTerminalShell();
    const cols = Number.isFinite(Number(payload.cols)) ? Math.max(2, Number(payload.cols)) : 80;
    const rows = Number.isFinite(Number(payload.rows)) ? Math.max(2, Number(payload.rows)) : 24;
    let ptyProcess;
    try {
      ptyProcess = nodePty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });
    } catch (error) {
      broadcastTerminal("terminal-error", {
        sessionId: payload.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const session = {
      ptyProcess,
      cwd,
      shell,
      title: null,
      rawShellTitle: null,
      outputBuffer: "",
      outputTruncated: false,
      lastActivityMs: Date.now(),
      clientIds: new Set(),
    };
    touchTerminalSession(session, context);
    terminalSessions.set(payload.sessionId, session);
    rememberConversationSession(payload.sessionId, conversationIdFromPayload(payload));
    broadcastTerminal("terminal-attached", {
      sessionId: payload.sessionId,
      cwd,
      shell,
    });
    ptyProcess.onData((data) => {
      if (!data) return;
      session.outputBuffer += data;
      if (session.outputBuffer.length > TERMINAL_REPLAY_BUFFER_LIMIT) {
        session.outputBuffer = session.outputBuffer.slice(-TERMINAL_REPLAY_BUFFER_LIMIT);
        session.outputTruncated = true;
      }
      broadcastTerminal("terminal-data", { sessionId: payload.sessionId, data });
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      terminalSessions.delete(payload.sessionId);
      forgetConversationSession(payload.sessionId);
      broadcastTerminal("terminal-exit", {
        sessionId: payload.sessionId,
        code: exitCode,
        signal: signal == null ? null : String(signal),
      });
    });
    return true;
  }

  /** 主动关闭 PTY 会话。 */
  function closeTerminalSession(sessionId) {
    const session = terminalSessions.get(sessionId);
    if (!session) return true;
    terminalSessions.delete(sessionId);
    forgetConversationSession(sessionId);
    try {
      session.ptyProcess.kill();
    } catch {}
    return true;
  }

  /** 返回官方 renderer 读取 app terminal 时需要的轻量快照。 */
  function terminalSnapshotForSession(session) {
    if (!session) return null;
    const buffer = String(session.outputBuffer || "");
    return {
      cwd: session.cwd || "",
      shell: session.shell || "unknown",
      title: session.title || null,
      rawShellTitle: session.rawShellTitle || null,
      buffer: buffer.slice(-TERMINAL_SNAPSHOT_BUFFER_LIMIT),
      truncated: !!session.outputTruncated || buffer.length > TERMINAL_SNAPSHOT_BUFFER_LIMIT,
    };
  }

  /** 按 thread/conversation 找到当前活跃终端，并返回其输出缓冲。 */
  function threadTerminalSnapshot(payload) {
    const conversationId = conversationIdFromPayload(payload);
    const sessionId = conversationId ? conversationSessions.get(conversationId) : null;
    return {
      session: sessionId ? terminalSnapshotForSession(terminalSessions.get(sessionId)) : null,
    };
  }

  /** OpenCodex 目前没有单独的 node_repl 后台执行表；返回 0 让官方中断流程继续。 */
  function killNodeReplActiveExecs() {
    return { failedCount: 0 };
  }

  /** 处理 terminal-* 消息，包括 create/write/resize/close/run-action。 */
  function handleTerminalMessage(payload, context = {}) {
    if (!payload || typeof payload !== "object") return false;
    const type = String(payload.type || "");
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    switch (type) {
      case "terminal-create":
      case "terminal-attach":
        return createTerminalSession(payload, context);
      case "terminal-write": {
        const session = terminalSessions.get(sessionId);
        if (!session) return false;
        touchTerminalSession(session, context);
        const data = typeof payload.data === "string" ? payload.data : "";
        if (data) session.ptyProcess.write(data);
        return true;
      }
      case "terminal-run-action": {
        const session = terminalSessions.get(sessionId);
        if (!session) return false;
        touchTerminalSession(session, context);
        const command = typeof payload.command === "string" ? payload.command : "";
        const cwd =
          typeof payload.cwd === "string" && payload.cwd && deps.isWithinAllowedRoots(payload.cwd)
            ? deps.normalizeWorkspacePath(payload.cwd)
            : null;
        if (cwd) session.cwd = cwd;
        const title = cleanTerminalTitle(command);
        session.title = title || session.title || null;
        session.rawShellTitle = null;
        session.ptyProcess.write(`${cwd ? `cd ${deps.shellQuote(cwd)} && ` : ""}${command}\r`);
        return true;
      }
      case "terminal-resize": {
        const session = terminalSessions.get(sessionId);
        if (!session) return false;
        touchTerminalSession(session, context);
        const cols = Number.isFinite(Number(payload.cols)) ? Math.max(2, Number(payload.cols)) : 80;
        const rows = Number.isFinite(Number(payload.rows)) ? Math.max(2, Number(payload.rows)) : 24;
        try {
          session.ptyProcess.resize(cols, rows);
        } catch {}
        return true;
      }
      case "terminal-close":
        return closeTerminalSession(sessionId);
      default:
        return false;
    }
  }


  return {
    handleTerminalMessage,
    killNodeReplActiveExecs,
    terminalShellOptions,
    threadTerminalSnapshot,
  };
}

module.exports = {
  createTerminalIpcHandlers,
};
