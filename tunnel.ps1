$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location $PSScriptRoot
$Host.UI.RawUI.WindowTitle = '모르둠 - 외부 공개 (이 창을 닫으면 외부 접속 종료)'

# 1) cloudflared 준비 (처음 한 번만 다운로드)
$cf = Join-Path $PSScriptRoot 'cloudflared.exe'
if (-not (Test-Path $cf)) {
  Write-Host '[1/3] cloudflared 다운로드 중... (처음 한 번만, 약 60MB)'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -UseBasicParsing
} else { Write-Host '[1/3] cloudflared 준비됨' }

# 2) 게임 서버가 꺼져 있으면 새 창으로 켜기
$up = $false
try { Invoke-WebRequest -Uri 'http://localhost:3000/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true } catch {}
if (-not $up) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js가 없어요. https://nodejs.org 에서 설치하세요.'; Read-Host '엔터로 종료'; exit }
  Write-Host '[2/3] 게임 서버 시작 (새 창)'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'node server.js' -WorkingDirectory $PSScriptRoot
  Start-Sleep -Seconds 2
} else { Write-Host '[2/3] 게임 서버 이미 실행 중' }

# 3) 터널 열고 주소 찾기
Write-Host '[3/3] 외부 접속 주소 만드는 중... (10초 정도)'
$log = Join-Path $env:TEMP 'mordum-cloudflared.log'
Remove-Item $log -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $cf -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://localhost:3000' -NoNewWindow -PassThru -RedirectStandardError $log
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Seconds 1
  if ($p.HasExited) { break }
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) {
  Write-Host ''
  Write-Host '주소를 만들지 못했어요. 아래 로그를 확인하세요:' -ForegroundColor Red
  if (Test-Path $log) { Get-Content $log -Tail 15 }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  Read-Host '엔터로 종료'; exit
}
try { Set-Clipboard -Value $url } catch {}
Write-Host ''
Write-Host '==============================================================' -ForegroundColor Magenta
Write-Host '  외부 접속 주소 (클립보드에 복사됨):' -ForegroundColor White
Write-Host ''
Write-Host ('     ' + $url) -ForegroundColor Yellow
Write-Host ''
Write-Host '  이 주소를 친구에게 보내세요. 방 번호와 함께 쓰면 돼요.'
Write-Host '  * 이 창을 닫으면 외부 접속이 끊겨요. 켤 때마다 주소가 바뀌어요.'
Write-Host '==============================================================' -ForegroundColor Magenta
Start-Process $url
try { Wait-Process -Id $p.Id } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
