# 弱网快速同步与缓存优化设计

## 背景

OpenCodex 在手机、平板或远程电脑上访问目标机器的 Codex。弱网下页面经常表现为首屏空白、进入对话慢、发送后长时间转圈。根因不是单一资源加载慢，而是官方 renderer、WebSocket、app-host relay、app-server 和会话状态拉取存在串行等待。

本设计把目标限定为第一阶段：弱网下先显示可用界面和历史内容，并让用户发送消息后立即看到本地 pending 状态。官方 app-server 的新鲜数据仍是最终事实来源。

## 目标

- 首屏 1 秒内尽量显示上次的侧边栏、项目列表和当前会话最近内容。
- 发送消息不等待所有同步链路完成，先本地显示 pending 消息，再后台提交。
- 数据按“近到远”加载：浏览器本地快照、gateway 磁盘快照、官方 app-server 新鲜数据。
- 复用现有 `flow-monitor`，记录首屏、同步和发送每一步耗时。
- 不改变官方最终会话数据结构，不引入跨 Mac/Win 域名会话合并。

## 非目标

- 不做完整离线编辑或长期离线发送。
- 不缓存或重放 assistant 流式正文作为最终事实。
- 不合并不同环境的会话列表。
- 不改官方 renderer 的主要 UI 结构。

## 分层加载模型

页面启动后按四层推进：

```text
静态资源缓存 -> 浏览器本地快照 -> gateway 磁盘快照 -> 官方 app-server 新鲜数据
```

### 静态资源缓存

继续使用现有 Service Worker 和静态资源缓存。它只负责让 HTML、JS、CSS 和字体尽快命中本地缓存，不承担会话数据一致性。

### 浏览器本地快照

浏览器保存最近成功渲染过的轻量快照：

- `thread/list` 摘要。
- 项目和工作区入口摘要。
- 当前 `thread/read` 的元信息。
- 当前会话最近 N 条可显示消息。
- 基础配置快照，例如账号状态、模型列表、权限模式名称。

快照只用于首屏占位和弱网恢复，必须带 `capturedAtMs`、`sourceHost`、`schemaVersion`。如果域名或环境不一致，不使用该快照。

### gateway 磁盘快照

gateway 在成功转发官方只读结果后落盘一份最近快照。浏览器本地没有或太旧时，页面可以从 gateway 读取更近的数据。

适合缓存的方法：

- `thread/list`
- `thread/read`
- `thread/turns/list`
- `project/list` 或官方等价项目查询
- `config/read`
- `account/read`
- `model/list`

不缓存或只短时内存去重的方法：

- `plugin/list`，插件安装和启用状态必须实时。
- `turn/start`、发送、审批、权限写入等有副作用请求。
- 包含敏感正文且无法脱敏的诊断数据。

### 官方新鲜数据

app-server ready 后所有页面状态最终以官方返回为准。新鲜数据回来后按 threadId、turnId、messageId 合并覆盖本地 stale 内容，不能整页 reload。

## 首屏流程

1. web shell 加载后立即渲染官方 shell。
2. polyfill 初始化本地 snapshot store。
3. 如果 URL 包含 threadId，先尝试读取浏览器本地当前 thread 快照。
4. 找到快照后立即投递给 renderer，使侧边栏和会话区先有内容。
5. 同时建立 WebSocket，并请求 gateway 磁盘快照。
6. WebSocket `hello-ack` 后继续走官方 IPC。
7. 官方 `thread/read`、`thread/turns/list` 返回后覆盖 stale 快照。

中文注释要求：实现时每个缓存命中分支都要说明数据来源和一致性边界。

## 发送 pending 队列

发送按钮不应被首屏完整同步阻塞。用户点击发送后：

1. 前端生成 `localSendId`。
2. 立即在当前会话插入 pending 用户消息。
3. 将请求写入短期 pending queue。
4. 如果 WebSocket 和 app-server 可用，立即提交。
5. 如果不可用，等待 `ws_ready` 或 `app_server_ready` 后自动 flush。
6. `turn/start` 成功后，把 pending 状态改成 accepted。
7. 官方 turn 或历史刷新出现对应消息后，移除 pending 替身。
8. 提交失败时保留用户输入和错误状态，允许重试。

