'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BluetoothBridge } = require('./lib/bluetooth');
const { UsbVideo } = require('./lib/usb-video');

function createApp({ bridge, token, now = Date.now }) {
  const usb = new UsbVideo();
  let lease = null, frame = null;
  function release() { lease = null; bridge.release(); }
  function expire() { if (lease && (now() - lease.time > 1200 || bridge.active !== 1)) release(); if (frame && now() - frame.time > 4000) frame = null; }
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
      assets['/console.ico'] = ['console.ico', 'image/x-icon'];
      if (req.method !== 'GET' || !Object.hasOwn(assets, pathname)) return json(res, 404, { error: 'Not found' });
      const [file, type] = assets[pathname]; res.setHeader('Content-Type', type.startsWith('text/') ? type + '; charset=utf-8' : type);
      fs.createReadStream(path.join(__dirname, 'web', file)).pipe(res); return;
    }
    const provided = Buffer.from(req.headers['x-control-token'] || ''); const expected = Buffer.from(token);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return json(res, 401, { error: '请通过项目启动器打开控制台。' });
    try {
      expire();
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ...bridge.snapshot(), controlling: !!lease, frameAvailable: !!frame });
      if (req.method === 'GET' && pathname === '/api/frame') {
        if (!frame) return json(res, 404, { error: '尚未允许画面读取，或画面已过期。' });
        res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('X-Frame-Age-Ms', String(now() - frame.time)); res.end(frame.bytes); return;
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (pathname === '/api/usb/video') { await usb.stream(res); return; }
      if (pathname === '/api/frame') {
        const bytes = await body(req, 2 * 1024 * 1024);
        if (req.headers['content-type'] !== 'image/jpeg' || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return json(res, 400, { error: '无效 JPEG' });
        frame = { bytes, time: now() }; return json(res, 200, { ok: true });
      }
      const data = JSON.parse((await body(req, 4096)).toString() || '{}');
      if (pathname === '/api/frame/clear') { frame = null; return json(res, 200, { ok: true }); }
      if (pathname === '/api/connect') { return json(res, 200, await bridge.connect()); }
      if (pathname === '/api/disconnect') { release(); await bridge.close(); return json(res, 200, bridge.snapshot()); }
      if (pathname === '/api/control/start') {
        if (lease) return json(res, 409, { error: '另一个页面正在控制，请先停止。' });
        if (bridge.active !== 1) return json(res, 409, { error: '请先连接一台 iPad。' });
        lease = { id: crypto.randomUUID(), time: now(), seq: 0 }; return json(res, 200, { lease: lease.id });
      }
      if (!lease || data.lease !== lease.id) return json(res, 409, { error: '控制已释放，请重新开始。' });
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
        } else {
          const {buttons,x,y,wheel}=data;
          if(![buttons,x,y,wheel].every(Number.isSafeInteger)||buttons<0||buttons>1||[x,y,wheel].some(n=>Math.abs(n)>127)) return json(res,400,{error:'无效鼠标报告'});
          accepted=bridge.report(buttons,x,y,wheel);
        }
        lease.seq=seq;lease.time=now();
        if(!accepted){release();return json(res,409,{error:'蓝牙繁忙或断开，已释放控制。'});}
        return json(res,200,{ok:true});
      }      return json(res, 404, { error: 'Not found' });
    } catch (e) { json(res, e.status || 400, { error: e.message }); }
  });
  server.on('close', () => { clearInterval(timer); release(); frame = null; });
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
  const { server, stopCapture } = createApp({ bridge, token });
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
