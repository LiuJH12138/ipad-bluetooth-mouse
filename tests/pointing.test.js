'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {picturePoint,movedPointer,aimPointer,createHeldMover}=require('../web/pointing');
test('contain geometry excludes letterboxes and maps a scaled portrait frame',()=>{
  const rect={left:20,top:10,width:600,height:400};
  assert.equal(picturePoint(rect,200,400,100,210),null);
  assert.deepEqual(picturePoint(rect,200,400,320,210),{x:100,y:200});
  assert.equal(picturePoint(rect,200,400,420,210),null);
});
function frame(x,y,extra=[]) {
  const width=180,height=120,data=new Uint8ClampedArray(width*height*4);
  for(const [cx,cy] of [[x,y],...extra])for(let j=0;j<height;j++)for(let i=0;i<width;i++)
    if(Math.hypot(i-cx,j-cy)<=4)data[(j*width+i)*4]=150;
  return {width,height,data};
}
test('rejects identical frames and multiple moving pointer candidates',()=>{
  const a=frame(20,40,[[40,80]]),b=frame(44,40,[[64,80]]);
  assert.equal(movedPointer(a.data,a.data,180,120,{x:24,y:0}),null);
  assert.equal(movedPointer(a.data,b.data,180,120,{x:24,y:0}),null);
});
test('measured relative movements converge to the requested picture coordinate',async()=>{
  let x=32,y=34;
  await aimPointer({x:132,y:79},async()=>frame(x,y),async(dx,dy)=>{x+=dx;y+=dy;},()=>{});
  assert.ok(Math.hypot(x-132,y-79)<=4);
});
test('joined pointer silhouettes keep their last measured diameter during a fine correction',()=>{
  const a=frame(64,53), b=frame(66,60);
  const seen=movedPointer(a.data,b.data,180,120,{x:2,y:7},{x:64,y:53,w:9,h:9,area:49});
  assert.ok(seen);
  assert.ok(Math.hypot(seen.to.x-66,seen.to.y-60)<2);
});
test('a wide fullscreen monitor rejects pillarboxes',()=>{
  const r={left:0,top:0,width:1920,height:1000};
  assert.equal(picturePoint(r,1200,900,100,500),null);
  assert.deepEqual(picturePoint(r,1200,900,960,500),{x:600,y:450});
});

function simulatedPointer(start, gain = 1, delayed = false) {
  let {x,y}=start, serial=0, pending=null, late=false;
  const reports=[];
  return {
    reports,
    sample: async () => {
      if (pending && !late) {
        x+=pending.x*gain; y+=pending.y*gain; serial++; pending=null;
      } else {
        late=false;
      }
      return {...frame(x,y),serial};
    },
    move: async (dx,dy) => {
      if (pending && delayed) throw Error('issued another movement before its frame arrived');
      reports.push({dx,dy});
      pending={x:(pending?.x||0)+dx,y:(pending?.y||0)+dy};
      late=delayed;
    },
    relocate: (px,py) => { x=px; y=py; serial++; }
  };
}

test('a warm target follows a direct line and a verified repeat requires no movement', async () => {
  const mouse=simulatedPointer({x:41,y:48});
  const aim=(target,cache)=>aimPointer(target,mouse.sample,mouse.move,()=>{},cache);
  const first=await aim({x:96,y:63});
  assert.ok(first.position);
  assert.ok(first.reports<=2, 'cold localization and one correction');
  assert.equal(first.probes,1);
  const second=await aim({x:139,y:82},first);
  assert.equal(second.reports,1);
  assert.equal(second.probes,0);
  const repeat=await aim({x:139,y:82},second);
  assert.equal(repeat.reports,0);
  assert.equal(repeat.probes,0);
});

test('fresh frames arriving after an unchanged frame do not cause another probe', async () => {
  const mouse=simulatedPointer({x:30,y:38},1,true);
  const hit=await aimPointer({x:101,y:74},mouse.sample,mouse.move,()=>{});
  assert.ok(Math.hypot(hit.position.x-101,hit.position.y-74)<=4);
  assert.equal(hit.probes,1);
});

test('a changed local footprint cannot authorize a click on a stale cached location', async () => {
  const mouse=simulatedPointer({x:33,y:40});
  const target={x:115,y:73};
  const cache=await aimPointer(target,mouse.sample,mouse.move,()=>{});
  mouse.relocate(38,45);
  const hit=await aimPointer(target,mouse.sample,mouse.move,()=>{},cache);
  assert.ok(hit.reports>0);
  assert.ok(Math.hypot(hit.position.x-target.x,hit.position.y-target.y)<=4);
});