pending queue 只保留当前浏览器会话内的短期请求。页面刷新后可以恢复未提交用户消息，但默认不自动提交超过 5 分钟的旧 pending 请求，避免误发。

## 一致性规则

- 官方新鲜数据优先级最高。
- gateway 磁盘快照优先级高于浏览器本地快照。
- pending 用户消息只在当前 thread 显示，不写入官方历史缓存。
- 如果官方历史已经包含相同 `localSendId`、内容 hash 或 turn 关联，则合并而不是重复显示。
- stale 快照必须有轻量标记，内部状态可标为 `snapshot`，不需要新增明显突兀的 UI。

## 可观测性

复用 `gateway/runtime/core/flow-monitor.cjs`，新增或补充阶段事件：

- `shell_ready`
- `local_snapshot_hit`
- `local_snapshot_miss`
- `gateway_snapshot_hit`
- `gateway_snapshot_miss`
- `ws_ready`
- `app_server_ready`
- `fresh_thread_list_ready`
- `fresh_thread_read_ready`
- `send_pending_created`
- `send_pending_flushed`
- `send_turn_accepted`
- `send_pending_failed`

这些事件不记录用户消息正文，只记录 threadId、turnId、localSendId、耗时、数据来源和错误摘要。

## 数据存储

### 浏览器端

第一阶段优先使用 IndexedDB；如果环境不支持，再退化到 localStorage 的小快照。

建议对象仓库：

- `snapshots`：按 `host + key` 存储 thread/project/config 快照。
- `pendingSends`：按 `host + threadId + localSendId` 存储短期 pending 请求。
- `meta`：schemaVersion、最近清理时间。

### gateway 端

继续使用 `.data/runtime/cache`。新增会话快照文件时按 hash key 存储，避免路径里直接暴露 threadId。写入采用临时文件加 rename，避免弱网或重启时写坏。

## 错误处理

- IndexedDB 打不开：降级为内存快照，本次会话仍可用。
- gateway 快照损坏：删除该条并继续请求官方数据。
- pending flush 超时：状态变为可重试，不自动重复刷屏。
- WebSocket 断开：pending 保留，等待重连；超过阈值后显示重试提示。
- 官方返回冲突：官方数据覆盖 snapshot，pending 只保留未被官方确认的请求。

## 测试计划

- 单元测试 snapshot key、过期判断、schemaVersion 兼容。
- 单元测试 pending queue 的创建、flush、成功合并和失败重试。
- 网关测试磁盘快照写入、读取、损坏恢复和敏感字段过滤。
- 弱网手工测试：Chrome DevTools 或网络限速下验证首屏先显示旧内容，再被新数据覆盖。
- 回归测试：`plugin/list` 不走 stale cache，发送请求不进入只读缓存。

## 阶段拆分

### 第一阶段

- 浏览器本地 thread/list 和当前 thread 快照。
- gateway 磁盘 thread/list、thread/read、thread/turns/list 快照。
- pending 用户消息显示和手动/自动 flush。
- flow-monitor 增加首屏和发送状态点。

### 第二阶段

- 项目列表和模型配置快照。
- 更细的 pending 合并策略。
- 诊断面板展示“本地快照、gateway 快照、官方新鲜数据”的时间线。

### 第三阶段

- IndexedDB 容量管理和快照压缩。
- 更完整的离线恢复策略。
- 可选的用户级缓存清理入口。

## 用户体验判定

第一阶段完成后，弱网下应达到：

- 打开已有会话时，历史内容能先从快照出现。
- 发送消息后，用户消息立即出现在对话里，并标记为等待提交或已提交。
- 网络恢复后无需刷新页面，pending 自动推进。
- 如果卡住，诊断流能显示卡在本地缓存、gateway、WebSocket、app-server 还是官方 turn 事件。
