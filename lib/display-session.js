'use strict';
const {randomUUID} = require('node:crypto');
const {movedPointer,differenceRegions} = require('../web/pointing');

const unavailable = () => Object.assign(new Error('画面未确认，请检查设备并重试。'), {status:409});

class DisplaySession {
  constructor(id, now) {
    this.id = id;
    this.now = now;
    this.serial = 0;
    this.layout = 0;
    this.times = new Map();
    this.closed = false;
  }
  observe(layout, serial, age) {
    if (this.closed || !Number.isSafeInteger(layout) || layout < 1 || !Number.isSafeInteger(serial) ||
        serial < 1 || !Number.isFinite(age) || age < 0 || layout < this.layout ||
        (layout > this.layout && serial <= this.serial)) throw unavailable();
    if (serial <= this.serial) return;
    if (layout !== this.layout) this.times.clear();
    this.layout = layout;
    this.serial = serial;
    this.times.set(serial, this.now() - age);
    if (this.times.size > 64) this.times.delete(this.times.keys().next().value);
  }
  frameTime(layout, serial) {
    return this.layout === layout ? this.times.get(serial) : undefined;
  }
  get age() { return this.serial ? Math.max(0, this.now() - this.times.get(this.serial)) : Infinity; }
  get fresh() { return !this.closed && this.age <= 4000; }
  attach(res) {
    if (this.closed || this.channel) throw unavailable();
    this.channel = res;
    res.writeHead(200, {'Content-Type':'application/x-ndjson', 'Cache-Control':'no-store'});
    res.write('{}\n');
    res.once('close', () => {
      if (this.channel === res) { this.channel = null; this.pending?.finish(); }
    });
  }
  sample(after) {
    if (!this.channel || this.pending || this.closed) throw unavailable();
    const id = randomUUID(), layout = this.layout;
    return new Promise((resolve,reject) => {
      const finish = value => {
        if (this.pending?.id !== id) return;
        clearTimeout(timer);
        this.pending = null;
        if (value && !this.closed && layout === this.layout) resolve(value);
        else reject(unavailable());
      };
      const timer = setTimeout(finish, 700);
      this.pending = {id,layout,finish};
      this.channel.write(JSON.stringify({id,layout,after})+'\n');
    });
  }
  close() {
    this.closed = true;
    this.pending?.finish();
    this.channel?.end();
  }
}

// Reject scene changes outside the cursor footprints, including small controls
// changing inside a larger stationary page. Allow isolated compression noise.
function sameScene(a,b,...footprints) {
  const {width,height} = a;
  let previous = new Uint8Array(width);
  for (let y=0;y<height;y++) {
    const row = new Uint8Array(width);
    for (let x=0;x<width;x++) {
      const i=4*(width*y+x);
      if (Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),Math.abs(a.data[i+2]-b.data[i+2]))<18) continue;
      if (footprints.some(p=>Math.abs(x-p.x)<=p.w/2+2 && Math.abs(y-p.y)<=p.h/2+2)) continue;
      row[x]=1;
      if (x && previous[x-1] && previous[x] && row[x-1]) return false;
    }
    previous=row;
  }
  return true;
}

