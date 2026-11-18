'use strict';
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const bundledHelper = path.join(__dirname, '..', 'usb', 'iphone-usb.exe');
const helper = require('node:fs').existsSync(bundledHelper) ? bundledHelper :
  path.join(__dirname, '..', '.local', 'usb-v0.2.0', 'iphone-usb.exe');
const options = { cwd: path.dirname(helper), windowsHide: true };

async function selectDevice() {
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(helper, ['--list'], { ...options, timeout: 10000 }));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('请先运行 Install-UsbReceiver.ps1 安装 USB 视频组件。');
    throw new Error('USB 设备检测失败。请检查 Apple Mobile Device 服务并重新连接 iPad。');
  }
  const devices = JSON.parse(stdout);
  // Apple Mobile Device can temporarily omit a device already in capture mode.
  // Resolve only a single present Apple USB composite parent in that case.
  if (!devices.length) {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const query = "Get-PnpDevice -PresentOnly -Class USB | Where-Object { $_.InstanceId -match '^USB\\\\VID_05AC&PID_[0-9A-F]{4}\\\\' -and $_.FriendlyName -like 'Apple Mobile Device USB Composite*' } | ForEach-Object { $_.InstanceId.Split('\\')[-1] }";
    const parents = (await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], { ...options, timeout: 15000 })).stdout.trim().split(/\s+/).filter(Boolean);
    if (parents.length === 1 && /^[\da-f-]{16,48}$/i.test(parents[0])) {
      const result = await promisify(execFile)(helper, ['--driver', parents[0]], options);
      const info = JSON.parse(result.stdout);
      if (info.present) devices.push({ serial: parents[0], driver: info.driver });
    }
  }
  if (devices.length !== 1) throw new Error('请用数据线连接并解锁一台 iPad，拔掉其他 Apple 移动设备后重试。');
  const device = devices[0];
  if (device.driver === 'replug') throw new Error('请拔插 iPad 数据线，等待驱动就绪后重试。');
  if (device.driver !== 'ready') throw new Error('当前设备缺少 USB 采集过滤驱动。请参阅 README 的 USB 配置说明。');
  if (!/^[\da-f-]{16,48}$/i.test(device.serial)) throw new Error('USB 设备信息无效。');
  return device.serial;
}

class UsbVideo {
  async stream(res) {
    if (this.busy) throw new Error('USB 视频已被占用或正在释放，请稍后重试。');
    this.busy = true;
    let listener, child, socket, timeout, finished;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timeout);
      if (listener?.listening) listener.close();
      socket?.destroy();
      if (child?.stdin.writable) child.stdin.end('stop\n');
    };
    res.once('close', stop);
    this.stopCapture = () => { stop(); res.destroy(); };
    try {
      const serial = await selectDevice();
      if (stopping) return;
      listener = net.createServer(connection => {
        if (socket || stopping) return connection.destroy();
        socket = connection;
        socket.once('data', () => {
          clearTimeout(timeout);
          res.setHeader('Content-Type', 'application/octet-stream');
        });
        const disconnected = () => {
          if (res.headersSent && !res.destroyed) res.end();
          stop();
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
      child.stderr.on('data', data => { detail = (detail + data.toString()).slice(-1200); });
      finished = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      timeout = setTimeout(stop, 45000);
      await finished;
      if (!res.headersSent && !res.destroyed) {
        throw new Error(/driver|filter/i.test(detail) ? 'USB 驱动尚未就绪，请重新连接 iPad。' :
          '没有收到 USB 视频。请解锁 iPad、关闭其他 USB 投屏，拔插数据线后重试。');
      }
      if (!res.destroyed) res.end();
    } finally {
      stop();
      if (listener?.listening) listener.close();
      res.off('close', stop);
      this.busy = false;
      this.stopCapture = null;
    }
  }
}
module.exports = { UsbVideo };
