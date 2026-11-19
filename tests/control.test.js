'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { BluetoothBridge } = require('../lib/bluetooth');
const { attachDisplayClient } = require('./helpers/display-client');

async function fixture(t, options = {}) {
  let clock=1000, serial=0, layout=1, sessionId, activeId, changed;
  const events=[];
  const id='0'.repeat(32), peerId='e'.repeat(32);
  const bridge={active:1,keyboardActive:1,peers:[{id:peerId,keyboard:true,absolute:false}],selectedPeer:null,
    selectPeer:async function(id){this.selectedPeer=id;return true;},
    keys:(modifiers,keys)=>{events.push({modifiers,keys});return true;}, snapshot:()=>({state:'connected',active:bridge.active}),
    release:()=>events.push('release'),report:(...args)=>{events.push(args);return true;},connect:async()=>({active:1}),close:async()=>{}};
  const fake=options.usb || {};
  const usb={...fake,devices:fake.devices || (async()=>[{id}]),get busy(){return fake.busy;},
    stream:async(res,change,chosen)=>{
      const publish=(target,lost)=>{
        activeId=target?.id;
        sessionId=target && require('node:crypto').randomUUID();
        serial=0; layout=1; changed=publish;
        change(target && {...target,sessionId},lost);
      };
      if(fake.stream) await fake.stream(res,publish,chosen);
      else {publish({id:chosen || id,multiple:false});res.end();}
    }};
  const token='test-token';
  const {server,expire}=createApp({now:()=>clock,...options,bridge,token,usb});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url='http://127.0.0.1:'+server.address().port;
  async function request(route,data,headers={}) {
    if (data && !headers['X-Assistant-Token'] && ['control/start','assistant/enable','assistant/disable','frame/clear','control/identify-relative','control/confirm-relative'].includes(route))
      data={sessionId,deviceId:activeId,...data};
    const response=await fetch(url+'/api/'+route,{method:data===undefined?'GET':'POST',headers:{'X-Control-Token':token,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
    if (route==='usb/video' && response.ok && activeId) await progress();
    return response;
  }
  async function progress(nextLayout=layout) {
    layout=nextLayout;
    return request('display/progress',{sessionId,layout,serial:++serial,ageMs:0});
  }
  async function startRelative() {
    await request('usb/video',{deviceId:id});
    const target={deviceId:id,peerId};
    const challenge=await (await request('control/identify-relative',target)).json();
    assert.equal((await request('control/confirm-relative',{...target,confirmation:challenge.confirmation})).status,200);
    events.length=0;
  }
  if (!options.usb) await startRelative();
  return {request,url,token,bridge,events,progress,startRelative,closeDisplay:()=>changed(null),get sessionId(){return sessionId;},
    get frameHeaders(){return {'X-USB-Session':sessionId,'X-Serial':String(serial),'X-Layout':String(layout)};},advance(ms){clock+=ms;expire();}};

}
test('unauthorized and cross-origin requests cannot control the device',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('status',undefined,{'X-Control-Token':''})).status,401);
  assert.equal((await f.request('connect',{}, {'Origin':'https://untrusted.example'})).status,403);
  assert.equal((await f.request('status')).status,200);
  assert.deepEqual(f.events,[]);
});
test('setup accepts only console credentials, known actions and an exact target', async t => {
  let key;
  const calls = [];
  const id = 'a'.repeat(32);
  const status = {receiverReady:true,sourceInstallable:false,appleService:'ready',computerName:'TEST'};
  const f = await fixture(t, {
    setup:{status:async()=>status,prepareReceiver:async()=>calls.push('receiver'),startAppleService:async()=>calls.push('apple')},
    usb:{setupDevice:async target=>{calls.push(target); return {status:'replug'};}},
    publishAssistant:(_port,token)=>{key=token;}
  });
  assert.deepEqual(await (await f.request('setup')).json(),status);
  await f.startRelative();
  await f.request('assistant/enable',{});
  const assistant = {'X-Assistant-Token':key};
  for (const [route,body] of [['setup',undefined],['setup/receiver',{}],['setup/apple-service',{}],['setup/driver',{deviceId:id}]]) {
    assert.equal((await f.request(route,body,assistant)).status,403);
  }
  assert.equal((await f.request('setup/receiver',{path:'untrusted'})).status,400);
  assert.equal((await f.request('setup/apple-service',{name:'other'})).status,400);
  assert.equal((await f.request('setup/driver',{})).status,400);
  assert.equal((await f.request('setup/driver',{deviceId:id,all:true})).status,400);
  assert.equal((await f.request('setup/driver',{deviceId:'other'})).status,400);
  f.closeDisplay();
  assert.deepEqual(calls,[]);
  assert.equal((await f.request('setup/receiver',{})).status,200);
  assert.equal((await f.request('setup/apple-service',{})).status,200);
  assert.deepEqual(await (await f.request('setup/driver',{deviceId:id})).json(),{driver:'replug'});
  assert.deepEqual(calls,['receiver','apple',id]);
});

