# OpenCodex 多端状态同步架构

这份文档说明 OpenCodex 在电脑浏览器、手机浏览器和其它远端客户端同时访问同一个 Codex 会话时，如何避免退化成“远程桌面式全量透传”，如何在弱网和丢包后补齐状态，以及哪些能力应复用成熟传输层，哪些能力必须由 OpenCodex 自己维护。

## 目标

- 多个客户端打开同一个 thread 时，各自拥有独立的连接状态、快照水位和增量游标。
- 手机后台恢复、弱网重连或临时丢包后，优先补增量；增量不连续时再走全量快照修复。
- gateway 维护 thread 级全量快照和 app-host 增量日志，不要求每次重连都重新向官方 runtime 拉完整状态。
- 传输层优先复用 Socket.IO，OpenCodex 只保留 Codex 私有协议适配。

## 分层职责

| 层级 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| Socket.IO | 连接生命周期、ping/pong、自动重连、短断线包恢复、client/thread room 定向投递 | 理解 `thread/read`、app-host MessagePort、快照语义 |
| raw `/ws` 回退 | Socket.IO 脚本或握手失败时兜底 | 长期主路径优化 |
| OpenCodex gateway | `threadSeq`、全量快照、增量队列、per-client 水位、gap 判断、relay 重建 | 替代官方 Codex runtime |
| 浏览器 polyfill | 优先连接 Socket.IO、保存本标签页 thread 游标、消费快照并 ack | 跨标签页共享私有状态 |
| 官方 runtime | 官方真实会话读写、模型调用、工具状态 | 远端弱网补偿 |

## 可复用开源组件映射

这些能力并不是都要手搓。更合理的边界是：OpenCodex 负责把官方 Codex 私有协议翻译成标准同步模型，底层同步机制尽量复用成熟项目。

| 当前概念 | 通用抽象 | 可复用项目 | 适配方式 |
| --- | --- | --- | --- |
| `threadSeq` | stream sequence / logical clock | Socket.IO packet recovery、NATS JetStream、Yjs state vector | 当前短期用内存 seq；后续可以把 app-host 增量抽象成 stream event |
| 全量快照 | snapshot / compaction / materialized view | Yjs snapshot/update、Replicache pull response、事件溯源 snapshot | gateway 仍生成 Codex thread 快照，但快照存储和 compaction 可复用成熟模式 |
| 增量队列 | event log / retained packets / update log | Socket.IO connection state recovery、NATS JetStream、Yjs updates | 短断线优先 Socket.IO；更长窗口可考虑持久化 event log |
| per-client 水位 | consumer offset / state vector / client cookie | JetStream consumer ack floor、Replicache client cookie、Yjs state vector | 现在是 `snapshotAckThreadSeqByClientId` 和 `threadCursor`；后续可收敛成标准 offset 表 |
| gap 判断 | diff availability / missing update detection | Yjs state vector diff、Replicache pull cookie、stream oldest/latest seq | 当前用 `oldestThreadSeq > cursor + 1`；后续可封装为通用 diff/gap detector |
| relay 重建 | resource lifecycle / actor state machine | XState、Socket.IO rooms、actor model | relay 创建/关闭/重建可以用状态机表达，避免 scattered if/else |

### 选型判断

- Socket.IO 已经适合接管连接恢复、短期 missed packets、room、ack 和广播，不应该继续手写传输层。
- Yjs/Automerge 适合“我们拥有数据结构”的协同文档；Codex thread 可以借鉴 state vector 和 update log，但不能直接把官方 app-host RPC 当成 Yjs 文档。
- Replicache/Electric/PowerSync 适合本地优先数据库同步；如果未来把 thread 列表、消息可见视图做成独立本地数据库，可以复用这类 pull/push/cookie 协议。
- NATS JetStream 适合把 app-host 增量变成持久 event stream，天然有 stream seq、consumer ack 和 redelivery；但引入服务组件较重，适合多机器/长期运行阶段。
- XState 适合 relay 生命周期和恢复决策状态机，不负责数据同步本身。

### 成熟方案取舍

这里的核心判断是：`threadSeq`、全量快照、增量队列、per-client 水位、gap 判断和 relay 重建都有成熟抽象，但没有一个开源项目能直接理解官方 Codex 的 app-host 私有协议。因此 OpenCodex 应只保留“业务语义适配层”，把底层能力尽量落到成熟机制上。

