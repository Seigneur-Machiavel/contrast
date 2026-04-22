@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "PARENT=%ROOT%\.."
set "TESTNET_DIR=%PARENT%\contrast-testnet"

echo.
echo  ██████╗ ██████╗ ███╗   ██╗████████╗██████╗  █████╗ ███████╗████████╗
echo  ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝
echo  ██║     ██║   ██║██╔██╗ ██║   ██║   ██████╔╝███████║███████╗   ██║
echo  ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══██╗██╔══██║╚════██║   ██║
echo  ╚██████╗╚██████╔╝██║ ╚████║   ██║   ██║  ██║██║  ██║███████║   ██║
echo   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝   ╚═╝
echo.
echo  Setup v1.0
echo  ─────────────────────────────────────────────────────
echo.

set /p "TESTNET= Also install testnet? (y/n): "
echo.
set /p "AUTOUPDATE= Enable auto-update? (y/n): "
echo.
set /p "SHORTCUT= Create desktop shortcuts? (y/n): "
echo.
echo  Installing...
echo.

call :write_config "%ROOT%\client\launcher-config.json" "mainnet"
echo  [OK] contrast (mainnet)

if /i "%TESTNET%" neq "n" (
    xcopy /e /i /q "%ROOT%" "%TESTNET_DIR%" >nul
    del /q "%TESTNET_DIR%\setup.bat" >nul 2>&1
    call :write_config "%TESTNET_DIR%\client\launcher-config.json" "testnet"
    echo  [OK] contrast-testnet
)

if /i "%SHORTCUT%" neq "n" (
    call :create_shortcut "Contrast" "%ROOT%\client\contrast.exe"
    if /i "%TESTNET%" neq "n" call :create_shortcut "Contrast Testnet" "%TESTNET_DIR%\client\contrast.exe"
    echo  [OK] Shortcuts created
)

if exist "%PARENT%\contrast.zip" del /q "%PARENT%\contrast.zip" >nul 2>&1
del /q "%ROOT%\setup.bat" >nul 2>&1

echo.
echo  ─────────────────────────────────────────────────────
echo  Done! Run contrast.exe from your install folder(s).
echo  ─────────────────────────────────────────────────────
echo.
pause
exit /b 0

:write_config
set "AU=false"
if /i "%AUTOUPDATE%" neq "n" set "AU=true"
(
    echo {
    echo   "network": "%~2",
    echo   "autoUpdate": %AU%
    echo }
) > "%~1"
goto :eof

:create_shortcut
powershell -NoProfile -Command ^
  "$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\%~1.lnk');" ^
  "$s.TargetPath='%~2';" ^
  "$s.WorkingDirectory='%~dp2';" ^
  "$s.Save()"
goto :eof