test('a Windows wall-clock adjustment cannot renew frozen frames or expire a live control session', async t => {
  t.mock.timers.enable({apis:['Date'],now:2000000000000});
  const f=await fixture(t,{now:undefined});
  const {lease}=await (await f.request('control/start',{})).json();
  assert.ok(lease);
  t.mock.timers.setTime(Date.now()+3600000);
  const status=await (await f.request('status')).json();
  assert.equal(status.displayState,'live');
  assert.equal(status.controlling,true);
  await f.request('display/progress',{sessionId:f.sessionId,serial:500,layout:1,ageMs:5000});
  t.mock.timers.setTime(Date.now()-3600000);
  assert.equal((await (await f.request('status')).json()).displayState,'stale');
});

test('a failed USB mode transition carries its recovery code through the normal video endpoint', async t => {
  const usb={stream:async()=>{throw Object.assign(Error('USB mode transition failed'),{status:503,code:'USB_MODE_UNCHANGED'});}};
  const f=await fixture(t,{usb});
  const response=await f.request('usb/video',{deviceId:'b'.repeat(32)});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'USB mode transition failed',code:'USB_MODE_UNCHANGED'});
});

test('USB stop acknowledges only after the owning capture has released and rejects missing identity', async t => {
  const release = Promise.withResolvers(), stopping = Promise.withResolvers();
  const f = await fixture(t,{usb:{stopCapture:async id=>{stopping.resolve(id); await release.promise;}}});
  await f.request('usb/video',{deviceId:'b'.repeat(32)});
  assert.equal((await f.request('usb/stop',{})).status,409);
  let acknowledged=false;
  const stop=f.request('usb/stop',{sessionId:f.sessionId}).then(response=>{acknowledged=true;return response;});
  assert.equal(await stopping.promise,f.sessionId);
  assert.equal(acknowledged,false);
  release.resolve();
  assert.equal((await stop).status,200);
});

test('setup and capture cannot race, and cancelled elevation can be retried', async t => {
  const id = 'b'.repeat(32);
  let finish, calls = 0;
  const started = new Promise(resolve=>{finish=resolve;});
  let complete;
  const pending = new Promise(resolve=>{complete=resolve;});
  const usb = {busy:true,setupDevice:async()=>{
    if (++calls===1) { finish(); await pending; return {status:'cancelled'}; }
    return {status:'ready'};
  }};
  const f = await fixture(t,{usb});
  assert.equal((await f.request('setup/driver',{deviceId:id})).status,409);
  usb.busy=false;
  const first=f.request('setup/driver',{deviceId:id});
  await started;
  assert.equal((await f.request('usb/video',{deviceId:id})).status,409);
  assert.equal((await f.request('setup/apple-service',{})).status,409);
  complete();
  assert.equal((await first).status,409);
  assert.deepEqual(await (await f.request('setup/driver',{deviceId:id})).json(),{driver:'ready'});
  assert.equal(calls,2);
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
  const upload=()=>fetch(f.url+'/api/frame',{method:'POST',headers:{...f.frameHeaders,'X-Control-Token':f.token,'Content-Type':'image/jpeg'},body:bytes});
  assert.equal((await f.request('frame')).status,404);
  assert.equal((await upload()).status,200); assert.equal((await f.request('frame')).status,200);
  assert.equal((await f.request('frame',undefined,{'X-Control-Token':'wrong'})).status,401);
  f.advance(4001); assert.equal((await f.request('frame')).status,404);
  assert.equal((await upload()).status,409);
  await f.progress(); await upload(); await f.request('frame/clear',{}); assert.equal((await f.request('frame')).status,404);
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
    ...f.frameHeaders,'X-Control-Token':f.token,'X-Assistant-View':id,'X-View-Mode':'fullscreen','Content-Type':'image/jpeg'
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
  await f.request('assistant/disable',{view});
  assert.equal((await agent('status')).status,401);
  assert.equal(key,null);
  assert.equal(f.events.at(-1),'release');
  await f.request('assistant/enable',{});
  const renewed=key;
  f.advance(4001);
  assert.equal((await f.request('status',undefined,{'X-Assistant-Token':renewed})).status,401);
  assert.equal(key,null);
});

