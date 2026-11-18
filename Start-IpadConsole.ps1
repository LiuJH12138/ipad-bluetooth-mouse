$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$local = Join-Path $PSScriptRoot '.local'
$null = New-Item -ItemType Directory -Path $local -Force
$sessionPath = Join-Path $local 'session.json'
$session = $null
if (Test-Path -LiteralPath $sessionPath) {
    try {
        $candidate = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
        $null = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/status" -f $candidate.port) -Headers @{ 'X-Control-Token' = $candidate.token } -TimeoutSec 2
        $session = $candidate
    } catch {}
}
if ($null -eq $session) {
    if (Test-Path -LiteralPath $sessionPath) { Remove-Item -LiteralPath $sessionPath -Force }
    Start-Process -FilePath $node -ArgumentList @(('"{0}"' -f (Join-Path $PSScriptRoot 'server.js'))) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $local 'server.log') -RedirectStandardError (Join-Path $local 'server-error.log')
    for ($i=0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 100
        if (Test-Path -LiteralPath $sessionPath) { $session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json; break }
    }
    if ($null -eq $session) { throw 'Local server failed to start. Check .local/server-error.log.' }
}
$chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
if (Test-Path -LiteralPath $chrome) { Start-Process -FilePath $chrome -ArgumentList @($session.url) }
else { Start-Process $session.url }