// Loaded into the existing test WebView. These helpers never click or send input.
function accessoryBlue(data,i) {
  return data[i+2]>=110 && data[i+2]-data[i]>65 && data[i+2]-data[i+1]>22 && data[i+1]>=data[i]-15;
}
function findConnectedAccessoryInfo(labels, image, accessory = 'computer') {
  const {width, height} = image;
  const scale = Math.min(width,height);
  if (!labels.some(hit=>hit.label==='bluetooth')) return null;
  const possible=[];
  for (const row of labels.filter(hit=>hit.label===accessory)) {
    const adjacent=labels.filter(hit=>hit.x>row.x && Math.abs(hit.y-row.y)<=Math.max(3,scale*.012));
    const connected=adjacent.filter(hit=>hit.label==='connected');
    if (connected.length>1 || (connected.length && adjacent.some(hit=>hit.label==='not-connected'))) return null;
    if (connected.length===1) possible.push({row,status:connected[0]});
  }
  if (possible.length!==1) return null;
  return findAccessoryRowInfo(image,possible[0].row.y,possible[0].status.x);
}
function findAccessoryRowInfo(image,rowY,statusX) {
  const {width,height,data}=image, scale=Math.min(width,height);
  // Only inspect this connected row, to the right of its status label. Identify
  // a blue circular ring *and* the separate interior dot and stem of the i.
  const left = Math.max(0,Math.ceil(statusX+scale*.012));
  const top = Math.max(0,Math.floor(rowY-scale*.048));
  const right = width-1, bottom = Math.min(height-1,Math.ceil(rowY+scale*.048));
  if (left>=right || top>=bottom) return null;
  const stride = right-left+1;
  const visited = new Uint8Array(stride*(bottom-top+1));
  function blue(x,y) {
    return accessoryBlue(data,4*(y*width+x));
  }
  function hasInk(cx,cy,radius,dx,y1,y2) {
    for (let y=Math.ceil(cy+y1*radius);y<=cy+y2*radius;y++)
      for (let x=Math.ceil(cx-dx*radius);x<=cx+dx*radius;x++)
        if (blue(x,y)) return true;
    return false;
  }
  const matches = [];
  for (let y=top;y<=bottom;y++) for (let x=left;x<=right;x++) {
    const first=(y-top)*stride+x-left;
    if (visited[first] || !blue(x,y)) continue;
    let minX=x,maxX=x,minY=y,maxY=y;
    const pixels = [first]; visited[first]=1;
    for (let head=0;head<pixels.length;head++) {
      const pixel=pixels[head], px=left+pixel%stride, py=top+Math.floor(pixel/stride);
      minX=Math.min(minX,px); maxX=Math.max(maxX,px);
      minY=Math.min(minY,py); maxY=Math.max(maxY,py);
      for (let ny=Math.max(top,py-1);ny<=Math.min(bottom,py+1);ny++)
        for (let nx=Math.max(left,px-1);nx<=Math.min(right,px+1);nx++) {
          const next=(ny-top)*stride+nx-left;
          if (!visited[next] && blue(nx,ny)) {visited[next]=1; pixels.push(next);}
        }
    }
    const w=maxX-minX+1,h=maxY-minY+1,cx=(maxX+minX)/2,cy=(maxY+minY)/2,r=(w+h)/4;
    if (w<Math.max(12,scale*.011) || w>scale*.085 || Math.abs(w-h)>w*.13 ||
        Math.abs(cy-rowY)>scale*.012 || minX===left || minY===top || maxX===right || maxY===bottom) continue;
    const sectors=new Set();
    let ring=true;
    for (const p of pixels) {
      const dx=(left+p%stride-cx)/r,dy=(top+Math.floor(p/stride)-cy)/r;
      if (Math.hypot(dx,dy)<.63) {ring=false; break;}
      sectors.add(Math.floor((Math.atan2(dy,dx)+Math.PI)*16/(2*Math.PI))%16);
    }
    if (!ring || sectors.size!==16 || !hasInk(cx,cy,r,.17,-.58,-.15) ||
        !hasInk(cx,cy,r,.17,.05,.42)) continue;
    // A plus or a solid button can have central ink too. Require a clear
    // horizontal gap between upper dot and stem, inside the ring.
    let separated=false;
    for (let iy=Math.ceil(cy-.35*r);iy<=cy;iy++) {
      if (!hasInk(cx,iy,r,.22,0,0)) {separated=true; break;}
    }
    if (separated) matches.push({x:cx,y:cy});
  }
  return matches.length===1 ? matches[0] : null;
}

