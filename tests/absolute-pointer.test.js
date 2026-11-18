'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {absoluteCoordinates, verifyAbsolutePointer} = require('../web/absolute-pointer');

test('absolute coordinates preserve fractional pixels and clamp at both edges', () => {
  assert.deepEqual(absoluteCoordinates({x:-5,y:640},840,630), {x:0,y:32767});
  assert.deepEqual(absoluteCoordinates({x:839,y:0},840,630), {x:32767,y:0});
  assert.deepEqual(absoluteCoordinates({x:419.5,y:314.5},840,630), {x:16384,y:16384});
  assert.deepEqual(absoluteCoordinates({x:0.5,y:1.5},257,257), {x:64,y:192});
  assert.throws(() => absoluteCoordinates({x:NaN,y:0},840,630));
  assert.throws(() => absoluteCoordinates({x:0,y:0},0,630));
});

function simulated({map = p => p, ignore = false, animation = false, staleOnly = false,
    startAtFirst = false, overshootLast = false, secondCursor = false} = {}) {
  const width=240, height=180, commands=[];
  let pending, lag=0, serial=0, reads=0, overshoot=false;
  let cursor=startAtFirst ? {x:Math.round(.24*(width-1)),y:Math.round(.32*(height-1))} : {x:20,y:16};
  function sample() {
    reads++;
    if (overshoot) {cursor={x:cursor.x+20,y:cursor.y};overshoot=false;}
    if (pending && lag--<=0) {
      cursor=pending;pending=null;
      overshoot=overshootLast && commands.length===3;
    }
    const data=new Uint8ClampedArray(width*height*4);
    const circles=[cursor];
    if (secondCursor) circles.push({x:cursor.x+27,y:cursor.y+15});
    if (animation) circles.push({x:84+reads%12,y:103});
    for (const point of circles) {
      for (let y=point.y-4;y<=point.y+4;y++) for (let x=point.x-4;x<=point.x+4;x++) {
        if (Math.hypot(x-point.x,y-point.y)<=4) data[(y*width+x)*4]=124;
      }
    }
    return {width,height,data,serial:staleOnly ? 0 : ++serial};
  }
  function send(...args) {
    assert.equal(args.length,2);
    assert.ok(args.every(Number.isInteger));
    commands.push(args);
    if (!ignore) pending=map({x:Math.round(args[0]*(width-1)/32767),y:Math.round(args[1]*(height-1)/32767)});
    lag=2;
  }
  return {width,height,sample,send,validate() {},commands};
}

test('three real closed-loop absolute positions pass after old and noisy frames',async()=>{
  const device=simulated({animation:true,map:p=>({x:p.x+1,y:p.y-1})});
  const result=await verifyAbsolutePointer(device);
  assert.equal(device.commands.length,3);
  assert.equal(result.errors.length,3);
  assert.ok(Math.abs(result.maxError-Math.SQRT2)<0.1);
});

test('starting at the first requested position is confirmed by the first departure',async()=>{
  assert.equal((await verifyAbsolutePointer(simulated({startAtFirst:true}))).maxError,0);
});

for (const [name,options] of Object.entries({
  'subscriber ignoring reports':{ignore:true},
  'single unrelated animation':{ignore:true,animation:true},
  'pixels presented with stale frame serials':{staleOnly:true},
  'transiently crossing the final target before drifting away':{overshootLast:true},
  'rotated mapping':{map:p=>({x:239-p.x,y:179-p.y})},
  'incorrect scaling':{map:p=>({x:Math.round(.8*p.x),y:Math.round(.8*p.y)})}
})) {
  test(name+' cannot enable absolute control',async()=>{await assert.rejects(verifyAbsolutePointer(simulated(options)));});
}

test('orientation or control ownership changes interrupt the probe',async()=>{
  const resized=simulated(), read=resized.sample;
  resized.sample=()=>({...read(),height:179});
  await assert.rejects(verifyAbsolutePointer(resized));
  assert.equal(resized.commands.length,0);
  const lost=simulated();
  lost.validate=()=>{if(lost.commands.length===1) throw Error('lost lease');};
  await assert.rejects(verifyAbsolutePointer(lost),/lost lease/);
  assert.equal(lost.commands.length,1);
});

test('automatic probe selects a quieter patch when the usual point is textured', () => {
  const width=240, height=180;
  const data=new Uint8ClampedArray(width*height*4);
  for (let y=48;y<=68;y++) for (let x=46;x<=68;x++) {
    data[(y*width+x)*4]=(x+y)%2 ? 225 : 30;
  }
  const {selectProbeTargets}=require('../web/absolute-pointer');
  const points=selectProbeTargets({width,height,data});
  assert.equal(points.length,3);
  assert.ok(Math.hypot(points[0].x-57,points[0].y-57)>12);
  assert.ok(points[1].x>width*.6 && points[2].y>height*.6);
});

test('a second synchronized animation outside the target patches cannot mask real arrivals', async () => {
  const device=simulated({secondCursor:true});
  assert.equal((await verifyAbsolutePointer(device)).maxError,0);
});
