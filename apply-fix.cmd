@echo off
rem ASCII-only launcher on purpose: cmd.exe parsing stays safe, while all the
rem Chinese messages live in apply-fix.ps1 (UTF-8 **with BOM**, so both
rem Windows PowerShell 5.1 and pwsh 7 read it correctly).
setlocal
cd /d "%~dp0"

rem Prefer PowerShell 7 when it exists; fall back to the always-present 5.1.
set "PS=powershell"
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS=%ProgramFiles%\PowerShell\7\pwsh.exe"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-fix.ps1"

echo.
pause