| 方案 | 适合接管 | 不适合接管 | 当前结论 |
| --- | --- | --- | --- |
| Socket.IO connection state recovery | 短断线 missed packets、room、自动重连、连接恢复标记 | 长期离线后的持久事件回放、Codex 快照语义 | 已作为默认传输层；OpenCodex 只在 recovery 失败后补 thread replay/snapshot |
| Redis Streams | 单机或小集群持久 event log、stream id、consumer group offset、pending/ack | 浏览器直连、app-host MessagePort 生命周期 | 适合做下一阶段正式 `ThreadEventLog` adapter，复杂度低于 JetStream |
| NATS JetStream | 多进程/多机器 event stream、consumer ack、redelivery、长期 replay | 只跑单机 gateway 时偏重 | 多机部署阶段再引入；保持 `ThreadEventLog` 接口可替换 |
| SQLite event log | 单机持久化、重启恢复、便于随 OpenCodex 打包 | 多机共享消费、水位竞争 | 已作为正式单机 `ThreadEventLog` adapter 落地 |
| Yjs/Automerge | 协同编辑、CRDT 合并、我们拥有的数据模型 | 官方 app-host RPC 原样回放、工具流状态 | 可借鉴 state vector/update 思路，不直接引入为 thread 同步内核 |
| Replicache/Electric/PowerSync | 本地优先数据库、pull/push/cookie、可见视图同步 | app-host 私有帧的低层转发 | 如果未来把 thread 列表/消息视图落成本地 DB，再评估 |
| XState | relay 生命周期、恢复分支、错误状态收敛 | 事件持久化和网络传输 | 适合把 relay 重建和 snapshot repair 决策从散落 if/else 中抽出来 |

近期不要继续扩大自研范围：短断线交给 Socket.IO，单机持久回放使用 SQLite adapter。OpenCodex 当前按单机运行，Redis Streams 和 JetStream 暂不作为近期目标；relay 生命周期和 snapshot repair 决策都用本地状态机收敛。OpenCodex 自己只维护 `thread/read`、`thread/turns/list`、app-host port、snapshot ack 这些官方协议和标准同步抽象之间的翻译。

### 推荐演进顺序

1. 继续用 Socket.IO 做默认传输，补齐 transport recovery 诊断。
2. `threadSeq + queue + cursor + gap` 已抽成 `ThreadEventLog` 接口，gateway 默认使用内存实现。
3. `ws-hub` 支持注入替换 `threadEventLog`，并可通过 opt-in JSONL adapter 做进程重启后的短窗口恢复验证。
4. 单机持久回放使用 opt-in SQLite adapter；Redis Streams/JetStream 只留作未来多进程部署候选。
5. relay 生命周期和 snapshot repair 决策都已抽成状态机，避免浏览器和 gateway 各自散落判断。
6. 如果未来把 thread 可见状态落成本地数据库，再评估 Replicache/Electric 这类 local-first sync。

## ThreadEventLog 边界

`ThreadEventLog` 是 OpenCodex 目前的同步抽象层，不绑定具体存储。它只表达通用事件流语义：

```js
const log = createThreadEventLog({ maxEntries, ttlMs });
log.append(threadId, event);
log.readAfter(threadId, afterSeq);
log.rememberCursor(clientId, portId, threadId, seq);
log.cursor(clientId, portId, threadId);
log.ackSnapshot(clientId, threadId, seq, activePortIds);
log.stats(threadId);
```

`ws-hub` 只依赖这组方法：

- `append`：把官方 app-host 下行帧变成 thread 事件，并拿到新的 `threadSeq`。
- `readAfter`：客户端重连时按 `lastThreadSeq` 读取缺失增量，同时返回 `gap`。
- `rememberCursor` / `cursor`：记录每个 `clientId + portId + threadId` 的投递水位。
- `ackSnapshot`：客户端消费全量快照后，把对应 active ports 推进到快照覆盖的 `threadSeq`。
- `stats`：给诊断接口提供 retained queue 和 latest seq 水位。

当前内存实现适合单机调试和短断线修复；如果要覆盖进程重启、多机部署或更长弱网窗口，可以保持这组接口不变，把实现替换为持久 event stream。

### 持久 Adapter

默认模式仍是内存：

```bash
OPENCODEX_THREAD_EVENT_LOG_MODE=memory
```

需要验证进程重启后的 replay 能力时，可以显式启用 JSONL 文件 adapter：

```bash
OPENCODEX_THREAD_EVENT_LOG_MODE=file
OPENCODEX_THREAD_EVENT_LOG_FILE=/path/to/thread-event-log.jsonl
```

推荐的单机持久 adapter 是 SQLite：

```bash
OPENCODEX_THREAD_EVENT_LOG_MODE=sqlite
OPENCODEX_THREAD_EVENT_LOG_FILE=/path/to/thread-event-log.sqlite
```

