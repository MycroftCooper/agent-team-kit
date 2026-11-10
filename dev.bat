@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\desktop-dev.ps1"
set "atkExit=%ERRORLEVEL%"
if not "%atkExit%"=="0" if not defined ATK_DESKTOP_TEST pause
exit /b %atkExit%
