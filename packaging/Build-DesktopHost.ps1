param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$version = '1.0.4314.35'
$cache = Join-Path $root 'build/tooling'
$null = New-Item -ItemType Directory -Force -Path $cache,$Destination,(Join-Path $Destination 'licenses')
$archive = Join-Path $cache "webview2-$version.zip"
$sha = '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
if (!(Test-Path -LiteralPath $archive)) {
    $temporary = "$archive.$([Guid]::NewGuid()).tmp"
    try {
        Invoke-WebRequest -UseBasicParsing "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $temporary
        if ((Get-FileHash $temporary).Hash -ne $sha) { throw 'WebView2 SDK checksum mismatch' }
        Move-Item -LiteralPath $temporary -Destination $archive -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}
if ((Get-FileHash $archive).Hash -ne $sha) { throw 'WebView2 SDK checksum mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$files = @{
    'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
    'runtimes/win-x64/native/WebView2Loader.dll' = 'WebView2Loader.dll'
    'LICENSE.txt' = 'licenses/WebView2-LICENSE.txt'
    'NOTICE.txt' = 'licenses/WebView2-NOTICE.txt'
}
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($entry in $files.GetEnumerator()) {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($entry.Key), (Join-Path $Destination $entry.Value), $true)
    }
} finally { $zip.Dispose() }
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:winexe /platform:x64 /codepage:65001 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/reference:$Destination\Microsoft.Web.WebView2.Core.dll" "/reference:$Destination\Microsoft.Web.WebView2.WinForms.dll" "/win32icon:$root\web\console.ico" "/out:$Destination\iPadControlConsole.exe" "$PSScriptRoot\Launcher.cs" "$PSScriptRoot\ConsoleWindow.cs"
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the desktop application' }