未配置 `OPENCODEX_THREAD_EVENT_LOG_FILE` 时，gateway 会写到：

```text
<RUNTIME_DIR>/cache/thread-event-log.jsonl   # mode=file/jsonl
<RUNTIME_DIR>/cache/thread-event-log.sqlite  # mode=sqlite/sqlite3
```

注意：JSONL 和 SQLite adapter 都会保存用于 replay 的 app-host 原始下行帧，里面可能包含会话正文或工具结果，因此默认关闭。JSONL 只用于验证边界；SQLite 是当前推荐的单机持久实现。多机或长期共享部署再评估 Redis Streams 或 JetStream，并保持同一组 `ThreadEventLog` 方法不变。

## 当前传输路径

浏览器默认路径：

```text
浏览器 polyfill
  -> 加载 /socket.io/socket.io.js
  -> io(location.origin, { path: "/socket.io", transports: ["websocket"] })
  -> emit("message", JSON.stringify(payload))
  -> gateway Socket.IO 适配器
  -> 既有 ws-hub JSON handler
```

失败回退路径：

```text
浏览器 polyfill
  -> Socket.IO 脚本加载失败或握手失败
  -> new WebSocket("/ws")
  -> 既有 ws-hub JSON handler
```

无论使用 Socket.IO 还是 raw WebSocket，业务 payload 都保持一致：

- `hello`
- `ipc-invoke`
- `app-host-connect`
- `app-host-port-message`
- `opencodex:fast-sync-snapshot-ack`
- `client-diagnostic`

这样传输层可以继续演进，而 app-host、IPC、快照补偿逻辑不会分叉。

## 核心水位

| 字段 | 所属端 | 含义 |
| --- | --- | --- |
| `threadSeq` | gateway | gateway 观察到的某个 thread 下 app-host 下行增量序号 |
| `lastThreadSeq` | browser -> gateway | 浏览器端口上报自己已经消费到哪个 thread seq |
| `threadCursor` | gateway diagnostics | gateway 认为某客户端端口已投递到的 seq |
| snapshot 里的 `threadSeq` | gateway snapshot | 该全量快照覆盖到的 app-host seq |
| `snapshotAckThreadSeq` | browser -> gateway | 浏览器确认自己已消费某个全量快照 |
| `snapshotAckThreadSeqByClientId` | gateway diagnostics | 每个客户端自己的快照消费水位 |

`lastSnapshotAckThreadSeq` 只表示最近一次 ack 事件，不能用它判断其它客户端是否落后。

## 正常同步流程

```mermaid
sequenceDiagram
  participant Official as 官方 runtime
  participant Gateway as OpenCodex 网关
  participant A as 电脑客户端
  participant B as 手机客户端

  A->>Gateway: app-host-connect(threadId, lastThreadSeq=10)
  Official-->>Gateway: app-host frame(threadId)
  Gateway->>Gateway: 分配 threadSeq=11 并缓存增量帧
  Gateway-->>A: app-host-port-message(threadSeq=11)
  Gateway-->>B: replay 或 live app-host-port-message(threadSeq=11)
  B->>B: 将 threadSeq=11 写入 sessionStorage
```

## 弱网恢复流程

```mermaid
flowchart TD
  A["客户端带 threadId + lastThreadSeq 重连"] --> B{"gateway 保留的增量队列是否连续?"}
  B -->|连续| C["补发 threadSeq > lastThreadSeq 的增量帧"]
  C --> D["客户端应用 replay frames"]
  B -->|不连续| E["发送 replayGap=true 的 nudge"]
  E --> F["浏览器读取 gateway memory snapshot"]
  F --> G["浏览器发送带 threadSeq 的 snapshot ack"]
  G --> H["gateway 推进该客户端 active port cursor"]
```

## 快照补偿

gateway 为 `thread/read` 和 `thread/turns/list` 保存进程内快照：

```json
{
  "method": "thread/read",
  "threadId": "thread-1",
  "threadSeq": 42,
  "source": "gateway-memory",
  "value": {}
}
```

浏览器消费后发送 ack：

```json
{
  "type": "opencodex:fast-sync-snapshot-ack",
  "clientId": "client-phone",
  "threadId": "thread-1",
  "method": "thread/read",
  "source": "gateway-memory",
  "threadSeq": 42
}
```

gateway 收到 ack 后：

- 更新 `snapshotAckThreadSeqByClientId[clientId]`。
- 将该客户端当前 active app-host ports 的 replay cursor 推进到 `threadSeq`。
- 后续 nudge 只补 `threadSeq` 之后的增量。

## 诊断接口

`GET /api/diagnostics/threads?threadId=<id>` 应重点看：

