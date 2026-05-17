@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: Check if server already running on port 3000
netstat -ano 2>nul | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
    start "" http://localhost:3000
    exit /b 0
)

:: Start node server completely hidden - no DOS window
set "_APPDIR=%~dp0"
powershell -NoProfile -WindowStyle Hidden -Command "$env:NODE_NO_WARNINGS='1'; Start-Process 'node' 'server.js' -WorkingDirectory $env:_APPDIR -WindowStyle Hidden" >nul 2>&1

:: Wait up to 15 seconds for server to be ready
for /l %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul
    netstat -ano 2>nul | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
    if !errorlevel!==0 goto :ready
)

:ready
start "" http://localhost:3000
endlocal
exit /b 0
