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
