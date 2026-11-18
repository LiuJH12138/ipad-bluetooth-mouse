param([Parameter(Mandatory)][string]$Msi)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $Msi).Path
$target = Join-Path $env:TEMP ('iPadConsoleInstallerTest-' + [guid]::NewGuid().ToString('N'))
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'iPad 控制台.lnk'
if ((Test-Path -LiteralPath $shortcut) -or (Test-Path 'HKCU:\Software\LiuJH12138\iPadControlConsole')) {
    throw 'Run this installation test with a user account that does not have the desktop app installed.'
}
function Run-Msi([string[]]$Options) {
    $proc = Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" -ArgumentList $Options -WindowStyle Hidden -PassThru -Wait
    if ($proc.ExitCode -ne 0) { throw "Windows Installer failed ($($proc.ExitCode))" }
}
Run-Msi @('/i', ('"{0}"' -f $package), '/qn', '/norestart', ('INSTALLDIR="{0}"' -f $target))
try {
    $expected = Join-Path $target 'iPadControlConsole.exe'
    if (!(Test-Path -LiteralPath $expected) -or !(Test-Path -LiteralPath $shortcut)) { throw 'App or Start menu entry missing' }
    $shell = New-Object -ComObject WScript.Shell
    if ($shell.CreateShortcut($shortcut).TargetPath -ne $expected) { throw 'Incorrect Start menu shortcut' }
    foreach ($binary in 'runtime/node.exe','usb/iphone-usb.exe') {
        if (!(Test-Path -LiteralPath (Join-Path $target $binary))) { throw "Missing runtime: $binary" }
    }
} finally {
    # Exercise uninstall without resupplying the original installation path.
    Run-Msi @('/x', ('"{0}"' -f $package), '/qn', '/norestart')
}
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall left files behind' }
Write-Output 'MSI install, custom path, Start menu shortcut and uninstall verified.'
