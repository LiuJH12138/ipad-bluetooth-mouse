# -DualDevice verifies two live targets with unpressed pointer moves only.
# Add -VerifyInput -InstalledDirectory E:\ipad to click recognized system search
# fields and type and remove temporary markers on both real devices.
# -VerifyAccessories checks the paired accessory menus, attempts a supported
# display name and disconnects only the verified iPad. Reconnect on that iPad.
param([switch]$DualDevice, [ValidatePattern('^[a-fA-F0-9]{8,32}$')][string]$FirstDevice,
    [string]$InstalledDirectory, [switch]$VerifyInput, [switch]$PreparedSearch,
    [switch]$VerifyAccessories, [switch]$NamesOnly, [switch]$AuditPhoneRadio, [ValidateSet('iPad','iPhone')][string]$CycleDevice, [ValidateSet('iPad','iPhone')][string]$RecoverMarker,
    [ValidatePattern('^[a-fA-F0-9]{8}$')][string]$KnownIpad, [ValidatePattern('^[a-fA-F0-9]{8}$')][string]$KnownPhone)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$destination = Join-Path $root 'build/native-smoke'
& "$PSScriptRoot/Build-DesktopHost.ps1" -Destination $destination
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$test = Join-Path $destination 'DesktopWindowSmoke.exe'
& $csc /nologo /target:exe /platform:x64 /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/reference:$destination\Microsoft.Web.WebView2.Core.dll" "/reference:$destination\Microsoft.Web.WebView2.WinForms.dll" "/out:$test" "$PSScriptRoot\ConsoleWindow.cs" "$root\tests\DesktopWindowSmoke.cs"
if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the native window smoke test' }
$appRoot = if ($InstalledDirectory) { (Resolve-Path -LiteralPath $InstalledDirectory).Path } else { $root }
$node = if ($InstalledDirectory) { Join-Path $appRoot 'runtime/node.exe' } else { (Get-Command node.exe).Source }
if (($VerifyInput -or $VerifyAccessories) -and (!$InstalledDirectory -or !$DualDevice)) { throw 'Input tests require the installed application and two devices' }
if ($VerifyInput -and $VerifyAccessories) { throw 'Select one live test per run' }
if ($AuditPhoneRadio -and (!$VerifyAccessories -or $CycleDevice -ne 'iPhone')) { throw 'Use the audited radio test only with a targeted iPhone accessory run' }
if ($NamesOnly -and (!$VerifyAccessories -or $CycleDevice)) { throw 'Select accessory names or a targeted reconnect separately' }
$start = New-Object Diagnostics.ProcessStartInfo($node, 'server.js --desktop')
$start.WorkingDirectory = $appRoot
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
    $runner.EnvironmentVariables.Remove('IPAD_CONSOLE_INPUT_TEST')
    $runner.EnvironmentVariables['IPAD_CONSOLE_RECOVER_MARKER'] = $RecoverMarker
    $runner.EnvironmentVariables['IPAD_CONSOLE_PREPARED_SEARCH'] = if ($PreparedSearch -and $VerifyInput) { 'yes' } else { '' }
    $runner.EnvironmentVariables['IPAD_CONSOLE_KNOWN_IPAD'] = $KnownIpad
    $runner.EnvironmentVariables['IPAD_CONSOLE_KNOWN_PHONE'] = $KnownPhone
    $runner.EnvironmentVariables['IPAD_CONSOLE_CYCLE_DEVICE'] = $CycleDevice
    $runner.EnvironmentVariables['IPAD_CONSOLE_AUDIT_PHONE_RADIO'] = if ($AuditPhoneRadio) { 'yes' } else { '' }
    $runner.EnvironmentVariables['IPAD_CONSOLE_NAMES_ONLY'] = if ($NamesOnly) { 'yes' } else { '' }
    if ($VerifyInput -or $VerifyAccessories) { $runner.EnvironmentVariables['IPAD_CONSOLE_INPUT_TEST'] = Join-Path $root 'tests/installed-input.hardware.js' }
    $runner.EnvironmentVariables.Remove('IPAD_CONSOLE_ACCESSORY_TEST')
    if ($VerifyAccessories) { $runner.EnvironmentVariables['IPAD_CONSOLE_ACCESSORY_TEST'] = Join-Path $root 'tests/installed-accessories.hardware.js' }
    if ($DualDevice) {
        $runner.EnvironmentVariables['IPAD_CONSOLE_HARDWARE_TEST'] = Join-Path $root 'tests/dual-device.hardware.js'
        $runner.EnvironmentVariables['IPAD_CONSOLE_FIRST_DEVICE'] = $FirstDevice
    } else {
        $runner.EnvironmentVariables.Remove('IPAD_CONSOLE_HARDWARE_TEST')
    }
    $process = [Diagnostics.Process]::Start($runner)
    try {
        $process.StandardInput.WriteLine($line.Result)
        $process.StandardInput.Close()
        # The live run opens three streams, waits for Bluetooth, then releases USB.
        $deadline = if ($VerifyInput -or $VerifyAccessories) { 1500000 } elseif ($DualDevice) { 660000 } else { 45000 }
        if (!$process.WaitForExit($deadline)) { $process.Kill(); throw 'Window test timed out' }
        if ($process.ExitCode -ne 0) { throw 'Native window smoke test failed' }
    } finally { $process.Dispose() }
} finally {
    $server.StandardInput.Close()
    if (!$server.WaitForExit(12000)) { $server.Kill() }
    $server.Dispose()
}
