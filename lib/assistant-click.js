'use strict';
const {absoluteCoordinates, verifyAbsolutePointer} = require('../web/absolute-pointer');
const {movedPointer} = require('../web/pointing');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function clickPointer(args, status, send, sample) {
  const {picture} = status;
  const absolute = status.absoluteActive === 1 && !!picture?.layout;
  if (args.length && (!absolute || args.length !== 2 || !args.every(v => /^\d+$/.test(v))))
    throw Error('坐标点击需要 USB 画面和已连接的绝对指针，格式为 click X Y（回传 JPEG 像素）。');
  const mouse = (x,y,buttons=0) => send({x,y,buttons,wheel:0});
  let press = buttons => mouse(0,0,buttons);
  if (absolute) {
    let target;
    if (args.length) {
      const [x,y] = args.map(Number);
      if (x >= picture.width || y >= picture.height) throw Error('点击坐标超出回传画面。');
      target = absoluteCoordinates({x,y}, picture.width, picture.height);
    }
    const first = await sample();
    const {width,height} = first;
    const place = (x,y,buttons=0) => send({kind:'absolute',x,y,buttons});
    if (!target) {
      // Wake a hidden pointer, then identify its original footprint from a
      // small reversible move. Never click an estimated or ambiguous position.
      await mouse(1,0); await mouse(-1,0); await wait(180);
      for (const dx of [20,-20]) {
        const before = await sample();
        await mouse(dx,0);
        try {
          for (let i=0;i<5 && !target;i++) {
            await wait(60);
            const after = await sample();
            if (after.serial === before.serial) continue;
            const match = movedPointer(before.data,after.data,width,height,{x:dx,y:0},null);
            if (match) target = absoluteCoordinates(match.from,width,height);
          }
        } finally { await mouse(-dx,0); }
        if (target) break;
      }
      if (!target) throw Error('无法确认当前指针位置，请用 frame 读取画面，然后用 click X Y 点击目标。');
    }
    if (!picture.verified) {
      await verifyAbsolutePointer({width,height,sample,send:place,validate(){}});
    }
    await place(target.x,target.y);
    press = buttons => place(target.x,target.y,buttons);
  }
  await press(1);
  try { await wait(70); } finally { await press(0); }
}
module.exports = {clickPointer};