test('an open sharing window survives frame pauses, gates input, and revokes on close', async t => {
  let key;
  const f = await fixture(t, {publishAssistant: (_port, value) => { key = value; }});
  const {view} = await (await f.request('assistant/enable', {})).json();
  const headers = {'X-Control-Token':'', 'X-Assistant-Token':key};
  const controller = new AbortController();
  t.after(() => controller.abort());
  const presence = await fetch(f.url+'/api/assistant/presence', {method:'POST',
    headers:{'X-Control-Token':f.token}, body:JSON.stringify({view}), signal:controller.signal});
  assert.equal(presence.status, 200);
  const upload = () => fetch(f.url+'/api/frame', {method:'POST', headers:{
    ...f.frameHeaders,'X-Control-Token':f.token, 'X-Assistant-View':view, 'Content-Type':'image/jpeg'
  }, body:Buffer.from([255,216,255,217])});
  try {
    await upload();
    f.advance(65_000);
    assert.equal((await f.request('status', undefined, headers)).status, 200);
    assert.equal((await f.request('frame', undefined, headers)).status, 404);
    assert.equal((await f.request('control/start', {}, headers)).status, 409);
    await f.progress(); await upload();
    assert.equal((await f.request('control/start', {}, headers)).status, 200);
  } finally { controller.abort(); }
  for (let i=0; key && i<30; i++) await new Promise(resolve => setTimeout(resolve,10));
  assert.equal(key, null);
  assert.equal(f.events.at(-1), 'release');
});

test('USB source changes revoke old assistant tokens, frame and manual input lease', async t => {
  let key, sourceChanged;
  const usb = {stream:async (res, changed, id) => {
    sourceChanged = changed;
    changed(id && {id,multiple:false});
    res.end('video');
  }};
  const f = await fixture(t, {usb, publishAssistant: (_, value) => {key=value;}});
  await f.startRelative();
  await f.request('assistant/enable', {});
  const oldKey = key;
  const {lease} = await (await f.request('control/start', {})).json();
  assert.equal((await f.request('usb/video', {})).status, 200);
  assert.equal((await f.request('status', undefined, {'X-Assistant-Token':oldKey})).status,401);
  assert.equal((await f.request('heartbeat', {lease})).status,409);
  await f.startRelative();
  const {view} = await (await f.request('assistant/enable', {})).json();
  sourceChanged();
  assert.equal(key, null);
  const late = await fetch(f.url+'/api/frame',{method:'POST',headers:{
    'X-Control-Token':f.token, 'X-Assistant-View':view,'Content-Type':'image/jpeg'
  },body:Buffer.from([255,216,255,217])});
  assert.equal(late.status,409);
  assert.equal((await f.request('frame')).status,404);
});

test('losing the only Bluetooth mouse revokes its previously authorized input', async t => {
  let key;
  const f=await fixture(t,{publishAssistant: (_, value) => {key=value;}});
  await f.request('assistant/enable', {});
  const previous=key;
  f.bridge.active=2;
  f.advance(1);
  f.bridge.active=1;
  assert.equal((await f.request('status',undefined,{'X-Assistant-Token':previous})).status,401);
});

test('multiple keyboard subscribers invalidate the lease even with one mouse',async t=>{
  const f=await fixture(t);
  const {lease}=await (await f.request('control/start',{})).json();
  f.bridge.keyboardActive=2;
  assert.equal((await f.request('input',{lease,seq:1,buttons:1,x:0,y:0,wheel:0})).status,409);
  assert.equal((await f.request('control/start',{})).status,409);
  assert.deepEqual(f.events,['release']);
});

