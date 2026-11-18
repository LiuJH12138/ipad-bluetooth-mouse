'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BluetoothBridge } = require('./lib/bluetooth');
const { UsbVideo } = require('./lib/usb-video');

function createApp({ bridge, token, now = Date.now, publishAssistant }) {
  const usb = new UsbVideo();
  let lease = null, frame = null;
  let assistant = null;
  const assistantRoutes = new Set(['GET /api/status','GET /api/frame','POST /api/control/start','POST /api/control/stop','POST /api/input','POST /api/assistant/sample']);
  function revokeAssistant() {
    if (!assistant) return;
    assistant.sample?.cancel();
    const presence = assistant.presence;
    assistant = null;
    presence?.end();
    if (lease?.assistant) release();
    publishAssistant(server.address()?.port, null);
  }
  function release() { lease = null; bridge.release(); }
  function expire() {
    if (lease && (now() - lease.time > 1200 || bridge.active !== 1 ||
        (lease.usedAbsolute && bridge.absoluteActive !== 1))) release();
    if (frame && now() - frame.time > 4000) frame = null;
    if (assistant && !assistant.presence && now() - assistant.seen > 4000) revokeAssistant();
  }
  const timer = setInterval(expire, 200); timer.unref();
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  async function body(req, limit) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > limit) { const e = new Error('请求过大'); e.status = 413; throw e; } chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'");
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: '仅允许本机页面访问。' });
    const pathname = new URL(req.url, origin).pathname;
    if (!pathname.startsWith('/api/')) {
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/keyboard.js': ['keyboard.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      assets['/usb-video.js'] = ['usb-video.js', 'text/javascript'];
      assets['/pointing.js'] = ['pointing.js', 'text/javascript'];
      assets['/absolute-pointer.js'] = ['absolute-pointer.js', 'text/javascript'];
      assets['/mouse-gestures.js'] = ['mouse-gestures.js', 'text/javascript'];
      assets['/console.ico'] = ['console.ico', 'image/x-icon'];
      if (req.method !== 'GET' || !Object.hasOwn(assets, pathname)) return json(res, 404, { error: 'Not found' });
      const [file, type] = assets[pathname]; res.setHeader('Content-Type', type.startsWith('text/') ? type + '; charset=utf-8' : type);
      fs.createReadStream(path.join(__dirname, 'web', file)).pipe(res); return;
    }
    expire();
    const isAssistant = !!req.headers['x-assistant-token'];
    const credential = isAssistant ? assistant?.token : token;
    if (!credential) return json(res, 401, { error: '助手控制未开启或已过期。' });
    const provided = Buffer.from(req.headers[isAssistant ? 'x-assistant-token' : 'x-control-token'] || ''); const expected = Buffer.from(credential);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return json(res, 401, { error: '请通过项目启动器打开控制台。' });
    if (isAssistant && !assistantRoutes.has(req.method + ' ' + pathname)) return json(res, 403, { error: '该操作需要控制台授权。' });
    try {
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ...bridge.snapshot(), controlling: !!lease, frameAvailable: !!frame, assistantEnabled: !!assistant, fullscreen: !!frame?.fullscreen,
        picture: frame && frame.view === assistant?.view ? frame.picture : undefined });
      if (req.method === 'GET' && pathname === '/api/frame') {
        if (!frame || (isAssistant && frame.view !== assistant.view)) return json(res, 404, { error: '尚未允许画面读取，或画面已过期。' });
        res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('X-Frame-Age-Ms', String(now() - frame.time)); res.end(frame.bytes); return;
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (pathname === '/api/assistant/pixels') {
        const owner = assistant, sample = owner?.sample;
        if (!sample || req.headers['x-sample-id'] !== sample.id || req.headers['x-assistant-view'] !== owner.view)
          return json(res,409,{error:'画面请求已过期。'});
        const w = Number(req.headers['x-width']), h = Number(req.headers['x-height']);
        if (![w,h].every(n=>Number.isInteger(n) && n>=2 && n<=840)) return json(res,400,{error:'无效画面尺寸。'});
        const bytes = await body(req, w*h*4);
        if (bytes.length !== w*h*4 || assistant !== owner || owner.sample !== sample) return json(res,409,{error:'画面请求已过期。'});
        if (sample.layout !== req.headers['x-layout']) return json(res,409,{error:'画面方向已改变。'});
        sample.done({bytes,w,h,serial:req.headers['x-serial']});
        return json(res,200,{ok:true});
      }
      if (pathname === '/api/usb/video') { await usb.stream(res); return; }
      if (pathname === '/api/frame') {
        const bytes = await body(req, 2 * 1024 * 1024);
        if (req.headers['content-type'] !== 'image/jpeg' || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return json(res, 400, { error: '无效 JPEG' });
        const picture = {layout:req.headers['x-layout'],width:Number(req.headers['x-width']),height:Number(req.headers['x-height']),verified:req.headers['x-verified']==='true'};
        frame = { bytes, picture, time: now(), fullscreen: req.headers['x-view-mode'] === 'fullscreen', view: req.headers['x-assistant-view'] };
        if (assistant && req.headers['x-assistant-view'] === assistant.view) assistant.seen = now();
        return json(res, 200, { ok: true });
      }
      const data = JSON.parse((await body(req, 4096)).toString() || '{}');
      expire();
      if (isAssistant && (assistant?.token !== credential || (pathname !== '/api/control/stop' && frame?.view !== assistant?.view))) return json(res, 409, { error: '等待已授权窗口恢复实时画面。' });
      if (pathname === '/api/assistant/presence') {
        if (!assistant || assistant.view !== data.view || assistant.presence) return json(res,409,{error:'分享窗口已更改。'});
        const owner = assistant;
        owner.presence = res;
        res.writeHead(200, {'Content-Type':'text/plain', 'Cache-Control':'no-store'});
        res.write('sharing\n');
        res.once('close', () => { if (assistant === owner) revokeAssistant(); });
        return;
      }
      if (pathname === '/api/assistant/enable') {
        if (!publishAssistant) return json(res, 409, { error: '当前服务未配置助手入口。' });
        revokeAssistant();
        const next = { token: crypto.randomBytes(32).toString('hex'), view: crypto.randomUUID(), seen: now() };
        publishAssistant(server.address().port, next.token);
        assistant = next; frame = null;
        return json(res, 200, { view: next.view });
      }
      if (pathname === '/api/assistant/disable') { revokeAssistant(); frame = null; return json(res, 200, {ok:true}); }
      if (pathname === '/api/frame/clear') { frame = null; return json(res, 200, { ok: true }); }
      if (pathname === '/api/connect') { return json(res, 200, await bridge.connect()); }
      if (pathname === '/api/disconnect') { release(); await bridge.close(); return json(res, 200, bridge.snapshot()); }
      if (pathname === '/api/control/start') {
        if (lease) return json(res, 409, { error: '另一个页面正在控制，请先停止。' });
        if (bridge.active !== 1) return json(res, 409, { error: '请先连接一台 iPad。' });
        lease = { id: crypto.randomUUID(), time: now(), seq: 0, assistant: isAssistant }; return json(res, 200, { lease: lease.id });
      }
      if (!lease || data.lease !== lease.id || lease.assistant !== isAssistant) return json(res, 409, { error: '控制已释放，请重新开始。' });
      if (data.layout && data.layout !== frame?.picture.layout) return json(res,409,{error:'画面已改变，请重新读取。'});
      if (pathname === '/api/assistant/sample' && isAssistant) {
        const owner = assistant;
        if (!owner.presence || owner.sample) return json(res,409,{error:'等待当前分享窗口。'});
        const id = crypto.randomUUID();
        lease.time = now();
        const pixels = await new Promise(resolve => {
          const timer = setTimeout(()=>done(null),900);
          function done(value) { clearTimeout(timer); owner.sample=null; resolve(value); }
          owner.sample = {id,layout:data.layout,done,cancel:()=>done(null)};
          owner.presence.write(id+'\n');
        });
        expire();
        if (!pixels || lease?.id !== data.lease || assistant !== owner || frame?.view !== owner.view)
          return json(res,409,{error:'无法取得当前 USB 指针画面。'});
        res.writeHead(200,{'Content-Type':'application/octet-stream','X-Width':pixels.w,'X-Height':pixels.h,'X-Serial':pixels.serial});
        res.end(pixels.bytes);
        return;
      }
      if (pathname === '/api/control/stop') { release(); return json(res, 200, { ok: true }); }
      if (pathname === '/api/heartbeat') { lease.time = now(); return json(res, 200, { ok: true }); }
      if (pathname === '/api/input') {
        const { seq } = data;
        if(!Number.isSafeInteger(seq) || seq <= lease.seq) return json(res,400,{error:'过期输入'});
        let accepted;
        if(data.kind === 'keyboard') {
          const { modifiers,keys }=data;
          if(!Number.isSafeInteger(modifiers)||modifiers<0||modifiers>255||!Array.isArray(keys)||keys.length>6||new Set(keys).size!==keys.length||keys.some(k=>!Number.isSafeInteger(k)||k<4||k>101)) return json(res,400,{error:'无效键盘报告'});
          if(bridge.keyboardActive!==1) return json(res,409,{error:'键盘尚未连接。升级后请在 iPad 忽略旧蓝牙设备并重新配对。'});
          accepted=bridge.keys(modifiers,keys);
        } else if(data.kind === 'absolute') {
          const {buttons,x,y}=data;
          if (![buttons,x,y].every(Number.isSafeInteger) || buttons<0 || buttons>7 ||
              x<0 || x>32767 || y<0 || y>32767) return json(res,400,{error:'无效绝对坐标报告'});
          if (bridge.absoluteActive!==1) return json(res,409,{error:'当前 iPad 未订阅绝对坐标报告。'});
          lease.usedAbsolute = true;
          accepted=bridge.absolute(buttons,x,y);
        } else {
          const {buttons,x,y,wheel}=data;
          if(![buttons,x,y,wheel].every(Number.isSafeInteger)||buttons<0||buttons>7||[x,y,wheel].some(n=>Math.abs(n)>127)) return json(res,400,{error:'无效鼠标报告'});
          accepted=bridge.report(buttons,x,y,wheel);
        }
        lease.seq=seq;lease.time=now();
        if (data.kind === 'absolute') {
          accepted = await accepted;
          if (lease?.id !== data.lease) return json(res,409,{error:'控制已释放。'});
        }
        if(!accepted){release();return json(res,409,{error:'蓝牙繁忙或断开，已释放控制。'});}
        if (isAssistant || data.settle === true) {
          while (lease?.id === data.lease && (bridge.pending || bridge.queue?.length)) {
            await new Promise(resolve => setTimeout(resolve, 10));
            expire();
          }
          if (lease?.id !== data.lease) return json(res,409,{error:'蓝牙输入未完成，请检查画面。'});
        }
        return json(res,200,{ok:true});
      }      return json(res, 404, { error: 'Not found' });
    } catch (e) { json(res, e.status || 400, { error: e.message }); }
  });
  server.on('close', () => { clearInterval(timer); revokeAssistant(); release(); frame = null; });
  return { server, expire, stopCapture: () => usb.stopCapture?.() };
}
if (require.main === module) {
  // An explicit developer restart can preserve an already-approved browser share.
  const resume = process.argv.includes('--resume-local-session')
    ? JSON.parse(fs.readFileSync(path.join(__dirname, '.local', 'session.json'), 'utf8')) : null;
  if (resume && (!/^[a-f0-9]{64}$/.test(resume.token) || !Number.isInteger(resume.port) || resume.port < 1024 || resume.port > 65535)) throw new Error('Invalid local session');
  const token = resume ? resume.token : crypto.randomBytes(32).toString('hex');
  const bridge = new BluetoothBridge(path.join(__dirname, 'IpadBluetoothMouse.ps1'));
  const desktop = process.argv.includes('--desktop');
  const assistantDirectory = path.join(process.env.LOCALAPPDATA || path.join(__dirname,'.local'), 'iPadControlConsole', 'assistant');
  let assistantFile;
  function publishAssistant(port, key) {
    if (!key) { if (assistantFile) fs.rmSync(assistantFile, {force:true}); return; }
    fs.mkdirSync(assistantDirectory, {recursive:true, mode:0o700});
    assistantFile = path.join(assistantDirectory, port + '.json');
    fs.writeFileSync(assistantFile, JSON.stringify({port, key}), {mode:0o600});
  }
  const { server, stopCapture } = createApp({ bridge, token, publishAssistant });
  server.listen(resume ? resume.port : 0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/#${token}`;
    if (desktop) {
      // The desktop host receives the session privately through its child process pipe.
      process.stdout.write(url + '\n');
      return;
    }
    fs.mkdirSync(path.join(__dirname, '.local'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '.local', 'session.json'), JSON.stringify({ pid: process.pid, port, token, url }));
    console.log('iPad console is listening on loopback.');
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    stopCapture();
    await bridge.close();
    server.close();
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  if (desktop) {
    process.stdin.once('end', shutdown);
    process.stdin.resume();
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
module.exports = { createApp };
