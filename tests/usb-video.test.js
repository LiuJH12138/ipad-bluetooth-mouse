'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UsbPackets, describeH264 } = require('../web/usb-video');

function packet(kind, payload) {
  const header = Buffer.alloc(24);
  header.write('MLB1');
  header.writeUInt32LE(payload.length, 4);
  header.writeUInt32LE(kind, 8);
  header.writeUInt32LE(1, 12);
  header.writeBigUInt64LE(987654n, 16);
  return Buffer.concat([header, Buffer.from(payload)]);
}

test('USB framing survives split headers, split payloads and concatenated packets', () => {
  const output = [];
  const parser = new UsbPackets((data, pts, turns) => output.push([[...data], pts, turns]));
  const stream = Buffer.concat([packet(1, [1, 2]), packet(2, [3]), packet(1, [4, 5, 6])]);
  for (const chunk of [stream.subarray(0, 9), stream.subarray(9, 25), stream.subarray(25)]) parser.push(chunk);
  assert.deepEqual(output, [[[1, 2], 987654, 1], [[4, 5, 6], 987654, 1]]);
});

test('USB parser rejects oversized access units before allocating their payload', () => {
  const bytes = packet(1, [1]);
  bytes.writeUInt32LE(0xffffffff, 4);
  assert.throws(() => new UsbPackets(() => {}).push(bytes));
});

test('Annex B SPS and IDR select the decoder configuration and restart point', () => {
  const idr = Uint8Array.from([0,0,0,1,0x67,0x64,0,0x32,0,0,1,0x68,0,0,1,0x65]);
  assert.deepEqual(describeH264(idr), { codec: 'avc1.640032', key: true });
  assert.equal(describeH264(Uint8Array.from([0,0,1,0x41])).key, false);
});

test('single USB selection exposes only a model-derived family and validates capture readiness', () => {
  const { captureTarget } = require('../lib/usb-video');
  const serial = '0123456789abcdef';
  const device = {serial, name:'Private phone label', driver:'ready'};
  for (const [model,family] of [['iPhone15,3','iPhone'],['iPad8,9','iPad'],[undefined,'Apple'],['iPhone fake','Apple']]) {
    assert.deepEqual(captureTarget([{...device,model}]),{serial,family});
  }
  assert.throws(()=>captureTarget([]));
  assert.throws(()=>captureTarget([device,device]));
  assert.throws(()=>captureTarget([{...device,driver:'missing'}]),/驱动/);
  assert.throws(()=>captureTarget([{...device,driver:'replug'}]),/数据线/);
  assert.throws(()=>captureTarget([{...device,serial:'private name'}]));
});

test('capture errors classify only known receiver messages and keep device details private', () => {
  const { captureFailure } = require('../lib/usb-video');
  for (const detail of ['USB handshake kick: QuickTime bulk write: libusb0 error -116',
    'opened screen capture but did not respond']) {
    const message = captureFailure('Private label and serial: ' + detail);
    assert.match(message,/已识别.*握手超时/);
    assert.doesNotMatch(message,/Private|serial|libusb/);
  }
  assert.doesNotMatch(captureFailure('Private label and serial'),/Private|serial|握手超时/);
  assert.match(captureFailure('claim QuickTime interface 2: libusb0_result=-5 win32_error=32 detail=private'),/占用/);
  assert.match(captureFailure('The iPhone rejected the screen-capture request. Unlock it and retry.'),/拒绝.*解锁/);
  assert.match(captureFailure('Screen capture started but the iPhone sent no video. Unlock it and retry.'),/采集已启动.*没有.*视频/);
  assert.match(captureFailure('USB configuration helper sent the QuickTime activation request but observed no exact interface transition'),/未进入投屏模式/);
  assert.match(captureFailure('USB configuration helper observed QuickTime activation removal but the exact interface did not return before timeout'),/重新识别.*超时/);
  assert.doesNotMatch(captureFailure('no USB media received for 15 seconds'),/已锁屏|已被占用/);
  assert.match(captureFailure('',true),/45 秒.*未收到视频/);
});

