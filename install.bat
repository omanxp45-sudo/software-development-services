@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: ─────────────────────────────────────────────────────────────────────────────
::  Dental Clinic Management System  -  Setup & Installation
:: ─────────────────────────────────────────────────────────────────────────────
title Dental Clinic - Setup
mode con cols=70 lines=45
color 0F

set FAILED=0
set NODE_VER=

call :cls_header

:: ─── STEP 1 : Node.js ────────────────────────────────────────────────────────
echo   [1/5]  Checking Node.js ...
echo.
node --version >nul 2>&1
if !errorlevel! neq 0 (
    echo          Not found.  Trying winget ...
    echo.
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>nul
    if !errorlevel! neq 0 (
        call :fail "Node.js install failed via winget."
        echo.
        echo          Please install Node.js manually:
        echo          https://nodejs.org/en/download/
        echo.
        echo          Then re-run install.bat
        call :done_fail
        exit /b 1
    )
    set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm"
    node --version >nul 2>&1
    if !errorlevel! neq 0 (
        call :fail "Node.js installed but PATH not updated yet."
        echo.
        echo          Close this window, open a new Command Prompt,
        echo          and run install.bat again.
        call :done_fail
        exit /b 1
    )
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
call :ok "Node.js !NODE_VER! ready"

:: ─── STEP 2 : npm install ────────────────────────────────────────────────────
echo   [2/5]  Installing dependencies ...
echo.
call npm install --save-exact >nul 2>&1
if !errorlevel! neq 0 (
    echo          First attempt failed — retrying ...
    echo.
    call npm install --save-exact
    if !errorlevel! neq 0 (
        call :fail "npm install failed.  Check internet connection."
        call :done_fail
        exit /b 1
    )
)
call :ok "Dependencies installed"

:: ─── STEP 3 : Database ───────────────────────────────────────────────────────
echo   [3/5]  Initialising database ...
echo.
node -e "try{require('./db');process.exit(0);}catch(e){console.error(e.message);process.exit(1);}" 2>nul
if !errorlevel! neq 0 (
    call :fail "Database initialisation failed."
    call :done_fail
    exit /b 1
)
call :ok "Database ready  (database\dental.db)"

:: ─── STEP 4 : Desktop icon + shortcut ────────────────────────────────────────
echo   [4/5]  Creating desktop icon and shortcut ...
echo.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\create-shortcuts.ps1" -AppDir "%~dp0"
if !errorlevel! neq 0 (
    call :warn "Shortcut could not be created automatically."
    echo          You can still start the app by running launch.bat
) else (
    call :ok "Desktop shortcut created"
)

:: ─── STEP 5 : Verify server starts ───────────────────────────────────────────
echo   [5/5]  Verifying server ...
echo.
set "_APPDIR=%~dp0"
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process 'node' 'server.js' -WorkingDirectory $env:_APPDIR -WindowStyle Hidden" >nul 2>&1
for /l %%i in (1,1,10) do (
    timeout /t 1 /nobreak >nul
    netstat -ano 2>nul | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
    if !errorlevel!==0 goto :server_ok
)
call :warn "Server did not respond in time — run launch.bat to start manually."
goto :skip_server
:server_ok
call :ok "Server responding on http://localhost:3000"
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 & goto :skip_server
)
:skip_server

:: ─── DONE ────────────────────────────────────────────────────────────────────
call :done_ok

echo.
echo   What was installed:
echo     - Node.js !NODE_VER!
echo     - Express web framework
echo     - SQLite database  (database\dental.db)
echo.
echo   Features included:
echo     - Patients, Appointments, Treatments, Billing
echo     - Inventory management
echo     - Reports ^& Analytics
echo     - User activity log
echo     - Barcode support (patient labels / stickers)
echo     - Signature ^& stamp on invoices
echo     - SMS notifications
echo     - Backup ^& Restore
echo.
echo   Default login:
echo     Username : admin
echo     Password : admin123
echo.
echo   To launch the app any time:
echo     Double-click  "Dental Clinic"  on your Desktop
echo          --or--
echo     Double-click  launch.bat  in this folder
echo          --or--
echo     Double-click  start.bat  (auto-restarts on crash)
echo.
echo  ================================================================
echo.
set /p ASK="  Launch the application now?  (Y / N): "
if /i "!ASK!"=="Y" (
    echo.
    echo   Starting ...
    call "%~dp0launch.bat"
) else (
    echo.
    pause
)
endlocal
exit /b 0

:: ─── SUB-ROUTINES ────────────────────────────────────────────────────────────

:cls_header
    cls
    color 0B
    echo.
    echo  ================================================================
    echo.
    echo      @@@@@@   Dental Clinic Management System  v3.0
    echo     @@@  @@@
    echo     @@@  @@@  Setup ^& Installation
    echo      @@@@@@   Running on Windows
    echo.
    echo  ================================================================
    echo.
    color 0F
    goto :eof

:ok
    color 0A
    echo          [  OK  ]  %~1
    color 0F
    echo.
    goto :eof

:warn
    color 0E
    echo          [ WARN ]  %~1
    color 0F
    echo.
    goto :eof

:fail
    set FAILED=1
    color 0C
    echo          [ FAIL ]  %~1
    color 0F
    echo.
    goto :eof

:done_ok
    color 0A
    echo.
    echo  ================================================================
    echo     Installation Complete!
    echo  ================================================================
    color 0F
    goto :eof

:done_fail
    color 0C
    echo.
    echo  ================================================================
    echo     Installation did not complete.  See errors above.
    echo  ================================================================
    color 0F
    echo.
    pause
    goto :eof