// Audit an entire visible paired-device group before identifying the global
// switch. A blue shape or an OCR status with no corresponding row blocks use.
function findAuditedSeBluetoothSwitch(labels,image,{accessory='computer',diagnostic}={}) {
  const {width:w,height:h,data}=image, tolerance=w*.012;
  const info={};
  function reject(reason) { diagnostic?.({...info,reason}); return null; }
  function sole(items) {return items.length===1 ? items[0] : null;}
  function named(label) {return labels.filter(hit=>hit.label===label);}
  const my=sole(named('my-devices')), others=sole(named('other-devices'));
  if (Math.abs(w/h-9/16)>.035 || !my || !others || my.y>=others.y || my.x>w*.55 || others.x>w*.55)
    return reject('paired-group-not-fully-visible');
  const heading=sole(named('bluetooth').filter(p=>Math.abs(p.x-w/2)<w*.12 && p.y<my.y && p.y<h*.13));
  if (!heading) return reject('not-bluetooth-settings');
  const row=sole(named('bluetooth').filter(p=>p.x<w*.4 && p.y>heading.y+tolerance && p.y<my.y));
  if (!row) return reject('switch-row-missing');
  const statuses=labels.filter(p=>['connected','not-connected'].includes(p.label) && p.y>my.y && p.y<others.y);
  const connected=sole(statuses.filter(p=>p.label==='connected'));
  const knownNames=new Set(['computer','pad-name','phone-name',accessory]);
  const targetName=connected && sole(labels.filter(p=>knownNames.has(p.label) && p.x<connected.x && Math.abs(p.y-connected.y)<=tolerance));
  if (targetName?.label!==accessory)
    return reject('unique-connected-target-unproven');
  const bands=[];
  let start=null;
  for (let y=Math.ceil(my.y);y<=Math.floor(others.y);y++) {
    let ink=false;
    for (let x=Math.floor(w*.83);x<w && !ink;x++) ink=accessoryBlue(data,4*(y*w+x));
    if (ink && start===null) start=y;
    if (!ink && start!==null) {bands.push((start+y-1)/2);start=null;}
  }
  Object.assign(info,{icons:bands.length,statuses:statuses.length});
  if (start!==null || bands.length!==statuses.length) return reject('unaccounted-paired-row');
  const matched=new Set();
  for (const y of bands) {
    const state=sole(statuses.filter(p=>p.x>w*.55 && p.x<w*.9 && Math.abs(p.y-y)<=tolerance));
    if (!state || matched.has(state) || !findAccessoryRowInfo(image,y,state.x)) return reject('paired-row-not-proven');
    matched.add(state);
  }
  let l=w,r=-1,t=h,b=-1,count=0;
  function green(x,y) {const i=4*(w*y+x);return data[i+1]>115 && data[i+1]-data[i]>38 && data[i+1]-data[i+2]>24;}
  for (let y=Math.ceil(heading.y+tolerance);y<my.y-tolerance;y++) for(let x=Math.ceil(w*.73);x<w;x++) {
    if (!green(x,y)) continue;
    l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);count++;
  }
  const sw=r-l+1,sh=b-t+1,cx=(l+r)/2,cy=(t+b)/2;
  if (!count || sw<w*.065 || sw>w*.18 || sw/sh<1.4 || sw/sh>2.25 || cx<w*.82 ||
      Math.abs(cy-row.y)>w*.025 || count/(sw*sh)<.32 || count/(sw*sh)>.76) return reject('enabled-switch-unproven');
  for (const x of [l+sh*.07,r-sh*.07]) for (const y of [t+sh*.07,b-sh*.07]) {
    if (green(Math.round(x),Math.round(y))) return reject('non-rounded-switch');
  }
  // On iOS an enabled switch has a green left half and the pale thumb on the right.
  for (const dy of [-.16,0,.16]) for(const dx of [-.09,0,.09]) {
    const py=Math.round(cy+dy*sh), knob=Math.round(r-sh*.5+dx*sh);
    const i=4*(w*py+knob), rgb=[data[i],data[i+1],data[i+2]];
    if (!green(Math.round(l+sh*.5+dx*sh),py) || Math.min(...rgb)<175 || Math.max(...rgb)-Math.min(...rgb)>45)
      return reject('right-hand-thumb-unproven');
  }
  diagnostic?.({...info,reason:'single-connected-accessory-and-enabled-switch'});
  return {x:cx,y:cy};
}

