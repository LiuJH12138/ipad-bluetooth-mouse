'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const startupErrors = {
  'no-adapter':'Windows 没有找到蓝牙适配器。请在设备管理器中检查蓝牙设备。',
  'radio-off':'系统蓝牙已关闭。请在 Windows 设置中打开蓝牙后重试。',
  'peripheral-unsupported':'此蓝牙适配器不支持 BLE 外设角色。可继续仅投屏，或更换支持该功能的适配器。',
  adapter:'无法读取 Windows 蓝牙状态。请检查蓝牙适配器及其驱动。',
  'hid-service':'Windows 无法创建蓝牙键鼠服务。请检查蓝牙驱动后重新连接。',
  subscriptions:'无法监测蓝牙订阅变化。请修复控制台安装后重试。',
  advertising:'Windows 未能广播蓝牙键鼠。请关闭再打开系统蓝牙后重试。'
};

class BluetoothBridge extends EventEmitter {
  constructor(script, { spawnProcess = spawn, startupTimeout = 45000 } = {}) {
    super(); this.script = script; this.spawnProcess = spawnProcess; this.startupTimeout = startupTimeout; this.child = null; this.active = 0;
    this.keyboardActive = 0; this.state = 'idle'; this.error = ''; this.queue = []; this.pending = null;
    this.absoluteActive = 0; this.absoluteHeld = false;
    this.buffer = ''; this.generation = 0;
    this.peers = []; this.selectedPeer = null; this.switchingPeer = false; this.routedWorker = false;
    this.protocol = 0; this.keyboardGeneration = 0;
  }
  snapshot() { return { state: this.state, active: this.active, keyboardActive: this.keyboardActive, keyboardGeneration:this.keyboardGeneration, absoluteActive: this.absoluteActive, error: this.error, peers: this.peers, selectedPeer: this.selectedPeer }; }
  async connect() {
    if (this.child) return this.snapshot();
    this.state = 'starting'; this.error = ''; this.active = 0; this.keyboardActive = 0; this.absoluteActive = 0;
    const generation = ++this.generation;
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = this.spawnProcess(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child; this.buffer = '';
    const startup = setTimeout(() => this.fail('蓝牙启动超时，请检查系统蓝牙。'), this.startupTimeout);
    this.startup = startup;
    child.stdin.on('error', e => { if (generation === this.generation) this.fail(e.message); });
    child.stdout.on('data', data => {
      if (generation !== this.generation) return;
      this.buffer += data.toString();
      for (;;) {
        const end = this.buffer.indexOf('\n'); if (end < 0) break;
        const line = this.buffer.slice(0, end).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim(); this.buffer = this.buffer.slice(end + 1);
        if (line.startsWith('READY:')) { clearTimeout(startup); this.state = 'waiting'; }
        else if (line.startsWith('Commands:')) { clearTimeout(startup); this.enqueue({ command: 'status' }); }
        else if (line.startsWith('STARTUP-ERROR:')) {
          const reason = line.slice('STARTUP-ERROR:'.length).trim();
          this.error = Object.hasOwn(startupErrors,reason) ? startupErrors[reason] : '蓝牙服务启动失败，请检查系统蓝牙。';
        }
        else if (line.startsWith('TARGETS:') || line.startsWith('CHANGED:')) {
          clearTimeout(startup);
          let status;
          try { status = JSON.parse(line.slice(8)); } catch {}
          if (!status || !Array.isArray(status.peers) || status.peers.some(p => !p || typeof p.id !== 'string' || !/^[a-f0-9]{32}$/.test(p.id)) ||
              (status.protocol === 2 && (!Number.isSafeInteger(status.keyboardGeneration) || status.keyboardGeneration < 0))) {
            this.fail('无法读取蓝牙设备列表，请重新连接蓝牙。');
            return;
          }
          this.routedWorker = true;
          this.protocol = status.protocol || 1;
          const oldPeer = this.selectedPeer, oldKeyboard = this.keyboardGeneration;
          this.keyboardGeneration = status.keyboardGeneration || 0;
          this.peers = status.peers.map(({id, keyboard, absolute}) => ({id, keyboard:keyboard === true, absolute:absolute === true}));
          const selected = this.peers.find(peer => peer.id === status.selectedPeer);
          this.selectedPeer = selected?.id || null;
          this.active = selected ? 1 : 0;
          this.keyboardActive = selected?.keyboard && status.keyboardActive === 1 ? 1 : 0;
          this.absoluteActive = selected?.absolute && status.absoluteActive === 1 ? 1 : 0;
          this.state = selected ? 'connected' : 'waiting';
          if (selected) this.error = '';
          if (this.protocol === 2 && (oldPeer !== this.selectedPeer || oldKeyboard !== this.keyboardGeneration)) {
            if (this.pending?.recipient) this.pending.obsolete = true;
            this.queue = this.queue.filter(item => {
              if (!item.recipient) return true;
              item.ack?.(false);
              return false;
            });
          }
          if (line.startsWith('TARGETS:') && (this.pending?.command === 'status' || this.pending && Object.hasOwn(this.pending,'select'))) this.finish(line);
          this.emit('status');
        }
        else if (line.startsWith('STATUS:')) {
          clearTimeout(startup);
          const match = line.match(/active mouse connections: (\d+)\./);
          this.active = match ? Number(match[1]) : 0;
          this.keyboardActive = Number(line.match(/active keyboard connections: (\d+)\./)?.[1] || 0);
          this.absoluteActive = this.active === 1 && /active absolute connections: 1\./.test(line) ? 1 : 0;
          this.state = this.active === 1 ? 'connected' : 'waiting';
          if (this.active === 1) this.error = '';
          this.finish(); this.emit('status');
        } else if (line.startsWith('OK:')) {
          const expected = this.pending?.command?.split(' ',1)[0] || 'report';
          if (this.protocol !== 2 || (this.pending && line === 'OK: ' + expected)) this.finish(line);
        }
        else if (line.startsWith('ERROR:')) {
          this.active = 0; this.keyboardActive = 0; this.absoluteActive = 0; this.error = '蓝牙输入未能送达，请确认所选设备仍已连接。'; this.state = 'waiting';
          const releaseFailed = ['absolute-release','peer-release'].includes(this.pending?.command);
          this.dropQueue(); this.finish(line);
          if (!releaseFailed) this.release();
          this.emit('status');
        }
      }
    });
    child.on('error', () => { clearTimeout(startup); if (generation === this.generation) this.fail('无法启动 Windows 蓝牙服务，请检查系统蓝牙后重试。'); });
    child.on('exit', code => {
      clearTimeout(startup); if (generation !== this.generation) return;
      this.child = null; this.active = 0; this.keyboardActive = 0; this.clear(); this.state = 'error';
      this.error = code === 73 ? '另一控制台正使用蓝牙，请在旧窗口断开蓝牙后重试。' : this.error || '蓝牙服务已退出，请检查系统蓝牙后重试。';
      this.emit('status');
    });
    this.poll = setInterval(() => { if (!this.pending && this.queue.length === 0 && this.state !== 'starting') this.enqueue({ command: 'status' }); }, 1000);
    return this.snapshot();
  }
  fail(message) {
    const graceful = this.routedWorker || this.absoluteHeld;
    this.keyboardActive = 0; this.error = message; this.state = 'error'; this.active = 0; this.clear();
    const child = this.child; this.child = null; ++this.generation;
    if (child && graceful && child.stdin.writable) {
      // The notification may have arrived even if the acknowledgement was late.
      // Give the worker a chance to send up at its saved coordinates before teardown.
      const timeout = setTimeout(() => child.kill(), 1500);
      timeout.unref(); child.once('exit', () => clearTimeout(timeout));
      try { child.stdin.end('absolute-release\nquit\n'); } catch { child.kill(); }
    } else if (child) child.kill();
    this.emit('status');
  }
  async selectPeer(id) {
    if (this.switchingPeer) return false;
    if (!this.child) return id === null;
    if (id !== null && !this.peers.some(p => p.id === id)) return false;
    this.switchingPeer = true;
    this.dropQueue();
    try {
      return await new Promise(resolve => {
        if (!this.enqueue({command:id === null ? 'peer-clear' : 'peer-select ' + id, select:id, ack:resolve})) resolve(false);
      });
    } finally { this.switchingPeer = false; }
  }
  dropQueue() { for (const item of this.queue) item.ack?.(false); this.queue = []; }
  clear() {
    clearInterval(this.poll); clearTimeout(this.startup); clearTimeout(this.pending?.timer);
    this.pending?.ack?.(false); this.pending = null; this.dropQueue();
    this.peers = []; this.selectedPeer = null;
    this.absoluteActive = 0; this.absoluteHeld = false;
    this.protocol = 0; this.keyboardGeneration = 0; this.routedWorker = false;
  }
  enqueue(item) {
    if (!this.child) return false;
    if (this.protocol === 2 && (item.absolute || !item.command || item.command.startsWith('keys '))) {
      if (!this.selectedPeer) return false;
      item.recipient = this.selectedPeer;
      item.keyboardGeneration = this.keyboardGeneration;
    }
    const last = this.queue.at(-1);
    if (item.motion && last?.motion && last.buttons === item.buttons && Math.abs(last.x + item.x) <= 127 && Math.abs(last.y + item.y) <= 127) {
      last.x += item.x; last.y += item.y; return true;
    }
    if (this.queue.length >= 32) { this.release(); return false; }
    this.queue.push(item); this.pump(); return true;
  }
  report(buttons, x, y, wheel, ack) {
    if (this.switchingPeer || this.active !== 1) return false;
    return this.enqueue({ buttons, x, y, wheel, ack, motion: !ack && wheel === 0 && (x !== 0 || y !== 0) });
  }
  reportConfirmed(buttons, x, y, wheel) {
    return new Promise(resolve => { if (!this.report(buttons,x,y,wheel,resolve)) resolve(false); });
  }
  keys(modifiers, keys, ack) {
    if (this.switchingPeer || this.active !== 1 || this.keyboardActive !== 1) return false;
    return this.enqueue({ command: 'keys ' + modifiers + (keys.length ? ' ' + keys.join(' ') : ''), ack });
  }
  keysConfirmed(modifiers, keys) {
    return new Promise(resolve => { if (!this.keys(modifiers,keys,resolve)) resolve(false); });
  }
  absolute(buttons, x, y) {
    if (this.switchingPeer || this.active !== 1 || this.absoluteActive !== 1) return false;
    return new Promise(resolve => {
      const item = {command: 'absolute ' + [buttons,x,y].join(' '), absolute: true, buttons, ack: resolve};
      if (!this.enqueue(item)) resolve(false);
    });
  }
  release() {
    this.dropQueue();
    if (this.child && this.routedWorker) { this.enqueue({command:'peer-release'}); return; }
    if (this.child && this.absoluteHeld) this.enqueue({command:'absolute-release'});
    if (this.child && this.active === 1) this.enqueue({ buttons: 0, x: 0, y: 0, wheel: 0 });
    if (this.child && this.keyboardActive === 1) this.enqueue({ command: 'keys 0' });
  }
  pump() {
    if (this.pending || !this.child || !this.queue.length) return;
    const item = this.queue.shift(); this.pending = item;
    if (item.absolute && item.buttons) this.absoluteHeld = true;
    item.timer = setTimeout(() => this.fail('蓝牙响应超时，控制已停止。'), 4000);
    const prefix = item.recipient ? `to ${item.recipient} ${item.keyboardGeneration} ` : '';
    this.child.stdin.write(prefix + (item.command || `report ${item.buttons} ${item.x} ${item.y} ${item.wheel}`) + '\n');
  }
  finish(line) {
    const item = this.pending;
    if (item) {
      clearTimeout(item.timer);
      if (item.absolute) {
        const ok = !item.obsolete && line === 'OK: absolute';
        if (ok) this.absoluteHeld = !!item.buttons;
        item.ack(ok);
      } else if (Object.hasOwn(item, 'select')) {
        const ok = line?.startsWith('TARGETS:') && item.select === this.selectedPeer;
        if (ok) this.absoluteHeld = false;
        item.ack(!!ok);
      } else if (item.ack) {
        const expected = item.command ? 'OK: keys' : 'OK: report';
        item.ack(!item.obsolete && line === expected);
      } else if (line === 'OK: absolute-release' || line === 'OK: peer-release') this.absoluteHeld = false;
    }
    this.pending = null; this.pump();
  }
  async close() {
    if (!this.child) { this.clear(); return; }
    const child = this.child;
    const shutdown = this.routedWorker ? 'peer-release\nquit\n' : 'absolute-release\nreport 0 0 0 0\nkeys 0\nquit\n';
    ++this.generation; this.child = null; this.active = 0; this.keyboardActive = 0; this.clear(); this.state = 'idle';
    try { child.stdin.write(shutdown); } catch {}
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
}
module.exports = { BluetoothBridge };
