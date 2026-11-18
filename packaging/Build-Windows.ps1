$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$out = Join-Path $root 'build'
$toolsDir = Join-Path $out 'tooling'
$wix = Join-Path $toolsDir 'wix314'
$mirror = Join-Path $out 'mirrorlab'
$work = Join-Path $out ([Guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'app'
$node = (Get-Command node.exe).Source
function Check([string]$operation) { if ($LASTEXITCODE -ne 0) { throw "$operation failed ($LASTEXITCODE)" } }
foreach ($dir in $toolsDir,$stage,"$stage/runtime","$stage/usb","$stage/licenses") {
    $null = New-Item -ItemType Directory -Force -Path $dir
}
$archive = Join-Path $toolsDir 'wix314-binaries.zip'
if (!(Test-Path $archive)) {
    gh release download wix3141rtm --repo wixtoolset/wix3 --pattern wix314-binaries.zip --dir $toolsDir
    Check 'Download WiX'
}
if ((Get-FileHash $archive).Hash -ne '6AC824E1642D6F7277D0ED7EA09411A508F6116BA6FAE0AA5F2C7DAA2FF43D31') { throw 'Unexpected WiX toolchain archive' }
if (!(Test-Path "$wix/light.exe")) { Expand-Archive $archive $wix -Force }
& "$PSScriptRoot/Get-UsbMaterials.ps1" -Cache $mirror
if ((& $node -p 'process.arch') -ne 'x64' -or [int](& $node -p "process.versions.node.split('.')[0]") -lt 22) { throw 'Use x64 Node.js 22 or newer' }
if ((Get-AuthenticodeSignature $node).Status -ne 'Valid') { throw 'The build requires a signed Node.js runtime' }
Copy-Item $node "$stage/runtime/node.exe"
Copy-Item (Join-Path (Split-Path $node) 'LICENSE') "$stage/licenses/Node-LICENSE.txt"
foreach ($f in 'server.js','IpadBluetoothMouse.ps1','README.md') { Copy-Item (Join-Path $root $f) $stage }
foreach ($f in (git -C $root ls-files -- web lib docs/overview.svg)) {
    $target = Join-Path $stage $f
    $null = New-Item -ItemType Directory -Force -Path (Split-Path $target)
    Copy-Item -LiteralPath (Join-Path $root $f) -Destination $target
}
foreach ($f in 'iphone-usb.exe','iPhoneMirror.UsbConfigurationSwitch.exe','libgcc_s_seh-1.dll','libstdc++-6.dll','libusb-1.0.dll','libusb0.dll','libwinpthread-1.dll') {
    Copy-Item -LiteralPath (Join-Path "$mirror/resources/usb/win32" $f) -Destination "$stage/usb"
}
Copy-Item "$mirror/NOTICE" "$stage/licenses/Mirrorlab-NOTICE.txt"
tar.exe -czf "$stage/licenses/Mirrorlab-USB-source.tar.gz" -C $mirror LICENSE NOTICE THIRD_PARTY.md resources/usb/source resources/airplay/source
Check 'Bundle native sources and notices'
Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $work 'app.ico'
$bitmap = [Drawing.Bitmap]::new(48,48)
$g = [Drawing.Graphics]::FromImage($bitmap)
$g.Clear([Drawing.Color]::FromArgb(40,48,43))
$pen = [Drawing.Pen]::new([Drawing.Color]::FromArgb(197,230,154),3)
$g.DrawRectangle($pen,6,10,36,25)
$g.DrawLine($pen,14,40,34,40)
$stream = [IO.File]::Create($iconPath)
try { [Drawing.Icon]::FromHandle($bitmap.GetHicon()).Save($stream) }
finally { $stream.Dispose(); $pen.Dispose(); $g.Dispose(); $bitmap.Dispose() }
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$launcher = Join-Path $stage 'iPadControlConsole.exe'
$source = Join-Path $PSScriptRoot 'Launcher.cs'
& $csc /nologo /target:winexe /platform:x64 /codepage:65001 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32icon:$iconPath" "/out:$launcher" $source
Check 'Compile the desktop launcher'
& $node "$PSScriptRoot/installer.js" $stage "$work/installer.wxs" $iconPath
Check 'Generate the installer manifest'
& "$wix/candle.exe" -nologo -out "$work/installer.wixobj" "$work/installer.wxs"
Check 'Compile the installer'
$package = Join-Path $out 'iPad-Control-Console-1.0.0-win-x64.msi'
& "$wix/light.exe" -nologo -spdb -out $package "$work/installer.wixobj"
Check 'Link and validate the installer'
(Get-FileHash $package).Hash.ToLowerInvariant() + '  ' + (Split-Path $package -Leaf) | Set-Content -Encoding ascii "$package.sha256"
$generated = (Resolve-Path -LiteralPath $work).Path
if ([IO.Path]::GetDirectoryName($generated) -ne (Resolve-Path -LiteralPath $out).Path -or
    [IO.Path]::GetFileName($generated) -notmatch '^[0-9a-f]{32}$' -or
    (Get-Item -LiteralPath $generated).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw 'Unexpected staging directory'
}
Remove-Item -LiteralPath $generated -Recurse -Force
Write-Output $package
