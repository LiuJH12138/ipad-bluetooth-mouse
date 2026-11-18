'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {BluetoothBridge} = require('../lib/bluetooth');
const {createApp} = require('../server');

async function openBridge(t) {
  const writes = [], child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin.write = line => writes.push(line.trim()); child.kill = () => {};
  const bridge = new BluetoothBridge('unused', {spawnProcess: () => child});
  t.after(() => bridge.clear());
  await bridge.connect();
  const reply = line => child.stdout.emit('data', Buffer.from(line + '\n'));
  reply('STATUS: Started; active mouse connections: 1. active absolute connections: 1.');
  return {bridge, writes, reply};
}

test('absolute input is acknowledged by the matching native report and released on lease loss', async t => {
  const {bridge, writes, reply} = await openBridge(t);
  assert.equal(bridge.snapshot().absoluteActive, 1);
  const press = bridge.absolute(1, 15320, 580);
  const skipped = bridge.absolute(1, 20000, 20000);
  bridge.release();
  assert.equal(await skipped, false);
  assert.deepEqual(writes,['absolute 1 15320 580']);
  reply('OK: absolute');
  assert.equal(await press, true);
  assert.equal(writes.at(-1),'absolute-release');
  reply('OK: absolute-release');
  assert.equal(writes.at(-1),'report 0 0 0 0');
  reply('OK: report');
  bridge.release();
  assert.equal(writes.filter(s => s === 'absolute-release').length, 1);
});

test('older paired hosts and ambiguous subscriptions cannot receive absolute reports', async t => {
  const {bridge, writes, reply} = await openBridge(t);
  for (const status of ['active mouse connections: 1.', 'active mouse connections: 2. active absolute connections: 1.']) {
    reply('STATUS: ' + status);
    assert.equal(bridge.snapshot().absoluteActive, 0);
    assert.equal(bridge.absolute(1, 100, 100), false);
  }
  assert.deepEqual(writes, []);
});

test('an absolute send error drops queued inputs and attempts release without replaying a press', async t => {
  const {bridge, writes, reply} = await openBridge(t);
  const pending = bridge.absolute(1, 100, 200);
  const queued = bridge.absolute(1, 300, 400);
  reply('ERROR: Absolute report failed');
  assert.deepEqual(await Promise.all([pending, queued]), [false, false]);
  assert.equal(bridge.snapshot().absoluteActive, 0);
  assert.deepEqual(writes, ['absolute 1 100 200', 'absolute-release']);
  reply('ERROR: failed to release');
  assert.equal(writes.length, 2);
});

test('absolute API uses the existing lease, validates coordinates, and waits for native delivery', async t => {
  const {bridge, reply} = await openBridge(t);
  const {server} = createApp({bridge, token:'local-test'});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  function post(route, data) {
    return fetch('http://127.0.0.1:' + server.address().port + '/api/' + route, {method:'POST',
      headers:{'X-Control-Token':'local-test','Content-Type':'application/json'}, body:JSON.stringify(data)});
  }
  const {lease} = await (await post('control/start',{})).json();
  const event = {lease, seq:1, kind:'absolute', buttons:1, x:0, y:32767};
  for (const bad of [{buttons:8}, {x:-1}, {y:32768}, {x:1.25}]) {
    assert.equal((await post('input', {...event,...bad})).status, 400);
  }
  const pending = post('input',event);
  const deadline = Date.now() + 1000;
  while (!bridge.pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(bridge.pending?.absolute);
  assert.equal((await post('input',event)).status, 400);
  reply('OK: absolute');
  assert.equal((await pending).status, 200);
  assert.equal((await post('control/stop',{lease})).status, 200);
  assert.equal((await post('input',{...event,seq:2})).status, 409);
});

test('native absolute payload preserves button bits, little-endian axes and ownership on release',
  {skip:process.platform !== 'win32'}, () => {
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',
      path.join(__dirname,'absolute-report.ps1')], {encoding:'utf8',windowsHide:true});
    assert.equal(result.status, 0, result.stderr);
  });
