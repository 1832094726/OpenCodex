# OpenCodex 启动命令说明

这份说明用于日常启动、常驻服务部署和排障。OpenCodex gateway 会复用本机已安装的官方 Codex Desktop 运行时；Codex 的登录态仍来自 `CODEX_HOME` 指向的 `auth.json`，默认是 `~/.codex/auth.json`。

## 本地手动启动

开发或临时调试时使用：

```bash
pnpm run web:dev
```

等价于先构建 gateway，再运行：

```bash
pnpm run build:gateway
node gateway/dev/run-gateway.cjs
```

默认监听：

```text
http://0.0.0.0:3737
```

可以临时指定监听地址和端口：

```bash
HOST=127.0.0.1 PORT=3737 pnpm run web:dev
HOST=0.0.0.0 PORT=3738 pnpm run web:dev
```

手动启动适合看日志和调试；终端关闭后 gateway 会退出。

## 一键启动脚本

仓库根目录提供两个本机启动脚本：

```text
start-opencodex-mac.sh
start-opencodex-win.bat
```

Mac：

```bash
chmod +x ./start-opencodex-mac.sh
./start-opencodex-mac.sh
```

Windows：

```powershell
.\start-opencodex-win.bat
```

脚本默认设置：

```text
HOST=0.0.0.0
PORT=3737
OPENCODEX_GATEWAY_SERVICE_MODE=1
CODEX_WEB_CONFIG_PATH=当前目录/config.yaml
```

脚本会先执行 `pnpm run build:gateway`，再启动 `gateway/dev/run-gateway.cjs`。它们只启动当前电脑上的 OpenCodex，不会合并 Mac/Win 会话。

## 常驻服务模式

手机或其他电脑远程访问时建议使用常驻服务。服务模式会设置：

```text
OPENCODEX_GATEWAY_SERVICE_MODE=1
```

这个变量会关闭 gateway 对父进程生命周期管道的依赖，避免 Windows 计划任务、SSH 启动器或后台脚本退出时把 OpenCodex 一起带走。

安装前先构建：

```bash
pnpm run build:gateway
```

macOS 当前用户登录后自动启动：

```bash
pnpm run service:install:mac
```

卸载：

```bash
pnpm run service:uninstall:mac
```

Windows 当前用户登录后自动启动：

```powershell
pnpm run service:install:win
```

卸载：

```powershell
pnpm run service:uninstall:win
```

默认端口是 `3737`，默认监听 `0.0.0.0`。安装时可覆盖：

```bash
HOST=0.0.0.0 PORT=3738 pnpm run service:install:mac
```

Windows 可直接传参数：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-windows-scheduled-task.ps1 -HostAddress 0.0.0.0 -Port 3738
```

## 本机验证

检查 gateway 是否可用：

```bash
curl -fsS http://127.0.0.1:3737/api/health
```

重点看：

```text
ok: true
officialIpc.ready: true
runtime.codexHome: ~/.codex 或 C:\Users\<you>\.codex
```

`officialIpc.ready` 在刚启动时可能短暂为 `false`，等待隐藏官方窗口和 app-server 初始化完成后会变成 `true`。

## Mac 常驻排障

查看服务：

```bash
launchctl print gui/$(id -u)/dev.opencodex.gateway
```

重启服务：

```bash
launchctl kickstart -k gui/$(id -u)/dev.opencodex.gateway
```

查看日志：

```bash
tail -f .data/logs/opencodex-gateway.out.log
tail -f .data/logs/opencodex-gateway.err.log
```

## Windows 常驻排障

查看任务：

```powershell
Get-ScheduledTask -TaskName "OpenCodex Gateway"
```

重启任务：

```powershell
Stop-ScheduledTask -TaskName "OpenCodex Gateway"
Start-ScheduledTask -TaskName "OpenCodex Gateway"
```

查看端口：

```powershell
netstat -ano | Select-String ":3737"
```

查看健康状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3737/api/health
```

如果用自定义 cmd 包装脚本，需要确保脚本里包含：

```bat
set "HOST=0.0.0.0"
set "PORT=3737"
set "CI=true"
set "OPENCODEX_GATEWAY_SERVICE_MODE=1"
node gateway\dev\run-gateway.cjs >> .data\logs\scheduled-gateway.log 2>&1
```

## Tailscale 访问

每台机器上的 Tailscale Serve 都应该代理到本机 gateway：

```bash
tailscale serve status
```

期望形态：

```text
https://<device>.<tailnet>.ts.net
|-- / proxy http://127.0.0.1:3737
```

手机访问时优先用 HTTPS Tailscale 域名：

```text
https://<device>.<tailnet>.ts.net/
```

Win 入口示例：

```text
https://win-eru5lcgnjes.tail4f1eca.ts.net/
```

## 多设备入口

当前推荐使用“各自域名、各自会话”的方式：

- Mac 和 Win 都运行同一套 OpenCodex gateway。
- 每台机器都有自己的 Tailscale Serve 域名。
- Mac 域名只显示和操作 Mac 本机 Codex 会话。
- Win 域名只显示和操作 Win 本机 Codex 会话。

普通 HTTPS 域名本身需要 DNS/TLS 给出一个确定入口，所以在完全没有中心协调者时，不能保证同一个 hostname 在 Mac 关机后自动漂移到 Win。要做到真正的单域名自动故障转移，需要额外组件，例如：

- 一个长期在线的小 VPS / NAS / 家庭网关做反向代理。
- DNS 健康检查和自动切换。
- Tailscale 内部再放一个固定入口服务。

不引入中心节点时，保留两个设备域名最稳：哪台电脑在线，就打开哪台电脑的域名；历史会话也只来自对应电脑本机。

## 常用环境变量

| 变量 | 说明 |
| --- | --- |
| `HOST` | gateway 监听地址，远程访问通常用 `0.0.0.0`。 |
| `PORT` | gateway 监听端口，默认 `3737`。 |
| `OPENCODEX_GATEWAY_SERVICE_MODE` | 设为 `1` 后按常驻服务运行，不依赖启动父进程。 |
| `CODEX_WEB_CONFIG_PATH` | gateway 配置文件路径，默认 `config.yaml`。 |
| `CODEX_HOME` | Codex 登录态和配置目录，默认 `~/.codex`。 |
| `CODEX_DESKTOP_APP_PATH` | 指定官方 Codex Desktop 安装路径或 `app.asar` 路径。 |
| `CODEX_WEB_RUNTIME_DIR` | gateway 运行时目录，默认 `.data/runtime`。 |
| `CODEX_WEB_OFFICIAL_BUNDLE_DIR` | 官方 bundle 解包缓存目录。 |
| `CODEX_WEB_OFFICIAL_USER_DATA_DIR` | OpenCodex 隔离使用的官方 Electron profile。 |
