@echo off
echo Installation of dependencies...
call npm i > npm_install_log.txt
if %errorlevel% neq 0 goto error

echo Packaging the app...
call node package-electron.js
if %errorlevel% neq 0 goto error

echo Terminé.
goto end

:error
echo Error, verify the logs.
:end
pause