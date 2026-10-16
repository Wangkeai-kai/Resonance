@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting Resonance. Open the complete access link printed below.
echo Keep this window open while using the application. Press Ctrl+C to stop.
node server.mjs --port 4173
if errorlevel 1 pause
