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
  const deviceId='1'.repeat(32),peerId='2'.repeat(32),sessionId='test-stream';
  const usb={stream:async(res,change)=>{change({id:deviceId,sessionId,multiple:false});res.end();}};
  const {server} = createApp({bridge,usb,token:'local-test'});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  function post(route, data) {
    return fetch('http://127.0.0.1:' + server.address().port + '/api/' + route, {method:'POST',
      headers:{'X-Control-Token':'local-test','Content-Type':'application/json'}, body:JSON.stringify(data)});
  }
  assert.equal((await post('control/start',{})).status,409);
  const url='http://127.0.0.1:'+server.address().port;
  await post('usb/video',{deviceId});
  await post('display/progress',{sessionId,serial:1,layout:1,ageMs:0});
  const {attachDisplayClient}=require('./helpers/display-client');
  const client=await attachDisplayClient({url,token:'local-test',sessionId});
  t.after(()=>client.close());
  const targets=selectedPeer=>'TARGETS: '+JSON.stringify({peers:[{id:peerId,absolute:true,keyboard:true}],selectedPeer,keyboardActive:1,absoluteActive:1});
  reply(targets(null));
  let auto=true;
  bridge.child.stdin.write=line=>{
    const [cmd,...args]=line.trim().split(' ');
    if(cmd==='peer-select') queueMicrotask(()=>reply(targets(peerId)));
    if(cmd==='absolute' && auto) {
      client.absolute(...args.map(Number));
      queueMicrotask(()=>reply('OK: absolute'));
    }
    if(cmd==='status') queueMicrotask(()=>reply(targets(peerId)));
    if(cmd==='peer-release') queueMicrotask(()=>reply('OK: peer-release'));
  };
  const probe=await (await post('control/start',{deviceId,sessionId,peerId,probe:true})).json();
  assert.ok(probe.lease);
  assert.equal((await post('control/verify-peer',{lease:probe.lease,deviceId,peerId})).status,200);
  await post('control/stop',{lease:probe.lease});
  const {lease} = await (await post('control/start',{deviceId,sessionId})).json();
  auto=false;
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

test('explicit routing waits for worker acknowledgement and never retargets queued input', async t => {
  const {bridge,writes,reply} = await openBridge(t);
  const [first,second] = ['a'.repeat(32),'b'.repeat(32)];
  const peers = [first,second].map(id => ({id,keyboard:true,absolute:true}));
  const status = selectedPeer => 'TARGETS: '+JSON.stringify({peers,selectedPeer,absoluteActive:1,keyboardActive:1});
  reply(status(null));
  assert.deepEqual(bridge.snapshot().peers,peers);
  assert.equal(bridge.active,0);
  assert.equal(await bridge.selectPeer('invalid'),false);
  const select = bridge.selectPeer(second);
  assert.equal(writes.at(-1),'peer-select '+second);
  assert.equal(bridge.keys(0,[4]),false);
  assert.equal(bridge.report(1,0,0,0),false);
  assert.equal(await bridge.selectPeer(first),false);
  reply(status(second));
  assert.equal(await select,true);
  assert.equal(bridge.snapshot().selectedPeer,second);
  assert.equal(bridge.keys(0,[4]),true);
  assert.equal(bridge.keys(0,[5]),true);
  const deselect = bridge.selectPeer(null);
  assert.ok(!writes.includes('keys 0 5'));
  reply('OK: keys');
  assert.equal(writes.at(-1),'peer-clear');
  reply(status(null));
  assert.equal(await deselect,true);
  assert.equal(bridge.keys(0,[4]),false);
  assert.ok(!writes.includes('keys 0 5'));
});
