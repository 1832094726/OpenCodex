# OpenCodex 状态流转监控设计

这份设计用于解决手机端或远程浏览器里“卡住了但不知道卡在哪”的问题。目标不是堆更多原始日志，而是把一次打开对话、拉取历史、发送消息、等待回复拆成用户能看懂、开发者能关联日志的状态流。

## 设计原则

OpenCodex 采用域名隔离：Mac 域名只表示 Mac gateway，Win 域名只表示 Win gateway。状态监控只展示当前域名对应机器的链路，不聚合跨机器会话，避免排障时把 Mac/Win 状态混在一起。

状态面板必须回答四个问题：

- 当前连接是否可用：浏览器在线、WebSocket 已连、gateway 健康、官方 runtime 可响应。
- 历史记录是否拉完：`thread/read`、`thread/resume`、`thread/turns/list` 是否成功，耗时多少。
- 消息是否发出：用户点发送后是否进入 `turn/start`，是否拿到成功回包。
- 后续为什么没动：stream 是否开始、是否断连、是否后端仍在跑、是否页面刷新没有重新订阅。

## 链路状态机

### 页面连接

| 状态 | 触发事件 | 成功下一步 | 异常提示 |
| --- | --- | --- | --- |
| `booting` | 页面加载 polyfill | `ws_connecting` | 页面脚本未加载 |
| `ws_connecting` | 创建 `/ws` | `ws_ready` | WebSocket 连接中断 |
| `ws_ready` | 收到 `hello-ack` | `runtime_checking` | gateway 未确认 clientId |
| `runtime_checking` | `account/read` 或 `config/read` 成功 | `ready` | 官方 runtime 无响应 |
| `ready` | 页面可操作 | 等待对话操作 | 无 |

### 打开对话和历史拉取

| 状态 | 触发事件 | 成功下一步 | 异常提示 |
| --- | --- | --- | --- |
| `thread_opening` | 进入线程路由 | `thread_reading` | 路由无 threadId |
| `thread_reading` | `thread/read` | `thread_resuming` | 对话元信息读取失败 |
| `thread_resuming` | `thread/resume` | `turns_loading` | 对话恢复失败 |
| `turns_loading` | `thread/turns/list` | `thread_ready` | 历史消息拉取失败 |
| `thread_ready` | 历史消息已渲染或列表为空 | 等待发送 | 无 |

### 发送消息

| 状态 | 触发事件 | 成功下一步 | 异常提示 |
| --- | --- | --- | --- |
| `drafting` | 输入框有内容 | `submitting` | 无 |
| `submitting` | 点击发送 | `turn_starting` | 页面未提交到 gateway |
| `turn_starting` | `turn/start` 请求发出 | `turn_accepted` | 官方 runtime 拒绝请求 |
| `turn_accepted` | `turn/start` 成功回包 | `assistant_streaming` 或 `waiting_for_events` | 已提交但没有后续事件 |
| `assistant_streaming` | 收到 turn/stream 相关事件 | `turn_completed` | stream 中断 |
| `waiting_for_events` | 无 stream 但后端已接收 | `assistant_streaming` 或 `stalled` | 等待事件超时 |
| `turn_completed` | turn 完成或刷新后出现在历史里 | `thread_ready` | 无 |
| `turn_failed` | 回包或事件带错误 | 等待重试 | 显示错误原因 |

### app-host relay

| 状态 | 触发事件 | 成功下一步 | 异常提示 |
| --- | --- | --- | --- |
| `relay_connected` | `app-host-port-connected` | 正常转发 | 无 |
| `relay_missing` | `app_host_message_missing_relay` | `relay_recreating` | 页面端口还在，gateway 端口丢失 |
| `relay_recreating` | 自动重建 relay | `relay_flushed` | 重建失败 |
| `relay_flushed` | `app_host_pending_messages_flushed` | 正常转发 | 缓存消息未完全发送 |
| `relay_failed` | `app_host_missing_relay_recreate_failed` | 等待刷新 | 需要刷新会话或重连 WS |

## 事件模型

前后端统一记录 `flowId`。一次页面加载生成 `clientId`，一次打开线程生成 `threadFlowId`，一次发送生成 `turnFlowId`。日志里即使没有完整 payload，也能用这些 ID 串起来。

```json
{
  "type": "opencodex:flow-event",
  "scope": "thread",
  "stage": "turn_starting",
  "level": "info",
  "clientId": "short-client-id",
  "threadId": "019f...",
  "turnId": "optional",
  "requestId": "official-request-id",
  "method": "turn/start",
  "startedAtMs": 1780000000000,
  "durationMs": 57,
  "ok": true,
  "error": "",
  "hint": "消息已提交到官方 runtime"
}
```

字段约定：

- `scope`：`connection`、`thread`、`turn`、`relay`、`health`。
- `stage`：状态机里的状态名。
- `level`：`info`、`warn`、`error`。
- `requestId`：官方 IPC 请求 ID，用于和 `AppServerConnection` 日志关联。
- `hint`：面向用户的短说明，不放敏感路径、token 或完整消息内容。

