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
    performance,AbortController, fetch:async()=>new Response(bytes),
  });
  await play({canvas, signal:ready.signal, onFrame:(_ms,turns)=>{
    frames.push([canvas.width,canvas.height,turns]);
    if (frames.length===3) ready.abort();
  }});
  assert.equal(configureCount,1);
  assert.deepEqual(frames,[[400,840,0],[400,840,2],[840,400,1]]);
  assert.deepEqual(rotations,[0,Math.PI,Math.PI/2]);
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
  assert.doesNotMatch(JSON.stringify(list),/00008030|00008120|Private/);
  assert.equal((await usb.target(target.id)).serial,phone.serial);
  await assert.rejects(usb.target(),/选择/);
  devices = [pad];
  await assert.rejects(usb.target(target.id),/设备/);
  assert.equal((await usb.target()).serial,pad.serial);
});
