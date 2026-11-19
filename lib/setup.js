'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

const receiverFiles = [
  'iphone-usb.exe', 'iPhoneMirror.UsbConfigurationSwitch.exe', 'libgcc_s_seh-1.dll',
  'libstdc++-6.dll', 'libusb-1.0.dll', 'libusb0.dll', 'libwinpthread-1.dll',
  'driver/usb-driver.ps1', 'driver/install-filter.exe', 'driver/libusb0.sys',
  'driver/libusb0.dll', 'driver/libusb0_x86.dll'
];
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive'];

// Use invariant service names and enum values; the display language may vary.
const queryService = [
  "try { $s = Get-Service -Name 'Apple Mobile Device Service' -ErrorAction Stop",
  "switch ($s.Status.ToString()) { 'Running' { 'ready' } 'Stopped' { 'stopped' } default { 'unknown' } }",
  "} catch { if ($_.FullyQualifiedErrorId -like 'NoServiceFoundForGivenName,*') { 'missing' } else { 'unknown' } }"
].join('\n');
const startService = [
  "$ErrorActionPreference = 'Stop'",
  "$info = New-Object System.Diagnostics.ProcessStartInfo",
  "$info.FileName = Join-Path ([Environment]::SystemDirectory) 'sc.exe'",
  "$info.Arguments = 'start \"Apple Mobile Device Service\"'",
  "$info.UseShellExecute = $true; $info.Verb = 'runas'; $info.WindowStyle = 'Hidden'",
  "try { $p = [Diagnostics.Process]::Start($info); $p.WaitForExit()",
  "if ($p.ExitCode -notin 0,1056) { exit 1 }",
  "(Get-Service -Name 'Apple Mobile Device Service').WaitForStatus('Running',[TimeSpan]::FromSeconds(15))",
  "} catch { if ($_.Exception.GetBaseException().NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }"
].join('\n');

async function isFile(file) {
  try { const info = await fs.stat(file); return info.isFile() && info.size > 0; }
  catch { return false; }
}

// Read just the section table to catch partial copies without loading or launching
// receiver executables and drivers during a status check.
async function completePe(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const {size} = await handle.stat();
    const header = Buffer.alloc(4096);
    const {bytesRead} = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 64 || header.readUInt16LE(0) !== 0x5a4d) return false;
    const pe = header.readUInt32LE(60);
    if (pe < 64 || pe + 24 > bytesRead || header.readUInt32LE(pe) !== 0x4550) return false;
    const count = header.readUInt16LE(pe + 6);
    const sections = pe + 24 + header.readUInt16LE(pe + 20);
    if (!count || sections + count * 40 > bytesRead) return false;
    for (let i = 0; i < count; i++) {
      const entry = sections + i * 40;
      if (header.readUInt32LE(entry + 20) + header.readUInt32LE(entry + 16) > size) return false;
    }
    return true;
  } catch { return false; }
  finally { if (handle) await handle.close(); }
}

function failure(message, status = 409) {
  return Object.assign(new Error(message), {status});
}

class Setup {
  constructor({root = path.resolve(__dirname, '..'), run = promisify(execFile)} = {}) {
    this.root = root;
    this.run = run;
  }
  async receiver() {
    const packaged = await isFile(path.join(this.root, 'runtime/node.exe'))
      || await isFile(path.join(this.root, 'iPadControlConsole.exe'))
      || await isFile(path.join(this.root, 'usb/iphone-usb.exe'));
    const sourceInstallable = !packaged && await isFile(path.join(this.root, 'Install-UsbReceiver.ps1'))
      && await isFile(path.join(this.root, 'packaging/Build-UsbCapture.ps1'));
    const directory = path.join(this.root, packaged ? 'usb' : '.local/usb-v0.2.0');
    const files = await Promise.all(receiverFiles.map(name => {
      const file = path.join(directory, name);
      return name.endsWith('.ps1') ? isFile(file) : completePe(file);
    }));
    return {receiverReady:files.every(Boolean), sourceInstallable};
  }
  async service() {
    try {
      const {stdout} = await this.run(powershell, [...psArgs, '-Command', queryService], {windowsHide:true, timeout:10000});
      const state = stdout.trim();
      return ['ready', 'stopped', 'missing'].includes(state) ? state : 'unknown';
    } catch { return 'unknown'; }
  }
  async status() {
    const [receiver, appleService] = await Promise.all([this.receiver(), this.service()]);
    return {...receiver, appleService, computerName:os.hostname()};
  }
  prepareReceiver() {
    this.preparing ??= this.prepare().finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async prepare() {
    const {receiverReady, sourceInstallable} = await this.receiver();
    if (!receiverReady) {
      if (!sourceInstallable) throw failure('USB 组件缺失或损坏。请重新打开本版 MSI，选择「修复」。');
      try {
        await this.run(powershell, [...psArgs, '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root,'Install-UsbReceiver.ps1')],
          {cwd:this.root, windowsHide:true, timeout:20 * 60000, maxBuffer:4 * 1024 * 1024});
      } catch { throw failure('准备 USB 组件失败。请检查网络和项目目录写入权限后重试，或用 MSI 安装。', 503); }
    }
    const result = await this.status();
    if (!result.receiverReady) throw failure('准备完成后仍缺少 USB 组件，请重试或用 MSI 安装。', 503);
    return result;
  }
  startAppleService() {
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async start() {
    const status = await this.status();
    if (status.appleService === 'ready') return status;
    if (status.appleService === 'missing') throw failure('找不到 Apple Mobile Device 服务。请先安装或修复 Apple 设备软件。');
    if (status.appleService !== 'stopped') throw failure('无法确定 Apple Mobile Device 服务状态，请刷新后重试。');
    try {
      await this.run(powershell, [...psArgs, '-Command', startService], {windowsHide:true, timeout:120000});
    } catch (error) {
      if (Number(error.code) === 1223) throw failure('已取消管理员授权，可重新尝试启动 Apple 服务。');
      throw failure('Apple Mobile Device 服务未能启动。请检查 Windows 服务状态后重试。', 503);
    }
    const result = await this.status();
    if (result.appleService !== 'ready') throw failure('Apple Mobile Device 服务尚未就绪，请刷新后重试。', 503);
    return result;
  }
}

module.exports = {Setup};