test('long moves use bounded collinear reports without paying a frame wait per report', async () => {
  const width=840,height=60;
  let x=65,y=30,serial=0;
  const reports=[], events=[];
  const sample=async () => {
    events.push('sample');
    const data=new Uint8ClampedArray(width*height*4);
    for(let row=y-4;row<=y+4;row++)for(let col=x-4;col<=x+4;col++)
      if(Math.hypot(col-x,row-y)<=4)data[(row*width+col)*4]=175;
    return {width,height,data,serial};
  };
  const move=async(dx,dy)=>{
    events.push('move'); reports.push([dx,dy]); x+=dx; y+=dy; serial++;
  };
  const cache=await aimPointer({x:120,y},sample,move,()=>{});
  reports.length=0; events.length=0;
  const result=await aimPointer({x:730,y},sample,move,()=>{},cache);
  assert.equal(result.probes,0);
  assert.ok(reports.length>=5);
  assert.ok(reports.every(([dx,dy])=>dx>0 && dx<=127 && dy===0));
  assert.ok(events.some((event,i)=>event==='move' && events[i+1]==='move'));
  assert.ok(Math.abs(result.position.x-730)<=4);
});

test('an initially hidden pointer clamped against a corner can be reacquired', async () => {
  let x=0,y=0,shown=false;
  const sample=async()=>shown?frame(x,y):frame(-50,-50);
  const move=async(dx,dy)=>{
    x=Math.min(179,Math.max(0,x+dx)); y=Math.min(119,Math.max(0,y+dy));
    shown=true;
  };
  const result=await aimPointer({x:12,y:14},sample,move,()=>{});
  assert.ok(Math.hypot(result.position.x-12,result.position.y-14)<=4);
  assert.ok(result.probes<=4);
});

function highlight(image,x,y,w,h,level=18) {
  for (let j=y;j<y+h;j++) for (let i=x;i<x+w;i++) image.data[(j*image.width+i)*4]=level;
  return image;
}

test('a disappearing known cursor and a unique small highlight can confirm a snapped button',()=>{
  const before=frame(46,50),after=highlight(frame(-20,-20),94,42,30,16);
  const previous={x:46,y:50,w:9,h:9};
  const landing={target:{x:105,y:50},predicted:{x:108,y:50}};
  assert.ok(movedPointer(before.data,after.data,180,120,{x:62,y:0},previous,landing)?.to.hover);
  assert.equal(movedPointer(frame(-20,-20).data,after.data,180,120,{x:62,y:0},previous,landing),null);
  assert.equal(movedPointer(before.data,after.data,180,120,{x:62,y:0},previous,{...landing,predicted:{x:155,y:50}}),null);
  const two=highlight(after,100,60,24,12);
  assert.equal(movedPointer(before.data,two.data,180,120,{x:62,y:0},previous,landing),null);
});

test('after a page change, a still-correct cached position guides the first move toward the target',async()=>{
  const mouse=simulatedPointer({x:36,y:44});
  const cache=await aimPointer({x:90,y:64},mouse.sample,mouse.move,()=>{});
  // Changing page color invalidates the previously observed footprint.
  cache.signature=cache.signature.map((value,i)=>i%5===1 ? 255-value : value);
  const hit=await aimPointer({x:152,y:87},mouse.sample,mouse.move,()=>{},cache);
  assert.equal(hit.probes,0);
  assert.equal(hit.reports,1);
  assert.ok(Math.hypot(hit.position.x-152,hit.position.y-87)<=4);
});

test('held dragging measures its own gain, even when it differs from free pointing',async()=>{
  let x=50,y=60,serial=0;
  const reports=[];
  const sample=async()=>({...frame(x,y),serial});
  const aligned={position:{x,y,w:9,h:9},gain:.4,width:180,height:120};
  const drag=createHeldMover(aligned,sample,async(dx,dy,mask)=>{
    reports.push([dx,dy,mask]); x+=dx*3; y+=dy*3; serial++;
  },()=>{});
  await drag({x:82,y:60},1);
  assert.ok(Math.abs(x-82)<=3);
  assert.ok(reports.length>=2);
  assert.ok(reports.every(([dx,dy,b])=>dx>0 && !dy && b===1));
  assert.ok(reports[0][0]<=6);
});

test('held dragging releases control to the caller when no motion is visible',async()=>{
  const reports=[];
  const aligned={position:{x:30,y:40,w:9,h:9},gain:.3,width:180,height:120};
  const drag=createHeldMover(aligned,async()=>frame(30,40),async(x,y)=>{reports.push({x,y});},()=>{});
  await assert.rejects(drag({x:130,y:40},1),/拖动/);
  assert.equal(reports.length,1);
  assert.ok(reports[0].x<=6);
});

