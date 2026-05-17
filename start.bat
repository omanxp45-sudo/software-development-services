@echo off
title Dental Clinic - Server
color 0A
cd /d "%~dp0"
set NODE_NO_WARNINGS=1

:LOOP
echo.
echo  ============================================
echo   Dental Clinic Management System
echo   http://localhost:3000
echo   Login: admin / admin123
echo  ============================================
echo.
node server.js
echo.
echo  [Server stopped - restarting in 2 seconds...]
timeout /t 2 /nobreak >nul
goto LOOP
