param(
  [string]$TaskName = "OpenCodex Gateway",
  [string]$HostAddress = "0.0.0.0",
  [string]$Port = "3737"
)

# 把 OpenCodex gateway 注册为当前用户登录后自动启动的计划任务，适合 Windows 远程常驻部署。
$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$GatewayScript = Join-Path $ProjectRoot "gateway\dev\run-gateway.cjs"
$BuildMarker = Join-Path $ProjectRoot "gateway\dist\official\LocalCodexBundleProvider.js"
$WrapperScript = Join-Path $ProjectRoot "run-gateway-service.cmd"
$Node = (Get-Command node).Source

if (!(Test-Path $GatewayScript)) {
  throw "Gateway script not found: $GatewayScript"
}
if (!(Test-Path $BuildMarker)) {
  throw "Gateway build output not found. Run pnpm run build:gateway before installing the service."
}

$WrapperContent = @(
  "@echo off",
  "setlocal EnableExtensions EnableDelayedExpansion",
  "cd /d `"$ProjectRoot`"",
  "set `"HOST=$HostAddress`"",
  "set `"PORT=$Port`"",
  "set `"CI=true`"",
  "set `"OPENCODEX_GATEWAY_SERVICE_MODE=1`"",
  "if not defined OPENCODEX_PROXY_URL (",
  "  for /f `"tokens=3*`" %%A in ('reg query `"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`" /v ProxyServer 2^>nul ^| find `"ProxyServer`"') do set `"OPENCODEX_PROXY_URL=%%A`"",
  ")",
  "if defined OPENCODEX_PROXY_URL (",
  "  echo !OPENCODEX_PROXY_URL! | findstr /i /b `"http:// https:// socks5:// socks://`" >nul",
  "  if errorlevel 1 (set `"OPENCODEX_PROXY_URL=http://!OPENCODEX_PROXY_URL!`")",
  "  set `"HTTP_PROXY=!OPENCODEX_PROXY_URL!`"",
  "  set `"HTTPS_PROXY=!OPENCODEX_PROXY_URL!`"",
  "  set `"ALL_PROXY=!OPENCODEX_PROXY_URL!`"",
  "  set `"NO_PROXY=localhost,127.0.0.1,::1,100.64.0.0/10,.ts.net`"",
  ")",
  "`"$Node`" `"$GatewayScript`" >> .data\logs\scheduled-gateway.log 2>&1"
) -join "`r`n"
Set-Content -Path $WrapperScript -Value $WrapperContent -Encoding ASCII

$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c `"$WrapperScript`"" -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

# 计划任务环境变量支持有限，这里把 HOST/PORT 写入用户环境，保证下次登录也按远程访问配置启动。
[Environment]::SetEnvironmentVariable("HOST", $HostAddress, "User")
[Environment]::SetEnvironmentVariable("PORT", $Port, "User")
[Environment]::SetEnvironmentVariable("CI", "true", "User")
[Environment]::SetEnvironmentVariable("OPENCODEX_GATEWAY_SERVICE_MODE", "1", "User")

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Run OpenCodex gateway as a background service." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "[opencodex-service] installed scheduled task: $TaskName"
Write-Host "[opencodex-service] local url: http://127.0.0.1:$Port"
