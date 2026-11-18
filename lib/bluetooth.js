'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

class BluetoothBridge extends EventEmitter {
  constructor(script, { spawnProcess = spawn, startupTimeout = 45000 } = {}) {
    super(); this.script = script; this.spawnProcess = spawnProcess; this.startupTimeout = startupTimeout; this.child = null; this.active = 0;
    this.keyboardActive = 0; this.state = 'idle'; this.error = ''; this.queue = []; this.pending = null;
    this.buffer = ''; this.generation = 0;
  }
  snapshot() { return { state: this.state, active: this.active, keyboardActive: this.keyboardActive, error: this.error }; }
  async connect() {
    if (this.child) return this.snapshot();
    this.state = 'starting'; this.error = ''; this.active = 0; this.keyboardActive = 0;
    const generation = ++this.generation;
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = this.spawnProcess(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.buffer = ''; let stderr = '';
    const startup = setTimeout(() => this.fail('蓝牙启动超时，请检查系统蓝牙。'), this.startupTimeout);
    this.startup = startup;
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1800); });
    child.stdin.on('error', e => this.fail(e.message));
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
          this.state = this.active === 1 ? 'connected' : 'waiting';
          if (this.active === 1) this.error = '';
          this.finish(); this.emit('status');
        } else if (line.startsWith('OK:')) this.finish();
        else if (line.startsWith('ERROR:')) {
          this.active = 0; this.error = line; this.state = 'waiting'; this.queue = []; this.finish(); this.emit('status');
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
    this.keyboardActive = 0; this.error = message; this.state = 'error'; this.active = 0; this.clear();
    const child = this.child; this.child = null; ++this.generation;
    if (child) child.kill(); this.emit('status');
  }
  clear() { clearInterval(this.poll); clearTimeout(this.startup); if (this.pending) clearTimeout(this.pending.timer); this.pending = null; this.queue = []; }
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
  release() {
    this.queue = [];
    if (this.child && this.active === 1) this.enqueue({ buttons: 0, x: 0, y: 0, wheel: 0 });
    if (this.child && this.keyboardActive === 1) this.enqueue({ command: 'keys 0' });
  }
  pump() {
    if (this.pending || !this.child || !this.queue.length) return;
    const item = this.queue.shift(); this.pending = item;
    item.timer = setTimeout(() => this.fail('蓝牙响应超时，控制已停止。'), 4000);
    this.child.stdin.write((item.command || `report ${item.buttons} ${item.x} ${item.y} ${item.wheel}`) + '\n');
  }
  finish() { if (this.pending) clearTimeout(this.pending.timer); this.pending = null; this.pump(); }
  async close() {
    if (!this.child) { this.clear(); return; }
    const child = this.child; ++this.generation; this.child = null; this.active = 0; this.keyboardActive = 0; this.clear(); this.state = 'idle';
    try { child.stdin.write('report 0 0 0 0\nkeys 0\nquit\n'); } catch {}
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
}
module.exports = { BluetoothBridge };