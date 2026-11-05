@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install it, then double-click start.bat again.
  pause
  exit /b 1
)
node "%~dp0apps\launcher\desktop.mjs" start %*
if errorlevel 1 (
  pause
  exit /b 1
)
