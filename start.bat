@echo off
chcp 65001 > nul
cd /d "%~dp0"
where node > nul 2>&1
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않아요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b
)
rem 예전에 켜 둔 게임 서버(node.exe)가 3000번 포트를 쓰고 있으면 끄고 새로 시작
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  tasklist /FI "PID eq %%p" | find /i "node.exe" > nul && (
    echo 이전에 켜 둔 게임 서버(PID %%p^)를 끄고 새로 시작합니다...
    taskkill /PID %%p /F > nul
  )
)
timeout /t 1 /nobreak > nul
start "" http://localhost:3000
node server.js
pause