```json
{
  "latestKnownThreadSeq": 45,
  "missedByTransport": 5,
  "oldestThreadSeq": 39,
  "repairedBySnapshot": 1,
  "repairedByThreadReplay": 3,
  "clientWatermarks": [
    {
      "clientId": "client-desktop",
      "portIds": ["port-a"],
      "threadCursor": 45,
      "snapshotAckThreadSeq": 42
    },
    {
      "clientId": "client-phone",
      "portIds": ["port-b"],
      "threadCursor": 40,
      "snapshotAckThreadSeq": 0
    }
  ],
  "snapshotAckThreadSeqByClientId": {
    "client-desktop": 42
  }
}
```

判断方式：

- `latestKnownThreadSeq === threadCursor`：该客户端已追到最新。
- `latestKnownThreadSeq > threadCursor` 且 retained queue 连续：应该补增量。
- `latestKnownThreadSeq > threadCursor` 且 `oldestThreadSeq > threadCursor + 1`：必须快照修复。
- `snapshotAckThreadSeq > 0` 但 `threadCursor` 更低：说明 ack 后 active port cursor 推进可能有问题。
- `missedByTransport`：客户端重连/replay 时按 cursor 推断缺失的 thread frame 累计数。
- `repairedByThreadReplay`：gateway 已通过 ThreadEventLog replay 实际补发的 frame 累计数。
- `repairedBySnapshot`：客户端已消费 gateway memory snapshot 并 ack 的全量修复累计次数。

这三个 repair 指标是诊断事件累计值，可能因为同一客户端多次重连而重复计入；它们用于判断“主要靠哪条恢复路径救回来”，不是审计级唯一帧集合。

## 已落地能力

- Socket.IO server 与 raw `/ws` 并行。
- 浏览器默认优先 Socket.IO client，失败回退 raw `/ws`。
- Socket.IO adapter 复用既有 JSON 协议和 `ws-hub` handler。
- Socket.IO 客户端加入 `client:<clientId>` 和 `thread:<threadId>` room；非 replay thread nudge 通过 room 定向投递，同步保留 raw `/ws` fallback。
- app-host thread replay queue 与 `threadSeq` 已收敛到可替换的 `ThreadEventLog` 接口。
- `ThreadEventLog` 提供内存实现、opt-in JSONL 文件实现和 opt-in SQLite 实现；`ws-hub` 可通过环境变量选择持久 adapter。
- 浏览器 `sessionStorage` 保存每个 thread 的 `lastThreadSeq`。
- memory snapshot 携带 `threadSeq`。
- 浏览器 snapshot ack 携带 `threadSeq`。
- gateway 按 client 保存 `snapshotAckThreadSeqByClientId`。
- diagnostics 暴露 `clientWatermarks`。
- diagnostics 暴露 `missedByTransport`、`repairedByThreadReplay`、`repairedBySnapshot`，用于区分传输恢复、thread replay 和 snapshot repair 的实际贡献。

## 下一步

1. 增加浏览器端真实集成测试：Socket.IO 主路径、脚本加载失败回退、握手失败回退。
2. 在诊断面板展示 per-client watermarks 和 repair counters，而不是只在 JSON API 里可见。
3. 在诊断面板展示 per-client watermarks 和 repair counters，而不是只在 JSON API 里可见。
4. 执行单机真机弱网验证：电脑端运行 `pnpm run observe:weak-network`，手机端反复后台、切网络和进入同一 thread，用 JSONL 证据确认 lag 和 repair counters 能回落。

## 可执行验证

```bash
pnpm run test:multi-client-recovery
```

该脚本会启动一个真实 gateway hub，并模拟：

- 两个客户端打开同一个 thread。
- 一个客户端收到 app-host frames，另一个客户端断开后重连。
- 保留队列连续时只补缺失 replay。
- replay 队列不连续时标记 `replayGap`，随后通过 gateway memory snapshot ack 推进该客户端 `threadCursor`。

## 验收标准

- 手机后台 30 秒后回到同一 thread，不刷新页面也能继续显示最新会话状态。
- 两个客户端同开一个 thread，A 发送消息后 B 不需要发一条消息才能看到历史更新。
- replay queue 连续时，B 只收到缺失增量，不重新拉完整 thread。
- replay queue 不连续时，B 读取 gateway memory snapshot，并发送 snapshot ack。
- diagnostics 中每个客户端的 `threadCursor` 和 `snapshotAckThreadSeq` 能解释当前 UI 是否落后。
- snapshot repair 状态机能解释当前恢复动作：`incremental-replay`、`snapshot-preload`、`route-refresh` 或 `ignored`。
