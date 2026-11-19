'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const { installFilter } = require('./usb-setup');

const bundledHelper = path.join(__dirname, '..', 'usb', 'iphone-usb.exe');
const helper = require('node:fs').existsSync(bundledHelper) ? bundledHelper :
  path.join(__dirname, '..', '.local', 'usb-v0.2.0', 'iphone-usb.exe');
const options = { cwd: path.dirname(helper), windowsHide: true };

const singleDeviceMessage = '请在设备列表中选择要控制的 iPhone 或 iPad。';

function serialKey(serial) {
  if (typeof serial !== 'string' || serial.length > 48 || !/^[\da-f]+(?:-[\da-f]+)*$/i.test(serial)) {
    throw new Error('USB 设备信息无效。');
  }
  const key = serial.replace(/-/g, '').toLowerCase();
  if (key.length < 16) throw new Error('USB 设备信息无效。');
  return key;
}

async function receiverDevices(run) {
  let stdout;
  try {
    ({ stdout } = await run(helper, ['--list'], { ...options, timeout: 10000 }));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('缺少 USB 视频组件，请从首页进入「一键配置」。');
    throw new Error('USB 设备检测失败。请检查 Apple Mobile Device 服务并重新连接 iPhone 或 iPad。');
  }
  let devices;
  try { devices = JSON.parse(stdout); } catch {}
  if (!Array.isArray(devices)) throw new Error('无法读取 USB 设备列表，请重新连接设备。');
  return devices;
}

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Only present Apple mobile composite parents, never their individual USB interfaces.
const parentQuery = [
    "Get-CimInstance -ClassName Win32_PnPEntity -Filter \"Present = TRUE AND DeviceID LIKE 'USB%VID_05AC%'\" -ErrorAction Stop",
    "Where-Object { $_.DeviceID -match '^USB\\\\VID_05AC&PID_[0-9A-F]{4}\\\\' -and $_.Name -like 'Apple Mobile Device USB Composite*' }",
    "ForEach-Object { $_.DeviceID.Split('\\')[-1] }"
].join(' | ');
async function mobileParents(run) {
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', parentQuery], { ...options, timeout: 15000 });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    throw new Error('无法核对 Windows 中的 Apple USB 设备，请重新连接设备后重试。');
  }
}

// The receiver can omit a device that is already in capture mode. A physical
// Windows parent is mandatory for every device offered to the user.
async function discover(run) {
  const [devices, parents] = await Promise.all([receiverDevices(run), mobileParents(run)]);
  const inventory = new Map(parents.map(serial => [serialKey(serial), {serial}]));
  const seen = new Set();
  for (const device of devices) {
    const key = serialKey(device?.serial);
    if (seen.has(key) || !inventory.has(key)) throw new Error('Windows 尚未核对全部 USB 设备，请刷新设备列表。');
    seen.add(key);
    inventory.set(key, device);
  }
  return [...inventory.values()];
}
function publicId(serial) {
  return crypto.createHash('sha256').update(JSON.stringify(['usb-device-v1',os.hostname(),process.env.USERNAME || '',serialKey(serial)]))
    .digest('hex').slice(0,32);
}
function describeDevice(device) {
  const match = /^(iPhone|iPad)\d+,\d+$/.exec(device.model);
  return {id:publicId(device.serial), family:match?.[1] || 'Apple', model:match?.[0] || '', name:device.name,
    driver:['ready','missing','replug'].includes(device.driver) ? device.driver : 'unknown'};
}
async function confirmedDevice(run, device) {
  if ('driver' in device) return device;
  try {
    const {stdout} = await run(helper, ['--driver', device.serial], {...options, timeout:10000});
    const info = JSON.parse(stdout);
    if (info.present === true) return {...device,driver:info.driver};
  } catch {}
  throw new Error('无法确认所选设备的 USB 驱动状态，请刷新设备列表。');
}
async function selectDevice(run = promisify(execFile)) {
  const target = await new UsbVideo({run}).target();
  return {serial:target.serial,family:target.family};
}

function captureTarget(devices) {
  if (devices.length !== 1) throw new Error(singleDeviceMessage);
  const device = devices[0];
  serialKey(device?.serial);
  if (device.driver === 'replug') throw new Error('请拔插设备数据线，等待驱动就绪后重试。');
  if (device.driver !== 'ready') throw new Error('当前设备缺少 USB 采集过滤驱动。请在设备列表中选择「配置此设备」。');
  const family = /^(iPhone|iPad)\d+,\d+$/.exec(device.model)?.[1] || 'Apple';
  return { serial: device.serial, family };
}

