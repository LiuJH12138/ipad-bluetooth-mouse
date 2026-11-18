'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const path = require('node:path');

test('desktop host receives a private session and closing its pipe stops the service', { timeout: 15000 }, async t => {
  const service = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--desktop'], {
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true
  });
  t.after(() => { if (service.exitCode === null) service.kill(); });
  const exited = once(service, 'exit');
  const lines = createInterface({ input: service.stdout });
  const [line] = await once(lines, 'line');
  const url = new URL(line);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.hash, /^#[a-f0-9]{64}$/);
  const status = url.origin + '/api/status';
  assert.equal((await fetch(status)).status, 401);
  const res = await fetch(status, { headers: { 'X-Control-Token': url.hash.slice(1) } });
  assert.equal((await res.json()).state, 'idle');
  service.stdin.end();
  assert.equal((await exited)[0], 0);
});
