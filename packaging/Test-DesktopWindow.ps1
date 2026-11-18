$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$destination = Join-Path $root 'build/native-smoke'
& "$PSScriptRoot/Build-DesktopHost.ps1" -Destination $destination
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$test = Join-Path $destination 'DesktopWindowSmoke.exe'
& $csc /nologo /target:exe /platform:x64 /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/reference:$destination\Microsoft.Web.WebView2.Core.dll" "/reference:$destination\Microsoft.Web.WebView2.WinForms.dll" "/out:$test" "$PSScriptRoot\ConsoleWindow.cs" "$root\tests\DesktopWindowSmoke.cs"
if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the native window smoke test' }
$start = New-Object Diagnostics.ProcessStartInfo((Get-Command node.exe).Source, 'server.js --desktop')
$start.WorkingDirectory = $root
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardInput = $true
$server = [Diagnostics.Process]::Start($start)
try {
    $line = $server.StandardOutput.ReadLineAsync()
    if (!$line.Wait(15000)) { throw 'Service timed out' }
    $runner = New-Object Diagnostics.ProcessStartInfo($test)
    $runner.UseShellExecute = $false
    $runner.RedirectStandardInput = $true
    $runner.CreateNoWindow = $true
    $runner.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $destination 'profile'
    $process = [Diagnostics.Process]::Start($runner)
    try {
        $process.StandardInput.WriteLine($line.Result)
        $process.StandardInput.Close()
        if (!$process.WaitForExit(45000)) { $process.Kill(); throw 'Window test timed out' }
        if ($process.ExitCode -ne 0) { throw 'Native window smoke test failed' }
    } finally { $process.Dispose() }
} finally {
    $server.StandardInput.Close()
    if (!$server.WaitForExit(12000)) { $server.Kill() }
    $server.Dispose()
}
