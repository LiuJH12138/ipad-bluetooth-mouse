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
foreach ($f in 'server.js','assistant.js','IpadBluetoothMouse.ps1','README.md') { Copy-Item (Join-Path $root $f) $stage }
foreach ($f in (@(git -C $root ls-files -- web lib docs/overview.svg) + @('web/mouse-gestures.js','web/pointing.js','web/absolute-pointer.js') | Sort-Object -Unique)) {
    $target = Join-Path $stage $f
    $null = New-Item -ItemType Directory -Force -Path (Split-Path $target)
    Copy-Item -LiteralPath (Join-Path $root $f) -Destination $target
}
foreach ($f in 'iPhoneMirror.UsbConfigurationSwitch.exe','libgcc_s_seh-1.dll','libstdc++-6.dll','libusb-1.0.dll','libusb0.dll','libwinpthread-1.dll') {
    Copy-Item -LiteralPath (Join-Path "$mirror/resources/usb/win32" $f) -Destination "$stage/usb"
}
& "$PSScriptRoot/Build-UsbCapture.ps1" -Destination "$stage/usb" -Materials "$mirror/resources/usb/source"
Copy-Item "$out/usb-capture/iphone-usb.cpp","$PSScriptRoot/Build-UsbCapture.ps1" "$stage/licenses"
Copy-Item "$toolsDir/llvm-mingw-20261104-ucrt-x86_64/LICENSE.TXT" "$stage/licenses/LLVM-MinGW-LICENSE.txt"
Copy-Item "$mirror/NOTICE" "$stage/licenses/Mirrorlab-NOTICE.txt"
tar.exe -czf "$stage/licenses/Mirrorlab-USB-source.tar.gz" -C $mirror LICENSE NOTICE THIRD_PARTY.md resources/usb/source resources/airplay/source
Check 'Bundle native sources and notices'
Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $root 'web\console.ico'
function Write-WizardBitmap($Name, $Height, [Drawing.Rectangle]$Placement) {
    $bitmap = [Drawing.Bitmap]::new(493,$Height,[Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $icon = [Drawing.Icon]::new($iconPath,256,256)
    $image = $icon.ToBitmap()
    try {
        $graphics.Clear([Drawing.Color]::White)
        if ($Name -eq 'welcome') {
            $brush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(232,237,231))
            try { $graphics.FillRectangle($brush,0,0,164,$Height) } finally { $brush.Dispose() }
        }
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($image,$Placement)
        $bitmap.Save((Join-Path $work "$Name.bmp"),[Drawing.Imaging.ImageFormat]::Bmp)
    } finally { $image.Dispose(); $icon.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}
Write-WizardBitmap 'welcome' 312 ([Drawing.Rectangle]::new(12,80,140,140))
Write-WizardBitmap 'banner' 58 ([Drawing.Rectangle]::new(431,3,52,52))
& "$PSScriptRoot/Build-DesktopHost.ps1" -Destination $stage
& $node "$PSScriptRoot/installer.js" $stage "$work/installer.wxs" $iconPath
Check 'Generate the installer manifest'
& "$wix/candle.exe" -nologo -out "$work/installer.wixobj" "$work/installer.wxs"
Check 'Compile the installer'
$package = Join-Path $out 'iPad-Control-Console-1.5.2-win-x64.msi'
& "$wix/light.exe" -nologo -spdb -ext "$wix/WixUIExtension.dll" -cultures:zh-CN -out $package "$work/installer.wixobj"
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
