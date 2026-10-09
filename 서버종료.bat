@echo off
chcp 65001 > nul
set FOUND=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  set FOUND=1
  echo 3000번 포트를 쓰는 프로그램(PID %%p^) 종료
  taskkill /PID %%p /F
)
if not defined FOUND echo 3000번 포트를 쓰는 프로그램이 없어요.
echo.
pause
