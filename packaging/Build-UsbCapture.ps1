param(
    [Parameter(Mandatory)][string]$Destination,
    [string]$Materials = (Join-Path (Split-Path $PSScriptRoot) 'build/mirrorlab/resources/usb/source')
)
$ErrorActionPreference = 'Stop'
$build = Join-Path (Split-Path $PSScriptRoot) 'build'
$tooling = Join-Path $build 'tooling'
$native = Join-Path $build 'usb-capture'
$upstream = Join-Path $native 'iPhoneMirror'
$toolchain = 'llvm-mingw-20261104-ucrt-x86_64'
foreach ($dir in $Destination,$tooling,$native,$upstream) {
    $null = New-Item -ItemType Directory -Force -Path $dir
}
function Verify-File($File, $Digest) {
    if ((Get-FileHash -LiteralPath $File).Hash -ne $Digest) { throw "Unexpected SHA-256 for $File" }
}
$compiler = Join-Path $tooling "$toolchain/bin/x86_64-w64-mingw32-clang++.exe"
if (!(Test-Path -LiteralPath $compiler)) {
    $archive = Join-Path $tooling "$toolchain.zip"
    if (!(Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -UseBasicParsing "https://github.com/mstorsjo/llvm-mingw/releases/download/20261104/$toolchain.zip" -OutFile "$archive.part"
        Verify-File "$archive.part" '552191B5754C49A5A20723276A6FC56541EA1922C4C50B7B669022333FC1B40F'
        Move-Item -LiteralPath "$archive.part" -Destination $archive -Force
    }
    Verify-File $archive '552191B5754C49A5A20723276A6FC56541EA1922C4C50B7B669022333FC1B40F'
    tar.exe -xf $archive -C $tooling
    if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the compiler' }
}
$null = New-Item -ItemType Directory -Force -Path $Materials
$sourceBase = 'https://raw.githubusercontent.com/SimonDaBoss/mirrorlab/ade4e6429690ebcf430ea19a142a2e01546da8ef/resources/usb/source'
$digests = @{
    'usb-driver.ps1' = 'DDA78182B0748F18D989BDAA22AFE80D08AC816AA10F4A56CE82D242229B01DF'
    'iphonemirror-source.tar.gz' = '48BCCDA23BB4B7C4E4312378FEDE26D0C59EE125F9A003F5CE7D4E3176EB054D'
    'mirrorlab_bridge.h' = 'A831018BB754214ABCCEBB0260C19259031B6D8C1BA6E83DAAE23DAD1BE693CB'
    'iphone-usb.cpp' = '9C60EA96307288BE8AA80BE4B26CEE877CB26CD6CC101E14CF2EA91C15029AF5'
}
foreach ($name in $digests.Keys) {
    $file = Join-Path $Materials $name
    if (!(Test-Path -LiteralPath $file)) {
        Invoke-WebRequest -UseBasicParsing "$sourceBase/$name" -OutFile "$file.part"
        Verify-File "$file.part" $digests[$name]
        Move-Item -LiteralPath "$file.part" -Destination $file -Force
    }
    Verify-File $file $digests[$name]
}
$archive = Join-Path $Materials 'iphonemirror-source.tar.gz'
tar.exe -xf $archive -C $upstream
if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the USB source' }
# Ship the verified, device-specific setup materials alongside the receiver.
$payload = Join-Path $upstream 'src/DriverInstaller/Assets/libusb-win32-1.2.6.0'
$driverDir = Join-Path $Destination 'driver'
$null = New-Item -ItemType Directory -Force -Path $driverDir
Copy-Item -LiteralPath (Join-Path $Materials 'usb-driver.ps1') -Destination $driverDir -Force
foreach ($name in 'amd64/install-filter.exe','amd64/libusb0.dll','amd64/libusb0.sys','x86/libusb0_x86.dll') {
    Copy-Item -LiteralPath (Join-Path $payload $name) -Destination $driverDir -Force
}
$source = [IO.File]::ReadAllText((Join-Path $Materials 'iphone-usb.cpp'))
$old = 'if (now - last > std::chrono::seconds(15)) throw std::runtime_error("No USB media received for 15 seconds");'
$replacement = @'
if (now - last > std::chrono::seconds(15)) {
                    if (!streaming) throw std::runtime_error("No USB media received for 15 seconds");
                    // A stationary iPad may stop sending frames. Poll the device only
                    // during silence. USB read errors and explicit stop still end capture.
                    if (!driver_state(serial).present) throw std::runtime_error("USB device disconnected");
                    last = now;
                }
'@
if (!$source.Contains($old)) { throw 'USB idle guard does not match the pinned source' }
[IO.File]::WriteAllText((Join-Path $native 'iphone-usb.cpp'), $source.Replace($old,$replacement))
$core = Join-Path $upstream 'src/Core/src'
$units = 'Protocol/Plist','Protocol/QuickTimePacket','Protocol/QuickTimeSession','Media/CoreMedia','Media/H264',
    'Transport/QtUsbTransport','Transport/LibUsb0Transport','Transport/UsbMuxClient','Transport/Socket','Device/AppleUsbDiscovery','Logging'
$files = @((Join-Path $native 'iphone-usb.cpp')) + @($units | ForEach-Object { Join-Path $core "$_.cpp" })
$third = Join-Path $upstream 'third_party'
$output = Join-Path $native 'iphone-usb.exe'
& $compiler -std=c++20 -O2 -static -D_WIN32_WINNT=0x0A00 -DWIN32_LEAN_AND_MEAN -DNOMINMAX "-I$Materials" "-I$core" `
    "-I$third/libusb/include" "-I$third/libusb-win32/include" @files "$third/libusb/lib/x64/libusb-1.0.lib" `
    "$third/libusb-win32/lib/x64/libusb0-dynamic.lib" -lws2_32 -lsetupapi -lcfgmgr32 -ladvapi32 -lbcrypt -lshell32 -o $output
if ($LASTEXITCODE -ne 0) { throw 'USB capture compilation failed' }
Copy-Item -LiteralPath $output -Destination $Destination -Force