test('USB discovery cross-checks the receiver with all present mobile parents', async () => {
  const { selectDevice } = require('../lib/usb-video');
  const serial = '00008030-00abcd1234567890', parent = '0000803000ABCD1234567890';
  const second = '000081200011223344556677';
  const device = {serial,driver:'ready',model:'iPhone15,3'};
  async function select(devices, parents) {
    return selectDevice(async (_exe, args) => {
      if (args[0] === '--list') return {stdout:JSON.stringify(devices)};
      if (args[0] === '--driver') {
        assert.equal(args[1],parent);
        return {stdout:'{"present":true,"driver":"ready"}'};
      }
      assert.ok(args.includes('-Command'));
      if (parents instanceof Error) throw parents;
      return {stdout:parents.join('\n')};
    });
  }
  assert.deepEqual(await select([device],[parent]),{serial,family:'iPhone'});
  assert.deepEqual(await select([],[parent]),{serial:parent,family:'Apple'});
  await assert.rejects(select([device],[parent,second]),/选择|核对/);
  await assert.rejects(select([device],[second]),/选择|核对/);
  await assert.rejects(select([device],['unrecognized']),/USB/);
  await assert.rejects(select([device],[]),/Windows/);
  await assert.rejects(select([device],new Error('private name')),/核对/);
});

test('one decoder configuration applies each access unit orientation including half turns', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname,'../web/usb-video.js'),'utf8');
  const ready = new AbortController(), frames = [], rotations = [];
  const canvas = {getContext:()=>({setTransform(){}, drawImage(){}, rotate:r=>rotations.push(r)})};
  let configureCount = 0;
  class Decoder {
    constructor({output}) { this.output=output; }
    reset() {} close() {}
    configure() { configureCount++; }
    decode(chunk) { this.output({timestamp:chunk.timestamp, displayWidth:400, displayHeight:840, close(){}}); }
  }
  const key = [0,0,1,0x67,0x64,0,0x32,0,0,1,0x65], delta = [0,0,1,0x41];
  const bytes = Buffer.concat([0,2,1].map((turns,i)=>{
    const unit = packet(1,i===0 ? key : delta);
    unit.writeUInt32LE(turns,12);
    return unit;
  }));
  const play = vm.runInNewContext(source+'\nplayUsbVideo', {
    VideoDecoder:Decoder, EncodedVideoChunk:class {constructor(init) { Object.assign(this,init); }},
    performance,AbortController,setTimeout,clearTimeout, fetch:async()=>new Response(bytes),
  });
  await play({canvas, signal:ready.signal, onFrame:(_ms,turns)=>{
    frames.push([canvas.width,canvas.height,turns]);
    if (frames.length===3) ready.abort();
  }});
  assert.equal(configureCount,1);
  assert.deepEqual(frames,[[400,840,0],[400,840,2],[840,400,1]]);
  assert.deepEqual(rotations,[0,Math.PI,Math.PI/2]);
});

test('a connected USB stream without a decoded first frame reports which stage timed out',async()=>{
  const vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../web/usb-video.js'),'utf8');
  const cases=[
    [Buffer.from('MLB1'),/完整.*视频/],
    [packet(1,[0,0,1,0x41]),/关键帧/],
    [packet(1,[0,0,1,0x67,0x64,0,0x32,0,0,1,0x65]),/解码/]
  ];
  for(const [chunk,expected] of cases) {
    const ready=new AbortController();
    let stop;
    const play=vm.runInNewContext(source+'\nplayUsbVideo',{
      VideoDecoder:class {reset(){} configure(){} decode(){} close(){}},
      EncodedVideoChunk:class {}, performance, AbortController, clearTimeout,
      setTimeout:callback=>setTimeout(callback,10),
      fetch:async(_url,{signal})=>new Response(new ReadableStream({
        start(controller) {controller.enqueue(chunk); stop=()=>controller.close(); signal.addEventListener('abort',stop,{once:true});}
      }))
    });
    const safety=setTimeout(()=>ready.abort(),120);
    try {
      await assert.rejects(play({canvas:{getContext:()=>({})},signal:ready.signal,onFrame:()=>assert.fail('unexpected frame')}),expected);
    } finally {clearTimeout(safety);}
  }
});

