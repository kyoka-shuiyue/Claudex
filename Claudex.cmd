@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch\start.ps1" %*
exit /b %errorlevel%
