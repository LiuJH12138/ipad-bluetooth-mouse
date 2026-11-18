param([Parameter(Mandatory)][string]$Cache)
$ErrorActionPreference = 'Stop'
$revision = 'ade4e6429690ebcf430ea19a142a2e01546da8ef'
$repo = 'SimonDaBoss/mirrorlab'
$tree = gh api "repos/$repo/git/trees/${revision}?recursive=1" | ConvertFrom-Json
if ($tree.sha -ne $revision -or $tree.truncated) { throw 'Incomplete USB source manifest.' }
$items = $tree.tree | Where-Object {
    $_.type -eq 'blob' -and ($_.path -match '^resources/usb/(source/|win32/(iphone-usb\.exe|iPhoneMirror\.UsbConfigurationSwitch\.exe|lib.*\.dll)$)' -or
        $_.path -in 'LICENSE','NOTICE','THIRD_PARTY.md','resources/airplay/source/msys2-packages.txt' -or
        $_.path -match '^resources/airplay/source/licenses/(libgcc|libstdc\+\+|libwinpthread|libusb[^/]*)/')
}
$client = New-Object Net.WebClient
try {
    foreach ($item in $items) {
        $file = Join-Path $Cache $item.path
        $null = New-Item -ItemType Directory -Force -Path (Split-Path $file)
        if ((Test-Path -LiteralPath $file) -and (git hash-object --no-filters -- $file) -eq $item.sha) { continue }
        $url = "https://raw.githubusercontent.com/$repo/$revision/" + $item.path
        $client.DownloadFile($url, "$file.part")
        if ((git hash-object --no-filters -- "$file.part") -ne $item.sha) { throw "USB source checksum mismatch: $($item.path)" }
        Move-Item -LiteralPath "$file.part" -Destination $file -Force
    }
} finally { $client.Dispose() }
