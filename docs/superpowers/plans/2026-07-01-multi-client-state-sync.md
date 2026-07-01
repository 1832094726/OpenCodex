# 多端客户端状态同步实施计划

> **给 agentic workers：** REQUIRED SUB-SKILL：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行。本计划使用 checkbox（`- [ ]`）追踪步骤。

**目标：** 让电脑、手机和其它浏览器客户端都能流畅进入同一个 Codex 会话，由 OpenCodex gateway 维护 thread 快照、app-host 增量帧和每个客户端自己的同步水位。

**架构：** Socket.IO 已成为浏览器默认传输层，raw `/ws` 保留为回退路径。gateway 仍然是 Codex 私有状态协调器：它保存带 `threadSeq` 的进程内全量快照，保留 app-host thread 增量队列，维护 per-client 游标，并在增量不连续时让浏览器走快照修复。

**技术栈：** Node.js CommonJS gateway 模块、Socket.IO、raw `ws` fallback、Electron 官方 runtime IPC 拦截、浏览器 polyfill、进程内 fast-sync snapshot、Node 内置 test runner。

---

## 架构参考

权威架构说明和排障手册在：

```text
docs/MULTI-CLIENT-STATE-SYNC.md
```

协议字段、恢复流程、诊断口径和验收标准都以该文档为准。

## 已完成

- [x] gateway 观察 app-host 帧，并在 `gateway/runtime/ipc/app-host-frame-observer.cjs` 保存脱敏 thread 状态。
- [x] gateway 在 `gateway/runtime/ipc/ws-hub.cjs` 给官方到浏览器的 app-host 帧分配 per-thread `threadSeq`。
- [x] 浏览器将每个 thread 的 `lastThreadSeq` 保存到 `sessionStorage`，并在 `app-host-connect` 时上报。
- [x] gateway 在重连时补发保留的 per-thread 增量帧，并在客户端游标早于保留队列时标记 `replayGap`。
- [x] gateway 为 `thread/read` 和 `thread/turns/list` 暴露进程内快照。
- [x] memory snapshot 携带自身覆盖到的 `threadSeq` 水位。
- [x] 浏览器在 `opencodex:fast-sync-snapshot-ack` 中携带 `threadSeq`。
- [x] snapshot ack 会推进该客户端 active gateway replay cursor。
- [x] gateway 记录 `snapshotAckThreadSeqByClientId`，一个客户端的 ack 不会覆盖另一个客户端的诊断状态。
- [x] 诊断接口暴露 `clientWatermarks`。
- [x] 浏览器暴露修复决策，可以区分增量 replay、快照 preload、route refresh 和 ignored。
- [x] Socket.IO server 已和 raw `/ws` 并行挂载。
- [x] 浏览器默认使用 Socket.IO client，Socket.IO 无法加载或握手失败时回退 raw `/ws`。
- [x] Socket.IO 和 raw `/ws` 共用同一套 gateway JSON payload。
- [x] Socket.IO 客户端按 `client:<clientId>` 和 `thread:<threadId>` 加入 room，非 replay thread nudge 走 room 定向投递。

## 当前协议

### 浏览器传输

```text
browser
  -> /socket.io/socket.io.js
  -> Socket.IO "message" event，payload 仍是既有 JSON
  -> gateway 适配器
  -> ws-hub handler
```

回退路径：

```text
browser
  -> new WebSocket("/ws")
  -> ws-hub handler
```

### 快照 ack

```json
{
  "type": "opencodex:fast-sync-snapshot-ack",
  "clientId": "client-b",
  "capturedAtMs": 1780000000000,
  "key": "snapshot-key",
  "method": "thread/read",
  "source": "gateway-memory",
  "threadId": "thread-1",
  "threadSeq": 42
}
```

gateway 使用该 ack 做两件事：

- 将该客户端在该 thread 下的 active app-host ports 推进到 `threadSeq`。
- 写入 `snapshotAckThreadSeqByClientId[clientId] = threadSeq`。

## 后续任务

现在缺的不是基础状态存储，而是观测、硬化和真实弱网验证。

### 任务 8：Socket.IO 恢复诊断

**文件：**
- 修改：`gateway/runtime/ipc/ws-hub.cjs`
- 修改：`gateway/test/app-host-frame-observer.test.cjs`
- 修改：`web-shell/codex-bridge-polyfill.js`
- 修改：`web-shell/test/codex-bridge-fast-sync.test.cjs`
- 修改：`docs/STATUS-FLOW-MONITORING.md`

- [x] **步骤 1：新增失败测试**

增加断言，要求 Socket.IO 连接事件记录：

```js
transport: "socket.io"
recovered: true | false
```

浏览器诊断需要包含实际选中的传输层：

