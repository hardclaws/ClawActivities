@echo off
title Activity Dock
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found. Please install it from https://nodejs.org  ^(LTS version^)
  echo  then run this file again.
  echo.
  pause
  exit /b 1
)
node server.js %*
echo.
echo  The server stopped. Press any key to close.
pause >nul