test('only a native activation refusal without an interface transition exposes the retry code', async () => {
  const {UsbVideo}=require('../lib/usb-video');
  const {PassThrough}=require('node:stream');
  const {EventEmitter}=require('node:events');
  const serial='0000803000abcd1234567890';
  const reason='USB configuration helper sent the QuickTime activation request but observed no exact interface transition';
  for(const [native,shouldRetry] of [[reason,true],['USB configuration helper observed QuickTime activation removal but the exact interface did not return before timeout',false]]) {
    const usb=new UsbVideo({run:async (_exe,args)=>({stdout:args[0]==='--list' ? JSON.stringify([{serial,driver:'ready'}]) : serial}),
      spawnProcess:()=>{
        const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stderr:new PassThrough()});
        setImmediate(()=>{
          child.stderr.write(native.slice(0,48));
          child.stderr.write(native.slice(48));
          if(shouldRetry) child.stderr.write('\n'+'ignored cleanup log '.repeat(120));
          child.emit('close',1);
        });
        return child;
      }});
    await assert.rejects(usb.stream(new PassThrough()),error=>{
      if(shouldRetry) {
        assert.equal(error.status,503); assert.equal(error.code,'USB_MODE_UNCHANGED');
        assert.match(error.message,/未进入投屏模式/);
      } else assert.equal(error.code,undefined);
      return true;
    });
    assert.equal(usb.busy,false);
  }
});

test('USB playback retries the same selected device once, only before media, and can be cancelled',async()=>{
  const vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../web/usb-video.js'),'utf8');
  const id='b'.repeat(32);
  const refused=()=>Response.json({error:'所选设备未进入投屏模式。',code:'USB_MODE_UNCHANGED'},{status:503});
  const occupied=()=>Response.json({error:'USB 采集接口被占用。'},{status:409});
  const media=()=>new Response(packet(1,[0,0,1,0x67,0x64,0,0x32,0,0,1,0x65]),{
    headers:{'X-Apple-Device-Id':id,'X-USB-Session':'session-2','X-Apple-Device-Family':'iPad'}});
  class Decoder {
    constructor({output}) {this.output=output;}
    reset(){} configure(){} close(){}
    decode(chunk){this.output({timestamp:chunk.timestamp,displayWidth:100,displayHeight:50,close(){}});}
  }
  async function scenario(sequence,{deviceId=id,cancelAtRetry=false,finishAfterFrame=false}={}) {
    const requests=[], notices=[], frames=[];
    const abort=new AbortController();
    const play=vm.runInNewContext(source+'\nplayUsbVideo',{
      VideoDecoder:Decoder, EncodedVideoChunk:class{constructor(init){Object.assign(this,init);}},
      performance,AbortController,clearTimeout,setTimeout:(callback,ms)=>setTimeout(callback,ms>10000?ms:1),
      fetch:async(_url,opts)=>{requests.push(opts.body&&JSON.parse(opts.body).deviceId);return sequence[requests.length-1]();}
    });
    const canvas={getContext:()=>({setTransform(){},rotate(){},drawImage(){}})};
    let error;
    try {
      await play({token:'test',deviceId,canvas,signal:abort.signal,onRetry:message=>{
        notices.push(message);
        if(cancelAtRetry) abort.abort();
      },onFrame:(_ms,_turns,_family,session)=>{
        frames.push(session); if(finishAfterFrame) abort.abort();
      }});
    } catch(e) {error=e;}
    return {requests,notices,frames,error};
  }
  const success=await scenario([refused,media],{finishAfterFrame:true});
  assert.deepEqual(success.requests,[id,id]); assert.equal(success.notices.length,1);
  assert.deepEqual(success.frames,['session-2']); assert.equal(success.error,undefined);
  const repeated=await scenario([refused,refused]);
  assert.deepEqual(repeated.requests,[id,id]); assert.equal(repeated.error.code,'USB_MODE_UNCHANGED');
  assert.match(repeated.error.message,/未进入投屏模式/);
  const busy=await scenario([occupied]);
  assert.deepEqual(busy.requests,[id]); assert.deepEqual(busy.notices,[]);
  const ambiguous=await scenario([refused],{deviceId:null}); assert.deepEqual(ambiguous.requests,[undefined]);
  const cancelled=await scenario([refused],{cancelAtRetry:true}); assert.deepEqual(cancelled.requests,[id]);
  const disconnected=await scenario([media]); assert.deepEqual(disconnected.requests,[id]);
  assert.deepEqual(disconnected.frames,['session-2']); assert.deepEqual(disconnected.notices,[]);
  assert.match(disconnected.error.message,/断开/);
});

