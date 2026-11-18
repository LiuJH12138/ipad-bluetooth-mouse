'use strict';

// Map a CSS click through object-fit: contain into the orientation already drawn by the USB decoder.
function picturePoint(rect, width, height, clientX, clientY) {
  const scale = Math.min(rect.width / width, rect.height / height);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const x = (clientX - rect.left - (rect.width - width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - height * scale) / 2) / scale;
  return x >= 0 && y >= 0 && x < width && y < height ? {x,y} : null;
}

// A move on a stationary screen leaves two compact differences: the pointer disappears
// at its old position and appears at its new position. Reject ambiguous or moving scenes.
let diffMask=new Uint8Array(0), regionQueue=new Int32Array(0);
function differenceRegions(a,b,width,height,left,top,threshold,maxRatio) {
  const count=width*height;
  if (diffMask.length<count) {
    diffMask=new Uint8Array(count);
    regionQueue=new Int32Array(count);
  }
  const mask=diffMask, work=regionQueue;
  let changed=0;
  const stride=a.width;
  for (let y=0,p=0;y<height;y++) {
    for (let x=0,i=((top+y)*stride+left)*4;x<width;x++,i+=4,p++) {
      mask[p]=Math.max(Math.abs(a.data[i]-b[i]),Math.abs(a.data[i+1]-b[i+1]),Math.abs(a.data[i+2]-b[i+2]))>threshold ? 1 : 0;
      changed+=mask[p];
    }
  }
  if (changed>count*maxRatio) return null;
  const regions=[];
  if (!changed) return regions;
  for (let p=0;p<count;p++) {
    if (!mask[p]) continue;
    let minX=width,maxX=0,minY=height,maxY=0;
    let head=0,tail=1;
    work[0]=p; mask[p]=0;
    while (head<tail) {
      const at=work[head++],x=at%width,y=Math.floor(at/width);
      minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      for (let yy=Math.max(0,y-1);yy<=Math.min(height-1,y+1);yy++) {
        for (let xx=Math.max(0,x-1);xx<=Math.min(width-1,x+1);xx++) {
          const n=yy*width+xx;
          if (mask[n]) { mask[n]=0; work[tail++]=n; }
        }
      }
    }
    const w=maxX-minX+1,h=maxY-minY+1;
    if (tail>=8 && w>=2 && h>=2 && tail>=w*h*.25)
      regions.push({x:left+(minX+maxX)/2,y:top+(minY+maxY)/2,w,h,area:tail});
  }
  return regions;
}

function insideHighlight(point,region) {
  return Math.abs(point.x-region.x)<=region.w/2-2 && Math.abs(point.y-region.y)<=region.h/2-2;
}

function snappedButton(a,b,width,height,previous,direction,landing,regions) {
  if (!landing || !previous || previous.hover) return null;
  const {target,predicted}=landing;
  if (Math.hypot(target.x-predicted.x,target.y-predicted.y)>14) return null;
  // Require the entire old round pointer to disappear at the known position.
  const old=regions.filter(r=>Math.hypot(r.x-previous.x,r.y-previous.y)<=2 &&
    Math.abs(r.w-previous.w)<=3 && Math.abs(r.h-previous.h)<=3);
  if (old.length!==1 || Math.hypot(target.x-previous.x,target.y-previous.y)<previous.w+8) return null;
  const left=Math.max(0,Math.floor(target.x)-55),top=Math.max(0,Math.floor(target.y)-33);
  const right=Math.min(width,Math.ceil(target.x)+56),bottom=Math.min(height,Math.ceil(target.y)+34);
  // Hover capsules are often much fainter than the circular cursor. Search only
  // a small neighborhood, rejecting nearby animations, partial rows and panels.
  const weak=differenceRegions({data:a,width},b,right-left,bottom-top,left,top,9,.55);
  if (!weak) return null;
  const candidates=weak.filter(r=>r.w>=12 && r.w<=76 && r.h>=6 && r.h<=32 &&
    r.w>=1.15*r.h && r.w<=6*r.h && r.area>=r.w*r.h*.42 &&
    Math.hypot(r.x-previous.x,r.y-previous.y)>previous.w);
  if (candidates.length!==1) return null;
  const to=candidates[0];
  if (to.x-to.w/2<=left || to.x+to.w/2>=right-1 || to.y-to.h/2<=top || to.y+to.h/2>=bottom-1) return null;
  if (!insideHighlight(target,to) || !insideHighlight(predicted,to)) return null;
  const x=to.x-previous.x,y=to.y-previous.y,len=Math.hypot(direction.x,direction.y);
  const forward=(x*direction.x+y*direction.y)/len;
  if (forward<=0 || Math.abs(x*direction.y-y*direction.x)/len>Math.max(5,.13*forward)) return null;
  return {from:previous,to:{...to,hover:true}};
}

