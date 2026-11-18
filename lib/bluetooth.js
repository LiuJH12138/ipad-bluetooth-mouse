'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

class BluetoothBridge extends EventEmitter {
  constructor(script, { spawnProcess = spawn, startupTimeout = 45000 } = {}) {
    super(); this.script = script; this.spawnProcess = spawnProcess; this.startupTimeout = startupTimeout; this.child = null; this.active = 0;
    this.keyboardActive = 0; this.state = 'idle'; this.error = ''; this.queue = []; this.pending = null;
    this.absoluteActive = 0; this.absoluteHeld = false;
    this.buffer = ''; this.generation = 0;
  }
  snapshot() { return { state: this.state, active: this.active, keyboardActive: this.keyboardActive, absoluteActive: this.absoluteActive, error: this.error }; }
  async connect() {
    if (this.child) return this.snapshot();
    this.state = 'starting'; this.error = ''; this.active = 0; this.keyboardActive = 0; this.absoluteActive = 0;
    const generation = ++this.generation;
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = this.spawnProcess(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.buffer = ''; let stderr = '';
    const startup = setTimeout(() => this.fail('蓝牙启动超时，请检查系统蓝牙。'), this.startupTimeout);
    this.startup = startup;
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1800); });
    child.stdin.on('error', e => { if (generation === this.generation) this.fail(e.message); });
    child.stdout.on('data', data => {
      if (generation !== this.generation) return;
      this.buffer += data.toString();
      for (;;) {
        const end = this.buffer.indexOf('\n'); if (end < 0) break;
        const line = this.buffer.slice(0, end).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim(); this.buffer = this.buffer.slice(end + 1);
        if (line.startsWith('READY:')) { clearTimeout(startup); this.state = 'waiting'; }
        else if (line.startsWith('Commands:')) { clearTimeout(startup); this.enqueue({ command: 'status' }); }
        else if (line.startsWith('STATUS:')) {
          clearTimeout(startup);
          const match = line.match(/active mouse connections: (\d+)\./);
          this.active = match ? Number(match[1]) : 0;
          this.keyboardActive = Number(line.match(/active keyboard connections: (\d+)\./)?.[1] || 0);
          this.absoluteActive = this.active === 1 && /active absolute connections: 1\./.test(line) ? 1 : 0;
          this.state = this.active === 1 ? 'connected' : 'waiting';
          if (this.active === 1) this.error = '';
          this.finish(); this.emit('status');
        } else if (line.startsWith('OK:')) this.finish(line);
        else if (line.startsWith('ERROR:')) {
          this.active = 0; this.keyboardActive = 0; this.absoluteActive = 0; this.error = line; this.state = 'waiting';
          const releaseFailed = this.pending?.command === 'absolute-release';
          this.dropQueue(); this.finish(line);
          if (!releaseFailed) this.release();
          this.emit('status');
        }
      }
    });
    child.on('error', e => { clearTimeout(startup); if (generation === this.generation) this.fail(e.message); });
    child.on('exit', () => {
      clearTimeout(startup); if (generation !== this.generation) return;
      this.child = null; this.active = 0; this.keyboardActive = 0; this.clear(); this.state = 'error';
      this.error = stderr || this.error || '蓝牙服务已退出，请重试。'; this.emit('status');
    });
    this.poll = setInterval(() => { if (!this.pending && this.queue.length === 0 && this.state !== 'starting') this.enqueue({ command: 'status' }); }, 1000);
    return this.snapshot();
  }
  fail(message) {
    const held = this.absoluteHeld;
    this.keyboardActive = 0; this.error = message; this.state = 'error'; this.active = 0; this.clear();
    const child = this.child; this.child = null; ++this.generation;
    if (child && held && child.stdin.writable) {
      // The notification may have arrived even if the acknowledgement was late.
      // Give the worker a chance to send up at its saved coordinates before teardown.
      const timeout = setTimeout(() => child.kill(), 1500);
      timeout.unref(); child.once('exit', () => clearTimeout(timeout));
      try { child.stdin.end('absolute-release\nquit\n'); } catch { child.kill(); }
    } else if (child) child.kill();
    this.emit('status');
  }
  dropQueue() { for (const item of this.queue) item.ack?.(false); this.queue = []; }
  clear() {
    clearInterval(this.poll); clearTimeout(this.startup); clearTimeout(this.pending?.timer);
    this.pending?.ack?.(false); this.pending = null; this.dropQueue();
    this.absoluteActive = 0; this.absoluteHeld = false;
  }
  enqueue(item) {
    if (!this.child) return false;
    const last = this.queue.at(-1);
    if (item.motion && last?.motion && last.buttons === item.buttons && Math.abs(last.x + item.x) <= 127 && Math.abs(last.y + item.y) <= 127) {
      last.x += item.x; last.y += item.y; return true;
    }
    if (this.queue.length >= 32) { this.release(); return false; }
    this.queue.push(item); this.pump(); return true;
  }
  report(buttons, x, y, wheel) {
    if (this.active !== 1) return false;
    return this.enqueue({ buttons, x, y, wheel, motion: wheel === 0 && (x !== 0 || y !== 0) });
  }
  keys(modifiers, keys) {
    if (this.active !== 1 || this.keyboardActive !== 1) return false;
    return this.enqueue({ command: 'keys ' + modifiers + (keys.length ? ' ' + keys.join(' ') : '') });
  }
  absolute(buttons, x, y) {
    if (this.active !== 1 || this.absoluteActive !== 1) return false;
    return new Promise(resolve => {
      const item = {command: 'absolute ' + [buttons,x,y].join(' '), absolute: true, buttons, ack: resolve};
      if (!this.enqueue(item)) resolve(false);
    });
  }
  release() {
    this.dropQueue();
    if (this.child && this.absoluteHeld) this.enqueue({command:'absolute-release'});
    if (this.child && this.active === 1) this.enqueue({ buttons: 0, x: 0, y: 0, wheel: 0 });
    if (this.child && this.keyboardActive === 1) this.enqueue({ command: 'keys 0' });
  }
  pump() {
    if (this.pending || !this.child || !this.queue.length) return;
    const item = this.queue.shift(); this.pending = item;
    if (item.absolute && item.buttons) this.absoluteHeld = true;
    item.timer = setTimeout(() => this.fail('蓝牙响应超时，控制已停止。'), 4000);
    this.child.stdin.write((item.command || `report ${item.buttons} ${item.x} ${item.y} ${item.wheel}`) + '\n');
  }
  finish(line) {
    const item = this.pending;
    if (item) {
      clearTimeout(item.timer);
      if (item.absolute) {
        const ok = line === 'OK: absolute';
        if (ok) this.absoluteHeld = !!item.buttons;
        item.ack(ok);
      } else if (line === 'OK: absolute-release') this.absoluteHeld = false;
    }
    this.pending = null; this.pump();
  }
  async close() {
    if (!this.child) { this.clear(); return; }
    const child = this.child; ++this.generation; this.child = null; this.active = 0; this.keyboardActive = 0; this.clear(); this.state = 'idle';
    try { child.stdin.write('absolute-release\nreport 0 0 0 0\nkeys 0\nquit\n'); } catch {}
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
}
module.exports = { BluetoothBridge };
