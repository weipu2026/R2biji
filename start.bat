@echo off
rem JMbiji launcher: start local server and open browser (double-click me)
rem Requires Node.js >= 22 (https://nodejs.org)
cd /d "%~dp0"

set NODE_EXE=
where node >nul 2>nul && set NODE_EXE=node
if not defined NODE_EXE (
  echo [JMbiji] Node.js not found. Please install Node.js 22 or later first.
  pause
  exit /b 1
)

start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:8787"
%NODE_EXE% dev-server.mjs 8787
pause