test('a delayed first key from the previous keyboard subscription is discarded', async t => {
  const f=await fixture(t);
  f.bridge.keyboardGeneration=7;
  const {lease}=await (await f.request('control/start',{})).json();
  f.bridge.keyboardGeneration=8;
  const key={lease,seq:1,kind:'keyboard',modifiers:8,keys:[4]};
  assert.equal((await f.request('input',key)).status,409);
  assert.deepEqual(f.events,['release']);
});

test('only the current console can rename its displayed device and see its private label', async t => {
  const aliases=new Map();
  let key;
  const f=await fixture(t,{names:{get:id=>aliases.get(id) || '',set:(id,alias)=>{aliases.set(id,alias);return alias;}},
    publishAssistant:(_,value)=>{key=value;}});
  const deviceId='0'.repeat(32);
  assert.equal((await f.request('device/alias',{deviceId:'9'.repeat(32),alias:'Other'})).status,409);
  assert.equal((await f.request('device/alias',{deviceId,alias:'Private label'})).status,200);
  const local=await (await f.request('status')).json();
  assert.equal(local.deviceAlias,'Private label');
  assert.equal(local.computerName,require('node:os').hostname());
  await f.request('assistant/enable',{});
  const h={'X-Assistant-Token':key};
  const shared=await (await f.request('status',undefined,h)).json();
  assert.equal(shared.activeDeviceId,deviceId);
  assert.equal(shared.deviceAlias,undefined);
  assert.equal(shared.deviceLabel,undefined);
  assert.equal(shared.computerName,undefined);
  assert.equal((await f.request('device/alias',{deviceId,alias:'overwritten'},h)).status,403);
});

test('rotation retires verified assistant coordinates while preserving the sharing grant', async t => {
  let token;
  const f = await fixture(t, {publishAssistant: (_, value) => {token = value;}});
  const {view} = await (await f.request('assistant/enable', {})).json();
  const agent = (route, data) => f.request(route, data, {'X-Assistant-Token':token});
  const upload = async (layout, verified) => { await f.progress(layout); return fetch(f.url+'/api/frame', {method:'POST', headers:{
    ...f.frameHeaders,'X-Control-Token':f.token, 'X-Assistant-View':view, 'Content-Type':'image/jpeg',
    'X-Layout':String(layout), 'X-Verified':String(verified), 'X-Width':'400','X-Height':'840'
  }, body:Buffer.from([255,216,255,217])}); };
  assert.equal((await upload(3,true)).status,200);
  const {lease} = await (await agent('control/start', {})).json();
  await f.request('frame/clear', {view,layout:4});
  assert.equal((await agent('frame')).status,404);
  // A late upload of the pre-rotation frame has exactly the same pixel dimensions.
  assert.equal((await upload(3,true)).status,409);
  assert.equal((await upload(4,false)).status,200);
  // Delivery of an already applied notification must not discard the fresh frame.
  await f.request('frame/clear', {view,layout:4});
  const status = await (await agent('status')).json();
  assert.equal(status.picture.verified,false);
  assert.equal(status.picture.layout,'4');
  assert.equal(status.controlling,false);
  assert.equal((await agent('input',{lease,layout:'3',seq:1,buttons:1,x:0,y:0,wheel:0})).status,409);
  assert.equal((await agent('control/start',{})).status,200);
});

test('Bluetooth startup shows a short recovery message and clears it on retry',async t=>{
  const {EventEmitter}=require('node:events');
  function worker() {
    const child=new EventEmitter();
    child.stdin=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter();
    child.stdin.write=()=>{}; child.kill=()=>{};
    return child;
  }
  const first=worker(), next=worker(), children=[first,next];
  const bridge=new BluetoothBridge('unused',{spawnProcess:()=>children.shift()});
  t.after(()=>bridge.clear());
  await bridge.connect();
  first.stderr.emit('data',Buffer.from('private path / PowerShell stack'));
  first.emit('exit',73);
  assert.equal(bridge.snapshot().error,'另一控制台正使用蓝牙，请在旧窗口断开蓝牙后重试。');
  await bridge.connect();
  next.stdout.emit('data',Buffer.from('STATUS: Started; active mouse connections: 1.\n'));
  assert.equal(bridge.snapshot().state,'connected');
  assert.equal(bridge.snapshot().error,'');
});

