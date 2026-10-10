@echo off
rem 예약 작업(IntakeHelper)이 호출하는 실행 파일. 출력은 logs\server.log 에 쌓입니다.
chcp 65001 >nul
cd /d "%~dp0.."
if not exist logs mkdir logs
if exist node.exe (
  node.exe src\server.js >> logs\server.log 2>&1
) else (
  node src\server.js >> logs\server.log 2>&1
)
