'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {findConnectedAccessoryInfo,findAccessoryNameDone,findAuditedSeBluetoothSwitch,createBluetoothCycleObserver}=require('./accessory-validation.hardware');

function screenshot(symbols) {
  const width=600,height=800,data=new Uint8ClampedArray(width*height*4).fill(255);
  for (const [cx,cy,letter] of symbols)
    for (let dy=-12;dy<=12;dy++) for (let dx=-12;dx<=12;dx++) {
      const radius=Math.hypot(dx,dy);
      const glyph=letter==='i' && Math.abs(dx)<=1 && ((dy>=-5 && dy<=-3) || (dy>=0 && dy<=5));
      if ((radius>=9 && radius<=11) || glyph) data.set([0,122,255,255],4*((cy+dy)*width+cx+dx));
    }
  return {width,height,data};
}
const row = [{label:'bluetooth',x:200,y:45},{label:'computer',x:100,y:200},{label:'connected',x:483,y:200}];
test('only a fully visible SE paired list with every info row accounted for and a unique on switch passes',()=>{
  const width=450,height=800;
  const input=screenshot([[398,264,'i'],[398,320,'i']]);
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++) data.set(input.data.subarray(4*y*input.width,4*(y*input.width+width)),4*y*width);
  const image={width,height,data}, px=(x,y,color)=>data.set(color,4*(y*width+x));
  function toggle(cy,right=true) {
    for(let y=-13;y<=13;y++) for(let x=-23;x<=23;x++) {
      if (Math.hypot(Math.max(0,Math.abs(x)-10),y)>13) continue;
      px(396+x,cy+y,Math.hypot(x-(right?10:-10),y)<=10 ? [255,255,255,255] : [40,194,95,255]);
    }
  }
  toggle(128);
  const labels=[{label:'bluetooth',x:225,y:48},{label:'bluetooth',x:60,y:128},
    {label:'my-devices',x:62,y:222},{label:'other-devices',x:62,y:385},{label:'computer',x:65,y:264},
    {label:'connected',x:350,y:264},{label:'not-connected',x:350,y:320}];
  assert.deepEqual(findAuditedSeBluetoothSwitch(labels,image),{x:396,y:128});
  for(const absent of ['other-devices','my-devices','connected','not-connected','computer'])
    assert.equal(findAuditedSeBluetoothSwitch(labels.filter(p=>p.label!==absent),image),null);
  assert.equal(findAuditedSeBluetoothSwitch(labels.map(p=>p.label==='not-connected'?{...p,label:'connected'}:p),image),null);
  toggle(128,false);
  assert.equal(findAuditedSeBluetoothSwitch(labels,image),null);
  toggle(128);toggle(166);
  assert.equal(findAuditedSeBluetoothSwitch(labels,image),null);
});
function toolbar(background,glyph) {
  const image=screenshot([]), cx=550,cy=60;
  function pixel(x,y,blue) {image.data.set(blue?[0,122,255,255]:[255,255,255,255],4*(y*image.width+x));}
  if (background) for (let y=-18;y<=18;y++) for(let x=-18;x<=18;x++) if(Math.hypot(x,y)<=18) pixel(cx+x,cy+y,true);
  for(let x=-10;x<=10;x++) {
    const y=glyph==='tick' ? (x<=-3 ? (x+10)*5/7 : 5-(x+3)*13/13) : glyph==='v' ? 7-Math.abs(x) : 0;
    for(let dy=-1;dy<=1;dy++) pixel(cx+x,cy+Math.round(y)+dy,!background);
  }
  return image;
}
test('a name editor toolbar requires the two unequal arms of a single check mark',()=>{
  const title={label:'name',x:300,y:60};
  for (const disc of [false,true]) {
    assert.ok(findAccessoryNameDone(toolbar(disc,'tick'),title));
    for (const shape of ['v','dash']) assert.equal(findAccessoryNameDone(toolbar(disc,shape),title),null);
  }
  const image=toolbar(true,'tick');
  image.data.set([0,122,255,255],4*(60*image.width+499));
  assert.equal(findAccessoryNameDone(image,title),null);
  assert.equal(findAccessoryNameDone(toolbar(true,'tick'),{...title,label:'bluetooth'}),null);
  assert.equal(findAccessoryNameDone(toolbar(true,'tick'),{...title,y:300}),null);
});
test('same-name advertisements below the single connected accessory do not hide its detail action',()=>{
  const others=[310,370,430,490].map(y=>({label:'computer',x:100,y}));
  assert.deepEqual(findConnectedAccessoryInfo([...row,...others],screenshot([[550,200,'i'],[550,310,'i']])),{x:550,y:200});
});
test('two connected same-name rows or conflicting indications cannot select a detail action',()=>{
  const image=screenshot([[550,200,'i'],[550,310,'i']]);
  assert.equal(findConnectedAccessoryInfo([...row,{label:'computer',x:100,y:310},{label:'connected',x:483,y:310}],image),null);
  assert.equal(findConnectedAccessoryInfo([...row,{label:'not-connected',x:483,y:200}],image),null);
});
test('only a complete information glyph to the right of the exact connected row is actionable',()=>{
  assert.deepEqual(findConnectedAccessoryInfo(row,screenshot([[550,200,'i'],[550,240,'i']])),{x:550,y:200});
  assert.equal(findConnectedAccessoryInfo(row,screenshot([[550,200,'circle']])),null);
  assert.equal(findConnectedAccessoryInfo(row,screenshot([[550,240,'i']])),null);
  assert.equal(findConnectedAccessoryInfo(row,screenshot([[530,200,'i'],[575,200,'i']])),null);
  assert.equal(findConnectedAccessoryInfo([...row,row[1]],screenshot([[550,200,'i']])),null);
  assert.equal(findConnectedAccessoryInfo(row.filter(hit=>hit.label!=='connected'),screenshot([[550,200,'i']])),null);
});
const old = {id:'first',boundDeviceId:'A'}, other = {id:'second',boundDeviceId:'B'};
const fresh = {id:'new',boundDeviceId:null};
const status = (peers,verifiedPeerId=null) => ({peers,activeDeviceId:'A',verifiedPeerId,needsPairing:!verifiedPeerId});
async function observe(steps,options={},initial=[old,other]) {
  const observations = [status(initial,old.id),...steps];
  let index=0;
  const observer=await createBluetoothCycleObserver(async()=>observations[Math.min(index++,observations.length-1)],
    'A',old.id,{intervalMs:1,timeoutMs:600,...options});
  return observer.done;
}
test('a reconnect requires an observed gap, continuity of the other receiver, and a new USB proof',async()=>{
  const phases=[];
  const result=await observe([status([other]),status([other,fresh]),status([other,{...fresh,boundDeviceId:'A'}],fresh.id)],
    {onPhase:phase=>phases.push(phase)});
  assert.deepEqual(phases,['disconnected','reappeared','verified']);
  assert.equal(result.verified,true);
});
test('three baseline receivers may survive USB rebinding; positive proof identifies the correct new candidate',async()=>{
  const extra={id:'third',boundDeviceId:null}, unboundOther={...other,boundDeviceId:null};
  const unrelated={id:'fourth',boundDeviceId:null};
  const result=await observe([status([unboundOther,extra]),status([unboundOther,extra,unrelated,fresh]),
    status([unboundOther,extra,unrelated,{...fresh,boundDeviceId:'A'}],fresh.id)],
    {otherUsbId:'B',otherPeerId:other.id},[old,unboundOther,extra]);
  assert.equal(result.verified,true);
  assert.equal(result.newPeerId,fresh.id);
});
test('losing any baseline receiver, including an unbound third receiver, fails the single-target cycle',async()=>{
  const extra={id:'third',boundDeviceId:null};
  for (const retained of [[other],[extra]]) {
    const result=await observe([status(retained)],{otherUsbId:'B',otherPeerId:other.id},[old,other,extra]);
    assert.equal(result.phase,'incomplete');
  }
});
test('an ambiguous replacement, stale handle, or simultaneous loss cannot pass a hardware cycle',async()=>{
  for (const steps of [
    [status([other,fresh])], [status([])], [status([other]),status([other,old])],
    [status([other]),status([other,fresh]),status([other,{...fresh,id:'different'}])]
  ]) {
    const result=await observe(steps);
    assert.equal(result.phase,'incomplete'); assert.ok(result.error);
  }
});