test('USB picker targets an exact live device, validates Windows presence and hides serials', async () => {
  const { UsbVideo } = require('../lib/usb-video');
  const phone = {serial:'00008030-00ABCD1234567890', driver:'ready', model:'iPhone15,3', name:'Private phone'};
  const pad = {serial:'00008120-0011223344556677', driver:'ready', model:'iPad8,11'};
  let devices = [phone,pad];
  const run = async (_exe,args) => args[0] === '--list' ? {stdout:JSON.stringify(devices)}
    : {stdout:devices.map(d=>d.serial.replace('-','').toLowerCase()).join('\n')};
  const usb = new UsbVideo({run});
  const list = await usb.devices();
  assert.equal(list.length,2);
  const target = list.find(d=>d.model===phone.model);
  assert.match(target.id,/^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(list),/00008030|00008120/);
  assert.equal(target.name, 'Private phone');
  assert.equal((await usb.target(target.id)).serial,phone.serial);
  await assert.rejects(usb.target(),/选择/);
  devices = [pad];
  await assert.rejects(usb.target(target.id),/设备/);
  assert.equal((await usb.target()).serial,pad.serial);
});

test('device names survive capture re-enumeration and are cleaned for display', async () => {
  const {UsbVideo} = require('../lib/usb-video');
  const serial = '0000803000abcd1234567890';
  let list = [{serial, driver:'ready', name:'  书房\n的\u202eiPad  ', model:'iPad8,11'}];
  const usb = new UsbVideo({run:async (_exe, args) => {
    if (args[0] === '--list') return {stdout:JSON.stringify(list)};
    if (args[0] === '--driver') return {stdout:'{"present":true,"driver":"ready"}'};
    return {stdout:serial};
  }});
  const [device] = await usb.devices();
  assert.equal(device.name, '书房 的iPad');
  list = [];
  assert.deepEqual(await usb.devices(), [device]);
});

test('USB topology watcher deduplicates snapshots, fails closed and cancels', async () => {
  const {UsbVideo} = require('../lib/usb-video');
  const {EventEmitter} = require('node:events');
  const {PassThrough} = require('node:stream');
  const serials = ['0000803000abcd1234567890','000081200011223344556677'];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  const usb = new UsbVideo({spawnProcess:()=>child, run:async (_exe,args) =>
    ({stdout:args[0] === '--list' ? JSON.stringify(serials.map(serial=>({serial,driver:'ready'}))) : serials.join('\n')})});
  const ids = (await usb.devices()).map(d=>d.id).sort();
  const seen = [];
  const cancel = usb.watchTopology(value => seen.push(value));
  for (const snapshot of [serials, [...serials].reverse(), [], 'bad', 'bad', [serials[0]]]) {
    child.stdout.write(JSON.stringify(snapshot) + '\n');
  }
  cancel();
  child.stdout.write('[]\n');
  child.emit('close', 0);
  assert.deepEqual(seen, [ids, [], null, [(await usb.devices())[0].id]]);
  assert.equal(killed, true);
});

test('each capture gets a distinct session and a stuck helper releases the capture slot after termination', async () => {
  const {UsbVideo} = require('../lib/usb-video');
  const {EventEmitter, once} = require('node:events');
  const {PassThrough} = require('node:stream');
  const net = require('node:net');
  const serial = '0000803000abcd1234567890';
  let forced = 0, stopped = 0;
  const usb = new UsbVideo({stopGraceMs:10, killWaitMs:15, run:async (_exe,args) =>
    ({stdout:args[0] === '--list' ? JSON.stringify([{serial,driver:'ready'}]) : serial}),
    spawnProcess:(_exe,_args,options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin.on('data', data=>{ if (String(data) === 'stop\n') stopped++; });
      const socket = net.connect(Number(options.env.MIRRORLAB_MEDIA_PORT), '127.0.0.1', () => socket.write('frame'));
      child.kill = () => { forced++; socket.destroy(); child.emit('close',1); return true; };
      return child;
    }});
  const sessions = new Set();
  for (let i = 0; i < 2; i++) {
    const res = new PassThrough(), headers = new Map(), changes = [];
    res.setHeader = (key, value) => headers.set(key,value);
    const firstData = once(res,'data');
    const stream = usb.stream(res,(source,lost) => changes.push([source,lost]));
    await firstData;
    const session = headers.get('X-USB-Session');
    assert.match(session,/^[a-f0-9-]{36}$/);
    assert.equal(changes[0][0].sessionId,session);
    await assert.rejects(usb.stopCapture('a-different-session'),{status:409});
    assert.equal(usb.busy,true);
    sessions.add(session);
    usb.stopCapture();
    await stream;
    assert.equal(usb.busy,false);
    assert.deepEqual(changes[1],[null,null]);
  }
  assert.equal(sessions.size,2);
  assert.equal(forced,2);
  assert.equal(stopped,2);
});

