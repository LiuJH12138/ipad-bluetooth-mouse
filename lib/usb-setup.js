'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

const hashes = Object.freeze({
  'usb-driver.ps1':'DDA78182B0748F18D989BDAA22AFE80D08AC816AA10F4A56CE82D242229B01DF',
  'install-filter.exe':'DF2ABF387893332F28C4DF68B10A6B176DC9706142055DCCCCF447F5A9CEDE2D',
  'libusb0.sys':'8058F2AFE6EF96A7D2DED432997FD8655970C9EA75A938EE4557D6A2CB4CC989',
  'libusb0.dll':'4F18B5D2C28AA66B648C8683C6D09B52B92CBBEE85984BBEFAD5F38A64BC2A14',
  'libusb0_x86.dll':'00CACA07869B19D10B370552AC7CC2F6F2EE246FC15DB11650F6CD3F4EF9B666'
});

// Windows PowerShell receives the trusted bootstrap directly as a Unicode command.
// Only data values cross the UAC boundary. The elevated process never loads a
// script or DLL from a user-writable directory, even between hashing and use.
const elevatedSetup = String.raw`$ErrorActionPreference = 'Stop'
$system = [Environment]::SystemDirectory
$env:SystemRoot = [IO.Directory]::GetParent($system).FullName
$env:windir = $env:SystemRoot
$env:PATH = $system + ';' + $PSHOME
$env:PSModulePath = Join-Path $PSHOME 'Modules'
Set-Location -LiteralPath $system
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SETUP_REQUEST__')) | ConvertFrom-Json
$base = [Environment]::GetFolderPath('ProgramFiles')
$stage = $null
$mutex = [Threading.Mutex]::new($false, 'Global\iPadControlConsole.UsbFilterSetup')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { exit 12 }
    if ($request.serial -notmatch '^[0-9a-f]{16,48}$') { exit 13 }
    $directory = [IO.DirectoryInfo]::new($request.directory)
    if ($directory.FullName -notmatch '^[a-z]:\\' -or [IO.DriveInfo]::new($directory.Root.FullName).DriveType -notin 'Fixed','Removable') { exit 13 }
    for ($parent = $directory; $parent; $parent = $parent.Parent) {
        if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 13 }
    }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in 'S-1-5-18','S-1-5-32-544') {
        $identity = [Security.Principal.SecurityIdentifier]::new($sid)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    $leaf = 'iPadControlUsbSetup-' + [Guid]::NewGuid().ToString('N')
    $path = [IO.Path]::Combine($base,$leaf)
    if ([IO.Directory]::Exists($path)) { exit 13 }
    $stage = [IO.Directory]::CreateDirectory($path,$acl).FullName
    foreach ($entry in $request.hashes.PSObject.Properties) {
        $src = [IO.Path]::Combine($request.directory,$entry.Name)
        $dst = [IO.Path]::Combine($stage,$entry.Name)
        if ([IO.File]::GetAttributes($src) -band [IO.FileAttributes]::ReparsePoint) { exit 13 }
        $reader = [IO.File]::OpenRead($src)
        try {
            if ($reader.Length -gt 4MB) { exit 13 }
            $writer = [IO.File]::Open($dst,'CreateNew','Write','None')
            try { $reader.CopyTo($writer) } finally { $writer.Dispose() }
        } finally { $reader.Dispose() }
        if ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash -ne $entry.Value) { exit 13 }
    }
    $driver = Join-Path $stage 'libusb0.sys'
    if ((Get-AuthenticodeSignature -LiteralPath $driver).Status -ne 'Valid') { exit 13 }
    # Preserve other installed versions of the shared libusb-win32 components.
    $systemFiles = @{
        'libusb0.sys' = Join-Path $system 'drivers\libusb0.sys'
        'libusb0.dll' = Join-Path $system 'libusb0.dll'
        'libusb0_x86.dll' = Join-Path ([Environment]::GetFolderPath('SystemX86')) 'libusb0.dll'
    }
    foreach ($name in $systemFiles.Keys) {
        $file = $systemFiles[$name]
        if ([IO.File]::Exists($file) -and (Get-FileHash -LiteralPath $file).Hash -ne $request.hashes.$name) { exit 14 }
    }
    # The pinned upstream script checks the exact PnP parent and usbccgp again.
    # Its only filter target is the selected device instance.
    Set-Location -LiteralPath $stage
    $result = Join-Path $stage 'result.json'
    & (Join-Path $stage 'usb-driver.ps1') -Serial $request.serial -Result $result
    if ($LASTEXITCODE -ne 0) { exit 15 }
    $outcome = [IO.File]::ReadAllText($result) | ConvertFrom-Json
    if ($outcome.ok -ne $true) { exit 15 }
    if ($outcome.replug) { exit 10 }
    exit 0
} catch { exit 15 } finally {
    Set-Location -LiteralPath $system
    if ($stage -and [IO.Path]::GetDirectoryName($stage) -eq $base -and
        [IO.Path]::GetFileName($stage) -match '^iPadControlUsbSetup-[a-f0-9]{32}$') {
        foreach ($name in @($request.hashes.PSObject.Properties.Name) + 'result.json') {
            [IO.File]::Delete([IO.Path]::Combine($stage,$name))
        }
        [IO.Directory]::Delete($stage,$false)
    }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}`;

const requestElevation = String.raw`$ErrorActionPreference = 'Stop'
try {
    $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -Wait -PassThru -WindowStyle Hidden -WorkingDirectory ([Environment]::SystemDirectory) -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-EncodedCommand',$env:IPAD_FILTER_SETUP_COMMAND)
    exit $p.ExitCode
} catch {
    for ($errorCause=$_.Exception; $errorCause; $errorCause=$errorCause.InnerException) {
        if ($errorCause -is [ComponentModel.Win32Exception] -and $errorCause.NativeErrorCode -eq 1223) { exit 11 }
    }
    exit 15
}`;

async function installFilter(serial, directory, run) {
  if (!/^[a-f0-9]{16,48}$/i.test(serial)) throw new Error('USB 设备标识无效。');
  try {
    await Promise.all(Object.entries(hashes).map(async ([name, expected]) => {
      const bytes = await fs.readFile(path.join(directory,name));
      if (crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase() !== expected) throw Error();
    }));
  } catch {
    throw Object.assign(new Error('USB 安装组件缺失或未通过校验。请重新安装控制台；源码版请运行 Install-UsbReceiver.ps1。'),{status:503});
  }
  const input = Buffer.from(JSON.stringify({serial,directory,hashes}),'utf8').toString('base64');
  const encoded = Buffer.from(elevatedSetup.replace('__SETUP_REQUEST__', input),'utf16le').toString('base64');
  const powershell = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  try {
    await run(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',requestElevation],{
      cwd:path.dirname(powershell),windowsHide:true,env:{...process.env,IPAD_FILTER_SETUP_COMMAND:encoded}
    });
    return 'installed';
  } catch (error) {
    if (error.code === 10) return 'replug';
    if (error.code === 11) return 'cancelled';
    const failures = {
      12:'另一窗口正在配置 USB 驱动，请稍后重试。',
      13:'USB 安装组件未通过完整性或 Windows 签名校验。',
      14:'电脑已安装其他版本的 libusb-win32。请通过驱动管理器检查现有版本。'
    };
    throw Object.assign(new Error(failures[error.code] || 'USB 驱动配置失败。请检查手机连接和管理员授权后重试。'),{status:409});
  }
}
module.exports = {installFilter};
