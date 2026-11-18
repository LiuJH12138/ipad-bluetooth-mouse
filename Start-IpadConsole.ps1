param([switch]$Usb, [switch]$Browser)
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
if (!$Browser) {
    $inputs = 'packaging/Launcher.cs','packaging/ConsoleWindow.cs','packaging/Build-DesktopHost.ps1','web/console.ico'
    $stamp = ($inputs | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $_)).Hash.Substring(0,12) }) -join '-'
    $hostDirectory = Join-Path $PSScriptRoot "build/desktop-$stamp"
    $executable = Join-Path $hostDirectory 'iPadControlConsole.exe'
    if (!(Test-Path -LiteralPath $executable)) {
        & "$PSScriptRoot/packaging/Build-DesktopHost.ps1" -Destination $hostDirectory
    }
    $arguments = if ($Usb) { '--source --usb' } else { '--source' }
    $start = New-Object Diagnostics.ProcessStartInfo($executable,$arguments)
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $desktop = [Diagnostics.Process]::Start($start)
    try { $desktop.StandardInput.WriteLine($session.url) } finally { $desktop.StandardInput.Close(); $desktop.Dispose() }
    return
}
$url = if ($Usb) { $session.url.Replace('#', '?source=usb#') } else { $session.url }
$chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
if (Test-Path -LiteralPath $chrome) { Start-Process -FilePath $chrome -ArgumentList @($url) }
else { Start-Process $url }