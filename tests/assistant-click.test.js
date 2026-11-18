'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {clickPointer} = require('../lib/assistant-click');
const {absoluteCoordinates} = require('../web/absolute-pointer');

function device() {
  const status = {absoluteActive:1,picture:{width:320,height:240,verified:true,layout:'1'}};
  const reports = [];
  let x = 50, y = 40, serial = 0;
  function sample() {
    const data = new Uint8Array(160*120*4);
    for (let j=y-4;j<=y+4;j++) for (let i=x-4;i<=x+4;i++)
      if (Math.hypot(i-x,j-y)<=4) data[(j*160+i)*4]=150;
    return {width:160,height:120,serial:++serial,data};
  }
  function send(report) {
    reports.push(report);
    if (report.kind !== 'absolute') { x+=report.x; y+=report.y; }
  }
  return {status,reports,send,sample};
}

test('bare assistant click presses and releases at the observed pre-probe position', async () => {
  const d = device();
  await clickPointer([],d.status,d.send,d.sample);
  const position = absoluteCoordinates({x:50,y:40},160,120);
  assert.deepEqual(d.reports.slice(-3),[0,1,0].map(buttons=>({kind:'absolute',...position,buttons})));
  assert.equal(d.reports.filter(r=>r.buttons).length,1);
});

test('assistant coordinates use the JPEG pixel grid and reject out-of-frame clicks', async () => {
  const d = device();
  await assert.rejects(clickPointer(['320','50'],d.status,d.send,d.sample));
  assert.deepEqual(d.reports,[]);
  await clickPointer(['319','239'],d.status,d.send,d.sample);
  assert.deepEqual(d.reports,[0,1,0].map(buttons=>({kind:'absolute',x:32767,y:32767,buttons})));
});
