@echo off
setlocal enabledelayedexpansion
title Dental Clinic - Network Server
color 0A
cd /d "%~dp0"

:: Get this machine's LAN IP address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set "IP=%%a"
    set "IP=!IP: =!"
    goto :found
)
:found

cls
echo.
echo  ============================================================
echo    Dental Clinic Management System — Network Mode
echo  ============================================================
echo.
echo   This PC is now the SERVER for your clinic network.
echo.
echo   *** SHARE THIS ADDRESS WITH ALL OTHER DEVICES ***
echo.
echo        http://!IP!:3000
echo.
echo   Any PC, tablet, or phone on the same WiFi can open
echo   the above address in a browser to use the system.
echo.
echo  ============================================================
echo.
echo   Starting server...
echo.

:: Open Windows Firewall for port 3000 (silently)
netsh advfirewall firewall add rule name="Dental Clinic App" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1

:: Start server (visible window so staff can see it is running)
set NODE_NO_WARNINGS=1
node server.js

pause
