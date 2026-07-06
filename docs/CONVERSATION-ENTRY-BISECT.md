# OpenCodex 对话进入二分记录

## 背景

Mac 端曾出现侧栏可见、点击本地对话后正文/输入框进不去的问题。为避免继续凭感觉改动，这里记录一套可复用的二分判定方法：用 Win 正常版本作为基线，逐步切候选提交，用浏览器真实打开 `/local/:threadId`，以是否出现 composer 作为通过条件。

## 判定标准

对每个候选版本启动隔离端口和隔离运行目录，然后打开：

```text
http://127.0.0.1:<port>/local/<threadId>?full=1&probe=<timestamp>
```

浏览器侧判定：

- `hasComposer: true`：通过，说明可以进入对话并显示输入区。
- `hasOops: true` 或正文出现 `Codex 崩溃`：失败，说明官方 renderer/app-server 已经进入错误态。
- `hasComposer: false` 且正文为空：失败，说明 shell/renderer 交接或本地恢复链路没有真正进入对话。

## 已验证矩阵

| 候选版本 | 端口 | 结果 | 证据 |
| --- | --- | --- | --- |
| `codex/backup-before-win-merge-20260628` | `4739` | 通过 | 加载 `official-patched-v4/assets/index-CUYAyYU6.js`，`hasComposer: true` |
| `3638125 fix(mobile): serve official renderer directly` | `4738` | 失败 | 页面显示 `Codex 崩溃`，app-server `SIGTERM`，最近错误为插件 marketplace 配置项找不到 |
| `149cc61 fix(runtime): suppress expected app-server restart fatals` | `4740` | 通过 | 加载 `official-patched-v5/assets/index-CUYAyYU6.js`，`hasComposer: true` |

## 当前结论

`3638125` 是一个明确坏的中间态，但当前已提交 HEAD 已经能进入对话。因此不要把当前分支整体回滚到 Win backup；真正要避免的是重新引入 `3638125` 那种“认证后直接返回官方 renderer，但缺少后续 runtime/资源路径修复”的半成品状态。

这次失败不是单纯的 React 页面空白。`3638125` 下首先触发的是官方 app-server 崩溃，错误文本里出现：

```text
configured non-curated plugin no longer exists in discovered marketplaces during cache refresh
```

后续提交已经修复了这条主线，使当前 HEAD 可以通过浏览器进入对话。

## 2026-07-01 追加结论

本轮 Mac 端再次出现“侧栏正常、点进本地对话正文/输入框不稳定”的症状。最终确认不是 Win 基线整体更正确，而是 Mac 当前官方 Web bridge 还缺两处本地会话恢复补丁：

1. 官方 `local-conversation-page` 依赖 Statsig gate `567837310` 决定是否挂载本地 resume 组件；Web 侧 Statsig 路径不稳定时必须在响应期钉住该 gate。
2. 官方 `local-conversation-thread` 的 resume hook 原本依赖 catalog 内部 `needs-resume` atom，并在发送 `maybe-resume-conversation` 前计算 `serviceTier: await Js(...)`。OpenCodex Web bridge 的 `localThreadCatalog` 只提供轻量目录，`needs-resume` 可能为空；`serviceTier` 的账号/模型侧计算又可能先于 `thread/read` 卡住首屏。因此当前 patch 改为“有 `conversationId` 就触发 resume”，并把本地恢复请求里的 `serviceTier` 置为 `null`。

已补回归测试：

- `patched official chunks force-enable local thread resume gate`
- `patched official chunks trigger local conversation resume without service tier prefetch`
- `bridge exposes local thread catalog for official local conversation resume`

验证命令：

```bash
rtk node --check gateway/runtime/http/static-assets.cjs
rtk node --check gateway/runtime/core/config.cjs
rtk node --check web-shell/codex-bridge-polyfill.js
rtk node --test gateway/test/mobile-api.test.cjs web-shell/test/codex-bridge-fast-sync.test.cjs gateway/test/official-runtime-noncritical.test.cjs gateway/test/app-host-frame-observer.test.cjs
rtk pnpm run build:gateway
```

真实浏览器验证：

- `http://127.0.0.1:3737/local/019f0311-1626-7263-86fe-3834322ceafd?full=1`：CDP 判定 `hasComposer: true`，正文长度约 `9551`，加载 `official-patched-v15`。
- `https://zbmacbook-pro.tail4f1eca.ts.net/local/019f0311-1626-7263-86fe-3834322ceafd?full=1`：CDP 判定 `hasComposer: true`，日志出现 `maybe_resume_success`。

注意：Tailscale HTTPS 首次冷启动可能超过 60 秒才完成官方 resume，单次 `hasComposer: false` 不能直接判定失败；需要同时看 `maybe_resume_started` / `maybe_resume_success`、`thread/read` 是否发出，以及是否仍有后续 `Received app server notification`。

## 后续合并规则

1. 合并大块变化前，先在独立 worktree 启动候选版本，不要污染正在使用的 `3737` 服务。
2. 每个候选版本使用独立端口和运行目录，例如：

```bash
PORT=4740 \
HOST=127.0.0.1 \
CODEX_WEB_RUNTIME_DIR=/tmp/opencodex-bisect-runtime-head \
CODEX_WEB_REPORTS_DIR=/tmp/opencodex-bisect-reports-head \
CODEX_WEB_OFFICIAL_USER_DATA_DIR=/tmp/opencodex-bisect-official-head \
CODEX_WEB_OFFICIAL_BUNDLE_DIR=/Users/hechengjun.9/Documents/jd/OpenCodex/.data/cache/codex-official-bundle \
OPENCODEX_GATEWAY_SERVICE_MODE=1 \
node gateway/dev/run-gateway.cjs
```

3. 等 `/api/health` 里 `officialIpc.ready === true` 后，再打开 `/local/:threadId` 做浏览器判定。
4. 如果候选失败，优先区分两类问题：

- 页面出现 `Codex 崩溃`：先查官方 app-server/runtime 资源路径和插件 marketplace。
- 页面无输入框但不崩：再查 shell handoff、`localThreadCatalog`、`maybe-resume-conversation`、`thread/read` 是否发出。