function roundFootprint(r) {
  const short=Math.min(r.w,r.h),long=Math.max(r.w,r.h),fill=r.area/(r.w*r.h);
  return short>=4 && long<=28 && long<=short*1.45 && fill>=.4 && fill<.93;
}

function circlesAlongMove(fromRegions,toRegions,direction,previous) {
  const length=Math.hypot(direction.x,direction.y);
  if (!length || fromRegions.length>50 || toRegions.length>50) return null;
  let unique=null;
  for (const from of fromRegions) {
    if (!roundFootprint(from) || previous && (Math.hypot(from.x-previous.x,from.y-previous.y)>3 ||
        Math.abs(from.w-previous.w)>4 || Math.abs(from.h-previous.h)>4)) continue;
    for (const to of toRegions) {
      if (!roundFootprint(to) || Math.abs(from.w-to.w)>3 || Math.abs(from.h-to.h)>3 ||
          Math.min(from.area,to.area)<.63*Math.max(from.area,to.area)) continue;
      const x=to.x-from.x,y=to.y-from.y,forward=(x*direction.x+y*direction.y)/length;
      if (forward<Math.max(4,from.w*.7) || forward>length*6+5 ||
          Math.abs(x*direction.y-y*direction.x)/length>Math.max(3,forward*.1)) continue;
      if (unique) return false;
      unique={from,to};
    }
  }
  return unique;
}

function nearbyChanges(a,b,width,height,point,radius) {
  const left=Math.max(0,Math.floor(point.x-radius)),top=Math.max(0,Math.floor(point.y-radius));
  const right=Math.min(width,Math.ceil(point.x+radius+1)),bottom=Math.min(height,Math.ceil(point.y+radius+1));
  if (right<=left || bottom<=top) return [];
  return differenceRegions({data:a,width},b,right-left,bottom-top,left,top,8,.38) || [];
}

function movedPointer(a,b,width,height,direction,previous,landing=null) {
  if (landing && previous && !previous.hover) {
    const predicted=landing.predicted, delta=Math.hypot(predicted.x-previous.x,predicted.y-previous.y);
    const localOld=nearbyChanges(a,b,width,height,previous,Math.max(14,previous.w));
    const localNew=nearbyChanges(a,b,width,height,predicted,Math.min(68,Math.max(18,delta*.32+8)));
    const pair=circlesAlongMove(localOld,localNew,direction,previous);
    if (pair===false) return null;
    if (pair) return pair;
  }
  const all=differenceRegions({data:a,width},b,width,height,0,0,28,.05);
  const strong=all && matchRegions(a,b,width,height,direction,previous,landing,all);
  if (strong) return strong;
  // The old and new footprints of a translucent iPadOS cursor can both be
  // below the strong-difference threshold. Require a single congruent pair;
  // a clock hand or icon animation elsewhere is allowed to change independently.
  const faint=differenceRegions({data:a,width},b,width,height,0,0,8,.12);
  if (!faint) return null;
  const pair=circlesAlongMove(faint,faint,direction,previous);
  if (pair===false) return null;
  if (pair) return pair;
  if (previous && landing && Math.hypot(landing.predicted.x-previous.x,landing.predicted.y-previous.y)<=previous.w+6)
    return matchRegions(a,b,width,height,direction,previous,null,
      nearbyChanges(a,b,width,height,previous,Math.max(20,previous.w*2)));
  return null;
}