const handshakeTimeout = /USB handshake kick: QuickTime bulk write: libusb0 error -116\b|opened screen capture but did not respond/i;
const modeUnchanged = /USB configuration helper sent the QuickTime activation request but observed no exact interface transition/i;
function captureFailure(detail, startupTimedOut = false) {
  if (handshakeTimeout.test(detail)) return '设备已识别，但 USB 采集握手超时。请保持设备解锁，关闭其他投屏，重新拔插数据线后重试。';
  if (/claim QuickTime interface[^\r\n]*(?:win32_error=32\b|resource busy|sharing violation)/i.test(detail))
    return 'USB 采集接口被占用。请停止其他窗口或应用中的 USB 投屏，再重新连接。';
  if (/rejected the screen-capture request/i.test(detail))
    return '设备拒绝了投屏请求。请解锁设备，确认可能出现的信任提示后重试。';
  if (modeUnchanged.test(detail))
    return '已识别设备，但 USB 未进入投屏模式。请拔插这台设备的数据线，保持解锁后重新投屏。';
  if (/configuration helper (?:timed out|observed QuickTime activation removal but the exact interface did not return before timeout)/i.test(detail))
    return 'USB 切换采集模式时重新识别设备超时。请拔插所选设备的数据线、解锁后重试。';
  if (/Screen capture started but .* sent no video|No USB media received for 15 seconds/i.test(detail))
    return 'USB 采集已启动，但没有收到视频数据。请解锁设备并点亮屏幕，然后重新投屏。';
  if (/driver|filter/i.test(detail)) return 'USB 驱动尚未就绪，请重新连接设备。';
  if (startupTimedOut) return 'USB 采集启动后等待了 45 秒，仍未收到视频数据。请保持设备解锁，退出其他投屏，再拔插数据线重试。';
  return '没有收到 USB 视频。请解锁设备、关闭其他 USB 投屏，拔插数据线后重试。';
}

