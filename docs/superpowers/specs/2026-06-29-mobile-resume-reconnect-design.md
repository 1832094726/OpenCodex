# Mobile Resume Reconnect Design

## 背景

移动端浏览器进入后台后，系统可能暂停页面计时器、冻结 WebSocket，或让原连接处于半开状态。OpenCodex 当前在移动端后台超过阈值后恢复前台时，会强制重建 WebSocket；但重连成功后还会调用 `location.reload()` 刷新当前会话页。这个策略能修复一部分半同步状态，却会打断用户正在看的对话、输入草稿和滚动位置。

## 目标

- 手机从后台回到前台时默认原地恢复连接，不自动刷新整页。
- 恢复链路要尽量确定：新 WebSocket 握手成功后，主动重建 app-host relay，并补发官方 renderer 依赖的本地同步事件。
- 连接异常时要有兜底：页面继续后台重试，并给用户一个明确但不突兀的手动重连/刷新入口。
- 不改变桌面端短暂断线的体验，不影响现有弱网 fast-sync 和发送中状态优化。

## 非目标

- 不做多环境会话合并。
- 不改变官方 renderer 的路由结构。
- 不在恢复前台时自动发起会话业务请求的重复写操作。

## 设计方案

推荐方案是“优先无感重连，保留显式兜底”。移动端恢复前台时，如果页面隐藏时间超过现有阈值，前端仍会丢弃旧 WebSocket 并创建新连接。新连接收到 gateway 的 `hello-ack` 后，不再安排整页刷新，而是完成以下恢复动作：

1. 重建所有仍然活跃的 app-host relay。
2. 冲刷 relay pending 队列。
3. 补发 `persisted-atom-sync`。
4. 补发 Web 运行必需的 shared-object snapshot。
5. 写入诊断事件，标记本次恢复没有触发 reload。

如果恢复后 WebSocket 仍未 ready，继续使用现有指数退避重连。页面不自动刷新；网络状态面板保留“重连 WS”和“刷新页面”作为手动兜底。这样异常状态可恢复，正常状态不会被刷新打断。

## 兜底策略

- 自动兜底：`scheduleReconnect()` 继续按指数退避重连，最大延迟沿用现有 5 秒上限。
- 半连接兜底：如果 WebSocket 已 open 但一直没有 `hello-ack`，继续使用现有 `forceGatewayWebSocketReconnect()` 换线。
- 用户兜底：网络状态面板继续提供手动重连和刷新页面。刷新页面只由用户明确触发。
- 诊断兜底：增加移动恢复相关诊断，方便从 `/api/diagnostics/flow` 或客户端面板确认恢复卡在哪一步。

## 测试计划

- 增加 source-level 回归测试，确保移动端恢复重连逻辑不再通过 `location.reload()` 自动刷新当前会话。
- 测试保留强制 WebSocket 重连路径，确保后台恢复仍会触发 `ensureGatewayWebSocket(... force: true)`。
- 运行现有完整测试集，确认 fast-sync、flow monitor、认证和日志相关测试不回退。