```js
clientDiagnostic("ws-transport-selected", {
  transport: "socket.io"
});
```

- [x] **步骤 2：实现传输诊断**

在 flow event 和相关 thread diagnostics 中暴露：

- `transport`
- `socketId`
- `recovered`
- `fallbackTransport`

- [x] **步骤 3：验证**

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
rtk pnpm test
rtk git diff --check
```

预期：全部通过。

### 任务 9：Thread Room 路由

**文件：**
- 修改：`gateway/runtime/ipc/ws-hub.cjs`
- 修改：`gateway/test/app-host-frame-observer.test.cjs`

- [x] **步骤 1：新增 room 路由测试**

证明同一个 thread 下的 active Socket.IO 客户端可以通过 thread room 定向投递，同时 raw `/ws` fallback 仍然走当前内存 active client list。

- [x] **步骤 2：实现 room join**

处理 `app-host-connect` 时，Socket.IO 客户端应加入：

```text
client:<clientId>
thread:<threadId>
```

raw `/ws` 客户端继续使用既有的 `clientsById` 和 `activeClientPorts` 路径。

- [x] **步骤 3：验证**

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
rtk pnpm test
rtk git diff --check
```

### 任务 10：端到端弱网恢复脚本

**文件：**
- 新建：`scripts/test-multi-client-recovery.cjs`
- 修改：`package.json`
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`

- [x] **步骤 1：创建脚本化测试脚本**

测试脚本需要模拟：

- 两个客户端打开同一个 thread；
- 一个客户端收到 app-host frames；
- 另一个客户端断开并重连；
- 保留队列连续时只补 replay；
- replay gap 后走 snapshot ack。

- [x] **步骤 2：新增 npm script**

```json
"test:multi-client-recovery": "node scripts/test-multi-client-recovery.cjs"
```

- [x] **步骤 3：验证**

```bash
rtk pnpm run test:multi-client-recovery
rtk pnpm test
```

### 任务 11：抽象 ThreadEventLog

**文件：**
- 新建：`gateway/runtime/core/thread-event-log.cjs`
- 新建：`gateway/test/thread-event-log.test.cjs`
- 修改：`gateway/runtime/ipc/ws-hub.cjs`
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`

- [x] **步骤 1：新增失败测试**

测试一个内存 `ThreadEventLog` 需要覆盖：

- append event 后分配递增 `threadSeq`；
- 按 `afterSeq` 读取增量；
- 返回 `oldestSeq`、`latestSeq`、`gap`；
- 为每个 `clientId + portId + threadId` 保存 cursor；
- ack snapshot 后推进对应 client 的 cursor。

- [x] **步骤 2：实现内存 ThreadEventLog**

接口先按最小能力设计：

```js
const log = createThreadEventLog({ maxEntries, ttlMs });
log.append(threadId, event);
log.readAfter(threadId, afterSeq);
log.rememberCursor(clientId, portId, threadId, seq);
log.cursor(clientId, portId, threadId);
log.ackSnapshot(clientId, threadId, seq, activePortIds);
log.stats(threadId);
```

- [x] **步骤 3：让 ws-hub 使用接口**

把当前散落在 `appHostDownstreamFramesByThreadId`、`appHostDownstreamThreadSeqByThreadId`、`appHostThreadSeqByRelayKey` 的逻辑收拢到 `ThreadEventLog`。
`ws-hub` 现在默认使用内存 `ThreadEventLog`，也支持通过 `threadEventLog` 注入替换实现，方便后续接入 JetStream、SQLite event log 或其它成熟 stream store。

- [x] **步骤 4：验证**

```bash
rtk node --test gateway/test/thread-event-log.test.cjs
rtk node --test gateway/test/app-host-frame-observer.test.cjs
rtk pnpm test
rtk git diff --check
```

预期：行为不变，但后续可以把内存实现替换为 JetStream、SQLite event log 或其它成熟 stream store。

### 任务 12：Opt-in 持久 ThreadEventLog Adapter

