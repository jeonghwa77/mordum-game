@echo off
chcp 65001 > nul
net session > nul 2>&1
if %errorlevel% neq 0 (
  echo 관리자 권한이 필요해요. 잠시 후 뜨는 창에서 "예"를 눌러주세요.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set NODEPATH=
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODEPATH set "NODEPATH=%%i"
echo.
echo [1/3] 예전에 생긴 Node.js 차단 규칙 삭제...
netsh advfirewall firewall delete rule name="Node.js JavaScript Runtime" > nul 2>&1
netsh advfirewall firewall delete rule name="Mordum Game 3000" > nul 2>&1
netsh advfirewall firewall delete rule name="Mordum Game (node)" > nul 2>&1
echo [2/3] 3000번 포트 허용...
netsh advfirewall firewall add rule name="Mordum Game 3000" dir=in action=allow protocol=TCP localport=3000 profile=any > nul
echo [3/3] node.exe 허용...
if defined NODEPATH (
  netsh advfirewall firewall add rule name="Mordum Game (node)" dir=in action=allow program="%NODEPATH%" enable=yes profile=any > nul
  echo       %NODEPATH%
) else (
  echo       node.exe 를 찾지 못했어요. Node.js 설치를 확인하세요.
)
echo.
echo 완료! 게임 서버(start.bat)를 껐다가 다시 켠 뒤, 다른 기기에서 접속해 보세요.
echo.
pause