test('failed termination rejects further captures and setup until Windows confirms exit', async () => {
  const {UsbVideo} = require('../lib/usb-video');
  const {PassThrough} = require('node:stream');
  const {EventEmitter} = require('node:events');
  const usb = new UsbVideo({stopGraceMs:5, killWaitMs:5});
  const child = Object.assign(new EventEmitter(), {
    pid:1, stdin:new PassThrough(), stderr:new PassThrough(), kill:()=>false
  });
  const capture = usb.superviseCapture(child);
  capture.stop();
  await assert.rejects(capture.done,/停止超时/);
  await assert.rejects(usb.stream(new PassThrough()),{status:503});
  await assert.rejects(usb.setupDevice('0'.repeat(32)),{status:503});
  await assert.rejects(usb.stopCapture('no-active-session'),{status:503});
  child.emit('exit', 1);
  assert.doesNotThrow(()=>usb.checkReceiverReleased());
});

test('an explicit stop adopts a closing stream and waits for native USB restoration', async () => {
  const {UsbVideo} = require('../lib/usb-video');
  const {EventEmitter,once} = require('node:events');
  const {PassThrough} = require('node:stream');
  const net = require('node:net');
  const serial='0000803000abcd1234567890', stopping=Promise.withResolvers();
  let kills=0, commands=0, session;
  const usb=new UsbVideo({stopGraceMs:10,restoreGraceMs:200,killWaitMs:5,
    run:async (_exe,args)=>({stdout:args[0]==='--list' ? JSON.stringify([{serial,driver:'ready'}]) : serial}),
    spawnProcess:(_exe,_args,opts)=>{
      const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stderr:new PassThrough()});
      const socket=net.connect(Number(opts.env.MIRRORLAB_MEDIA_PORT),'127.0.0.1',()=>socket.write('frame'));
      child.stdin.on('data',()=>{
        commands++; stopping.resolve();
        setTimeout(()=>{socket.destroy();child.emit('close',0);},35);
      });
      child.kill=()=>{kills++; child.emit('close',1); return true;};
      return child;
    }});
  const res=new PassThrough(); res.setHeader=()=>{};
  const ready=once(res,'data');
  const stream=usb.stream(res,source=>{if(source) session=source.sessionId;});
  await ready;
  res.destroy();
  await stopping.promise;
  await usb.stopCapture(session);
  await stream;
  assert.equal(commands,1);
  assert.equal(kills,0);
  assert.equal(usb.busy,false);
  await usb.stopCapture(session); // Repeated cleanup preserves the original disconnect reason.
});

test('host shutdown shortens an ongoing normal restore deadline without issuing stop twice', async () => {
  const {UsbVideo} = require('../lib/usb-video');
  const {PassThrough} = require('node:stream');
  const {EventEmitter} = require('node:events');
  const usb=new UsbVideo({stopGraceMs:5,restoreGraceMs:1000,killWaitMs:5});
  let kills=0,commands=0;
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stderr:new PassThrough(),
    kill(){kills++;child.emit('close',1);return true;}});
  child.stdin.on('data',()=>commands++);
  const managed=usb.superviseCapture(child);
  usb.activeCapture={sessionId:'one',stop:ms=>{managed.stop(ms);return managed.done;}};
  const normal=usb.stopCapture('one');
  const host=usb.stopCapture();
  let timer;
  try {
    assert.equal(await Promise.race([Promise.all([normal,host]).then(()=>true),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),250);})]),true);
  } finally {clearTimeout(timer);}
  assert.equal(kills,1);
  assert.equal(commands,1);
});

