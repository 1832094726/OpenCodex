@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM 一键启动本机 OpenCodex gateway；Win 域名只服务 Win 本机 Codex 会话。
set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

REM 远程访问默认监听所有网卡；需要改端口可在运行前设置 PORT。
if "%HOST%"=="" set "HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=3737"
if "%CI%"=="" set "CI=true"
if "%OPENCODEX_GATEWAY_SERVICE_MODE%"=="" set "OPENCODEX_GATEWAY_SERVICE_MODE=1"
if "%CODEX_WEB_CONFIG_PATH%"=="" set "CODEX_WEB_CONFIG_PATH=%ROOT_DIR%config.yaml"

REM 后台 gateway 不一定能继承系统代理，这里自动读取 Windows 代理并传给 Node/Electron/Codex。
if "%OPENCODEX_PROXY_URL%"=="" (
  for /f "tokens=3*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| find "ProxyServer"') do set "OPENCODEX_PROXY_URL=%%A"
)
if not "%OPENCODEX_PROXY_URL%"=="" (
  echo !OPENCODEX_PROXY_URL! | findstr /i /b "http:// https:// socks5:// socks://" >nul
  if errorlevel 1 set "OPENCODEX_PROXY_URL=http://!OPENCODEX_PROXY_URL!"
  set "HTTP_PROXY=!OPENCODEX_PROXY_URL!"
  set "HTTPS_PROXY=!OPENCODEX_PROXY_URL!"
  set "ALL_PROXY=!OPENCODEX_PROXY_URL!"
  set "NO_PROXY=localhost,127.0.0.1,::1,100.64.0.0/10,.ts.net"
)

if not exist ".data\logs" mkdir ".data\logs"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo 未找到 pnpm，请先安装 Node.js/pnpm 后再启动 OpenCodex。
  pause
  exit /b 1
)

echo OpenCodex Windows gateway 启动中...
echo 项目目录: %ROOT_DIR%
echo 监听地址: http://127.0.0.1:%PORT%
echo 远程访问: http://^<Win-IP^>:%PORT% 或已配置的 Tailscale Serve 域名
echo 代理地址: !OPENCODEX_PROXY_URL!

REM 每次启动前构建 gateway，确保本地代码改动已生效。
call pnpm run build:gateway
if errorlevel 1 (
  echo gateway 构建失败。
  pause
  exit /b 1
)

node gateway\dev\run-gateway.cjs
pause
