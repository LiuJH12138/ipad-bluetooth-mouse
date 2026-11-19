'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { KeyboardState } = require('./web/keyboard');
const { clickPointer } = require('./lib/assistant-click');

async function run([command, ...args]) {
  const directory = path.join(process.env.LOCALAPPDATA || path.join(__dirname,'.local'), 'iPadControlConsole','assistant');
  const sessions = [];
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
    if (!/^\d{1,5}\.json$/.test(name)) continue;
    try {
      const {key,port} = JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(key)) continue;
      async function request(route, body) {
        const response = await fetch('http://127.0.0.1:' + port + '/api/' + route, {
          method: body === undefined ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.timeout(3500),
          headers:{'X-Assistant-Token':key,'Content-Type':'application/json'}, body: JSON.stringify(body)
        });
        if (!response.ok) throw Error((await response.json()).error);
        return response;
      }
      const status = await (await request('status')).json();
      sessions.push({request,status});
    } catch { /* Closed or expired session. */ }
  }
  if (sessions.length !== 1) throw Error('请在一个正在投屏的控制台窗口中点「允许助手控制」。');
  const {request} = sessions[0];
  let {status} = sessions[0];
  if (command === 'status') { console.log(JSON.stringify(status)); return; }
  if (command === 'frame' && args.length === 1) {
    const data = await (await request('frame')).arrayBuffer();
    fs.writeFileSync(args[0], Buffer.from(data));
    return;
  }
  const reports = [];
  const keyboard = new KeyboardState();
  function chord(codes) {
    for (const code of codes) {
      const report = keyboard.change(code,true);
      if (!report) throw Error('未知物理键位：' + code);
    }
    reports.push({kind:'keyboard',...keyboard.report()}, {kind:'keyboard',...keyboard.clear()});
  }
  function mouse(x,y,wheel,buttons=0) { reports.push({x,y,wheel,buttons}); }
  function number(s,limit) {
    if (!/^-?\d+$/.test(s) || Math.abs(Number(s))>limit) throw Error('无效位移或滚轮值');
    return Number(s);
  }
  if (command === 'key' && args.length && args.length<=6) chord(args);
  else if (command === 'type' && args.length === 1 && /^[a-zA-Z0-9 ]{1,120}$/.test(args[0])) {
    for (const ch of args[0]) {
      if (ch === ' ') chord(['Space']);
      else if (/\d/.test(ch)) chord(['Digit'+ch]);
      else chord((/[A-Z]/.test(ch) ? ['ShiftLeft'] : []).concat('Key'+ch.toUpperCase()));
    }
  } else if (command === 'click' && (args.length===0 || args.length===2)) { /* Sent under the lease below. */ }
  else if (command === 'scroll' && args.length === 1) mouse(0,0,number(args[0],127));
  else if (command === 'move' && args.length === 2) {
    let x=number(args[0],2048), y=number(args[1],2048);
    while (x || y) {
      const stepX=Math.max(-127,Math.min(127,x)), stepY=Math.max(-127,Math.min(127,y));
      mouse(stepX,stepY,0); x-=stepX; y-=stepY;
    }
  } else throw Error('用法：status | frame <jpeg> | move <dx> <dy> | click [X Y] | scroll <n> | key <物理键位...> | type <英文字母、空格或数字>');
  const {lease} = await (await request('control/start',{})).json();
  try {
    status=await (await request('status')).json();
    let seq = 0;
    const layout = command === 'click' ? status.picture?.layout : undefined;
    const send = report => request('input',{lease,layout,seq:++seq,...report});
    if (command === 'click') {
      await clickPointer(args,status,send,async () => {
        const res = await request('assistant/sample',{lease,layout});
        return {width:Number(res.headers.get('X-Width')),height:Number(res.headers.get('X-Height')),
          serial:Number(res.headers.get('X-Serial')),data:new Uint8Array(await res.arrayBuffer())};
      });
    } else for (const report of reports) await send(report);
  } finally { await request('control/stop',{lease}).catch(()=>{}); }
}
run(process.argv.slice(2)).catch(error=>{ console.error(error.message); process.exitCode=1; });