function matchRegions(a,b,width,height,direction,previous,landing,all) {
  const regions=all.filter(r=>Math.max(r.w,r.h)<=30);
  const matches = [];
  const length = Math.hypot(direction.x,direction.y);
  if (!length || regions.length > 60) return null;
  for (const from of regions) {
    if (previous && Math.hypot(from.x-previous.x,from.y-previous.y)>9) continue;
    for (const to of regions) {
      const dx = to.x-from.x, dy = to.y-from.y;
      const forward = (dx*direction.x+dy*direction.y)/length;
      if (forward < 3 || forward > length*6+12 ||
          Math.abs(dx*direction.y-dy*direction.x)/length > Math.max(4,forward*.14)) continue;
      if (Math.abs(from.w-to.w)>5 || Math.abs(from.h-to.h)>5 ||
          Math.min(from.area,to.area)<.38*Math.max(from.area,to.area)) continue;
      matches.push({from,to});
    }
  }
  if (matches.length===1) {
    const match=matches[0];
    // When the silhouettes overlap, only their exposed crescents differ.
    if (previous && Math.abs(match.from.x-match.to.x)<previous.w*1.5 &&
        Math.abs(match.from.y-match.to.y)<previous.h*1.5 &&
        Math.hypot(match.from.x-previous.x,match.from.y-previous.y)>1) {
      const x=match.to.x+match.from.x-previous.x, y=match.to.y+match.from.y-previous.y;
      return {from:previous,to:{...previous,x,y}};
    }
    return match;
  }
  if (!previous || matches.length) return null;
  // Touching circles can form one connected region. Their union is centered
  // halfway between the old and new pointer; use the known last footprint.
  const joined=[];
  for (const region of regions) {
    const dx=2*(region.x-previous.x), dy=2*(region.y-previous.y);
    if ((dx*direction.x+dy*direction.y)/length < 1 ||
        Math.abs(dx*direction.y-dy*direction.x)/length > 3 ||
        Math.abs(region.w-previous.w-Math.abs(dx))>3 ||
        Math.abs(region.h-previous.h-Math.abs(dy))>3 ||
        Math.hypot(dx,dy)>length*6+4) continue;
    joined.push({from:previous,to:{...previous,x:previous.x+dx,y:previous.y+dy}});
  }
  if (joined.length) return joined.length===1 ? joined[0] : null;
  return snappedButton(a,b,width,height,previous,direction,landing,regions);
}

function cursorSignature(before, after, position) {
  const {x,y,w,h}=position;
  const pixels=[];
  for (let row=Math.max(0,Math.ceil(y-h/2));row<=Math.min(after.height-1,Math.floor(y+h/2));row++) {
    for (let col=Math.max(0,Math.ceil(x-w/2));col<=Math.min(after.width-1,Math.floor(x+w/2));col++) {
      const index=(row*after.width+col)*4;
      const r=after.data[index], g=after.data[index+1], b=after.data[index+2];
      const contrast=Math.max(Math.abs(r-before.data[index]),Math.abs(g-before.data[index+1]),Math.abs(b-before.data[index+2]));
      if (contrast>8) pixels.push(index,r,g,b,Math.max(2,Math.min(11,Math.floor(contrast*.35))));
    }
  }
  return pixels;
}

function sameCursor(frame, signature) {
  if (!signature || signature.length<8*5) return false;
  let matched=0;
  for (let i=0;i<signature.length;i+=5) {
    const index=signature[i],tolerance=signature[i+4];
    if (Math.abs(frame.data[index]-signature[i+1])<=tolerance &&
        Math.abs(frame.data[index+1]-signature[i+2])<=tolerance &&
        Math.abs(frame.data[index+2]-signature[i+3])<=tolerance) matched++;
  }
  return matched>=signature.length/5*.9;
}

