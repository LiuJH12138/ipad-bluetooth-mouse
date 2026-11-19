'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {DisplaySession, recoverPointer} = require('../lib/display-session');

test('repeated decoded serials, heartbeats and delayed photos cannot refresh a frozen display', () => {
  let clock = 10;
  const display = new DisplaySession('stream-a', () => clock);
  display.observe(1, 10, 0);
  clock += 5000;
  display.observe(1, 10, 0);
  assert.equal(display.fresh, false);
  assert.equal(display.frameTime(1, 10), 10);
  display.observe(1, 11, 4500);
  assert.equal(display.fresh, false);
  display.observe(2, 12, 0);
  assert.equal(display.fresh, true);
  assert.throws(() => display.observe(1, 99, 0));
  assert.equal(display.frameTime(1, 10), undefined);
});

function pixels(x, serial) {
  const width=160, height=100, data=Buffer.alloc(width*height*4);
  for (let j=-4;j<=4;j++) for (let i=-4;i<=4;i++) {
    if (i*i+j*j<=16 && x+i>=0 && x+i<width) data[4*((50+j)*width+x+i)]=200;
  }
  return {width,height,data,serial};
}
test('recovery observes a round trip before admitting the original action', async () => {
  let x=40, serial=1;
  const moves=[];
  await recoverPointer({sample:async()=>pixels(x,serial), move:async dx=>{moves.push(dx);x+=dx;serial++;}, validate(){}});
  assert.deepEqual(moves,[24,-24]);
});
test('a changed page during recovery never authorizes the queued click', async () => {
  let x=40, serial=1;
  await assert.rejects(recoverPointer({sample:async()=>{
    const p=pixels(x,serial);
    if(serial>1) p.data.fill(255,0,160*4*30);
    return p;
  }, move:async dx=>{x+=dx;serial++;},validate(){}}));
});

function pointerDevice(startX, hidden=false, border=4) {
  let x=startX, serial=1;
  const moves=[];
  return {
    moves, get x() { return x; },
    sample:async()=>{
      const frame=pixels(x,serial);
      if(hidden) frame.data.fill(0);
      return frame;
    },
    move:async dx=>{
      moves.push(dx);
      const next=Math.max(border,Math.min(159-border,x+dx));
      if(next!==x || hidden) serial++;
      hidden=false; x=next;
    },
    validate(){}
  };
}

test('a hidden cursor must visibly move out and back before its original location is restored', async () => {
  const device=pointerDevice(60,true);
  await recoverPointer(device);
  assert.equal(device.x,60);
  assert.ok(device.moves.length>=3);
});

test('a right edge clamp permits an inward round trip and restores the visible starting position', async () => {
  for(const x of [155,145]) {
    const device=pointerDevice(x);
    await recoverPointer(device);
    assert.ok(Math.abs(device.x-x)<=2);
    assert.ok(device.moves.includes(24) && device.moves.includes(-24));
  }
});

test('a cursor cropped to a half-circle at the display boundary still has a verifiable return', async () => {
  for (const x of [0,159]) {
    const device=pointerDevice(x,false,0);
    await recoverPointer(device);
    assert.equal(device.x,x);
  }
});

test('a previously hidden cursor waking at the right edge has an ambiguous origin', async () => {
  const device=pointerDevice(145,true);
  await assert.rejects(recoverPointer(device),{status:409});
});

test('even a transient scene change before the cursor arrives rejects the original action', async () => {
  const device=pointerDevice(60);
  const sample=device.sample;
  let first=true;
  device.sample=async()=>{
    const frame=await sample();
    if(device.moves.length===1 && first) {
      first=false; frame.data.fill(160,0,160*4*20);
    }
    return frame;
  };
  await assert.rejects(recoverPointer(device),{status:409});
  assert.deepEqual(device.moves,[24]);
});

test('a UI change revealed under the departing cursor is caught by the final baseline comparison', async () => {
  const device=pointerDevice(40);
  const sample=device.sample;
  device.sample=async()=>{
    const frame=await sample();
    if (device.moves.length) {
      for(let yy=53;yy<=54;yy++) for(let xx=67;xx<=68;xx++) frame.data[4*(yy*160+xx)]=180;
    }
    return frame;
  };
  await assert.rejects(recoverPointer(device),{status:409});
});

test('the two-second deadline includes unresponsive frame reads and HID writes', async () => {
  const devices=[pointerDevice(60),pointerDevice(60)];
  const gate=Promise.withResolvers();
  const move=devices[1].move;
  devices[0].sample=()=>gate.promise.then(()=>pixels(60,1));
  devices[1].move=async dx=>{ await move(dx); await gate.promise; };
  const runs=devices.map(device=>assert.rejects(recoverPointer(device),{status:409}));
  let timer;
  try {
    const observed=await Promise.race([Promise.all(runs).then(()=>true),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),2350);})]);
    assert.equal(observed,true,'recovery must settle while both transports are still blocked');
  } finally { clearTimeout(timer); gate.resolve(); await Promise.allSettled(runs); }
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(devices.map(device=>device.moves),[[],[24]]);
});