**文件：**
- 修改：`gateway/runtime/core/thread-event-log.cjs`
- 修改：`gateway/runtime/ipc/ws-hub.cjs`
- 修改：`gateway/test/thread-event-log.test.cjs`
- 修改：`gateway/test/app-host-frame-observer.test.cjs`
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`

- [x] **步骤 1：新增失败测试**

覆盖：

- 文件 adapter 能从 JSONL 恢复 retained events；
- 文件 adapter 能恢复每个 `clientId + portId + threadId` 的 cursor；
- 恢复后 `threadSeq` 继续单调递增；
- 配置工厂只有在 `mode=file` 时才写文件；
- `ws-hub` 通过 `OPENCODEX_THREAD_EVENT_LOG_MODE=file` 确实写入 event log。

- [x] **步骤 2：实现 JSONL adapter**

新增：

```js
createFileThreadEventLog({ filePath, maxEntries, ttlMs });
createConfiguredThreadEventLog({ mode, filePath, maxEntries, ttlMs });
```

默认仍走内存实现；文件 adapter 是 opt-in，因为它会保存用于 replay 的 app-host 原始下行帧。

- [x] **步骤 3：接入 ws-hub**

`ws-hub` 默认使用：

```js
createConfiguredThreadEventLog({
  filePath: process.env.OPENCODEX_THREAD_EVENT_LOG_FILE || path.join(RUNTIME_DIR, "cache", "thread-event-log.jsonl"),
  maxEntries,
  ttlMs,
});
```

当 `OPENCODEX_THREAD_EVENT_LOG_MODE=file` 时启用 JSONL 持久 adapter。

- [x] **步骤 4：验证**

```bash
rtk node --test gateway/test/thread-event-log.test.cjs
rtk node --test gateway/test/app-host-frame-observer.test.cjs
```

下一步不是继续扩大 JSONL，而是用同一接口评估 SQLite event log、Redis Streams 或 JetStream。

### 任务 13：Thread Repair Counters

**文件：**
- 修改：`gateway/runtime/ipc/app-host-frame-observer.cjs`
- 修改：`gateway/test/app-host-frame-observer.test.cjs`
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`

- [x] **步骤 1：新增失败测试**

覆盖 diagnostics thread snapshot 中必须包含：

- `missedByTransport`：客户端重连/replay 时按 cursor 推断缺失的 thread frame 累计数；
- `repairedByThreadReplay`：gateway 通过 ThreadEventLog replay 实际补发的 frame 累计数；
- `repairedBySnapshot`：客户端消费 gateway memory snapshot 后 ack 的累计次数。

- [x] **步骤 2：实现累计指标**

在 app-host thread state 中维护累计计数：

- `recordAppHostThreadReplay` 根据 `latestKnownThreadSeq - cursor` 累加 `missedByTransport`；
- `recordAppHostThreadReplay` 根据 `sent` 累加 `repairedByThreadReplay`；
- `recordAppHostThreadSnapshotAck` 在 `source === "gateway-memory"` 且 `threadSeq > 0` 时累加 `repairedBySnapshot`。

这些值是恢复事件累计诊断，不是去重后的精确帧审计。

- [x] **步骤 3：验证**

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
```

### 任务 14：成熟同步机制选型收敛

**文件：**
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`
- 修改：`docs/superpowers/plans/2026-07-01-multi-client-state-sync.md`

- [x] **步骤 1：明确可复用边界**

把 `threadSeq`、全量快照、增量队列、per-client 水位、gap 判断和 relay 重建映射到成熟同步/消息系统抽象，避免把这些能力继续散落手写。

- [x] **步骤 2：给出近期取舍**

近期决策：

- Socket.IO 继续接管短断线、room、自动重连和 connection recovery。
- `ThreadEventLog` 保持为 OpenCodex 的事件流适配边界，后续 adapter 优先评估 SQLite event log 或 Redis Streams。
- NATS JetStream 留给多进程/多机器阶段，不作为当前单机默认依赖。
- Yjs/Automerge 只借鉴 state vector/update log，不直接承载官方 app-host RPC。
- relay 生命周期和 snapshot repair 决策后续可用 XState 类状态机收敛。

- [x] **步骤 3：实现正式持久 adapter**

在 JSONL 验证完成后，基于同一 `ThreadEventLog` 接口实现更成熟的持久 adapter。当前已落地：

- SQLite event log：适合单机 OpenCodex，易打包，能覆盖重启恢复。

后续候选：

- Redis Streams：适合已经有 Redis 的部署，天然 stream id、consumer group 和 ack。

