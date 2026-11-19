'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BluetoothBridge } = require('./lib/bluetooth');
const { Setup } = require('./lib/setup');
const { UsbVideo } = require('./lib/usb-video');

function createApp({ bridge, token, now = Date.now, publishAssistant, usb = new UsbVideo(), setup = new Setup() }) {
  let lease = null, frame = null;
  let assistant = null;
  let configuring = null;
  async function configure(key, operation) {
    if (configuring) {
      if (configuring.key === key) return configuring.result;
      throw conflict('另一项设备配置正在进行。');
    }
    if (usb.busy || source) throw conflict('请先停止正在进行的 USB 投屏。');
    const result = Promise.resolve().then(operation);
    configuring = {key,result};
    try { return await result; }
    finally { configuring = null; }
  }
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
  function release() {
    const wasProbe = lease?.probe;
    lease = null;
    // A probe only sent unpressed absolute moves. It has no keys/buttons to release.
    if (!wasProbe) bridge.release();
  }
  function advanceAssistantLayout(layout) {
    if (layout <= assistant.layout) return;
    assistant.layout = layout;
    frame = null;
    assistant.sample?.cancel();
    if (lease?.assistant) release();
  }
  function resetDeviceSession() {
    revokeAssistant();
    if (lease) release();
    frame = null;
  }
  let source = null, guarded = false, selectingPeer = false;
  let relativePeer = null, confirmation = null;
  let workerGeneration = bridge.generation;
  const bindings = new Map();
  const availablePeers = () => bridge.peers || [];
  const boundPeer = () => source && (bindings.get(source.id) || relativePeer);
  const paired = () => !!boundPeer() && boundPeer() === bridge.selectedPeer;
  const conflict = message => Object.assign(new Error(message), {status:409});

  function relativeCandidate() {
    const peers = availablePeers();
    return source && !source.multiple && peers.length === 1 && !peers[0].absolute &&
      ![...bindings].some(([device,id]) => device !== source.id && id === peers[0].id) ? peers[0].id : null;
  }
  function recordInventory(devices) {
    if (devices.length > 1) guarded = true;
    if (source) source.multiple = devices.length !== 1 || devices[0].id !== source.id;
  }
  async function checkRelativeTarget(deviceId,peerId) {
    const owner = source, generation = bridge.generation;
    if (!owner || owner.id !== deviceId || !peerId) throw conflict('需要唯一的 USB 设备和仅支持相对移动的蓝牙鼠标。');
    const devices = await usb.devices();
    if (owner !== source || generation !== bridge.generation) throw conflict('设备已改变，请重新核对。');
    recordInventory(devices);
    if (relativeCandidate() !== peerId) throw conflict('设备已改变，请重新核对。');
    return owner;
  }
  async function routePeer(id) {
    if (selectingPeer) throw conflict('蓝牙接收者正在切换，请稍后重试。');
    const owner = source, generation = bridge.generation;
    selectingPeer = true;
    try {
      const ok = await bridge.selectPeer(id);
      if (!ok || source !== owner || bridge.generation !== generation || bridge.selectedPeer !== id) {
        throw conflict('蓝牙或 USB 设备已改变，请重新验证。');
      }
    } finally { selectingPeer = false; }
  }
  function changeSource(next, lostId) {
    resetDeviceSession();
    confirmation = null; relativePeer = null;
    if (lostId) bindings.delete(lostId);
    source = next || null;
    if (!source) {
      if (guarded && bridge.selectedPeer && !selectingPeer) routePeer(null).catch(()=>{});
      return;
    }
    // A single USB phone and a single Bluetooth receiver can still be two different devices.
    guarded = true;
    const id = boundPeer() || null;
    if (guarded && id !== bridge.selectedPeer && (!id || availablePeers().some(p=>p.id===id))) {
      routePeer(id).catch(()=>{}); // A fresh probe is available if restoration fails.
    }
  }
  const singleInputDevice = () => bridge.active === 1 && !(bridge.keyboardActive > 1);
  function expire() {
    if (bridge.generation !== workerGeneration) {
      bindings.clear(); relativePeer = null; confirmation = null;
      workerGeneration = bridge.generation;
      resetDeviceSession();
    }
    const peers = availablePeers();
    if (peers.length > 1) guarded = true;
    if (confirmation && (confirmation.expires <= now() || relativeCandidate() !== confirmation.peerId || bridge.selectedPeer !== confirmation.peerId)) confirmation = null;
    if (relativePeer && (relativeCandidate() !== relativePeer || bridge.selectedPeer !== relativePeer)) {
      relativePeer = null; resetDeviceSession();
    }
    for (const [device, peer] of bindings) {
      if (!peers.some(p=>p.id===peer)) bindings.delete(device);
    }
    if (lease && !lease.probe && guarded && !paired()) resetDeviceSession();
    if (lease?.probe && (lease.source !== source || lease.peerId !== bridge.selectedPeer)) release();
    if (assistant && singleInputDevice()) assistant.hadMouse = true;
    if (assistant?.hadMouse && !singleInputDevice()) resetDeviceSession();
    if (lease && (now() - lease.time > 1200 || !singleInputDevice() ||
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
      assets['/setup.js'] = ['setup.js', 'text/javascript'];
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
      if (req.method === 'GET' && pathname === '/api/setup') return json(res,200,await setup.status());
      if (req.method === 'GET' && pathname === '/api/devices') {
        const devices = await usb.devices();
        recordInventory(devices);
        expire();
        return json(res,200,{devices,activeDeviceId:source?.id || null});
      }
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ...bridge.snapshot(),
        ...(!isAssistant && {activeDeviceId:source?.id || null, needsPairing:!!source && guarded && !paired(),
          verifiedPeerId:boundPeer() || null, canIdentifyRelative:!!relativeCandidate() && !paired(), peers:availablePeers().map(peer=>({...peer,
            boundDeviceId:[...bindings].find(([,id])=>id===peer.id)?.[0] || null}))}),
        controlling: !!lease, frameAvailable: !!frame, assistantEnabled: !!assistant, fullscreen: !!frame?.fullscreen,
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

      if (pathname === '/api/frame') {
        const bytes = await body(req, 2 * 1024 * 1024);
        if (req.headers['content-type'] !== 'image/jpeg' || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return json(res, 400, { error: '无效 JPEG' });
        const view = req.headers['x-assistant-view'];
        if (view && view !== assistant?.view) return json(res,409,{error:'画面授权已结束。'});
        if (view) {
          const layout = Number(req.headers['x-layout'] || 0);
          if (!Number.isSafeInteger(layout) || layout < 0) return json(res,400,{error:'无效画面布局。'});
          if (layout < assistant.layout) return json(res,409,{error:'画面方向已改变。'});
          advanceAssistantLayout(layout);
        }
        const picture = {layout:req.headers['x-layout'],width:Number(req.headers['x-width']),height:Number(req.headers['x-height']),verified:req.headers['x-verified']==='true'};
        frame = { bytes, picture, time: now(), fullscreen: req.headers['x-view-mode'] === 'fullscreen', view };
        if (assistant && req.headers['x-assistant-view'] === assistant.view) assistant.seen = now();
        return json(res, 200, { ok: true });
      }
      const data = JSON.parse((await body(req, 4096)).toString() || '{}');
      expire();
      if (isAssistant && (assistant?.token !== credential || (pathname !== '/api/control/stop' && frame?.view !== assistant?.view))) return json(res, 409, { error: '等待已授权窗口恢复实时画面。' });
      if (pathname.startsWith('/api/setup/')) {
        if (!data || Array.isArray(data) || typeof data !== 'object') return json(res,400,{error:'无效配置请求。'});
        const fields = Object.keys(data);
        if (pathname === '/api/setup/driver') {
          if (fields.length !== 1 || typeof data.deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(data.deviceId))
            return json(res,400,{error:'请选择已连接的 USB 设备。'});
          const result = await configure('driver:' + data.deviceId, () => usb.setupDevice(data.deviceId));
          if (result.status === 'cancelled') throw conflict('已取消 Windows 管理员确认，可以重试。');
          return json(res,200,{driver:result.status});
        }
        if (fields.length) return json(res,400,{error:'配置请求包含多余参数。'});
        if (pathname === '/api/setup/receiver' || pathname === '/api/setup/apple-service') {
          await configure(pathname, () => pathname === '/api/setup/receiver' ? setup.prepareReceiver() : setup.startAppleService());
          return json(res,200,{ok:true});
        }
        return json(res,404,{error:'未知配置步骤。'});
      }
      if (pathname === '/api/usb/video') {
        if (configuring) throw conflict('正在配置设备，请稍后再打开投屏。');
        const {deviceId} = data;
        if (deviceId !== undefined && (typeof deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(deviceId))) return json(res,400,{error:'无效 USB 设备。'});
        await usb.stream(res, changeSource, deviceId); return;
      }
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
        const next = { layout:0, hadMouse: singleInputDevice(), token: crypto.randomBytes(32).toString('hex'), view: crypto.randomUUID(), seen: now() };
        publishAssistant(server.address().port, next.token);
        assistant = next; frame = null;
        return json(res, 200, { view: next.view });
      }
      if (pathname === '/api/assistant/disable') { revokeAssistant(); frame = null; return json(res, 200, {ok:true}); }
      if (pathname === '/api/frame/clear') {
        if (data.view) {
          if (data.view !== assistant?.view) return json(res,409,{error:'画面授权已结束。'});
          if (!Number.isSafeInteger(data.layout) || data.layout < 1) return json(res,400,{error:'无效画面布局。'});
          advanceAssistantLayout(data.layout);
        } else frame = null;
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/connect') { return json(res, 200, await bridge.connect()); }
      if (pathname === '/api/disconnect') { resetDeviceSession(); await bridge.close(); return json(res, 200, bridge.snapshot()); }
      if (pathname === '/api/control/identify-relative') {
        const {deviceId,peerId} = data;
        const owner = await checkRelativeTarget(deviceId,peerId);
        if (lease || selectingPeer || paired()) throw conflict('请先停止当前控制。');
        confirmation = null;
        revokeAssistant();
        await routePeer(peerId);
        if (source !== owner || relativeCandidate() !== peerId || !bridge.report(0,48,0,0)) throw conflict('指针未移动，请重新核对。');
        confirmation = {peerId, nonce:crypto.randomUUID(), expires:now()+60000};
        return json(res,200,{confirmation:confirmation.nonce});
      }
      if (pathname === '/api/control/confirm-relative') {
        const ticket = confirmation;
        if (!ticket || ticket.nonce !== data.confirmation || ticket.peerId !== data.peerId) throw conflict('核对已失效，请重新移动指针。');
        await checkRelativeTarget(data.deviceId,data.peerId);
        if (confirmation !== ticket || selectingPeer || lease || ticket.expires <= now() || bridge.selectedPeer !== ticket.peerId) throw conflict('核对已失效，请重新移动指针。');
        confirmation = null;
        relativePeer = ticket.peerId;
        return json(res,200,{ok:true});
      }
      if (pathname === '/api/control/start') {
        if (lease || selectingPeer) throw conflict('正在控制或切换设备，请稍后重试。');
        if (data.deviceId && data.deviceId !== source?.id) throw conflict('投屏设备已改变，请重新选择。');
        if (data.probe) {
          if (isAssistant) return json(res,403,{error:'请在控制台验证蓝牙设备。'});
          const id = data.peerId;
          if (!source || data.deviceId !== source.id || !availablePeers().some(p=>p.id===id && p.absolute) ||
              [...bindings].some(([device,peer])=>peer===id && device!==source.id)) throw conflict('当前设备没有可验证的蓝牙接收者。');
          const owner = source;
          revokeAssistant();
          await routePeer(id);
          if (owner !== source) throw conflict('设备已改变，请重新验证。');
          lease = {id:crypto.randomUUID(), time:now(), seq:0, assistant:false, probe:true, peerId:id, source, points:new Set()};
          return json(res,200,{lease:lease.id});
        }
        if (guarded && (!paired() || (!isAssistant && data.deviceId !== source?.id))) {
          throw conflict('请先在当前设备上完成蓝牙指针验证。');
        }
        if (!singleInputDevice()) return json(res, 409, { error: '请先连接一台 iPhone 或 iPad。' });
        lease = { id: crypto.randomUUID(), time: now(), seq: 0, assistant: isAssistant }; return json(res, 200, { lease: lease.id });
      }
      if (!lease || data.lease !== lease.id || lease.assistant !== isAssistant) return json(res, 409, { error: '控制已释放，请重新开始。' });
      if (pathname === '/api/control/verify-peer') {
        if (!lease.probe || lease.points.size < 3 || !source || data.deviceId !== source.id ||
            lease.source !== source || data.peerId !== lease.peerId || data.peerId !== bridge.selectedPeer) {
          throw conflict('蓝牙验证尚未完成，或当前设备已改变。');
        }
        bindings.set(source.id,lease.peerId);
        return json(res,200,{ok:true});
      }
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
        if (lease.probe && (data.kind !== 'absolute' || data.buttons !== 0)) throw conflict('验证时只允许移动指针。');
        let accepted;
        if(data.kind === 'keyboard') {
          const { modifiers,keys }=data;
          if(!Number.isSafeInteger(modifiers)||modifiers<0||modifiers>255||!Array.isArray(keys)||keys.length>6||new Set(keys).size!==keys.length||keys.some(k=>!Number.isSafeInteger(k)||k<4||k>101)) return json(res,400,{error:'无效键盘报告'});
          if(bridge.keyboardActive!==1) return json(res,409,{error:'键盘尚未连接。升级后请在移动设备上忽略旧蓝牙设备并重新配对。'});
          accepted=bridge.keys(modifiers,keys);
        } else if(data.kind === 'absolute') {
          const {buttons,x,y}=data;
          if (![buttons,x,y].every(Number.isSafeInteger) || buttons<0 || buttons>7 ||
              x<0 || x>32767 || y<0 || y>32767) return json(res,400,{error:'无效绝对坐标报告'});
          if (bridge.absoluteActive!==1) return json(res,409,{error:'当前设备未订阅绝对坐标报告。'});
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
          if (accepted && lease.probe && lease.points.size < 3) lease.points.add(data.x + ',' + data.y);
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
    fs.writeFileSync(path.join(__dirname, '.local', 'session.json'), JSON.stringify({ pid: process.pid, port, token, url, setupVersion: 1 }));
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
