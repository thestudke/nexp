@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping old guard windows...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
rem NOTE: this .bat must stay PURE ASCII. cmd.exe decodes batch files with the
rem local ANSI code page (GBK on zh-CN), so any UTF-8 Chinese here turns into
rem mojibake and can break multi-line if blocks. All user-facing Chinese is
rem printed by node at runtime instead (see scripts/test-encoding.mjs).
rem
rem Why the kill logic below is written this way: start.bat launches with a
rem RELATIVE path (node src/bridge.js), so Win32_Process.CommandLine never
rem contains the repo's absolute path -- the older match on '*%~dp0src\bridge.js*'
rem never hit, so "restart" merely started a second instance while the old
rem bridge kept running (state/bridge.log shows two instances joining the DSH
rem event stream at 04:54; only the console port clash stopped them, and one
rem overwrote social-v2.json with a stale snapshot).
rem So we now kill two ways: by PID from the lock file, and by '*bridge.js*'.
powershell -NoProfile -Command "$lock = Join-Path '%~dp0' 'state\bridge.lock'; $pids = @(); if (Test-Path $lock) { $raw = (Get-Content $lock -Raw).Trim(); if ($raw -match '^\d+$') { $pids += [int]$raw } }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' } | ForEach-Object { $pids += $_.ProcessId }; $pids | Sort-Object -Unique | ForEach-Object { Write-Host ('  kill PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
rem Wait for the old instance to really exit (and release the console port)
rem before deleting the lock -- otherwise "lock gone, process alive" = two instances.
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$live = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }; if ($live) { Write-Host 'bridge processes are still alive:'; $live | ForEach-Object { Write-Host ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }; exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo.
    echo Restart aborted: avoid two instances fighting over messages and
    echo overwriting state. Kill the PIDs listed above, then retry.
    pause
    exit /b 1
)
del state\bridge.lock 2>nul
start "" cmd /c start.bat
echo Guard window started.