test('multiple connected devices route only validated USB and BLE pairs and retire old input', async t => {
  const phone = '1'.repeat(32), pad = '2'.repeat(32), peerA='a'.repeat(32), peerB='b'.repeat(32);
  const devices = [phone,pad].map(id=>({id,driver:'ready'}));
  let change;
  const usb={devices:async()=>devices,stream:async(res,onSource,id)=>{
    change=onSource;
    onSource({id,multiple:true}); res.end('video');
  }};
  let assistantKey;
  const f=await fixture(t,{usb,publishAssistant:(_,key)=>{assistantKey=key;}});
  const bridge=f.bridge;
  let display, visibleId;
  const owner = new Map([[peerA,phone],[peerB,pad]]);
  const received = new Map([[peerA,[]],[peerB,[]]]);
  async function clickAndType(lease,key) {
    const reports=[
      {buttons:1,x:0,y:0,wheel:0}, {buttons:0,x:0,y:0,wheel:0},
      {kind:'keyboard',modifiers:0,keys:[key]}, {kind:'keyboard',modifiers:0,keys:[]}
    ];
    for (const [i,report] of reports.entries()) {
      assert.equal((await f.request('input',{lease,seq:i+1,...report})).status,200);
    }
  }
  Object.assign(bridge,{generation:1,peers:[peerA,peerB].map(id=>({id,absolute:true,keyboard:true})),
    absoluteActive:1, selectedPeer:null, async selectPeer(id){this.selectedPeer=id;return true;},
    report(buttons){received.get(this.selectedPeer).push(buttons);return true;},
    keys(_modifiers,keys){received.get(this.selectedPeer).push(keys);return true;},
    absolute(...report){return owner.get(this.selectedPeer)===visibleId ? display.absolute(...report) : true;}});
  const pick=async id=>{
    await display?.close();
    await f.request('usb/video',{deviceId:id});
    visibleId=id;
    display=await attachDisplayClient(f);
  };
  const start=(deviceId,peerId)=>f.request('control/start',{probe:true,deviceId,peerId});
  const verify=(lease,deviceId,peerId)=>f.request('control/verify-peer',{lease,deviceId,peerId});
  const status=async()=>(await f.request('status')).json();
  assert.equal((await (await f.request('devices')).json()).devices.length,2);
  await pick(phone);
  assert.equal((await f.request('control/start',{deviceId:phone})).status,409);
  // A fully subscribed but different peer acknowledges every HID write.
  // Its cursor never appears on the selected phone.
  const other=(await (await start(phone,peerB)).json()).lease;
  assert.ok(other);
  const mismatch=await verify(other,phone,peerB);
  assert.equal(mismatch.ok,false);
  assert.equal((await status()).verifiedPeerId,null);
  await f.request('control/stop',{lease:other});
  const lease=(await (await start(phone,peerA)).json()).lease;
  assert.ok(lease);
  assert.equal((await f.request('input',{lease,seq:1,kind:'absolute',buttons:1,x:0,y:0})).status,409);
  assert.equal((await f.request('input',{lease,seq:1,kind:'keyboard',modifiers:0,keys:[4]})).status,409);
  assert.equal((await verify(lease,phone,peerB)).status,409);
  const confirmation=await verify(lease,phone,peerA);
  assert.equal(confirmation.status,200);
  assert.ok((await confirmation.json()).maxError<=1);
  await f.request('control/stop',{lease});
  const old=(await (await f.request('control/start',{deviceId:phone})).json()).lease;
  assert.ok(old);
  await clickAndType(old,4);
  assert.deepEqual(received.get(peerB),[]);
  await f.request('assistant/enable',{});
  assert.ok(assistantKey);
  await pick(pad);
  assert.equal(assistantKey,null);
  assert.equal((await f.request('heartbeat',{lease:old})).status,409);
  assert.equal((await start(pad,peerA)).status,409);
  assert.equal((await start(phone,peerB)).status,409);
  assert.equal((await f.request('control/start',{deviceId:pad})).status,409);
  const padProbe=(await (await start(pad,peerB)).json()).lease;
  assert.equal((await verify(padProbe,pad,peerB)).status,200);
  await f.request('control/stop',{lease:padProbe});
  const padLease=(await (await f.request('control/start',{deviceId:pad})).json()).lease;
  await clickAndType(padLease,5);
  assert.equal((await f.request('input',{lease:old,seq:5,kind:'keyboard',modifiers:0,keys:[6]})).status,409);
  assert.deepEqual(received.get(peerA),[1,0,[4],[]]);
  assert.deepEqual(received.get(peerB),[1,0,[5],[]]);
  await pick(phone);
  assert.equal((await status()).verifiedPeerId,peerA);
  change(null,phone); // Unexpected USB loss requires a new association.
  await pick(phone);
  assert.equal((await status()).verifiedPeerId,null);
  await display.close();
});

