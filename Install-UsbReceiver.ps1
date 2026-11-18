$ErrorActionPreference = 'Stop'
$revision = 'ade4e6429690ebcf430ea19a142a2e01546da8ef'
$base = "https://raw.githubusercontent.com/SimonDaBoss/mirrorlab/$revision/resources/usb/win32"
$files = @{
    'iPhoneMirror.UsbConfigurationSwitch.exe' = 'c7c279fe0d480faa728a6b6338be67dfda321505'
    'libgcc_s_seh-1.dll' = '9afc1d6da3ac5b379f50f9da26e2382c56d51a41'
    'libstdc++-6.dll' = '543a1451f8dac3c9131e6ecdfc7762f8b2502741'
    'libusb-1.0.dll' = '26808bb24e89c73657ec1aabd75845faf4501099'
    'libusb0.dll' = 'f916b089867ee05ae63cba8a375890d9244e3dcf'
    'libwinpthread-1.dll' = 'cab1ab3947b5e2a8967fadb66e057150debe343f'
}
$directory = Join-Path $PSScriptRoot '.local\usb-v0.2.0'
$null = New-Item -ItemType Directory -Force -Path $directory
function Get-GitBlobId($file) {
    $data = [IO.File]::ReadAllBytes($file)
    $prefix = [Text.Encoding]::ASCII.GetBytes(('blob {0}' -f $data.Length) + [char]0)
    $hash = [Security.Cryptography.SHA1]::Create()
    try { ([BitConverter]::ToString($hash.ComputeHash([byte[]]($prefix + $data)))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
foreach ($name in $files.Keys) {
    $target = Join-Path $directory $name
    if ((Test-Path -LiteralPath $target) -and (Get-GitBlobId $target) -eq $files[$name]) { continue }
    $part = "$target.$PID.part"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $part -TimeoutSec 90
        if ((Get-GitBlobId $part) -ne $files[$name]) { throw "Unexpected Git object for $name" }
        Move-Item -LiteralPath $part -Destination $target -Force
    } finally { if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part } }
}
& "$PSScriptRoot/packaging/Build-UsbCapture.ps1" -Destination $directory
Write-Output 'USB capture runtime verified and rebuilt.'