## 后端记录点

后端要把离散日志转成可查询的最近状态：

- `ws-hub`：记录 `hello`、`hello-ack`、`send_to_missing_client`、`app_host_message_missing_relay`、`app_host_pending_messages_flushed`、`app_host_missing_relay_recreate_failed`。
- `AppServerConnection`：记录 `thread/read`、`thread/resume`、`thread/turns/list`、`turn/start` 的开始、成功、失败、耗时。
- `server`：提供健康摘要，展示 gateway uptime、WS 客户端数、最近错误、当前域名环境。

建议新增内存环形缓冲：

```text
gateway/runtime/core/flow-monitor.cjs
```

职责：

- `recordFlowEvent(event)`：写入最近 300 条状态事件。
- `snapshotFlowState(clientId, threadId?)`：聚合当前连接、线程、发送、relay 状态。
- `recentFlowEvents(limit)`：给调试面板和接口查看最近事件。

## API 设计

新增只读接口：

```text
GET /api/diagnostics/flow
GET /api/diagnostics/flow?clientId=...&threadId=...
```

返回：

```json
{
  "ok": true,
  "environment": {
    "name": "Win",
    "hostname": "win-eru5lcgnjes.tail4f1eca.ts.net"
  },
  "connection": {
    "state": "ready",
    "wsReady": true,
    "lastHelloAtMs": 1780000000000
  },
  "thread": {
    "state": "thread_ready",
    "threadId": "019f...",
    "lastHistoryLoadMs": 132
  },
  "turn": {
    "state": "waiting_for_events",
    "lastTurnStartMs": 57,
    "ageMs": 4200
  },
  "relay": {
    "state": "relay_flushed",
    "lastQueued": 1,
    "lastSent": 1
  },
  "events": []
}
```

## 前端展示

把现有“网络状态”浮层升级为“链路状态”。仍然保持小入口，但内容分成四行摘要：

```text
连接：正常，WS 已确认
历史：已拉取，132ms
发送：已提交，等待回复 4.2s
通道：relay 已恢复，缓存 1 条已补发
```

点击展开后显示时间线：

```text
17:43:10 WS 已连接
17:43:11 thread/read 成功 4ms
17:43:11 thread/resume 成功 80ms
17:43:11 thread/turns/list 成功 16ms
17:43:18 turn/start 成功 57ms
17:43:23 等待回复超过 5s，未收到 stream 事件
```

状态颜色：

- 绿色：所有关键阶段成功，或正在合理等待。
- 黄色：等待超过阈值但链路未断，例如 `turn/start` 后 5 秒没有后续事件。
- 红色：请求失败、WS 断开、relay 重建失败、目标 clientId 丢失。

面板动作：

- `健康检查`：请求 `/api/health` 和 `/api/diagnostics/flow`。
- `重连 WS`：重建浏览器到 gateway 的 WebSocket。
- `刷新会话`：重新触发 `thread/read`、`thread/resume`、`thread/turns/list`。
- `复制诊断`：复制摘要 JSON，方便贴给开发者。

## 卡顿判定

默认阈值：

| 场景 | 阈值 | 提示 |
| --- | --- | --- |
| WS 未收到 `hello-ack` | 3s | gateway 未确认浏览器连接 |
| `thread/read` 未返回 | 5s | 对话元信息读取慢 |
| `thread/turns/list` 未返回 | 8s | 历史消息加载慢 |
| `turn/start` 未返回 | 8s | 消息还没被官方 runtime 接收 |
| `turn/start` 成功后无后续事件 | 5s | 已提交，等待模型或事件流 |
| relay missing 未 flush | 2s | 通道恢复失败，建议刷新会话 |
| `send_to_missing_client` | 立即红色 | gateway 找不到当前页面连接 |

## 落地步骤

1. 新增 `flow-monitor.cjs`，先做内存环形缓冲和 `/api/diagnostics/flow`。
2. 在 `ws-hub.cjs` 接入连接、relay、missing client 状态事件。
3. 在官方 IPC 响应路由处接入 `thread/read`、`thread/resume`、`thread/turns/list`、`turn/start`。
4. 前端 polyfill 把现有网络浮层改为链路状态面板，并定时拉 `/api/diagnostics/flow`。
5. 增加“复制诊断”按钮，输出当前域名、clientId、threadId、最近状态流，不包含用户消息正文。
6. 补测试：flow event 脱敏、环形缓冲上限、状态聚合、诊断接口鉴权。

## 排障口径

有了状态流后，常见问题可以直接定位：

- 历史空白：看 `thread/turns/list` 是否成功、返回是否慢。
- 点发送后消息消失：看是否进入 `turn/start`，以及是否有 `app_host_message_missing_relay`。
- 提交后没有回复：看 `turn/start` 是否成功，成功后是否进入 `waiting_for_events` 或 stream 阶段。
- 手机后台回来失败：看 WS 是否重新 `hello-ack`，relay 是否补建并 flush。
- 域名打不开：看 `/api/health`、WS 握手和 Tailscale Serve，不进入 thread 状态机。