async function recoverPointer({sample,move,validate}) {
  const until=performance.now()+2000;
  let active=true, timer;
  function check() {
    if (!active || performance.now()>=until) throw unavailable();
    validate();
  }
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function circle(region,frame) {
    const breadth=Math.min(region.w,region.h), length=Math.max(region.w,region.h);
    const fill=region.area/(region.w*region.h);
    const cropped=region.x-region.w/2<=0 || region.x+region.w/2>=frame.width-1 ||
      region.y-region.h/2<=0 || region.y+region.h/2>=frame.height-1;
    return breadth>=4 && length<=28 && length<=breadth*(cropped ? 2.4 : 1.5) && fill>=.38 && fill<=.95;
  }
  async function read(base) {
    check();
    const frame=await sample(base?.serial);
    check();
    if (!frame || !Number.isSafeInteger(frame.serial) || frame.serial<1 ||
        ![frame.width,frame.height].every(n=>Number.isInteger(n) && n>=2 && n<=840) ||
        frame.data?.length!==frame.width*frame.height*4 || (base &&
        (base.width!==frame.width || base.height!==frame.height || frame.serial<base.serial))) throw unavailable();
    return frame;
  }
  async function step(base,dx,previous,first=false) {
    check();
    await move(dx);
    const settleBy=performance.now()+350;
    let latest=base;
    for (let i=0;i<16 && performance.now()<settleBy;i++) {
      const frame=await read(latest);
      latest=frame;
      if (frame.serial>base.serial) {
        const pair=movedPointer(base.data,frame.data,base.width,base.height,{x:dx,y:0},previous);
        if (pair && circle(pair.from,frame) && circle(pair.to,frame) && (!previous || distance(pair.from,previous)<=3)) {
          if (!sameScene(base,frame,pair.from,pair.to)) throw unavailable();
          return {frame,...pair};
        }
        if (first) {
          const changes=differenceRegions(base,frame.data,base.width,base.height,0,0,8,.05);
          if (changes?.length===1 && circle(changes[0],frame) && sameScene(base,frame,changes[0]))
            return {frame,to:changes[0]}; // Wake-up only; this provides no movement proof.
        }
      }
      // A transient page change invalidates the whole challenge, even if a
      // later sample happens to look like the previous page again.
      if (!sameScene(base,frame)) throw unavailable();
    }
    if (first) return {frame:latest}; // The initial move may be clamped at the right edge.
    throw unavailable();
  }
  async function run() {
    const baseline=await read();
    const first=await step(baseline,24,null,true);
    function confirmed(last) {
      // A changed control can be hidden beneath the cursor while it is away.
      // Compare the restored view directly with the original before allowing input.
      const original=first.from || last.to;
      if (!sameScene(baseline,last.frame,original,last.to)) throw unavailable();
      return last.frame.serial;
    }
    // If an invisible pointer first appears against the edge, its original
    // position could have been anywhere within the clipped +24 movement.
    if (!first.from && first.to && first.to.x+first.to.w/2+2>=first.frame.width-1) throw unavailable();
    const back=await step(first.frame,-24,first.to);
    if (first.from) {
      if (distance(back.to,first.from)<=3) return confirmed(back);
      // The first rightward move may have been shortened by the edge. Use
      // the observed inward gain, then verify the correction at the origin.
      if (first.to.x+first.to.w/2+2<first.frame.width-1) throw unavailable();
      const gain=(back.from.x-back.to.x)/24;
      const correction=Math.round((first.from.x-back.to.x)/gain);
      if (!(correction>0 && correction<24)) throw unavailable();
      const restored=await step(back.frame,correction,back.to);
      if (distance(restored.to,first.from)>3) throw unavailable();
      return confirmed(restored);
    }
    // A newly visible cursor, or one pinned to the right edge, still needs
    // a complete inward and outward trip around a known visible position.
    const returned=await step(back.frame,24,back.to);
    if (distance(returned.to,back.from)>3) throw unavailable();
    if (!first.to) return confirmed(returned);
    // A hidden cursor woke away from the edge after the initial +24. Undo
    // that nudge as well, verifying its destination against the first return.
    const restored=await step(returned.frame,-24,returned.to);
    if (distance(restored.to,back.to)>3) throw unavailable();
    return confirmed(restored);
  }
  const deadline=new Promise((_,reject)=>{ timer=setTimeout(()=>reject(unavailable()),2000); });
  try {
    const serial=await Promise.race([run(),deadline]);
    check();
    return serial;
  } finally {
    active=false;
    clearTimeout(timer);
  }
}
module.exports = {DisplaySession,recoverPointer};
