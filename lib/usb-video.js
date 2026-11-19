'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

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
    if (error.code === 'ENOENT') throw new Error('请先运行 Install-UsbReceiver.ps1 安装 USB 视频组件。');
    throw new Error('USB 设备检测失败。请检查 Apple Mobile Device 服务并重新连接 iPhone 或 iPad。');
  }
  let devices;
  try { devices = JSON.parse(stdout); } catch {}
  if (!Array.isArray(devices)) throw new Error('无法读取 USB 设备列表，请重新连接设备。');
  return devices;
}

async function mobileParents(run) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Only present Apple mobile composite parents, never their individual USB interfaces.
  const query = [
    "Get-CimInstance -ClassName Win32_PnPEntity -Filter \"Present = TRUE AND DeviceID LIKE 'USB%VID_05AC%'\" -ErrorAction Stop",
    "Where-Object { $_.DeviceID -match '^USB\\\\VID_05AC&PID_[0-9A-F]{4}\\\\' -and $_.Name -like 'Apple Mobile Device USB Composite*' }",
    "ForEach-Object { $_.DeviceID.Split('\\')[-1] }"
  ].join(' | ');
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], { ...options, timeout: 15000 });
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
  return {id:publicId(device.serial), family:match?.[1] || 'Apple', model:match?.[0] || '',
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
  if (device.driver !== 'ready') throw new Error('当前设备缺少 USB 采集过滤驱动。请参阅 README 的 USB 配置说明。');
  const family = /^(iPhone|iPad)\d+,\d+$/.exec(device.model)?.[1] || 'Apple';
  return { serial: device.serial, family };
}

const handshakeTimeout = /USB handshake kick: QuickTime bulk write: libusb0 error -116\b|opened screen capture but did not respond/i;
function captureFailure(detail) {
  if (handshakeTimeout.test(detail)) return '设备已识别，但 USB 采集握手超时。请保持设备解锁，关闭其他投屏，重新拔插数据线后重试。';
  if (/driver|filter/i.test(detail)) return 'USB 驱动尚未就绪，请重新连接设备。';
  return '没有收到 USB 视频。请解锁设备、关闭其他 USB 投屏，拔插数据线后重试。';
}

class UsbVideo {
  constructor({run = promisify(execFile)} = {}) {
    this.run = run;
    this.models = new Map();
  }
  async inventory() {
    const devices = await discover(this.run);
    for (const device of devices) {
      const key = serialKey(device.serial);
      if (device.model) this.models.set(key, device.model);
      else device.model = this.models.get(key);
    }
    return devices;
  }
  async devices() {
    const devices = await this.inventory();
    return Promise.all(devices.map(async device => describeDevice(await confirmedDevice(this.run, device))));
  }
  async target(id) {
    const devices = await this.inventory();
    if (id == null && devices.length > 1) throw Object.assign(new Error(singleDeviceMessage),{status:409});
    const device = id == null ? devices[0] : devices.find(d=>publicId(d.serial)===id);
    if (!device) throw Object.assign(new Error('所选 USB 设备未连接，请刷新设备列表。'),{status:409});
    const target = captureTarget([await confirmedDevice(this.run, device)]);
    return {...target,id:publicId(target.serial),multiple:devices.length>1};
  }
  async stream(res, onSourceChange = () => {}, deviceId) {
    if (this.releasing) await this.releasing;
    if (res.destroyed) return;
    if (this.busy) throw Object.assign(new Error('USB 视频已在其他窗口打开，请先停止投屏。'),{status:409});
    this.busy = true;
    let listener, child, socket, timeout, finished;
    let stopping = false, live = false, resolveReleased;
    const released = new Promise(resolve => { resolveReleased = resolve; });
    let targetId;
    const stop = (lost = false) => {
      if (stopping) return;
      stopping = true;
      this.releasing = released;
      if (live || (lost && targetId)) onSourceChange(null, lost ? targetId : null);
      clearTimeout(timeout);
      if (listener?.listening) listener.close();
      socket?.destroy();
      if (child?.stdin.writable) child.stdin.end('stop\n');
    };
    res.once('close', stop);
    this.stopCapture = () => { stop(); res.destroy(); };
    try {
      const {serial, family, id, multiple} = await this.target(deviceId);
      targetId = id;
      if (stopping) return;
      listener = net.createServer(connection => {
        if (socket || stopping) return connection.destroy();
        socket = connection;
        socket.once('data', () => {
          if (stopping) return;
          live = true;
          onSourceChange({id,multiple});
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
      child = spawn(helper, ['--capture', serial, '--no-audio'], {
        ...options, stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, MIRRORLAB_MEDIA_PORT: String(listener.address().port) }
      });
      child.stdin.on('error', () => {});
      let detail = '';
      child.stderr.on('data', data => {
        if (handshakeTimeout.test(detail)) return;
        const chunk = detail + data.toString();
        detail = chunk.match(handshakeTimeout)?.[0] || chunk.slice(-1200);
      });
      finished = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      timeout = setTimeout(() => stop(true), 45000);
      await finished;
      if (!res.headersSent && !res.destroyed) {
        stop(true);
        throw new Error(captureFailure(detail));
      }
      if (!res.destroyed) res.end();
    } finally {
      stop();
      if (listener?.listening) listener.close();
      res.off('close', stop);
      this.busy = false;
      this.releasing = null;
      resolveReleased();
      this.stopCapture = null;
    }
  }
}
module.exports = { UsbVideo, captureTarget, captureFailure, selectDevice };
