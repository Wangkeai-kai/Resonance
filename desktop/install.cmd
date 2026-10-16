@echo off
setlocal
title Install Resonance
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "installExit=%ERRORLEVEL%"
echo.
pause
exit /b %installExit%
