@echo off
:: ─────────────────────────────────────────────────────────────────────────────
::  Auto-start Dental Clinic on Windows login (runs silently in background)
::  Run this ONCE as Administrator to register the auto-start.
:: ─────────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

echo.
echo  Setting up Dental Clinic to start automatically with Windows...
echo.

:: Install PM2 globally (keeps Node app running, auto-restarts on crash)
call npm install -g pm2 pm2-windows-startup -q 2>nul
if %errorlevel% neq 0 (
    echo  [WARN] PM2 install failed — using Task Scheduler instead.
    goto :task_scheduler
)

:: Register app with PM2
call pm2 delete dental-clinic 2>nul
call pm2 start "%~dp0server.js" --name dental-clinic
call pm2 save
call pm2-startup install
echo.
echo  [OK] PM2 configured — app will restart automatically on crash and reboot.
goto :done

:task_scheduler
:: Fallback: Windows Task Scheduler (runs on login)
set TASK_NAME=DentalClinicServer
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
schtasks /create /tn "%TASK_NAME%" ^
    /tr "cmd /c \"set NODE_NO_WARNINGS=1 && node \"%~dp0server.js\"\"" ^
    /sc onlogon /rl highest /f >nul
echo  [OK] Task Scheduler entry created — app starts on Windows login.

:done
echo.
echo  ============================================================
echo    Auto-start configured!
echo.
echo    The Dental Clinic server will now start automatically
echo    every time Windows starts.
echo.
echo    To disable auto-start:
echo      pm2 delete dental-clinic  (if using PM2)
echo      schtasks /delete /tn DentalClinicServer /f  (if Task Scheduler)
echo  ============================================================
echo.
pause