async function aimPointer(target, sample, move, validate, cache=null) {
  validate();
  let frame=await sample();
  const sameSize=cache && cache.width===frame.width && cache.height===frame.height;
  const recent=sameSize && Date.now()-cache.observedAt<12000;
  let position=sameSize && sameCursor(frame,cache.signature) &&
    (recent || Math.hypot(cache.position.x-target.x,cache.position.y-target.y)>4) ? cache.position : null;
  let gain=sameSize ? cache.gain : 1;
  let travelGain=sameSize ? cache.travelGain : null;
  let signature=position ? cache.signature : null;
  let observedAt=position ? cache.observedAt : 0;
  let reports=0, probes=0;
  const withinTarget=p=>p.hover ? insideHighlight(target,p) : Math.hypot(p.x-target.x,p.y-target.y)<=4;

  // Keep the same baseline while waiting for the consequences of ONE movement.
  // A decoded frame arriving immediately after a BLE acknowledgement can still
  // represent the old pointer location. Never compensate twice for that latency.
  async function track(dx,dy,origin) {
    const baseline=frame;
    // Large HID deltas change iPadOS acceleration. Split distant moves into
    // collinear reports of comparable size to those used to measure the gain.
    const steps=Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/64);
    let sentX=0,sentY=0;
    for (let step=1;step<=steps;step++) {
      validate();
      const x=Math.round(dx*step/steps), y=Math.round(dy*step/steps);
      await move(x-sentX,y-sentY);
      sentX=x; sentY=y; reports++;
    }
    const direction={x:dx,y:dy};
    const landing=origin && {target,predicted:{x:origin.x+dx*gain,y:origin.y+dy*gain}};
    // Only inspect frames captured after the last report in a burst.
    // sample() is immediate; sample(serial) waits for a later USB frame.
    let afterSerial=steps>1 ? (await sample()).serial : baseline.serial;
    const deadline=Date.now()+250;
    for (let i=0;i<12;i++) {
      validate();
      frame=await sample(afterSerial);
      if (frame.width!==baseline.width || frame.height!==baseline.height)
        throw Error('投屏方向已变化，请重新操作。');
      const fresh=afterSerial===undefined || frame.serial!==afterSerial;
      if (fresh || steps>1 && i===0) {
        let match=movedPointer(baseline.data,frame.data,frame.width,frame.height,direction,origin,landing);
        if (match && frame.serial!==undefined && (steps>1 || withinTarget(match.to))) {
          // A burst can generate several frames. Confirm the observed endpoint
          // once before issuing the next move or pressing a button.
          const last=await sample(frame.serial);
          validate();
          if (last.width!==frame.width || last.height!==frame.height) throw Error('投屏方向已变化，请重新操作。');
          if (last.serial!==frame.serial) {
            frame=last;
            match=movedPointer(baseline.data,frame.data,frame.width,frame.height,direction,origin,landing);
          }
        }
        if (match) {
          position=match.to;
          if (!position.hover) gain=Math.min(5,Math.max(.25,Math.hypot(position.x-match.from.x,position.y-match.from.y)/Math.hypot(dx,dy)));
          if (!position.hover && Math.hypot(dx,dy)/steps>=16) travelGain=gain;
          signature=cursorSignature(baseline,frame,position);
          observedAt=Date.now();
          return true;
        }
      }
      if (frame.serial===undefined || Date.now()>=deadline) break;
      afterSerial=frame.serial;
    }
    return false;
  }

  async function locate(hint, recovery=false) {
    // Search once toward the destination. Only a cold start gets two short
    // inward reports to reveal a hidden pointer pinned at a screen edge.
    let x=target.x-hint.x,y=target.y-hint.y;
    if (Math.hypot(x,y)<4) { x=target.x-frame.width/2; y=target.y-frame.height/2; }
    if (Math.hypot(x,y)<4) x=1;
    const distance=Math.hypot(x,y);
    const length=recovery ? 18 : 24;
    const scale=length/distance;
    x=Math.round(x*scale); y=Math.round(y*scale);
    const inwardX=target.x<frame.width/2 ? 19 : -19;
    const inwardY=target.y<frame.height/2 ? 19 : -19;
    const attempts=recovery ? [[x,y]] : [[x,y],[inwardX,inwardY],[inwardX,inwardY]];
    for (const [dx,dy] of attempts) {
      probes++;
      if (await track(dx,dy,null)) return true;
    }
    return false;
  }

  async function wakeNearby(cached) {
    const start=frame, radius=Math.min(29,Math.max(18,cached.w+14));
    let ax=target.x-cached.x,ay=target.y-cached.y;
    if (Math.hypot(ax,ay)<4) {
      // Work inward when the last visible position was near a display edge.
      ax=cached.x<start.width/2 ? 1 : -1; ay=0;
    }
    const wakeLength=Math.max(3,Math.min(12,Math.round(Math.max(7,cached.w*.7)/gain)));
    const norm=Math.hypot(ax,ay),dx=Math.round(wakeLength*ax/norm),dy=Math.round(wakeLength*ay/norm);
    validate();
    await move(dx,dy);
    reports++; probes++;
    let first=null,fresh=false;
    const deadline=Date.now()+165;
    for (let i=0;i<8;i++) {
      validate();
      frame=await sample(frame.serial);
      if (frame.width!==start.width || frame.height!==start.height) throw Error('投屏方向已变化，请重新操作。');
      fresh=frame.serial===undefined || frame.serial!==start.serial;
      if (fresh) {
        const nearby=nearbyChanges(start.data,frame.data,frame.width,frame.height,cached,radius).filter(r=>
          roundFootprint(r) && Math.abs(r.w-cached.w)<=4 && Math.abs(r.h-cached.h)<=4 &&
          Math.hypot(r.x-cached.x,r.y-cached.y)<radius-2);
        if (nearby.length>1) return false;
        first=nearby[0];
        if (first) break;
      }
      if (frame.serial===undefined || Date.now()>=deadline) break;
    }
    if (!fresh) return false;
    // A cursor appearing after auto-hide leaves no disappearing footprint.
    // The first circle is only a hypothesis. Require its response to a second,
    // small movement, preferably back toward the requested point.
    let x=first ? target.x-first.x : -dx,y=first ? target.y-first.y : -dy;
    if (Math.hypot(x,y)<2) { x=-dx; y=-dy; }
    const distance=Math.hypot(x,y);
    const physical=first ? Math.max(cached.w*.65,Math.min(12,distance)) : Math.max(12,cached.w+3);
    const scale=Math.max(3,Math.min(14,physical/gain))/distance;
    probes++;
    return track(Math.round(x*scale),Math.round(y*scale),first);
  }

  const nearbyRepeat=!position && sameSize && !cache.position.hover &&
    Math.hypot(cache.position.x-target.x,cache.position.y-target.y)<=12;
  if (nearbyRepeat) {
    if (!await wakeNearby(cache.position)) throw Error('未能确认唤醒后的指针位置，已取消操作。');
  } else if (!position && sameSize && !withinTarget(cache.position)) {
    // A new page often changes the cached pixels while the mouse stays put.
    // Try a useful target-directed move; the putative origin is just a hint
    // until a corresponding old/new silhouette is seen in the video.
    gain=travelGain || cache.gain;
    const x=(target.x-cache.position.x)/gain,y=(target.y-cache.position.y)/gain;
    const scale=Math.min(1,(recent ? 64 : 24)/Math.max(Math.abs(x),Math.abs(y)));
    await track(Math.round(x*scale),Math.round(y*scale),cache.position);
  }
  if (!position && !await locate(sameSize ? cache.position : {x:frame.width/2,y:frame.height/2},!!sameSize))
    throw Error('未能从投屏画面识别 iPad 指针。请在静止画面重试。');
  let recovered=false;
  for (let attempt=0;attempt<14;attempt++) {
    validate();
    if (withinTarget(position)) {
      return {position,gain,travelGain,signature,observedAt,width:frame.width,height:frame.height,reports,probes};
    }
    if (Math.hypot(target.x-position.x,target.y-position.y)>40 && travelGain) gain=travelGain;
    const x=(target.x-position.x)/gain, y=(target.y-position.y)/gain;
    // Use collinear HID reports for long moves, then use the actual observed
    // endpoint to correct iPadOS acceleration. Reserve the final approach.
    const extent=Math.max(Math.abs(x),Math.abs(y));
    const scale=extent>96 ? Math.min(.8,160/extent) : 1;
    if (await track(Math.round(x*scale),Math.round(y*scale),position)) continue;
    if (recovered || !await locate(position,true)) throw Error('未能确认指针落点，已取消操作。');
    recovered=true;
  }
  throw Error('指针尚未对准目标，请重试。');
}
// During a drag iPadOS may hide the pointer and draw the control's handle.
// Match changing edge pixels on that handle, along the requested movement.
function translatedHandle(before,after,from,dx,dy) {
  const {width,height,data:a}=before,b=after.data;
  const diff=(one,i,two,j)=>Math.max(Math.abs(one[i]-two[j]),Math.abs(one[i+1]-two[j+1]),Math.abs(one[i+2]-two[j+2]));
  const edges=[];
  let changedEdges=0;
  const cx=Math.round(from.x),cy=Math.round(from.y),radius=15;
  for (let y=Math.max(2,cy-radius);y<=Math.min(height-3,cy+radius);y++) {
    for (let x=Math.max(2,cx-radius);x<=Math.min(width-3,cx+radius);x++) {
      const i=(y*width+x)*4, change=diff(a,i,b,i);
      const contrast=Math.max(diff(a,i-4,a,i+4),diff(a,i-4*width,a,i+4*width));
      if (contrast<14) continue;
      if (change>=12) changedEdges++;
      edges.push({x,y,i,contrast});
    }
  }
  if (changedEdges<12) return null;
  const length=Math.hypot(dx,dy),ux=dx/length,uy=dy/length;
  const candidates=[],visited=new Set();
  for (let d=1;d<=Math.min(80,length*6+3);d++) {
    for (let lateral=-1;lateral<=1;lateral++) {
      const x=Math.round(d*ux-lateral*uy), y=Math.round(d*uy+lateral*ux);
      const key=(x+100)*201+y;
      if (visited.has(key)) continue;
      visited.add(key);
      let score=0;
      for (const p of edges) {
        if (p.x+x<0 || p.x+x>=width || p.y+y<0 || p.y+y>=height) continue;
        const error=diff(a,p.i,b,p.i+(y*width+x)*4);
        score+=Math.max(0,1-error/p.contrast);
      }
      if (score>=edges.length*.74) candidates.push({x,y,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates[0];
  if (!best || candidates.some(c=>Math.hypot(c.x-best.x,c.y-best.y)>2 && c.score>=best.score*.92)) return null;
  // Scrolling text can match a local patch as well. Check whether surrounding
  // content moved with the same offset before treating it as a tracked handle.
  let moving=0,correlated=0;
  for (let yy=-40;yy<=40;yy+=3) for (let xx=-40;xx<=40;xx+=3) {
    if (Math.max(Math.abs(xx),Math.abs(yy))<22 ||
        Math.max(Math.abs(xx-best.x),Math.abs(yy-best.y))<22) continue;
    const x=cx+xx,y=cy+yy;
    if (x<0 || x>=width || y<0 || y>=height || x+best.x<0 || x+best.x>=width || y+best.y<0 || y+best.y>=height) continue;
    const i=(y*width+x)*4, change=diff(a,i,b,i);
    if (change<18) continue;
    moving++;
    if (diff(a,i,b,i+(best.y*width+best.x)*4)<change*.4) correlated++;
  }
  if (moving>=10 && correlated>moving*.5) return null;
  return {...from,x:from.x+best.x,y:from.y+best.y};
}

function dragAreaStill(a,b,origin,target) {
  const left=Math.max(0,Math.floor(Math.min(origin.x,target.x))-20);
  const right=Math.min(a.width-1,Math.ceil(Math.max(origin.x,target.x))+20);
  const top=Math.max(0,Math.floor(Math.min(origin.y,target.y))-20);
  const bottom=Math.min(a.height-1,Math.ceil(Math.max(origin.y,target.y))+20);
  for (let y=top;y<=bottom;y++) {
    for (let x=left,i=(y*a.width+left)*4;x<=right;x++,i+=4) {
      if (Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),
        Math.abs(a.data[i+2]-b.data[i+2]))>9) return false;
    }
  }
  return true;
}

function createHeldMover(aligned,sample,moveWithButton,validate) {
  let position=aligned.position,gain=aligned.gain,measured=false;
  return async function moveHeld(target,mask,{intermediate=false}={}) {
    validate();
    if (!mask) throw Error('拖动需要保持鼠标键按下。');
    // A few mousemove events normally precede the slider activation threshold.
    // Coalesce them at the last *observed* location instead of treating a 1-HID
    // movement as an entire drag. The terminal waypoint is always verified.
    const requested=Math.hypot(target.x-position.x,target.y-position.y);
    if (requested<=3 || !measured && intermediate && requested<13)
      return {x:position.x,y:position.y};
    let frame=await sample();
    if (!measured && frame.serial!==undefined) frame=await sample(frame.serial);
    function checkFrame(next) {
      validate();
      if (next.width!==aligned.width || next.height!==aligned.height) throw Error('投屏方向已变化，拖动已结束。');
    }
    checkFrame(frame);
    let startupX=0,startupY=0,retries=0;
    for (let i=0;i<72;i++) {
      const x=target.x-position.x,y=target.y-position.y,distance=Math.hypot(x,y);
      if (distance<=3) return {x:position.x,y:position.y};
      // Held movement can be several times faster than free pointing. Only
      // increase the step after measuring what a small held report really did.
      const divisor=measured ? Math.max(.6,gain*1.18) : Math.max(6,gain);
      const budget=Math.min(12,Math.floor(distance/4));
      const length=retries ? Math.min(3,budget-Math.hypot(startupX,startupY)) :
        Math.min(measured ? 24 : 6,distance/divisor);
      const round=retries ? Math.trunc : Math.round;
      let dx=round(length*x/distance),dy=round(length*y/distance);
      if (!dx && !dy) {
        if (Math.abs(x)>=Math.abs(y)) dx=Math.sign(x); else dy=Math.sign(y);
      }
      validate();
      await moveWithButton(dx,dy,mask);
      startupX+=dx; startupY+=dy;
      const before=frame, deadline=Date.now()+320;
      let previousSeen=null,settled=null,newFrame=false,stationary=true;
      for (let reads=0;reads<14;reads++) {
        const serial=frame.serial;
        frame=await sample(serial);
        checkFrame(frame);
        if (serial===undefined || frame.serial!==serial) {
          if (serial!==undefined) newFrame=true;
          if (!measured && stationary) stationary=dragAreaStill(before,frame,position,target);
          const seen=movedPointer(before.data,frame.data,frame.width,frame.height,{x:startupX,y:startupY},position)?.to ??
            translatedHandle(before,frame,position,startupX,startupY);
          if (seen && (serial===undefined || previousSeen && Math.hypot(seen.x-previousSeen.x,seen.y-previousSeen.y)<=1.5)) {
            settled=seen;
            break;
          }
          previousSeen=seen;
        } else if (previousSeen) {
          settled=previousSeen;
          break;
        }
        if (serial===undefined || Date.now()>=deadline) break;
      }
      if (!settled) {
        // Only retry if freshly decoded frames show the entire drag area inert.
        // An uncertain translation, a stalled stream or a short remaining path
        // must not turn into blind dragging. All retries share one movement budget.
        if (!measured && stationary && newFrame && retries<2 &&
            budget-Math.hypot(startupX,startupY)>=2) { retries++; continue; }
        throw Error('无法确认拖动位移，已停止继续移动。');
      }
      gain=Math.max(.25,Math.min(8,Math.hypot(settled.x-position.x,settled.y-position.y)/Math.hypot(dx,dy)));
      measured=true;
      position=settled;
      startupX=startupY=retries=0;
    }
    throw Error('拖动未到达目标，已停止继续移动。');
  };
}
if (typeof module !== 'undefined') module.exports={picturePoint,movedPointer,aimPointer,createHeldMover,differenceRegions};