class UsbVideo {
  constructor({run = promisify(execFile), installFilter: install = installFilter, spawnProcess = spawn,
      stopGraceMs = 8000, restoreGraceMs = 50000, killWaitMs = 2000} = {}) {
    this.run = run;
    this.installFilter = install;
    this.spawnProcess = spawnProcess;
    this.stopGraceMs = stopGraceMs;
    this.restoreGraceMs = restoreGraceMs;
    this.killWaitMs = killWaitMs;
    this.deviceDetails = new Map();
  }
  async inventory() {
    const devices = await discover(this.run);
    for (const device of devices) {
      const key = serialKey(device.serial);
      const previous = this.deviceDetails.get(key);
      const name = typeof device.name === 'string' ? device.name.replace(/\p{Cf}/gu, '')
        .replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, 120) : '';
      // The receiver uses the literal "iPhone" when lockdown cannot read DeviceName.
      device.name = (name !== 'iPhone' && name) || previous?.name;
      device.model ||= previous?.model;
      this.deviceDetails.set(key, {name:device.name, model:device.model});
    }
    return devices;
  }
  async devices() {
    const devices = await this.inventory();
    return Promise.all(devices.map(async device => describeDevice(await confirmedDevice(this.run, device))));
  }
  watchTopology(onChange) {
    // Listen once for Windows device notifications. A periodic snapshot also covers
    // missed events and Windows installations where event subscriptions are denied.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "try { $null = Register-CimIndicationEvent -Query 'SELECT * FROM Win32_DeviceChangeEvent WHERE EventType = 2 OR EventType = 3' -SourceIdentifier AppleUsbChange; $subscribed = $true } catch { $subscribed = $false }",
      'while ($true) {',
      '  try { [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @(' + parentQuery + "))) } catch { [Console]::WriteLine('null') }",
      '  if ($subscribed) {',
      '    $null = Wait-Event -SourceIdentifier AppleUsbChange -Timeout 5',
      '    Remove-Event -SourceIdentifier AppleUsbChange -ErrorAction SilentlyContinue',
      '  } else { Start-Sleep -Seconds 2 }',
      '}'
    ].join('\n');
    const child = this.spawnProcess(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
      {windowsHide:true, stdio:['ignore','pipe','ignore']});
    const lines = createInterface({input:child.stdout});
    let previous, stopped = false, watchdog;
    const publish = ids => {
      const signature = JSON.stringify(ids);
      if (!stopped && previous !== signature) {
        previous = signature;
        onChange(ids);
      }
    };
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => publish(null), 12000);
      watchdog.unref();
    };
    arm();
    lines.on('line', line => {
      if (stopped) return;
      arm();
      let ids = null;
      try {
        const serials = JSON.parse(line);
        if (Array.isArray(serials)) ids = [...new Set(serials.map(publicId))].sort();
      } catch {}
      publish(ids);
    });
    const ended = () => { clearTimeout(watchdog); publish(null); };
    child.once('error', ended);
    child.once('close', ended);
    return () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(watchdog);
      lines.close();
      child.kill();
    };
  }
  async setupDevice(id) {
    this.checkReceiverReleased();
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('请选择要配置的 USB 设备。'),{status:400});
    if (this.setup?.id === id) return this.setup.promise;
    if (this.setup || this.busy) throw Object.assign(new Error('请先停止投屏或等当前驱动配置完成。'),{status:409});
    const promise = this.configureDevice(id);
    this.setup = {id,promise};
    try { return await promise; } finally { this.setup = null; }
  }
  async driverState(serial) {
    let info;
    try {
      const {stdout} = await this.run(helper,['--driver',serial],{...options,timeout:10000});
      info = JSON.parse(stdout);
    } catch {
      throw Object.assign(new Error('读取 USB 驱动状态失败，请刷新后重试。'),{status:503});
    }
    if (info?.present === false) return 'absent';
    const parent = /^USB\\VID_05AC&PID_[0-9A-F]{4}\\([0-9A-F-]+)$/i.exec(info?.instanceId || '');
    if (info?.present !== true || !parent || serialKey(parent[1]) !== serialKey(serial)) {
      throw Object.assign(new Error('USB 设备身份已改变，请重新选择。'),{status:409});
    }
    if (String(info.parentService).toLowerCase() !== 'usbccgp') {
      throw Object.assign(new Error('当前 USB 主驱动不兼容。请先通过 Apple Devices 或 iTunes 修复 Apple USB 支持。'),{status:409});
    }
    if (!['missing','ready','replug'].includes(info.driver)) throw Object.assign(new Error('无法确认 USB 驱动状态。'),{status:409});
    return info.driver;
  }
  async configureDevice(id) {
    const device = (await this.inventory()).find(d=>publicId(d.serial)===id);
    if (!device) throw Object.assign(new Error('所选 USB 设备已断开，请刷新设备列表。'),{status:409});
    const serial = device.serial;
    const status = await this.driverState(serial);
    if (status === 'absent') throw Object.assign(new Error('所选 USB 设备已断开，请刷新设备列表。'),{status:409});
    if (status !== 'missing') return {status};
    const result = await this.installFilter(serialKey(serial),path.join(options.cwd,'driver'),this.run);
    if (result === 'cancelled') return {status:'cancelled'};
    if (result === 'replug') return {status:'replug'};
    // A successful device restart can temporarily remove its PnP instance.
    return {status:(await this.driverState(serial)) === 'ready' ? 'ready' : 'replug'};
  }
  async target(id) {
    const devices = await this.inventory();
    if (id == null && devices.length > 1) throw Object.assign(new Error(singleDeviceMessage),{status:409});
    const device = id == null ? devices[0] : devices.find(d=>publicId(d.serial)===id);
    if (!device) throw Object.assign(new Error('所选 USB 设备未连接，请刷新设备列表。'),{status:409});
    const target = captureTarget([await confirmedDevice(this.run, device)]);
    return {...target,name:device.name,id:publicId(target.serial),multiple:devices.length>1};
  }
  checkReceiverReleased() {
    if (this.unreleasedChild) throw Object.assign(new Error('上一轮 USB 采集进程未能退出。请拔插数据线并重新启动控制台。'),{status:503});
  }
  async stopCapture(expectedSessionId) {
    this.checkReceiverReleased();
    const current=this.activeCapture;
    if (!current) return;
    if (expectedSessionId !== undefined && expectedSessionId !== current.sessionId) {
      throw Object.assign(new Error('投屏会话已改变，请刷新后重试。'),{status:409});
    }
    // Switching targets preserves the native USB restore cycle. Desktop exit
    // is bounded by the host's shorter shutdown budget.
    await current.stop(expectedSessionId === undefined ? this.stopGraceMs : this.restoreGraceMs);
    this.checkReceiverReleased();
  }
  superviseCapture(child) {
    let exited = false, terminating = false, settled = false, timer, finish, stopAt, forceAt;
    const done = new Promise((resolve, reject) => {
      finish = error => {
        clearTimeout(timer);
        settled = true;
        if (error) reject(error);
        else resolve();
      };
    });
    const closePipes = () => { child.stdin.destroy(); child.stderr.destroy(); };
    const recordExit = () => {
      exited = true;
      if (this.unreleasedChild === child) this.unreleasedChild = null;
    };
    child.once('exit', () => {
      recordExit();
      // A descendant can inherit a pipe. Once Windows confirms exit, allow a
      // short drain for final diagnostics, independently of the descendant.
      clearTimeout(timer);
      if (!settled) timer = setTimeout(() => { closePipes(); finish(); }, this.killWaitMs);
    });
    child.once('close', () => { recordExit(); finish(); });
    child.on('error', error => {
      // Spawn failures have no PID. Termination failures still own the USB
      // handle until Windows confirms exit and must go through the deadline.
      if (!child.pid) { recordExit(); finish(error); }
    });
    const stop = (graceMs = this.stopGraceMs) => {
      if (terminating || exited || settled) return;
      if (stopAt === undefined) {
        stopAt=performance.now();
        if (child.stdin.writable) child.stdin.end('stop\n');
      }
      const deadline=stopAt+graceMs;
      if (deadline===forceAt) return;
      forceAt=deadline;
      clearTimeout(timer);
      timer = setTimeout(() => {
        terminating=true;
        timer = setTimeout(() => {
          this.unreleasedChild = child;
          closePipes();
          finish(new Error('USB 采集组件停止超时。请拔插数据线后再连接。'));
        }, this.killWaitMs);
        child.kill('SIGKILL');
      }, Math.max(0,deadline-performance.now()));
    };
    return {done, stop};
  }
  async stream(res, onSourceChange = () => {}, deviceId) {
    if (this.releasing) await this.releasing;
    if (res.destroyed) return;
    this.checkReceiverReleased();
    if (this.setup) throw Object.assign(new Error('正在配置 USB 驱动，请稍后投屏。'),{status:409});
    if (this.busy) throw Object.assign(new Error('USB 视频已在其他窗口打开，请先停止投屏。'),{status:409});
    this.busy = true;
    const sessionId = crypto.randomUUID();
    let listener, capture, socket, timeout;
    let stopping = false, live = false, startupTimedOut = false, resolveReleased;
    const released = new Promise(resolve => { resolveReleased = resolve; });
    let targetId;
    const stop = (lost = false, graceMs) => {
      if (stopping) {
        if (graceMs!==undefined) capture?.stop(graceMs);
        return;
      }
      stopping = true;
      this.releasing = released;
      if (live || (lost && targetId)) onSourceChange(null, lost ? targetId : null);
      clearTimeout(timeout);
      if (listener?.listening) listener.close();
      socket?.destroy();
      capture?.stop(graceMs);
    };
    res.once('close', stop);
    this.activeCapture = {sessionId,stop:graceMs=>{ stop(false,graceMs); res.destroy(); return released; }};
    try {
      const {serial, family, name, id, multiple} = await this.target(deviceId);
      targetId = id;
      if (stopping) return;
      listener = net.createServer(connection => {
        if (socket || stopping) return connection.destroy();
        socket = connection;
        socket.once('data', () => {
          if (stopping) return;
          live = true;
          onSourceChange({id,multiple,sessionId,family,name});
          res.setHeader('X-USB-Session', sessionId);
          res.setHeader('X-Apple-Device-Id', id);
          clearTimeout(timeout);
          res.setHeader('X-Apple-Device-Family', family);
          res.setHeader('Content-Type', 'application/octet-stream');
        });
        const disconnected = () => {
          stop(true);
          if (res.headersSent && !res.destroyed) res.end();
        };
        socket.on('error', disconnected);
        socket.once('end', disconnected);
        res.socket?.setNoDelay(true);
        socket.pipe(res, { end: false });
      });
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
      });
      if (stopping) return;
      const child = this.spawnProcess(helper, ['--capture', serial, '--no-audio'], {
        ...options, stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, MIRRORLAB_MEDIA_PORT: String(listener.address().port) }
      });
      child.stdin.on('error', () => {});
      let detail = '';
      child.stderr.on('data', data => {
        if (handshakeTimeout.test(detail) || modeUnchanged.test(detail)) return;
        const chunk = detail + data.toString();
        detail = chunk.match(handshakeTimeout)?.[0] || chunk.match(modeUnchanged)?.[0] || chunk.slice(-1200);
      });
      capture = this.superviseCapture(child);
      timeout = setTimeout(() => { startupTimedOut = true; stop(true); }, 45000);
      await capture.done;
      stop(true);
      if (!res.headersSent && !res.destroyed) {
        const error=new Error(captureFailure(detail,startupTimedOut));
        if (modeUnchanged.test(detail)) Object.assign(error,{status:503,code:'USB_MODE_UNCHANGED'});
        throw error;
      }
      if (!res.destroyed) res.end();
    } finally {
      stop();
      if (listener?.listening) listener.close();
      res.off('close', stop);
      this.busy = false;
      this.releasing = null;
      resolveReleased();
      this.activeCapture = null;
    }
  }
}
module.exports = { UsbVideo, captureTarget, captureFailure, selectDevice };