**文件：**
- 修改：`gateway/runtime/core/thread-event-log.cjs`
- 修改：`gateway/runtime/ipc/ws-hub.cjs`
- 修改：`gateway/test/thread-event-log.test.cjs`
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`
- 修改：`pnpm-workspace.yaml`

### 任务 15：前端可见 Thread Diagnostics

**文件：**
- 修改：`web-shell/codex-bridge-polyfill.js`
- 修改：`web-shell/test/codex-bridge-fast-sync.test.cjs`
- 修改：`docs/STATUS-FLOW-MONITORING.md`

- [x] **步骤 1：新增失败测试**

要求网络/链路状态浮层能拉取：

```text
/api/diagnostics/threads?threadId=<currentRouteThreadId>
```

并在源码级覆盖：

- `clientWatermarks`
- `missedByTransport`
- `repairedByThreadReplay`
- `repairedBySnapshot`

- [x] **步骤 2：实现浏览器侧诊断摘要**

链路状态面板展开、健康检查和复制诊断时，同时刷新 flow diagnostics 和 thread diagnostics。面板正文展示：

- 当前 thread 的 latest seq；
- 传输缺失、thread replay 修复、snapshot repair 修复累计；
- 每个客户端的 `threadCursor`、`snapshotAckThreadSeq` 和 lag。

- [x] **步骤 3：验证**

```bash
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
```

### 任务 16：单机真机弱网验证和 Relay Lifecycle

**文件：**
- 新建：`gateway/runtime/core/relay-lifecycle.cjs`
- 新建：`gateway/test/relay-lifecycle.test.cjs`
- 新建：`scripts/observe-weak-network.cjs`
- 修改：`gateway/runtime/ipc/ws-hub.cjs`
- 修改：`package.json`
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`
- 修改：`docs/STATUS-FLOW-MONITORING.md`

- [x] **步骤 1：确认单机边界**

OpenCodex 当前按单机运行，继续使用 SQLite 作为持久 event log；Redis Streams 和 JetStream 不进入近期实现范围。

- [x] **步骤 2：Relay 生命周期状态机**

新增 `relay-lifecycle.cjs`，覆盖：

- `relay_connected`
- `relay_missing`
- `relay_recreating`
- `relay_flushed`
- `relay_partial_flush`
- `relay_failed`
- `relay_closed`

失败态会保留错误证据，直到下一次明确 reconnect/close。

- [x] **步骤 3：接入 ws-hub**

`ws-hub` 在 connect、missing、recreating、flush、failed、close 时记录 relay lifecycle；现有 flow monitor stage 保持兼容。

- [x] **步骤 4：真机弱网 observer**

新增：

```bash
pnpm run observe:weak-network
```

常用环境变量：

```bash
OPENCODEX_WEAK_OBSERVER_BASE_URL=http://127.0.0.1:3737
OPENCODEX_WEAK_OBSERVER_THREAD_ID=<thread-id>
OPENCODEX_WEAK_OBSERVER_DURATION_MS=60000
OPENCODEX_WEAK_OBSERVER_INTERVAL_MS=2000
OPENCODEX_WEAK_OBSERVER_OUTPUT=/tmp/opencodex-weak-network.jsonl
```

电脑端运行 observer，手机端执行后台、切网、重进 thread 和发送消息，最后用 JSONL 里的 health、flow、relay、lag 和 repair counters 判断真机弱网恢复是否成立。

### 任务 17：Snapshot Repair 状态机

**文件：**
- 新建：`web-shell/snapshot-repair-state.js`
- 新建：`web-shell/test/snapshot-repair-state.test.cjs`
- 修改：`web-shell/codex-bridge-polyfill.js`
- 修改：`web-shell/test/codex-bridge-fast-sync.test.cjs`
- 修改：`gateway/runtime/http/static-assets.cjs`
- 修改：`package.json`
- 修改：`docs/MULTI-CLIENT-STATE-SYNC.md`
- 修改：`docs/STATUS-FLOW-MONITORING.md`

- [x] **步骤 1：新增失败测试**

覆盖 snapshot repair 决策动作：

- `ignored`
- `incremental-replay`
- `snapshot-preload`
- `route-refresh`

- [x] **步骤 2：实现浏览器状态机模块**

新增 `snapshot-repair-state.js`，同时支持 Node test `require()` 和浏览器 `window.OpenCodexSnapshotRepairState`。

- [x] **步骤 3：接入 polyfill**

`threadSnapshotNudgeDecision()` 只收集页面上下文：

- route
- visibility
- editing focus
- nudge message

然后调用 `OpenCodexSnapshotRepairState.decideSnapshotRepair()` 得到标准决策。

- [x] **步骤 4：验证**

```bash
rtk node --test web-shell/test/snapshot-repair-state.test.cjs
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
```

## 验收标准

- 手机前台恢复时优先使用 Socket.IO，只有 Socket.IO 不可用时才回退 raw `/ws`。
- 两个客户端打开同一个 thread 时，各自拥有独立的 `threadCursor` 和 `snapshotAckThreadSeq`。
- 重连且保留队列连续时，只发送缺失增量。
- 重连且保留队列不连续时，触发 gateway snapshot preload 和 snapshot ack。
- 诊断信息能解释客户端是被 Socket.IO recovery、app-host replay，还是 memory snapshot repair 修复的。

## 验证命令

每个实现批次后运行：

```bash
rtk node --test gateway/test/app-host-frame-observer.test.cjs
rtk node --test web-shell/test/codex-bridge-fast-sync.test.cjs
rtk pnpm test
rtk git diff --check
```