// Caller first verifies the accessory name editor and its field contents by OCR.
// Inspect one navigation-bar crop. Extra blue controls expand the bounds and
// make the recognition inconclusive. Diagnostics contain dimensions only.
function findAccessoryNameDone(image, title, diagnostic) {
  const {width,height,data}=image, unit=Math.min(width,height);
  const info={bluePixels:0};
  function reject(reason) { diagnostic?.({...info,reason}); return null; }
  if (title?.label!=='name' || title.y<=0 || title.y>height*.17 ||
      title.x<width*.36 || title.x>width*.84) return reject('unconfirmed-title');
  const left=Math.max(Math.ceil(width*.83),Math.ceil(title.x+unit*.08)), top=Math.max(0,Math.floor(title.y-unit*.05));
  const bottom=Math.min(height-1,Math.ceil(title.y+unit*.05));
  const blue=[];
  function bounds(points) {
    let l=width,t=height,r=-1,b=-1;
    for (const [x,y] of points) {l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
    return {l,r,t,b,w:r-l+1,h:b-t+1,x:(l+r)/2,y:(t+b)/2};
  }
  for (let y=top;y<=bottom;y++) for (let x=left;x<width;x++) {
    const i=4*(y*width+x);
    if (data[i+2]>115 && data[i+2]-data[i]>65 && data[i+2]-data[i+1]>22 && data[i+1]>=data[i]-15) blue.push([x,y]);
  }
  info.bluePixels=blue.length;
  if (!blue.length) return reject('no-blue-control');
  const box=bounds(blue);
  Object.assign(info,{w:box.w,h:box.h,fill:Math.round(100*blue.length/(box.w*box.h))});
  if (box.w<Math.max(12,unit*.012) || box.w>unit*.13 || box.h>unit*.13 ||
      Math.abs(box.y-title.y)>unit*.02 || box.l===left || box.r===width-1 || box.t===top || box.b===bottom)
    return reject('toolbar-bounds');
  let ink=blue;
  if (info.fill>55) {
    if (Math.abs(box.w-box.h)>box.w*.12 || info.fill>82) return reject('not-a-blue-circle');
    const radius=(box.w+box.h)/4;
    if (blue.some(([x,y])=>Math.hypot(x-box.x,y-box.y)>radius*1.09)) return reject('not-a-blue-circle');
    ink=[];
    for (let y=box.t;y<=box.b;y++) for (let x=box.l;x<=box.r;x++) {
      if (Math.hypot(x-box.x,y-box.y)>radius*.79) continue;
      const i=4*(y*width+x), rgb=[data[i],data[i+1],data[i+2]];
      if (Math.min(...rgb)>185 && Math.max(...rgb)-Math.min(...rgb)<40) ink.push([x,y]);
    }
    if (ink.length<8) return reject('no-white-glyph');
  }
  const glyph=bounds(ink);
  if (glyph.w<9 || glyph.h<6 || glyph.w/glyph.h<.95 || glyph.w/glyph.h>2.25 ||
      (ink!==blue && (glyph.w<box.w*.28 || glyph.w>box.w*.8 || Math.abs(glyph.x-box.x)>box.w*.1)))
    return reject('glyph-bounds');
  const columns=Array.from({length:glyph.w},()=>[]);
  for (const [x,y] of ink) columns[x-glyph.l].push(y);
  if (columns.some(col=>!col.length || Math.max(...col)-Math.min(...col)>glyph.h*.52))
    return reject('broken-or-thick-stroke');
  const centers=columns.map(col=>(Math.max(...col)+Math.min(...col))/2);
  const elbow=centers.indexOf(Math.max(...centers)), last=centers.length-1;
  const firstY=centers[0], endY=centers[last], lowY=centers[elbow];
  if (elbow<last*.23 || elbow>last*.56 || lowY-firstY<glyph.h*.24 ||
      lowY-endY<glyph.h*.59 || firstY-endY<glyph.h*.16) return reject('not-a-tick');
  for (let x=0;x<=last;x++) {
    const expected=x<elbow ? firstY+(lowY-firstY)*x/elbow : lowY+(endY-lowY)*(x-elbow)/(last-elbow);
    if (Math.abs(centers[x]-expected)>Math.max(1.5,glyph.h*.16)) return reject('nonlinear-stroke');
  }
  diagnostic?.({...info,reason:ink===blue?'blue-tick':'white-tick'});
  return {x:box.x,y:box.y};
}

async function createBluetoothCycleObserver(readStatus, targetUsbId, targetPeerId, options = {}) {
  async function sample() {
    let timer;
    try {
      return await Promise.race([readStatus(),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('The current console stopped responding to status reads.')),5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const initial = await sample();
  const peers = initial.peers || [];
  if (initial.activeDeviceId!==targetUsbId || initial.verifiedPeerId!==targetPeerId ||
      initial.needsPairing || !peers.some(p=>p.id===targetPeerId && p.boundDeviceId===targetUsbId))
    throw Error('Independently verify the current USB picture and Bluetooth target before disconnecting.');
  const bystanders=peers.filter(peer=>peer.id!==targetPeerId);
  const other=options.otherPeerId ? bystanders.find(peer=>peer.id===options.otherPeerId) :
    bystanders.find(peer=>peer.boundDeviceId && peer.boundDeviceId!==targetUsbId);
  const otherUsb=options.otherUsbId || other?.boundDeviceId;
  if (!other || !otherUsb || otherUsb===targetUsbId || (other.boundDeviceId && other.boundDeviceId!==otherUsb))
    throw Error('Identify the other receiver by its independent USB proof and still-live handle.');
  const retained=new Set(bystanders.map(peer=>peer.id));
  const ineligible=new Set(retained);
  const state = {phase:'armed', gapObserved:false, candidateIds:[], newPeerId:null, verified:false, error:null};
  const end = performance.now()+(options.timeoutMs ?? 180000);
  const interval = options.intervalMs ?? 125;
  const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let stopped=false;
  function update(phase) { state.phase=phase; options.onPhase?.(phase); }
  const done = (async()=>{
    try {
      while (!stopped && performance.now()<end) {
        await pause(interval);
        if (stopped) break;
        const status = await sample();
        const now=status.peers || [];
        if (status.activeDeviceId!==targetUsbId) throw Error('The selected USB picture changed.');
        const live=new Set(now.map(peer=>peer.id));
        if ([...retained].some(id=>!live.has(id))) throw Error('Another baseline Bluetooth receiver also disappeared.');
        const witness=now.find(peer=>peer.id===other.id);
        if (witness.boundDeviceId && witness.boundDeviceId!==otherUsb) throw Error('The other USB proof conflicts with its original device.');
        if (live.has(targetPeerId)) {
          if (state.gapObserved) throw Error('The old subscription handle became active again.');
          for (const peer of now) if (peer.id!==targetPeerId) ineligible.add(peer.id);
          continue;
        }
        const candidates=now.filter(peer=>!ineligible.has(peer.id));
        state.candidateIds=candidates.map(peer=>peer.id);
        if (!candidates.length) {
          if (!state.gapObserved) {state.gapObserved=true; update('disconnected');}
          continue;
        }
        if (!state.gapObserved) throw Error('The handle changed before a target-only offline interval was observed.');
        if (state.phase!=='reappeared') update('reappeared');
        const proven=candidates.find(peer=>peer.id===status.verifiedPeerId && peer.boundDeviceId===targetUsbId);
        if (proven && !status.needsPairing) {
          state.newPeerId=proven.id; state.verified=true; update('verified'); return {...state};
        }
      }
      throw Error(stopped ? 'Observer stopped.' : 'Timed out waiting for a verified reconnection.');
    } catch (error) {
      state.error=error.message; update('incomplete'); return {...state};
    }
  })();
  return {state,done,stop(){stopped=true;}};
}

if (typeof module!=='undefined' && module.exports) {
  module.exports={findConnectedAccessoryInfo,findAccessoryNameDone,findAuditedSeBluetoothSwitch,createBluetoothCycleObserver};
}
