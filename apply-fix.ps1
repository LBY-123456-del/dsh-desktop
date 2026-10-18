# 应用 dsh-desktop 端口重试修复：把旁路构建好的版本换进 dist\win-unpacked。
#
# 必须在桌面版完全退出后运行——运行中的 exe 无法被替换，硬来会把现有安装弄坏。
# 换入过程先整份拷到暂存目录、再改名就位，任何一步失败都不会留下半成品。
#
# 用法（正常情况直接双击同目录的 apply-fix.cmd）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\apply-fix.ps1
param(
  [string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent) '.dsh-desktop-build\win-unpacked'),
  [string]$Target = (Join-Path $PSScriptRoot 'dist\win-unpacked'),
  [string]$ExeName = 'DeepSeek Harness.exe',
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$processName = [IO.Path]::GetFileNameWithoutExtension($ExeName)
$staging = "$Target.new"
$backup = "$Target.previous"

function Fail([string]$message, [string]$hint) {
  Write-Host "[中止] $message" -ForegroundColor Yellow
  if ($hint) { Write-Host "       $hint" }
  exit 1
}

Write-Host '=== dsh-desktop 修复应用 ===' -ForegroundColor Cyan
Write-Host "源:   $Source"
Write-Host "目标: $Target"
Write-Host ''

# 1) 桌面版必须已退出
$running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Fail "检测到「$processName」仍在运行（PID $($running.Id -join ', ')）。" `
    '请先完全退出桌面版（关窗口不够，确认任务管理器里没有残留进程）再运行本脚本。'
}

# 2) 旁路构建产物必须在
if (-not (Test-Path -LiteralPath (Join-Path $Source $ExeName))) {
  Fail "找不到构建产物：$Source" '请先在 dsh-desktop 目录执行 npm run dist:dir 重新构建。'
}

# 3) 先整份拷进暂存目录；这一步失败时现有安装分毫未动
Write-Host '拷贝新版本到暂存目录…'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
robocopy $Source $staging /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
  Fail "拷贝失败（robocopy 退出码 $LASTEXITCODE）。" '现有安装未被改动，可重试。'
}

# 4) 就位：旧版本改名留档，新版本改名顶上（同卷改名，瞬间完成）
if (Test-Path -LiteralPath $Target) {
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  Move-Item -LiteralPath $Target -Destination $backup
  Write-Host "旧版本已留档：$backup" -ForegroundColor DarkGray
}
Move-Item -LiteralPath $staging -Destination $Target
Write-Host '新版本已就位。' -ForegroundColor Green

# 5) 启动
if ($NoLaunch) {
  Write-Host '（-NoLaunch：跳过启动）' -ForegroundColor DarkGray
} else {
  Start-Process -FilePath (Join-Path $Target $ExeName)
  Write-Host '已启动桌面版。' -ForegroundColor Green
}

Write-Host ''
Write-Host '回滚：删掉 dist\win-unpacked，再把 win-unpacked.previous 改回 win-unpacked。' -ForegroundColor DarkGray
Write-Host '注意：桌面版固定在 3080，界面设置按 origin 隔离——回到 3080 后看到的是更早存在 3080 下的那套设置。' -ForegroundColor DarkGray