test('a low-contrast slider thumb supplies held feedback while the cursor is hidden',async()=>{
  let x=55;
  const sample=async()=>{
    const width=180,height=100,data=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++) for(let i=0;i<width;i++)
      data[(y*width+i)*4]=Math.hypot(i-x,y-50)<=7 ? 225 : 202;
    return {width,height,data};
  };
  const drag=createHeldMover({position:{x,y:50,w:10,h:10},gain:.5,width:180,height:100},sample,
    async(dx)=>{x+=dx*2;},()=>{});
  await drag({x:98,y:50},1);
  assert.ok(Math.abs(x-98)<=3);
});

test('a scrolling page cannot impersonate a slider thumb',async()=>{
  let offset=0,reports=0;
  const sample=async()=>{
    const width=180,height=100,data=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++) for(let i=0;i<width;i++)
      data[(y*width+i)*4]=((i-offset+180)*89 + y*13 + (i-offset+180)*y*19)%245;
    return {width,height,data};
  };
  const drag=createHeldMover({position:{x:60,y:50,w:10,h:10},gain:1,width:180,height:100},sample,
    async(dx)=>{offset+=dx; reports++;},()=>{});
  await assert.rejects(drag({x:110,y:50},1),/拖动/);
  assert.equal(reports,1);
});

test('tiny intermediate waypoints are deferred and a live stationary thumb can cross its activation threshold',async()=>{
  let x=45,effort=0,active=false,serial=0;
  const reports=[];
  const sample=async()=>({...frame(x,40),serial:++serial});
  const drag=createHeldMover({position:{x,y:40,w:9,h:9},gain:1,width:180,height:120},sample,
    async(dx,dy)=>{
      assert.equal(dy,0);
      reports.push(dx); effort+=dx;
      if (active || effort>=9) {active=true; x+=dx*2;}
    },()=>{});
  await drag({x:50,y:40},1,{intermediate:true});
  assert.deepEqual(reports,[]);
  await drag({x:108,y:40},1);
  assert.ok(Math.abs(x-108)<=3);
  assert.ok(reports.every(n=>n>0));
});

test('a live but unresponsive slider receives only bounded startup movement',async()=>{
  let serial=0;
  const reports=[];
  const drag=createHeldMover({position:{x:40,y:40,w:9,h:9},gain:1,width:180,height:120},
    async()=>({...frame(40,40),serial:++serial}),async(dx)=>reports.push(dx),()=>{});
  await assert.rejects(drag({x:140,y:40},1),/拖动/);
  assert.ok(reports.length>=2 && reports.length<=3);
  assert.ok(reports.reduce((sum,n)=>sum+Math.abs(n),0)<=12);
});

test('a close final waypoint is still verified after being deferred as an intermediate point',async()=>{
  let x=45;
  const drag=createHeldMover({position:{x,y:40,w:9,h:9},gain:1,width:180,height:120},
    async()=>frame(x,40),async(dx)=>{x+=dx*2;},()=>{});
  await drag({x:54,y:40},1,{intermediate:true});
  assert.equal(x,45);
  await drag({x:54,y:40},1);
  assert.ok(Math.abs(x-54)<=3);
});

function homeScreen(x,y,phase,extra=[]) {
  const width=240,height=160,data=new Uint8ClampedArray(width*height*4);
  for (let j=0;j<height;j++) for (let i=0;i<width;i++) {
    const at=(j*width+i)*4;
    const icon=(i%37<24 && j%41<24);
    const clock=i>160 && i<220 && j>8 && j<54;
    const tint=[[x,y],...extra].some(([cx,cy])=>Math.hypot(i-cx,j-cy)<=5) ? 15 : 0;
    for (let c=0;c<3;c++) {
      const texture=(i*7+j*3+c*19)%50;
      data[at+c]=(icon ? 58 : 99)+texture+tint+(clock ? (phase%2)*64 : (phase+i)%3);
    }
  }
  return {width,height,data,serial:phase};
}

test('faint round pointer on textured icons is found despite a large animated clock elsewhere',()=>{
  const a=homeScreen(42,88,0),b=homeScreen(102,92,1);
  const old={x:42,y:88,w:11,h:11};
  const landing={target:{x:108,y:92},predicted:{x:106,y:94}};
  const found=movedPointer(a.data,b.data,240,160,{x:60,y:4},old,landing);
  assert.ok(found && Math.hypot(found.to.x-102,found.to.y-92)<1);
  assert.ok(movedPointer(a.data,b.data,240,160,{x:60,y:4},null),'cold acquisition');
});

