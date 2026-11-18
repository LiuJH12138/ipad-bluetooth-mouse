'use strict';

function absoluteCoordinates(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw Error('无效的绝对指针坐标或画面尺寸。');
  }
  const axis = (pixel, size) => Math.round(32767 * Math.max(0, Math.min(size-1, pixel)) / (size-1));
  return {x:axis(point.x,width), y:axis(point.y,height)};
}

// Prefer flat patches in three separated regions. Text, icons and patterned
// wallpaper can mask the appearance of a small pointer after video compression.
function selectProbeTargets({width, height, data}) {
  function texture(cx, cy) {
    let score = 0;
    const radius = Math.min(10, Math.floor(Math.min(width,height)/18));
    for (let y=cy-radius; y<=cy+radius; y+=2) {
      for (let x=cx-radius; x<=cx+radius; x+=2) {
        const i=4*(y*width+x);
        for (let channel=0; channel<3; channel++) {
          const value=data[i+channel];
          score+=Math.abs(value-data[i+4+channel])+Math.abs(value-data[i+4*width+channel]);
        }
      }
    }
    return score;
  }
  return [[.24,.32],[.77,.42],[.46,.77]].map(([u,v]) => {
    let best, lowest=Infinity;
    for (const dy of [0,-.09,.09]) for (const dx of [0,-.10,.10]) {
      const point={x:Math.round((u+dx)*(width-1)),y:Math.round((v+dy)*(height-1))};
      const score=texture(point.x,point.y);
      if (score<lowest) { best=point; lowest=score; }
    }
    return best;
  });
}

async function verifyAbsolutePointer({width,height,sample,send,validate}) {
  const detect = typeof module === 'undefined' ? movedPointer : require('./pointing').movedPointer;
  const changes = typeof module === 'undefined' ? differenceRegions : require('./pointing').differenceRegions;
  const deadline = performance.now()+2800;
  function failure() { return Error('未能在三个位置确认绝对指针，请在静止画面重试。'); }
  async function bounded(operation) {
    validate();
    const remaining=deadline-performance.now();
    if (remaining<=0) throw failure();
    let timer;
    try {
      const result=await Promise.race([operation(),new Promise((_, reject) => {
        timer=setTimeout(() => reject(failure()),remaining);
      })]);
      validate();
      return result;
    } finally {clearTimeout(timer);}
  }
  async function read(after) {
    const frame=await bounded(() => sample(after));
    if (frame.width!==width || frame.height!==height || frame.data?.length!==width*height*4 ||
        !Number.isSafeInteger(frame.serial) || frame.serial<0 || frame.serial<after) {
      throw Error('验证期间 USB 画面发生变化，请重新验证。');
    }
    return frame;
  }
  async function place(target) {
    const {x,y}=absoluteCoordinates(target,width,height);
    await bounded(() => send(x,y));
  }
  // A modest local change is enough to start looking for the first departure.
  // The first point is only credited after its circular footprint disappears
  // at A and appears at B. A stationary pointer already at A is valid too.
  function changedAt(a,b,point) {
    let changed=0;
    for (let y=Math.max(0,point.y-6);y<=Math.min(height-1,point.y+6);y++) {
      for (let x=Math.max(0,point.x-6);x<=Math.min(width-1,point.x+6);x++) {
        const i=4*(y*width+x);
        if (Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),
            Math.abs(a.data[i+2]-b.data[i+2]))>8) changed++;
      }
    }
    return changed>=8;
  }
  function footprint(p) {
    const fill=p.area/(p.w*p.h), short=Math.min(p.w,p.h), long=Math.max(p.w,p.h);
    return !p.hover && short>=4 && long<=28 && long<=1.5*short && fill>=.38 && fill<=.94;
  }
  const error=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  // Absolute reports give us both expected locations. Ignore animations
  // elsewhere, but still require two distinct footprints and a settled frame.
  function localFootprint(before, after, point) {
    const radius=21;
    const left=Math.max(0,point.x-radius), top=Math.max(0,point.y-radius);
    const cols=Math.min(width,point.x+radius+1)-left;
    const rows=Math.min(height,point.y+radius+1)-top;
    const regions=changes(before,after.data,cols,rows,left,top,7,.36) || [];
    const matches=regions.filter(r=>footprint(r) && error(r,point)<=4);
    return matches.length===1 ? matches[0] : null;
  }
  let frame=await read();
  const initial=frame;
  const targets=selectProbeTargets(initial);
  await place(targets[0]);
  const seedDeadline=performance.now()+320;
  for (let i=0;i<24 && performance.now()<seedDeadline;i++) {
    frame=await read(frame.serial);
    if (frame.serial>initial.serial && changedAt(initial,frame,targets[0])) break;
  }
  let previous=null;
  const errors=[];
  for (let index=1;index<targets.length;index++) {
    const before=frame, source=targets[index-1], destination=targets[index];
    const direction={x:destination.x-source.x,y:destination.y-source.y};
    await place(destination);
    const until=performance.now()+580;
    function atDestination(observation) {
      const from=localFootprint(before,observation,source);
      const to=localFootprint(before,observation,destination);
      if (from && to && Math.abs(from.w-to.w)<=3 && Math.abs(from.h-to.h)<=3 &&
          Math.min(from.area,to.area)>=.6*Math.max(from.area,to.area)) return {from,to};
      const pair=detect(before.data,observation.data,width,height,direction,previous,
        {target:destination,predicted:destination});
      return pair && footprint(pair.from) && footprint(pair.to) &&
        error(pair.from,source)<=4 && error(pair.to,destination)<=4 ? pair : null;
    }
    let accepted;
    for (let i=0;i<36 && performance.now()<until;i++) {
      const serial=frame.serial;
      frame=await read(serial);
      if (frame.serial===serial) continue;
      const first=atDestination(frame);
      if (!first) continue;
      // A translating/settling cursor can pass through the target. Confirm
      // that the following video frame agrees, or that no newer frame arrived.
      const next=await read(frame.serial);
      const settled=next.serial===frame.serial ? first : atDestination(next);
      frame=next;
      if (!settled || error(first.to,settled.to)>2) continue;
      accepted=settled;
      break;
    }
    if (!accepted) throw failure();
    if (!previous) errors.push(error(accepted.from,source));
    previous=accepted.to;
    errors.push(error(previous,destination));
  }
  return {errors,maxError:Math.max(...errors)};
}

if (typeof module !== 'undefined') module.exports={absoluteCoordinates,verifyAbsolutePointer,selectProbeTargets};
