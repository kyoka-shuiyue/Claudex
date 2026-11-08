@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch\install.ps1" %*
exit /b %errorlevel%