test('ambiguous faint shapes near the expected landing leave the click unconfirmed',()=>{
  const a=homeScreen(42,88,0),b=homeScreen(104,88,1,[[86,88]]);
  const old={x:42,y:88,w:11,h:11};
  const landing={target:{x:100,y:88},predicted:{x:98,y:88}};
  assert.equal(movedPointer(a.data,b.data,240,160,{x:60,y:0},old,landing),null);
});

test('unrecoverable cold acquisition has a small bounded movement budget',async()=>{
  let distance=0,count=0;
  await assert.rejects(aimPointer({x:130,y:78},async()=>frame(-50,-50),
    async(dx,dy)=>{count++;distance+=Math.hypot(dx,dy);},()=>{}));
  assert.ok(count<=3 && distance<=83,`sent ${count} reports totalling ${distance} HID units`);
});

test('a faint footprint hidden between two clicks cannot authorize a zero-movement repeat',async()=>{
  let x=30,y=63,serial=0;
  const sample=async()=>homeScreen(x,y,serial);
  const move=async(dx,dy)=>{x+=dx;y+=dy;serial++;};
  const target={x:110,y:81};
  const cached=await aimPointer(target,sample,move,()=>{});
  x=32;y=76;serial++;
  const hit=await aimPointer(target,sample,move,()=>{},cached);
  assert.ok(hit.reports>0 && Math.hypot(hit.position.x-target.x,hit.position.y-target.y)<=4);
});

test('travel uses calibrated packet sizes when iPad gain jumps on large reports',async()=>{
  let x=15,y=80,serial=0;
  const path=[];
  const sample=async()=>homeScreen(x,y,serial);
  const move=async(dx,dy)=>{
    const gain=Math.max(Math.abs(dx),Math.abs(dy))>64 ? 4 : 1;
    x=Math.min(239,Math.max(0,x+gain*dx));y=Math.min(159,Math.max(0,y+gain*dy));
    path.push(x);serial++;
  };
  const hit=await aimPointer({x:198,y:80},sample,move,()=>{});
  assert.ok(Math.hypot(hit.position.x-198,hit.position.y-80)<=4);
  assert.ok(path.every((px,i)=>px<=198 && (!i||px>=path[i-1])));
});

function hiddenRepeatFixture() {
  let x=60,y=64,visible=true,ambiguous=false,serial=0;
  const moves=[];
  const sample=async()=>({...frame(visible?x:-50,visible?y:-50,ambiguous && visible ? [[x,y+13]] : []),serial});
  const move=async(dx,dy)=>{moves.push([dx,dy]);x+=dx;y+=dy;visible=true;serial++;};
  const target={x:78,y:60};
  return {
    target,moves,sample,move,
    hide(px=x,py=y,two=false){x=px;y=py;visible=false;ambiguous=two;serial++;moves.length=0;},
    actual(){return {x,y};}
  };
}
test('a repeat at an auto-hidden cursor is verified with short wake and return movements',async()=>{
  const f=hiddenRepeatFixture();
  const cache=await aimPointer(f.target,f.sample,f.move,()=>{});
  cache.observedAt-=20000;
  f.hide();
  const result=await aimPointer(f.target,f.sample,f.move,()=>{},cache);
  assert.ok(result.reports>=2 && result.reports<=3);
  assert.ok(f.moves.every(([x,y])=>Math.hypot(x,y)<=15));
  assert.ok(Math.hypot(f.actual().x-f.target.x,f.actual().y-f.target.y)<=4);
});

test('two newly appearing round indicators cannot authorize an auto-hidden repeat',async()=>{
  const f=hiddenRepeatFixture();
  const cache=await aimPointer(f.target,f.sample,f.move,()=>{});
  cache.observedAt-=20000;
  f.hide(cache.position.x,cache.position.y,true);
  await assert.rejects(aimPointer(f.target,f.sample,f.move,()=>{},cache));
  assert.ok(f.moves.length<=2);
});

test('an externally displaced hidden cursor must be re-observed before completing a repeat',async()=>{
  const f=hiddenRepeatFixture();
  const cache=await aimPointer(f.target,f.sample,f.move,()=>{});
  cache.observedAt-=20000;
  f.hide(18,32);
  const result=await aimPointer(f.target,f.sample,f.move,()=>{},cache);
  assert.ok(result.reports>=2);
  assert.ok(Math.hypot(f.actual().x-f.target.x,f.actual().y-f.target.y)<=4);
});
