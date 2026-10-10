<#
 접수 도우미 서버 설치 (Windows Server / Windows PC). 관리자 권한 PowerShell 에서 실행합니다.

   powershell -ExecutionPolicy Bypass -File deploy\install.ps1 -Url https://intake.example.go.kr -Port 8791 `
       [-Ips 10.20.0.0/24] [-Employees 100123,100456] [-NoService] [-NoFirewall]

 하는 일: Node 확인 -> npm ci -> .env 만들기(접속 비밀번호 자동 생성) -> 방화벽 허용 ->
          부팅 때 자동 시작되는 예약 작업 등록·시작 -> 점검
 같은 명령을 다시 실행하면 갱신됩니다(.env 는 그대로 유지).
 HTTPS 는 별도입니다(docs\서버배포.md): IIS/nginx 프록시 또는 .env 의 TLS_CERT / TLS_KEY.
#>
param(
  [string]$Url = '',
  [int]$Port = 8791,
  [string]$Ips = '',
  [string]$Employees = '',
  [switch]$NoService,
  [switch]$NoFirewall
)
$ErrorActionPreference = 'Stop'
$Dir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Dir

function Say($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Say '1/5 Node.js 확인'
$node = if (Test-Path (Join-Path $Dir 'node.exe')) { Join-Path $Dir 'node.exe' } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw 'Node.js 가 없습니다. Node 18 이상을 설치하거나 node.exe 를 이 폴더에 복사하세요.' }
$ver = (& $node -v).TrimStart('v')
if ([int]($ver.Split('.')[0]) -lt 18) { throw "Node.js 18 이상이 필요합니다 (현재 $ver)." }
Write-Host "Node.js $ver ($node)"

Say '2/5 라이브러리 설치 (npm ci)'
$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw 'npm 을 찾을 수 없습니다. Node.js 를 설치하면 함께 설치됩니다.' }
& $npm ci --omit=dev --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) { throw 'npm ci 가 실패했습니다.' }

Say '3/5 설정 파일(.env)'
$envFile = Join-Path $Dir '.env'
$newPw = ''
if (Test-Path $envFile) {
  Write-Host '.env 가 이미 있어 그대로 둡니다.'
} else {
  if (-not $Url) { throw '처음 설치에는 -Url (사용자가 입력할 주소, 예: https://intake.example.go.kr) 이 필요합니다.' }
  $bytes = New-Object byte[] 15
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $newPw = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', 'A').Replace('/', 'b')
  $text = Get-Content (Join-Path $Dir '.env.server.example') -Raw -Encoding UTF8
  $text = $text -replace '(?m)^PORT=.*$', "PORT=$Port"
  $text = $text -replace '(?m)^PUBLIC_URL=.*$', "PUBLIC_URL=$($Url.TrimEnd('/'))"
  $text = $text -replace '(?m)^ACCESS_PASSWORD=.*$', "ACCESS_PASSWORD=$newPw"
  $text = $text -replace '(?m)^ALLOWED_IPS=.*$', "ALLOWED_IPS=$Ips"
  $text = $text -replace '(?m)^ALLOWED_EMPLOYEES=.*$', "ALLOWED_EMPLOYEES=$Employees"
  [System.IO.File]::WriteAllText($envFile, $text, (New-Object System.Text.UTF8Encoding($false)))
  # 관리자와 SYSTEM 만 읽을 수 있게
  icacls $envFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
  Write-Host '.env 를 만들었습니다.'
}
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'logs') | Out-Null
$portInEnv = (Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1).Matches.Groups[1].Value
if ($portInEnv) { $Port = [int]$portInEnv }

Say '4/5 방화벽 · 자동 시작'
if (-not $NoFirewall) {
  Get-NetFirewallRule -DisplayName 'IntakeHelper' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $fw = @{ DisplayName = 'IntakeHelper'; Direction = 'Inbound'; Protocol = 'TCP'; LocalPort = $Port; Action = 'Allow' }
  if ($Ips) { $fw.RemoteAddress = $Ips.Split(',') }
  New-NetFirewallRule @fw | Out-Null
  Write-Host "방화벽: TCP $Port 허용$(if ($Ips) { " (허용 IP: $Ips)" } else { ' (모든 IP — ALLOWED_IPS 로 제한을 권장)' })"
}
if ($NoService) {
  Write-Host '-NoService: 건너뜁니다. 직접 실행: deploy\run-server.bat'
} else {
  $task = 'IntakeHelper'
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ""' + (Join-Path $Dir 'deploy\run-server.bat') + '""') -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 3
  Write-Host "예약 작업 '$task' 을 등록하고 시작했습니다(부팅 때 자동 시작)."
}

Say '5/5 점검'
& $node (Join-Path $Dir 'deploy\check.js') --url "http://127.0.0.1:$Port"

Write-Host ''
Write-Host '────────────────────────────────────────────'
Write-Host " 설치 위치     $Dir"
if ($Url) { Write-Host " 접속 주소     $Url  (HTTPS 설정은 별도: docs\서버배포.md)" }
if ($newPw) {
  Write-Host " 접속 비밀번호 $newPw"
  Write-Host "               (고객지원팀에만 알려 주세요. $envFile 의 ACCESS_PASSWORD 에도 있습니다.)"
}
Write-Host ' 사용 안내서   <접속 주소>/guide.html  (브라우저에서 열어 A4 1장으로 인쇄)'
Write-Host " 기록 보기     $Dir\logs"
Write-Host ' 중지/시작     Stop-ScheduledTask / Start-ScheduledTask -TaskName IntakeHelper'
Write-Host '────────────────────────────────────────────'
