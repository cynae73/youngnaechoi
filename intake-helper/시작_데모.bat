@echo off
chcp 65001 >nul
cd /d "%~dp0"
set KAFRI_DEMO=1
start "" http://127.0.0.1:8791
if exist node.exe (node.exe src\server.js) else (node src\server.js)
pause