test('stale input needs a visible round trip; a freeze or a scene change cannot authorize a click', async t => {
  const f=await fixture(t);
  const display=await attachDisplayClient(f);
  const reports=[];
  let changeDuringMove=false;
  f.bridge.report=(...report)=>{
    reports.push(report);
    if (changeDuringMove && report[1]) { display.changeScene(); changeDuringMove=false; }
    return display.report(...report);
  };
  async function keepLeaseWhilePictureAges(lease) {
    for (let i=0;i<5;i++) {
      f.advance(900);
      assert.equal((await f.request('heartbeat',{lease})).status,200);
    }
  }
  try {
    const first=(await (await f.request('control/start',{})).json()).lease;
    await keepLeaseWhilePictureAges(first);
    display.freeze();
    const click={seq:1,buttons:1,x:0,y:0,wheel:0};
    assert.equal((await f.request('input',{...click,lease:first})).status,409);
    assert.ok(reports.length>0);
    assert.ok(reports.every(([buttons,dx,dy,wheel])=>buttons===0 && dy===0 && wheel===0 && dx!==0));
    display.freeze(false);
    reports.length=0;
    const recovered=await f.request('control/start',{});
    assert.equal(recovered.status,200);
    const {lease}=await recovered.json();
    assert.deepEqual(reports,[[0,24,0,0],[0,-24,0,0]]);
    await keepLeaseWhilePictureAges(lease);
    reports.length=0;
    assert.equal((await f.request('input',{...click,lease})).status,200);
    assert.deepEqual(reports,[[0,24,0,0],[0,-24,0,0],[1,0,0,0]]);
    assert.equal((await f.request('input',{lease,seq:2,buttons:0,x:0,y:0,wheel:0})).status,200);
    await keepLeaseWhilePictureAges(lease);
    reports.length=0;
    changeDuringMove=true;
    assert.equal((await f.request('input',{...click,seq:3,lease})).status,409);
    assert.ok(reports.every(([buttons])=>buttons===0));
  } finally { await display.close(); }
});

test('an in-flight pixel reply from an old USB session cannot establish control on reconnect', async t => {
  const f=await fixture(t);
  const captured=Promise.withResolvers(), resume=Promise.withResolvers(), result=Promise.withResolvers();
  const display=await attachDisplayClient(f,{
    beforeReply:async sample=>{captured.resolve(sample.id); await resume.promise;},
    afterReply:status=>result.resolve(status)
  });
  try {
    f.advance(4100);
    const recovery=f.request('control/start',{});
    await captured.promise;
    f.closeDisplay();
    await f.startRelative();
    resume.resolve();
    assert.equal(await result.promise,409);
    assert.equal((await recovery).status,409);
    assert.equal((await (await f.request('status')).json()).controlling,false);
  } finally { resume.resolve(); await display.close(); }
});

test('interleaved heartbeats, queued input and stops from retired sessions never affect the new recipient', async t => {
  const f=await fixture(t), retired=[];
  let seed=0x517cca;
  function choose(size) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed%size;
  }
  for(let round=0;round<20;round++) {
    const {lease}=await (await f.request('control/start',{})).json();
    assert.ok(lease);
    if(retired.length) {
      const old=retired[choose(retired.length)];
      const routes=['input','heartbeat','control/stop'];
      const delayed=Array.from({length:6},(_,i)=>f.request(routes[choose(3)],{
        lease:old,seq:i+2,kind:'keyboard',modifiers:8,keys:[4]
      }));
      const status=await Promise.all(delayed);
      assert.ok(status.every(response=>response.status===409));
      assert.equal((await f.request('heartbeat',{lease})).status,200);
      assert.deepEqual(f.events,[]);
    }
    assert.equal((await f.request('input',{lease,seq:1,buttons:0,x:1,y:0,wheel:0})).status,200);
    retired.push(lease);
    f.closeDisplay();
    await f.startRelative();
  }
});

