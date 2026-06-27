param(
  [string]$TaskName = "OpenCodex Gateway"
)

# 删除 Windows OpenCodex 常驻计划任务；不会删除项目数据、配置或 Codex 登录态。
$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Write-Host "[opencodex-service] 已卸载常驻任务：$TaskName"
