@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch\stop.ps1"
exit /b %errorlevel%