test('USB hotplug revokes relative control without a manual inventory refresh', async t => {
  const deviceId='0'.repeat(32), other='7'.repeat(32);
  let notify, scans=0, cancelled=false;
  const usb={
    devices:async()=>{scans++; return [{id:deviceId}];},
    watchTopology:cb=>{notify=cb; return ()=>{cancelled=true;};}
  };
  const f=await fixture(t,{usb});
  await f.startRelative();
  const {lease}=await (await f.request('control/start',{})).json();
  assert.ok(lease);
  const initialScans=scans;
  notify([deviceId,other]);
  assert.equal((await f.request('heartbeat',{lease})).status,409);
  assert.equal((await f.request('control/start',{})).status,409);
  notify([deviceId]);
  assert.equal((await f.request('control/start',{})).status,409);
  const status=await (await f.request('status')).json();
  assert.equal(status.needsPairing,true);
  assert.equal(status.canIdentifyRelative,true);
  assert.equal(scans,initialScans);
  f.closeDisplay();
  assert.equal(cancelled,true);
});

test('one USB device and one unrelated Bluetooth subscriber never gain input by counting alone',async t=>{
  const target='6'.repeat(32), other='d'.repeat(32);
  const usb={devices:async()=>[{id:target}],stream:async(res,changed,id)=>{changed({id,multiple:false});res.end();}};
  const f=await fixture(t,{usb});
  Object.assign(f.bridge,{peers:[{id:other,keyboard:true,absolute:true}],selectedPeer:other,
    async selectPeer(id){this.selectedPeer=id;return true;}});
  await f.request('usb/video',{deviceId:target});
  assert.equal((await f.request('control/start',{deviceId:target})).status,409);
  const status=await (await f.request('status')).json();
  assert.equal(status.needsPairing,true);
  assert.equal(status.canIdentifyRelative,false);
});

test('single relative-only receiver needs a visible movement and explicit per-connection confirmation',async t=>{
  const deviceId='6'.repeat(32), peerId='f'.repeat(32);
  let inventory=[{id:deviceId}], changed;
  const usb={devices:async()=>inventory,stream:async(res,event,id)=>{changed=event;event({id,multiple:false});res.end();}};
  const f=await fixture(t,{usb});
  Object.assign(f.bridge,{peers:[{id:peerId,keyboard:true,absolute:false}],selectedPeer:null,
    async selectPeer(id){this.selectedPeer=id;return true;}});
  const target={deviceId,peerId};
  await f.request('usb/video',{deviceId});
  const identify=()=>f.request('control/identify-relative',target);
  const confirm=confirmation=>f.request('control/confirm-relative',{...target,confirmation});
  assert.equal((await (await f.request('status')).json()).canIdentifyRelative,true);
  assert.equal((await confirm('unknown')).status,409);
  let result=await identify();
  assert.equal(result.status,200);
  assert.ok(f.events.some(ev=>Array.isArray(ev)&&ev[0]===0&&ev[1]!==0&&ev[3]===0));
  let ticket=(await result.json()).confirmation;
  assert.equal((await f.request('control/start',{deviceId})).status,409);
  inventory.push({id:'another'});
  assert.equal((await confirm(ticket)).status,409);
  inventory=[{id:deviceId}];
  ticket=(await (await identify()).json()).confirmation;
  f.advance(61000);
  assert.equal((await confirm(ticket)).status,409);
  ticket=(await (await identify()).json()).confirmation;
  assert.equal((await confirm(ticket)).status,200);
  await f.progress();
  const lease=(await (await f.request('control/start',{deviceId})).json()).lease;
  assert.ok(lease);
  changed(null);
  await f.request('usb/video',{deviceId});
  assert.equal((await f.request('heartbeat',{lease})).status,409);
  assert.equal((await f.request('control/start',{deviceId})).status,409);
  assert.equal((await confirm(ticket)).status,409);
});
