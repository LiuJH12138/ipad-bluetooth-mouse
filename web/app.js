'use strict';
const $ = id => document.getElementById(id);
const startUsb = new URLSearchParams(location.search).get('source') === 'usb';
const token = location.hash.slice(1) || sessionStorage.getItem('control-token');
if (location.hash) { sessionStorage.setItem('control-token', token); history.replaceState(null, '', '/'); }
let stream, lease, seq = 0, connected = false, keyboardConnected = false, pad = null;
let inputChain = Promise.resolve(), leaseWait = null, controlEpoch = 0;
let dx = 0, dy = 0, buttons = 0, inputBusy = false, frameBusy = false, frameEpoch = 0;
const keyboard = new IpadKeyboard.KeyboardState();
const video = $('video');
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(route, data, options = {}) {
  const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Control-Token': token || '', 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), ...options });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
const usbCanvas = $('usb-canvas');
let usbSession = null, usbLive = false;
function hasPicture() {
  return usbLive || stream?.getVideoTracks()[0]?.readyState === 'live';
}
function ready() { return connected && hasPicture(); }
function update() {
  $('control').disabled = !ready() || !!document.pointerLockElement; $('connect').disabled = connected;
  $('release').disabled = !lease; $('search').disabled = !ready() || !keyboardConnected;
  $('disconnect').disabled = !connected; $('snapshot').disabled = !hasPicture();
  for (const id of ['tap','up','down']) $(id).disabled = !ready();
  $('stop-share').disabled = !stream && !usbSession;
  $('usb').disabled = !!usbSession;
  $('mode-label').textContent = document.pointerLockElement ? '键鼠控制中 · Esc 退出' : lease ? '触控板控制中' : '预览模式';
  document.body.classList.toggle('controlling', !!lease);
}
async function clearFrame() { frameEpoch++; try { await api('frame/clear', {}); } catch {} }
async function stopControl() {
  controlEpoch++; const old = lease; lease = null; keyboard.clear(); buttons = 0; dx = dy = 0; pad = null;
  $('touchpad').classList.remove('busy');
  if (document.pointerLockElement) document.exitPointerLock();
  if (old) try { await api('control/stop', { lease: old }, { keepalive: true }); } catch {}
  update();
}
async function ensureLease() {
  if (!ready()) throw new Error('画面和蓝牙都就绪后才能控制。');
  if (lease) return;
  if (leaseWait) return leaseWait;
  const epoch = controlEpoch;
  leaseWait = (async () => {
    const result = await api('control/start', {});
    if (epoch !== controlEpoch || !ready()) {
      await api('control/stop', { lease: result.lease });
      throw new Error('控制已取消。');
    }
    lease = result.lease; seq = 0; update();
  })();
  try { await leaseWait; } finally { leaseWait = null; }
}
function send(x = 0, y = 0, wheel = 0, b = buttons) {
  const owner=lease;
  if (!owner) return Promise.resolve();
  const request={ lease:owner, seq:++seq, buttons:b, x, y, wheel };
  inputChain=inputChain.then(async()=>{
    if(lease!==owner) return;
    try { await api('input', request); }
    catch(e) { if(lease===owner) { await stopControl(); notice(e.message,true); } }
  });
  return inputChain;
}
async function stopShare() {
  if (usbSession) usbSession.abort();
  usbSession = null;
  usbLive = false;
  usbCanvas.hidden = true;
  usbCanvas.width = usbCanvas.height = 1;
  await stopControl();
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null;
  video.classList.remove('active'); $('placeholder').hidden = false; $('video-dot').classList.remove('on'); $('video-status').textContent = '等待选择画面';
  $('frames').checked = false; await clearFrame(); update();
}
$('share').onclick = async () => {
  try {
    const selected = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', frameRate: { ideal: 30, max: 30 } }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' });
    await stopShare(); stream = selected; video.srcObject = stream; await video.play();
    video.classList.add('active'); $('placeholder').hidden = true; $('video-dot').classList.add('on'); $('video-status').textContent = '画面已接入';
    stream.getVideoTracks()[0].addEventListener('ended', stopShare, { once: true });
    stream.getVideoTracks()[0].addEventListener('mute', () => { stopControl(); notice('共享画面已暂停，控制已释放。', true); });
    notice('画面已接入。确认显示的是 iPad，再连接蓝牙。'); update();
  } catch (e) { if (e.name !== 'NotAllowedError') notice('共享失败：' + e.message, true); }
};
$('usb').onclick = async () => {
  await stopShare();
  const session = new AbortController();
  usbSession = session;
  update();
  $('video-status').textContent = '正在打开 USB 视频…';
  let frames = 0, decodeMs = 0, last = performance.now();
  try {
    await playUsbVideo({ token, canvas: usbCanvas, signal: session.signal, onFrame(ms) {
      if (usbSession !== session) return;
      if (!usbLive) {
        usbLive = true;
        usbCanvas.hidden = false;
        $('placeholder').hidden = true;
        $('video-dot').classList.add('on');
        $('video-status').textContent = 'USB 直连 · 已收到画面';
        notice('USB 画面已接入。连接蓝牙后即可开始键鼠控制。');
        last = performance.now();
        update();
      }
      frames++;
      decodeMs += ms;
      const elapsed = performance.now() - last;
      if (elapsed >= 1000) {
        $('video-status').textContent = 'USB · ' + Math.round(1000 * frames / elapsed) + ' fps · 本机解码绘制 ' + Math.round(decodeMs / frames) + ' ms';
        frames = 0; decodeMs = 0; last = performance.now();
      }
    } });
  } catch (error) {
    if (usbSession === session) notice(error.message, true);
  } finally {
    if (usbSession === session) await stopShare();
  }
};
$('stop-share').onclick = stopShare;
$('connect').onclick = async () => { try { $('connect').disabled = true; await api('connect', {}); notice('正在启动蓝牙，iPad 配对成功后会显示已连接。'); } catch(e) { notice(e.message,true); $('connect').disabled = false; } };
$('disconnect').onclick = async () => { await stopControl(); try { await api('disconnect', {}); connected = false; update(); } catch(e) { notice(e.message,true); } };
$('control').onclick = async () => {
  try {
    // Call within the direct click gesture; acquire a control lease after the browser grants capture.
    const surface = usbLive ? usbCanvas : video;
    await surface.requestPointerLock();
    if(document.pointerLockElement !== surface) throw new Error('鼠标捕获已取消。');
    await ensureLease(); notice('键鼠已交给 iPad。可直接移动、点击、滚动和输入，按 Esc 退出。');
  } catch(e) { await stopControl(); notice('未进入鼠标捕获。可以使用下方触控板。' + e.message, true); }
};
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) stopControl(); update(); });
document.addEventListener('mousemove', e => { if (document.pointerLockElement && lease) { dx += e.movementX * Number($('speed').value); dy += e.movementY * Number($('speed').value); dx=Math.max(-508,Math.min(508,dx)); dy=Math.max(-508,Math.min(508,dy)); } });
document.addEventListener('mousedown', e => { if (document.pointerLockElement && lease && e.button === 0) { buttons = 1; send(0,0,0,1); } });
document.addEventListener('mouseup', e => { if (document.pointerLockElement && lease && e.button === 0) { buttons = 0; send(0,0,0,0); } });
document.addEventListener('wheel', e => { if(document.pointerLockElement && lease) { e.preventDefault(); send(0,0,Math.sign(-e.deltaY)*3); } }, { passive: false });
document.addEventListener('contextmenu', e => { if (document.pointerLockElement) e.preventDefault(); });
window.addEventListener('blur', stopControl);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopControl(); });
window.addEventListener('pagehide', stopControl);
$('speed').oninput = () => $('speed-value').textContent = Number($('speed').value).toFixed(1) + '×';
$('touchpad').onpointerdown = async e => {
  if (e.button !== 0 || document.pointerLockElement) return;
  const pointer = { id:e.pointerId,x:e.clientX,y:e.clientY,distance:0,time:Date.now() };
  pad = pointer; $('touchpad').setPointerCapture(e.pointerId);
  try { await ensureLease(); if (pad === pointer) $('touchpad').classList.add('busy'); }
  catch(e) { pad = null; notice(e.message,true); }
};
$('touchpad').onpointermove = e => {
  if (!pad || pad.id !== e.pointerId) return;
  const x=e.clientX-pad.x,y=e.clientY-pad.y; pad.x=e.clientX; pad.y=e.clientY; pad.distance+=Math.abs(x)+Math.abs(y);
  if(lease) { dx+=x*Number($('speed').value); dy+=y*Number($('speed').value); }
};
$('touchpad').onpointerup = async e => {
  if (!pad || pad.id !== e.pointerId) return; const tap=pad.distance<5 && Date.now()-pad.time<350; pad=null; $('touchpad').classList.remove('busy');
  if(tap) { try { await ensureLease(); await send(0,0,0,1); await send(0,0,0,0); } catch(e) { notice(e.message,true); } }
};
$('touchpad').onpointercancel = stopControl;
$('tap').onclick = async () => { try { await ensureLease(); await send(0,0,0,1); await send(0,0,0,0); } catch(e) { notice(e.message,true); } };
for (const [id,wheel] of [['up',3],['down',-3]]) $(id).onclick = async () => { try { await ensureLease(); await send(0,0,wheel); } catch(e) { notice(e.message,true); } };
setInterval(async () => {
  if(!lease || inputBusy) return;
  const x=Math.max(-127,Math.min(127,Math.trunc(dx))),y=Math.max(-127,Math.min(127,Math.trunc(dy)));
  if(!x && !y) return; dx-=x; dy-=y; inputBusy=true; try { await send(x,y); } finally { inputBusy=false; }
},30);
setInterval(async () => { if(lease) try { await api('heartbeat',{lease}); } catch(e) { await stopControl(); notice(e.message,true); } },350);
setInterval(async () => {
  try {
    const status=await api('status'); connected=status.active===1; keyboardConnected=status.keyboardActive===1;
    $('keyboard-status').textContent = keyboardConnected ? '键盘已连接' : connected ? '鼠标已连接，键盘需重新配对' : '键盘尚未连接';
    const text={idle:'尚未启动',starting:'正在启动蓝牙…',waiting:'等待 iPad 连接',connected:'已连接 · 1 台 iPad',error:'启动失败，可点击连接重试'};
    $('bluetooth-status').textContent=text[status.state] || status.state;
    if(status.error) notice(status.error,true);
    if(!connected && lease) await stopControl(); update();
  } catch(e) { connected=false; await stopControl(); notice('本机服务不可用，请重新运行启动器。',true); }
},1000);
function frameCanvas() {
  const source = usbLive ? usbCanvas : video;
  const width = usbLive ? source.width : video.videoWidth;
  const height = usbLive ? source.height : video.videoHeight;
  if (!hasPicture() || !width || !height) return null;
  const canvas=document.createElement('canvas'); const scale=Math.min(1,1600/width);
  canvas.width=Math.round(width*scale); canvas.height=Math.round(height*scale);
  canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height); return canvas;
}
$('frames').onchange = () => { if(!$('frames').checked) clearFrame(); };
setInterval(async () => {
  if(!$('frames').checked || frameBusy) return;
  const canvas=frameCanvas(); if(!canvas) return; frameBusy=true; const epoch=frameEpoch;
  try {
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
    if(epoch!==frameEpoch || !$('frames').checked) return;
    const response=await fetch('/api/frame',{method:'POST',headers:{'X-Control-Token':token,'Content-Type':'image/jpeg'},body:blob});
    if(!response.ok) throw new Error('本机画面更新失败');
    if(epoch!==frameEpoch || !$('frames').checked) await clearFrame();
  } catch(e) { notice(e.message,true); } finally { frameBusy=false; }
},500);
$('snapshot').onclick = () => { const canvas=frameCanvas(); if(!canvas) return; canvas.toBlob(blob=>{ const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download='ipad-screen.png'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }); };
update();
function sendKeys(report) {
  const owner=lease; if(!owner) return Promise.resolve();
  const request={lease:owner,seq:++seq,kind:'keyboard',...report};
  inputChain=inputChain.then(async()=>{
    if(lease!==owner)return;
    try{await api('input',request);}catch(e){if(lease===owner){await stopControl();notice(e.message,true);}}
  });return inputChain;
}
for(const type of ['keydown','keyup'])document.addEventListener(type,e=>{
  if(!document.pointerLockElement||!lease)return;
  if(e.code==='Escape'){stopControl();return;}
  const report=keyboard.change(e.code,type==='keydown');if(!report)return;
  e.preventDefault();e.stopPropagation();
  if(e.repeat)return;
  if(!keyboardConnected){notice('鼠标已连接，但键盘尚未就绪。请重新配对组合设备。',true);return;}
  sendKeys(report);
},true);
$('command-control').onchange=()=>{keyboard.commandControl=$('command-control').checked;keyboard.clear();if(lease&&keyboardConnected)sendKeys(keyboard.report());};
$('release').onclick=stopControl;
if (startUsb) $('usb').click();
$('search').onclick=async()=>{try{await ensureLease();await sendKeys({modifiers:8,keys:[44]});await sendKeys({modifiers:0,keys:[]});}catch(e){notice(e.message,true);}};