test('a normally exiting receiver can leave an inherited pipe without blocking a switch', async () => {
  const {UsbVideo} = require('../lib/usb-video');
  const {PassThrough} = require('node:stream');
  const {EventEmitter} = require('node:events');
  const usb = new UsbVideo({stopGraceMs:30, killWaitMs:5});
  const child = Object.assign(new EventEmitter(), {
    stdin:new PassThrough(), stderr:new PassThrough(), kill:()=>assert.fail('graceful exit should not be forced')
  });
  const capture = usb.superviseCapture(child);
  capture.stop();
  child.emit('exit',0);
  await capture.done;
  assert.equal(child.stderr.destroyed,true);
  assert.doesNotThrow(()=>usb.checkReceiverReleased());
});

test('driver setup resolves only the chosen physical device and rechecks its parent before elevation',async()=>{
  const {UsbVideo}=require('../lib/usb-video');
  const serials=['000080112233445566778899','000081002233445566778899'];
  let parentService='usbccgp', state='missing', active=serials, finish;
  const entered=[];
  const usb=new UsbVideo({run:async(_exe,args)=>{
    if(args[0]==='--list') return {stdout:JSON.stringify(active.map(serial=>({serial,driver:state})))};
    if(args[0]==='--driver') return {stdout:JSON.stringify({present:active.includes(args[1]),driver:state,parentService,
      instanceId:['USB','VID_05AC&PID_12A8',args[1]].join(String.fromCharCode(92))})};
    return {stdout:active.join('\n')};
  },installFilter:async serial=>{entered.push(serial);return new Promise(resolve=>{finish=resolve;});}});
  const [a,b]=await usb.devices();
  for(const value of [undefined,'','../driver.ps1','0'.repeat(32)]) await assert.rejects(usb.setupDevice(value));
  parentService='WinUSB';
  await assert.rejects(usb.setupDevice(a.id),/Apple|主驱动/);
  parentService='usbccgp'; state='ready';
  assert.deepEqual(await usb.setupDevice(a.id),{status:'ready'});
  state='replug';
  assert.deepEqual(await usb.setupDevice(a.id),{status:'replug'});
  assert.deepEqual(entered,[]);
  state='missing';
  const first=usb.setupDevice(b.id), repeated=usb.setupDevice(b.id);
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(entered,[serials[1]]);
  await assert.rejects(usb.setupDevice(a.id),{status:409});
  finish('cancelled');
  assert.deepEqual(await Promise.all([first,repeated]),[{status:'cancelled'},{status:'cancelled'}]);
  const retry=usb.setupDevice(b.id);
  await new Promise(r=>setImmediate(r));
  active=[serials[0]]; finish('installed');
  assert.deepEqual(await retry,{status:'replug'});
  assert.deepEqual(entered,[serials[1],serials[1]]);
});

test('driver setup rejects an instance mismatch or an active video stream before elevation',async()=>{
  const {UsbVideo}=require('../lib/usb-video');
  const serial='000080112233445566778899';
  let installs=0;
  const usb=new UsbVideo({run:async(_exe,args)=>{
    if(args[0]==='--list') return {stdout:JSON.stringify([{serial,driver:'missing'}])};
    if(args[0]==='--driver') return {stdout:JSON.stringify({present:true,driver:'missing',parentService:'usbccgp',
      instanceId:['USB','VID_05AC&PID_12A8','000080999999999999999999'].join(String.fromCharCode(92))})};
    return {stdout:serial};
  },installFilter:async()=>{installs++;}});
  const [device]=await usb.devices();
  await assert.rejects(usb.setupDevice(device.id),{status:409});
  usb.busy=true;
  await assert.rejects(usb.setupDevice(device.id),/停止投屏/);
  assert.equal(installs,0);
});

test('incomplete driver payload and invalid serial never request UAC',async()=>{
  const {installFilter}=require('../lib/usb-setup');
  const path=require('node:path');
  const dir=path.join(__dirname,'unavailable-driver-fixture');
  let calls=0;
  const run=async()=>{calls++;};
  await assert.rejects(installFilter('bad;command',dir,run),/标识/);
  await assert.rejects(installFilter('0000000000000000',dir,run),{status:503});
  assert.equal(calls,0);
});
