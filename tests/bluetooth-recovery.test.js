'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {BluetoothBridge} = require('../lib/bluetooth');

const first = 'a'.repeat(32), renewed = 'b'.repeat(32);
test('Windows builds the WinRT watcher and records rapid subscription changes without hardware',
  {skip:process.platform !== 'win32'},()=>{
    const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',
      path.join(__dirname,'gatt-subscriptions.ps1')],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
  });
function status(id, generation) {
  return JSON.stringify({protocol:2, peers:[{id,keyboard:true,absolute:true}], selectedPeer:id,
    keyboardActive:1, absoluteActive:1, keyboardGeneration:generation});
}
async function open(t) {
  const child = new EventEmitter(), writes = [];
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin.write = line => writes.push(line.trim());
  child.kill = () => {};
  const bridge = new BluetoothBridge('unused',{spawnProcess:()=>child});
  await bridge.connect();
  t.after(()=>bridge.clear());
  const reply = line => child.stdout.emit('data',Buffer.from(line+'\n'));
  reply('TARGETS: '+status(first,1));
  return {bridge,writes,reply,child};
}
test('a topology update cannot acknowledge a pending report or replay input on a renewed peer',async t=>{
  const {bridge,writes,reply}=await open(t);
  const press=bridge.absolute(1,100,200), queued=bridge.absolute(1,100,201);
  assert.equal(writes[0],'to '+first+' 1 absolute 1 100 200');
  reply('CHANGED: '+status(renewed,2));
  assert.equal(bridge.snapshot().selectedPeer,renewed);
  assert.equal(await queued,false);
  assert.ok(bridge.pending);
  reply('OK: keys');
  assert.ok(bridge.pending);
  reply('OK: absolute');
  assert.equal(await press,false);
  assert.equal(writes.some(line=>line.includes('100 201')),false);
});
test('a keyboard-only reconnect invalidates pending keyboard input and preserves the mouse identity',async t=>{
  const {bridge,reply,writes}=await open(t);
  bridge.keys(8,[4]); bridge.keys(0,[5]);
  reply('CHANGED: '+status(first,2));
  assert.equal(bridge.snapshot().keyboardGeneration,2);
  reply('OK: keys');
  assert.equal(writes.some(line=>line.endsWith('keys 0 5')),false);
  assert.equal(bridge.keys(0,[6]),true);
  assert.equal(writes.at(-1),'to '+first+' 2 keys 0 6');
});
test('startup distinguishes adapters without peripheral support from generic failure',async t=>{
  const {bridge,child,reply}=await open(t);
  reply('STARTUP-ERROR: peripheral-unsupported');
  child.emit('exit',1);
  assert.match(bridge.snapshot().error,/BLE 外设/);
});
test('confirmed relative movement and keys wait for their own delivery and retain command boundaries',async t=>{
  const {bridge,reply,writes}=await open(t);
  const firstMove=bridge.reportConfirmed(0,3,0,0);
  const secondMove=bridge.reportConfirmed(0,4,0,0);
  const thirdMove=bridge.reportConfirmed(0,5,0,0);
  const key=bridge.keysConfirmed(8,[4]);
  assert.equal(writes.length,1);
  reply('OK: keys');
  assert.equal(writes.length,1);
  reply('OK: report'); assert.equal(await firstMove,true);
  assert.ok(writes.at(-1).endsWith('report 0 4 0 0'));
  reply('OK: report'); assert.equal(await secondMove,true);
  assert.ok(writes.at(-1).endsWith('report 0 5 0 0'));
  reply('OK: report'); assert.equal(await thirdMove,true);
  assert.ok(writes.at(-1).endsWith('keys 8 4'));
  reply('ERROR: keyboard delivery failed');
  assert.equal(await key,false);
});
