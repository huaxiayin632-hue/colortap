@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\dist\electron.exe" goto missing
if not exist "out\main\index.js" goto missing
start "Rhythm Canvas" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b
:missing
echo Please run npm install and npm run build in this folder first.
pause
