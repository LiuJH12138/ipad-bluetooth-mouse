'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { BluetoothBridge } = require('../lib/bluetooth');

async function fixture(t, options = {}) {
  let clock = 1000;
  const events = [];
  const bridge = { active:1, keyboardActive:1, keys:(modifiers,keys)=>{events.push({modifiers,keys});return true;}, snapshot:()=>({state:'connected',active:bridge.active}), release:()=>events.push('release'), report:(...args)=>{ events.push(args); return true; }, connect:async()=>({active:1}), close:async()=>{} };
  const token='test-token'; const { server,expire }=createApp({bridge,token,now:()=>clock,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  async function request(route, data, headers={}) {
    return fetch(url+'/api/'+route,{method:data===undefined?'GET':'POST',headers:{'X-Control-Token':token,'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});
  }
  return {request,url,token,bridge,events,advance(ms){clock+=ms;expire();}};
}
test('unauthorized and cross-origin requests cannot control the device',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('status',undefined,{'X-Control-Token':''})).status,401);
  assert.equal((await f.request('connect',{}, {'Origin':'https://untrusted.example'})).status,403);
  assert.equal((await f.request('status')).status,200);
  assert.deepEqual(f.events,[]);
});
test('exclusive lease, validation, replay rejection and stale requests after stop',async t=>{
  const f=await fixture(t);
  const {lease}=await (await f.request('control/start',{})).json();
  assert.equal((await f.request('control/start',{})).status,409);
  const report={lease,seq:1,buttons:0,x:30,y:-10,wheel:0};
  assert.equal((await f.request('input',{...report,x:128})).status,400);
  assert.equal((await f.request('input',report)).status,200);
  assert.equal((await f.request('input',report)).status,400);
  assert.equal((await f.request('input',{...report,seq:2,buttons:8})).status,400);
  assert.equal((await f.request('control/stop',{lease})).status,200);
  assert.equal((await f.request('input',{...report,seq:3})).status,409);
  assert.deepEqual(f.events,[[0,30,-10,0],'release']);
});
test('all three HID mouse buttons reach the device and unused bits are rejected',async t=>{
  const f=await fixture(t);
  const {lease}=await (await f.request('control/start',{})).json();
  for (const [i,buttons] of [2,4,7,0].entries()) {
    assert.equal((await f.request('input',{lease,seq:i+1,buttons,x:0,y:0,wheel:0})).status,200);
  }
  assert.deepEqual(f.events.map(report=>report[0]),[2,4,7,0]);
  assert.equal((await f.request('input',{lease,seq:5,buttons:8,x:0,y:0,wheel:0})).status,400);
});
test('heartbeat timeout and Bluetooth disconnect release held buttons',async t=>{
  const f=await fixture(t);
  let {lease}=await (await f.request('control/start',{})).json();
  await f.request('input',{lease,seq:1,buttons:1,x:0,y:0,wheel:0});
  f.advance(1201); assert.equal(f.events.at(-1),'release');
  assert.equal((await f.request('heartbeat',{lease})).status,409);
  ({lease}=await (await f.request('control/start',{})).json());
  f.bridge.active=0; f.advance(1); assert.equal((await f.request('heartbeat',{lease})).status,409);
});
test('frames require authentication, expire and can be cleared',async t=>{
  const f=await fixture(t); const bytes=Buffer.from([255,216,1,2,255,217]);
  const upload=()=>fetch(f.url+'/api/frame',{method:'POST',headers:{'X-Control-Token':f.token,'Content-Type':'image/jpeg'},body:bytes});
  assert.equal((await f.request('frame')).status,404);
  assert.equal((await upload()).status,200); assert.equal((await f.request('frame')).status,200);
  assert.equal((await f.request('frame',undefined,{'X-Control-Token':'wrong'})).status,401);
  f.advance(4001); assert.equal((await f.request('frame')).status,404);
  await upload(); await f.request('frame/clear',{}); assert.equal((await f.request('frame')).status,404);
});
test('movement is coalesced without merging across button transitions',()=>{
  const writes=[]; const bridge=new BluetoothBridge('unused');
  bridge.child={stdin:{write:s=>writes.push(s)}}; bridge.active=1;
  try {
    bridge.report(0,1,0,0); // in flight
    bridge.report(0,10,0,0); bridge.report(0,15,0,0);
    bridge.report(1,0,0,0); bridge.report(1,20,0,0); bridge.report(0,0,0,0);
    while(bridge.pending || bridge.queue.length) bridge.finish();
    assert.deepEqual(writes,['report 0 1 0 0\n','report 0 25 0 0\n','report 1 0 0 0\n','report 1 20 0 0\n','report 0 0 0 0\n']);
  } finally { bridge.clear(); }
});
test('queue overload drops stale input and retains a release report',()=>{
  const bridge=new BluetoothBridge('unused'); bridge.child={stdin:{write(){}}}; bridge.active=1;
  try {
    bridge.report(1,0,0,0);
    for(let i=0;i<32;i++) assert.equal(bridge.report(i%2,0,0,0),true);
    assert.equal(bridge.report(1,0,0,0),false);
    assert.equal(bridge.queue.length,1); assert.equal(bridge.queue[0].buttons,0);
  } finally { bridge.clear(); }
});
test('a valid STATUS is sufficient proof of startup even if READY was not recognized',async t=>{
  const { EventEmitter }=require('node:events');
  const child=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.stdin=new EventEmitter();
  child.stdin.write=()=>{}; child.kill=()=>{};
  const bridge=new BluetoothBridge('unused',{spawnProcess:()=>child,startupTimeout:20});
  t.after(()=>bridge.clear());
  await bridge.connect();
  child.stdout.emit('data',Buffer.from('Commands: status\nSTATUS: Started; subscribers: 1; active mouse connections: 1.\n'));
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(bridge.state,'connected'); assert.equal(bridge.active,1);
});

test('keyboard reports validate six-key rollover, usages and replay order',async t=>{
  const f=await fixture(t);const {lease}=await(await f.request('control/start',{})).json();
  const key={lease,seq:1,kind:'keyboard',modifiers:8,keys:[4]};
  assert.equal((await f.request('input',{...key,keys:[4,4]})).status,400);
  assert.equal((await f.request('input',{...key,keys:[4,5,6,7,8,9,10]})).status,400);
  assert.equal((await f.request('input',{...key,keys:[224]})).status,400);
  assert.equal((await f.request('input',key)).status,200);
  assert.equal((await f.request('input',{...key,seq:2,modifiers:0,keys:[]})).status,200);
  assert.deepEqual(f.events,[{modifiers:8,keys:[4]},{modifiers:0,keys:[]}]);
});
test('physical key mapping preserves modifiers and releases every key',()=>{
  const {KeyboardState}=require('../web/keyboard');const k=new KeyboardState();
  assert.deepEqual(k.change('ControlLeft',true),{modifiers:8,keys:[]});
  assert.deepEqual(k.change('KeyA',true),{modifiers:8,keys:[4]});
  assert.deepEqual(k.change('KeyA',false),{modifiers:8,keys:[]});
  assert.deepEqual(k.clear(),{modifiers:0,keys:[]});
  k.commandControl=false;assert.deepEqual(k.change('ControlLeft',true),{modifiers:1,keys:[]});
  assert.deepEqual(k.change('ShiftRight',true),{modifiers:33,keys:[]});
  assert.equal(k.change('Unidentified',true),null);
});
test('release flushes queued movement and both mouse and keyboard state',()=>{
  const bridge=new BluetoothBridge('unused');bridge.child={stdin:{write(){}}};bridge.active=bridge.keyboardActive=1;
  try{bridge.report(1,0,0,0);bridge.keys(2,[4]);bridge.release();assert.equal(bridge.queue.length,2);assert.equal(bridge.queue[0].buttons,0);assert.equal(bridge.queue[1].command,'keys 0');}finally{bridge.clear();}
});
test('disconnect clears both mouse and keyboard connection indicators',async()=>{
  const {EventEmitter}=require('node:events');
  const child=new EventEmitter();child.stdin={write(){queueMicrotask(()=>child.emit('exit',0));}};child.kill=()=>{};
  const bridge=new BluetoothBridge('unused');bridge.child=child;bridge.active=bridge.keyboardActive=1;
  await bridge.close();assert.equal(bridge.active,0);assert.equal(bridge.keyboardActive,0);assert.equal(bridge.snapshot().state,'idle');
});

test('assistant credential is scoped to a live, explicitly shared view and exclusive input', async t => {
  let key;
  const f = await fixture(t,{ publishAssistant:(_port,value)=>{key=value;} });
  const {view} = await (await f.request('assistant/enable',{})).json();
  const headers = {'X-Control-Token':'','X-Assistant-Token':key};
  const agent = (route,body) => f.request(route,body,headers);
  assert.equal((await agent('connect',{})).status,403);
  assert.equal((await agent('control/start',{})).status,409);
  const upload = async id => fetch(f.url+'/api/frame',{method:'POST',headers:{
    'X-Control-Token':f.token,'X-Assistant-View':id,'X-View-Mode':'fullscreen','Content-Type':'image/jpeg'
  },body:Buffer.from([255,216,255,217])});
  await upload('different-window');
  assert.equal((await agent('frame')).status,404);
  await upload(view);
  assert.equal((await agent('frame')).status,200);
  assert.equal((await (await agent('status')).json()).fullscreen,true);
  const {lease} = await (await agent('control/start',{})).json();
  assert.equal((await f.request('control/start',{})).status,409);
  assert.equal((await f.request('control/stop',{lease})).status,409);
  assert.equal((await agent('input',{lease,seq:1,kind:'keyboard',modifiers:0,keys:[4]})).status,200);
  await f.request('assistant/disable',{});
  assert.equal((await agent('status')).status,401);
  assert.equal(key,null);
  assert.equal(f.events.at(-1),'release');
  await f.request('assistant/enable',{});
  const renewed=key;
  f.advance(4001);
  assert.equal((await f.request('status',undefined,{'X-Assistant-Token':renewed})).status,401);
  assert.equal(key,null);
});
