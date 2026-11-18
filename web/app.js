'use strict';
const $ = id => document.getElementById(id);
const startUsb = new URLSearchParams(location.search).get('source') === 'usb';
const token = location.hash.slice(1) || sessionStorage.getItem('control-token');
if (location.hash) { sessionStorage.setItem('control-token', token); history.replaceState(null, '', '/'); }
let stream, lease, seq = 0, connected = false, keyboardConnected = false;
let inputChain = Promise.resolve(), leaseWait = null, controlEpoch = 0;
let dx = 0, dy = 0, buttons = 0, inputBusy = false, frameBusy = false, frameEpoch = 0;
let capturedPosition = null;
const keyboard = new IpadKeyboard.KeyboardState();
const video = $('video');
function notice(message, error = false) {
  $('notice').textContent = message === verificationDetail ? '' : message;
  $('notice').classList.toggle('error', error);
  $('fullscreen-error').textContent = error && document.fullscreenElement === $('monitor') ? message : '';
}
async function api(route, data, options = {}) {
  const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Control-Token': token || '', 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), ...options });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
const usbCanvas = $('usb-canvas');
let usbSession = null, usbLive = false;
let pointMode = false, aiming = false, usbFrameNumber = 0;
let absoluteActive = false, absoluteVerified = false, absoluteTried = false, usbTurns = 0;
let wakePointSample = null;
let lastPoint = null, heldPointer = null, currentAction = null, pointPhase = '';
const pictureQueue = [];
let verificationDetail = '';
function resetVerification() {
  if (capturedPosition) stopControl();
  absoluteVerified = absoluteTried = false;
  verificationDetail = '';
}
const pointFrame = document.createElement('canvas');
const pointContext = pointFrame.getContext('2d', {willReadFrequently:true});
let assistantView = null;
let assistantChanging = false;
async function disableAssistant() {
  assistantView = null;
  frameEpoch++;
  await api('assistant/disable', {});
  update();
}
$('assistant').onclick = async () => {
  assistantChanging = true;
  update();
  try {
    if (assistantView) await disableAssistant();
    else {
      await stopControl();
      const result = await api('assistant/enable', {});
      assistantView = result.view;
      if (!hasPicture()) await disableAssistant();
    }
  } catch (error) { notice(error.message, true); }
  finally { assistantChanging = false; update(); }
};
function hasPicture() {
  return usbLive || stream?.getVideoTracks()[0]?.readyState === 'live';
}
function ready() { return connected && hasPicture(); }
const monitor = $('monitor');
const fullscreenButton = $('fullscreen');
fullscreenButton.hidden = !document.fullscreenEnabled;
fullscreenButton.onclick = async () => {
  try {
    if (document.fullscreenElement === monitor) await document.exitFullscreen();
    else await monitor.requestFullscreen();
  } catch {
    notice('全屏切换失败，请在当前浏览器窗口重试。', true);
  }
};
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === monitor;
  fullscreenButton.textContent = active ? '退出全屏' : '全屏';
  if (!active) {
    $('fullscreen-error').textContent = '';
    stopControl();
  }
  update();
});
function update() {
  const probing = !!currentAction?.probe;
  const available = usbLive && absoluteActive;
  let status = '等待 USB 投屏', detail = '连接 USB 画面与蓝牙后可验证。';
  if (usbLive) {
    if (!connected) { status = '等待蓝牙'; detail = '连接蓝牙后检查 iPad 的指针输入。'; }
    else if (!absoluteActive) { status = '视觉定位'; detail = 'iPad 尚未订阅绝对坐标输入。'; }
    else {
      status = probing ? '正在验证' : absoluteVerified ? '绝对坐标直达' : absoluteTried ? '视觉定位' : '等待验证';
      detail = verificationDetail || '先在 iPad 上打开背景简单、指针清晰的页面，例如「设置 → 通用」，再点验证。';
    }
  }
  $('position-status').textContent = status;
  $('position-status').classList.toggle('verified', absoluteVerified && available);
  if ($('position-detail').textContent !== detail) $('position-detail').textContent = detail;
  $('transport-position').textContent = pointMode ? status : 'Esc 退出控制';
  $('verify-position').disabled = !available || aiming || !!document.pointerLockElement;
  $('verify-position').textContent = probing ? '验证中…' : absoluteVerified ? '重新验证' : '验证坐标';
  $('point').disabled = !usbLive || !connected || !!document.pointerLockElement;
  $('point').setAttribute('aria-pressed', String(pointMode));
  $('point').textContent = pointMode ? '退出画面操控' : '画面操控';
  usbCanvas.classList.toggle('point-mode', pointMode);
  $('assistant').disabled = aiming || assistantChanging || !hasPicture();
  $('assistant').textContent = assistantView ? '停止助手控制' : '允许助手控制';
  $('assistant').setAttribute('aria-pressed', String(!!assistantView));
  fullscreenButton.disabled = !hasPicture() && document.fullscreenElement !== monitor;
  monitor.classList.toggle('captured', !!document.pointerLockElement && !!lease);
  $('control').disabled = aiming || !ready() || !!document.pointerLockElement; $('connect').disabled = connected;
  $('release').disabled = !lease; $('search').disabled = aiming || !ready() || !keyboardConnected;
  $('disconnect').disabled = !connected;
  $('connect').hidden = connected;
  $('disconnect').hidden = !connected;
  $('release').hidden = !lease || (pointMode && aiming);
  $('control').hidden = !!document.pointerLockElement && !!lease;
  $('stop-share').disabled = !stream && !usbSession;
  $('stop-share').hidden = $('stop-share').disabled;
  $('usb').disabled = !!usbSession;
  $('fullscreen-usb').disabled = !!usbSession;
  $('mode-label').textContent = aiming ? pointPhase : pointMode ? '画面操控' : document.pointerLockElement ? '键鼠控制中' : '预览模式';
  document.body.classList.toggle('controlling', !!lease);
}
async function clearFrame() { frameEpoch++; try { await api('frame/clear', {}); } catch {} }
async function stopControl(keepPoint = false) {
  if (keepPoint !== true) {
    if (currentAction?.probe) verificationDetail = '验证已取消，可以重新验证。';
    lastPoint = null;
    heldPointer = null;
    currentAction?.gesture?.cancel();
    for (const action of pictureQueue.splice(0)) action.gesture?.cancel();
  }
  controlEpoch++; const old = lease; lease = null; keyboard.clear(); capturedPosition = null; buttons = 0; dx = dy = 0;
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
  lastPoint = null;
  const owner=lease;
  if (!owner) return Promise.resolve();
  const request={ lease:owner, seq:++seq, buttons:b, x, y, wheel };
  if (capturedPosition && !wheel) {
    const rect = usbCanvas.getBoundingClientRect();
    const scale = Math.min(rect.width / usbCanvas.width, rect.height / usbCanvas.height);
    if (scale <= 0) return stopControl();
    capturedPosition.x = Math.max(0, Math.min(1, capturedPosition.x + x / (usbCanvas.width * scale)));
    capturedPosition.y = Math.max(0, Math.min(1, capturedPosition.y + y / (usbCanvas.height * scale)));
    request.kind = 'absolute';
    request.x = Math.round(capturedPosition.x * 32767);
    request.y = Math.round(capturedPosition.y * 32767);
  }
  inputChain=inputChain.then(async()=>{
    if(lease!==owner) return;
    try { await api('input', request); }
    catch(e) { if(lease===owner) { await stopControl(); notice(e.message,true); } }
  });
  return inputChain;
}
async function stopShare() {
  pointMode=false;
  resetVerification();
  if (assistantView) await disableAssistant().catch(() => {});
  if (usbSession) usbSession.abort();
  usbSession = null;
  usbLive = false;
  usbCanvas.hidden = true;
  usbCanvas.width = usbCanvas.height = 1;
  await stopControl();
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null;
  video.classList.remove('active'); $('placeholder').hidden = false; $('video-dot').classList.remove('on'); $('video-status').textContent = '等待画面';
  await clearFrame(); update();
}
$('share').onclick = async () => {
  try {
    const selected = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', frameRate: { ideal: 30, max: 30 } }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' });
    await stopShare(); stream = selected; video.srcObject = stream; await video.play();
    video.classList.add('active'); $('placeholder').hidden = true; $('video-dot').classList.add('on'); $('video-status').textContent = '窗口共享中';
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
    let previousSize = '';
    await playUsbVideo({ token, canvas: usbCanvas, signal: session.signal, onFrame(ms, turns = 0) {
      if (usbSession !== session) return;
      const size = usbCanvas.width + 'x' + usbCanvas.height;
      if (previousSize !== size || usbTurns !== turns) {
        previousSize = size;
        usbTurns = turns;
        resetVerification();
        lastPoint = null;
      }
      usbFrameNumber++;
      wakePointSample?.();
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
$('stop-share').onclick = async () => { await stopShare(); notice('已停止投屏'); };
$('fullscreen-usb').onclick = () => $('usb').click();
$('connect').onclick = async () => { try { $('connect').disabled = true; await api('connect', {}); notice('正在启动蓝牙，iPad 配对成功后会显示已连接。'); } catch(e) { notice(e.message,true); $('connect').disabled = false; } };
$('disconnect').onclick = async () => { await stopControl(); try { await api('disconnect', {}); connected = false; update(); } catch(e) { notice(e.message,true); } };
$('control').onclick = async () => {
  try {
    pointMode=false;
    // Call within the direct click gesture; acquire a control lease after the browser grants capture.
    const surface = usbLive ? usbCanvas : video;
    await surface.requestPointerLock();
    if(document.pointerLockElement !== surface) throw new Error('鼠标捕获已取消。');
    await ensureLease();
    if (usbLive && absoluteVerified && absoluteActive) {
      capturedPosition = {x:0.5, y:0.5};
      await send();
      if (!lease) return;
      notice('键鼠控制中 · 指针从画面中央开始，移动后点按。按 Esc 退出。');
    } else {
      notice('键鼠控制中 · 相对鼠标。若左键无响应，按 Esc 后在 USB 预览中验证坐标，再开始控制。');
    }
  } catch(e) { await stopControl(); notice('未进入鼠标捕获。请重试或使用 USB 画面操控。' + e.message, true); }
};
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) stopControl(); update(); });
document.addEventListener('mousemove', e => { if (document.pointerLockElement && lease) { dx += e.movementX * Number($('speed').value); dy += e.movementY * Number($('speed').value); dx=Math.max(-508,Math.min(508,dx)); dy=Math.max(-508,Math.min(508,dy)); } });
for (const event of ['mousedown','mouseup']) document.addEventListener(event, e => {
  if (document.pointerLockElement && lease && e.button >= 0 && e.button <= 2) {
    if (capturedPosition && (dx || dy)) {
      send(dx,dy);
      dx=dy=0;
    }
    buttons = e.buttons & 7;
    send(0,0,0,buttons);
  }
});
document.addEventListener('wheel', e => { if(document.pointerLockElement && lease) { e.preventDefault(); send(0,0,Math.sign(-e.deltaY)*3); } }, { passive: false });
document.addEventListener('contextmenu', e => { if (document.pointerLockElement) e.preventDefault(); });
window.addEventListener('blur', stopControl);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopControl(); });
window.addEventListener('pagehide', stopControl);
$('speed').oninput = () => $('speed-value').textContent = Number($('speed').value).toFixed(1) + '×';
setInterval(async () => {
  if(!lease || inputBusy) return;
  const x=Math.max(-127,Math.min(127,Math.trunc(dx))),y=Math.max(-127,Math.min(127,Math.trunc(dy)));
  if(!x && !y) return; dx-=x; dy-=y; inputBusy=true; try { await send(x,y); } finally { inputBusy=false; }
},30);
setInterval(async () => { if(lease) try { await api('heartbeat',{lease}); } catch(e) { await stopControl(); notice(e.message,true); } },350);
setInterval(async () => {
  try {
    const status=await api('status'); connected=status.active===1; keyboardConnected=status.keyboardActive===1;
    absoluteActive = connected && status.absoluteActive === 1;
    if (!absoluteActive && (absoluteTried || absoluteVerified || currentAction?.probe)) {
      resetVerification();
      if (currentAction?.probe && lease) await stopControl();
    }
    if (assistantView && !assistantChanging && !status.assistantEnabled) { assistantView=null; notice('助手控制已结束。'); }
    $('keyboard-status').textContent = keyboardConnected ? '已连接' : connected ? '需重新配对' : '尚未连接';
    const text={idle:'尚未启动',starting:'正在启动蓝牙…',waiting:'等待 iPad 连接',connected:'已连接 · 1 台 iPad',error:'启动失败，可点击连接重试'};
    $('bluetooth-status').textContent=text[status.state] || status.state;
    if(status.error) notice(status.error,true);
    if(!connected && lease) await stopControl(); update();
  } catch(e) { connected=false; absoluteActive=false; resetVerification(); await stopControl(); notice('本机服务不可用，请重新运行启动器。',true); }
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
setInterval(async () => {
  if(!assistantView || frameBusy) return;
  const canvas=frameCanvas(); if(!canvas) return; frameBusy=true; const epoch=frameEpoch;
  try {
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
    if(epoch!==frameEpoch || !assistantView) return;
    const response=await fetch('/api/frame',{method:'POST',headers:{'X-Control-Token':token,'Content-Type':'image/jpeg','X-Assistant-View':assistantView || '', 'X-View-Mode':document.fullscreenElement === monitor ? 'fullscreen' : 'window'},body:blob});
    if(!response.ok) throw new Error('本机画面更新失败');
    if(epoch!==frameEpoch || !assistantView) await clearFrame();
  } catch(e) { notice(e.message,true); } finally { frameBusy=false; }
},500);

update();
function sendKeys(report) {
  const owner=lease; if(!owner) return Promise.resolve();
  const request={lease:owner,seq:++seq,kind:'keyboard',...report,settle:pointMode};
  inputChain=inputChain.then(async()=>{
    if(lease!==owner)return;
    try{await api('input',request);}catch(e){if(lease===owner){await stopControl();notice(e.message,true);}}
  });return inputChain;
}
for(const type of ['keydown','keyup'])document.addEventListener(type,e=>{
  if (e.code==='Escape' && pointMode && type==='keydown') {
    pointMode=false; stopControl(); return;
  }
  const pictureKeyboard = canPoint() && document.activeElement === usbCanvas;
  if (!pictureKeyboard && !(document.pointerLockElement && lease)) return;
  if(e.code==='Escape'){stopControl();return;}
  if (!keyboardConnected) { notice('键盘尚未连接，请检查蓝牙。',true); return; }
  const report=keyboard.change(e.code,type==='keydown');if(!report)return;
  e.preventDefault();e.stopPropagation();
  if(e.repeat)return;
  if (!pictureKeyboard) { sendKeys(report); return; }
  if (currentAction?.probe) { keyboard.clear(); return; }
  if (pictureQueue.length >= 96) {
    stopControl(); notice('输入积压，已释放键鼠。',true); return;
  }
  pictureQueue.push({keyboardReport:report});
  processPictureQueue();
},true);
$('command-control').onchange=()=>{keyboard.commandControl=$('command-control').checked;keyboard.clear();if(lease&&keyboardConnected)sendKeys(keyboard.report());};
$('release').onclick=stopControl;
if (startUsb) $('usb').click();
$('search').onclick=async()=>{try{await ensureLease();await sendKeys({modifiers:8,keys:[44]});await sendKeys({modifiers:0,keys:[]});}catch(e){notice(e.message,true);}};

$('point').onclick = async () => {
  pointMode = !pointMode;
  await stopControl();
  if (pointMode) usbCanvas.focus({preventScroll:true});
  notice(pointMode ? '点选 iPad 输入框即可打字。按 Esc 退出画面操控。' : '已退出画面操控。');
  update();
};

$('verify-position').onclick = async () => {
  if (aiming || !usbLive || !absoluteActive || document.pointerLockElement) return;
  if (!pointMode) { pointMode = true; await stopControl(); }
  if (aiming || !canPoint() || !absoluteActive) return;
  usbCanvas.focus({preventScroll:true});
  pictureQueue.push({probe:true, geometry:pictureGeometry()});
  processPictureQueue();
};

function pictureGeometry() {
  const width = usbCanvas.width, height = usbCanvas.height;
  const scale = 840 / Math.max(width, height);
  return {width, height, w:Math.round(width*scale), h:Math.round(height*scale), turns:usbTurns, session:usbSession};
}

function mousePoint(event, geometry, clampToPicture = false) {
  const rect = usbCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  let {clientX, clientY} = event;
  if (clampToPicture) {
    const scale = Math.min(rect.width / geometry.width, rect.height / geometry.height);
    const w = geometry.width * scale, h = geometry.height * scale;
    const left = rect.left + (rect.width-w)/2, top = rect.top + (rect.height-h)/2;
    clientX = Math.min(left+w-0.01, Math.max(left, clientX));
    clientY = Math.min(top+h-0.01, Math.max(top, clientY));
  }
  const point = picturePoint(rect, geometry.width, geometry.height, clientX, clientY);
  return point && {x:point.x*geometry.w/geometry.width, y:point.y*geometry.h/geometry.height};
}

async function runPictureAction(action) {
  const {geometry, target, gesture} = action;
  const epoch = controlEpoch;
  function validate() {
    if (epoch !== controlEpoch || !pointMode || !lease || !usbLive || !connected || document.hidden ||
        (action.probe && !absoluteActive) ||
        usbSession !== geometry.session || usbTurns !== geometry.turns || usbCanvas.width !== geometry.width || usbCanvas.height !== geometry.height)
      throw Error('画面或控制状态已变化，操作已取消。');
  }
  await ensureLease();
  validate();
  if (pointFrame.width !== geometry.w || pointFrame.height !== geometry.h) {
    pointFrame.width = geometry.w;
    pointFrame.height = geometry.h;
    lastPoint = null;
  }
  async function report(x, y, buttons = 0, wheel = 0) {
    validate();
    await api('input', {lease, seq:++seq, buttons, x, y, wheel, settle:true});
  }
  let sampledFrame;
  async function sample(afterSerial) {
    if (usbFrameNumber === afterSerial) {
      await new Promise(resolve => {
        const wake = () => {
          clearTimeout(timer);
          if (wakePointSample === wake) wakePointSample = null;
          resolve();
        };
        const timer = setTimeout(wake, 80);
        wakePointSample = wake;
      });
    }
    validate();
    if (sampledFrame?.serial === usbFrameNumber) return sampledFrame;
    pointContext.drawImage(usbCanvas, 0, 0, geometry.w, geometry.h);
    sampledFrame = {width:geometry.w, height:geometry.h, serial:usbFrameNumber,
      data:pointContext.getImageData(0, 0, geometry.w, geometry.h).data};
    return sampledFrame;
  }
  async function absoluteReport(x, y, mask = 0) {
    validate();
    if (!absoluteActive) throw Error('绝对坐标通道已断开，请重新操作。');
    await api('input', {lease,seq:++seq,kind:'absolute',buttons:mask,x,y,settle:true});
  }
  if (action.probe) {
    absoluteTried = true;
    absoluteVerified = false;
    verificationDetail = '正在检查三个落点，请保持画面静止。';
    notice('');
    pointPhase = '正在验证绝对坐标';
    lastPoint = null;
    update();
    try {
      const result = await verifyAbsolutePointer({width:geometry.w,height:geometry.h,sample,send:absoluteReport,validate});
      validate();
      if (!absoluteActive) throw Error('绝对坐标通道已断开。');
      absoluteVerified = true;
      verificationDetail = '三点通过 · 最大偏差 '+result.maxError.toFixed(1)+' 个采样像素。';
      notice(verificationDetail);
    } catch (error) {
      validate();
      absoluteVerified = false;
      verificationDetail = error.message + ' 请换到背景清晰的页面再点「验证坐标」。';
      notice(verificationDetail,true);
    }
    return;
  }
  const direct = absoluteActive && absoluteVerified;
  pointPhase = direct ? '发送目标坐标' : '正在定位指针';
  update();
  const started = performance.now();
  let moves = 0;
  async function moveToTarget(x, y) {
    moves++;
    await report(x, y);
  }
  let aligned, absolutePoint;
  try {
    if (direct) {
      absolutePoint = absoluteCoordinates(target,geometry.w,geometry.h);
      await absoluteReport(absolutePoint.x,absolutePoint.y);
    } else {
      aligned = await aimPointer(target, sample, moveToTarget, validate, lastPoint);
    }
  } catch (error) {
    validate();
    throw Error(error.message + '（定位 ' + Math.round(performance.now()-started) + ' 毫秒，移动 ' + moves + ' 次）');
  }
  validate();
  const aimMs = Math.round(performance.now()-started);
  lastPoint = aligned || null;
  if (gesture) {
    pointPhase = '鼠标操控中';
    update();
    const moveHeld = direct ? async (point, mask) => {
      const next = absoluteCoordinates(point,geometry.w,geometry.h);
      if (next.x !== absolutePoint.x || next.y !== absolutePoint.y) {
        await absoluteReport(next.x,next.y,mask);
        absolutePoint = next;
      }
    } : createHeldMover(aligned, sample, report, validate);
    const sendButton = direct ? (_x,_y,mask) => absoluteReport(absolutePoint.x,absolutePoint.y,mask) : report;
    const result = await gesture.play({report:sendButton, validate, moveHeld});
    if (result.dragged) lastPoint = null;
    const label = result.dragged ? '拖动完成' : '按键已松开';
    notice(label + ' · 按住 ' + result.heldMs + ' 毫秒 · 定位 ' + aimMs + ' 毫秒');
  } else {
    let scrolled = 0;
    while (action.wheel) {
      const ticks = action.wheel;
      action.wheel = 0;
      await report(0,0,0,ticks);
      scrolled += ticks;
    }
    if (scrolled) notice('滚动完成 · 定位 ' + aimMs + ' 毫秒');
  }
}

async function processPictureQueue() {
  if (aiming) return;
  aiming = true;
  const epoch = controlEpoch;
  try {
    while (pictureQueue.length && epoch === controlEpoch) {
      currentAction = pictureQueue.shift();
      if (currentAction.keyboardReport) {
        await ensureLease();
        if (epoch !== controlEpoch || !canPoint() || document.activeElement !== usbCanvas) break;
        pointPhase='键盘输入中';
        await sendKeys(currentAction.keyboardReport);
        if (epoch===controlEpoch && !currentAction?.keyboardReport?.keys.length && !keyboard.pressed.size) notice('键盘输入已发送。');
      } else {
        await runPictureAction(currentAction);
      }
      currentAction = null;
    }
  } catch (error) {
    if (epoch === controlEpoch) {
      await stopControl();
      notice(error.message, true);
    }
  } finally {
    if (epoch === controlEpoch && !keyboard.pressed.size) await stopControl(true);
    currentAction = null;
    aiming = false;
    update();
    if (pictureQueue.length) processPictureQueue();
  }
}

function canPoint() {
  return pointMode && usbLive && connected && !document.pointerLockElement;
}

usbCanvas.addEventListener('blur', () => {
  if (pointMode && (lease || aiming || keyboard.pressed.size)) stopControl();
});
usbCanvas.addEventListener('pointerdown', event => {
  if (currentAction?.probe) {
    event.preventDefault();
    return;
  }
  if (!canPoint() || heldPointer || !event.isPrimary || event.button < 0 || event.button > 2) return;
  const geometry = pictureGeometry(), target = mousePoint(event, geometry);
  if (!target || pictureQueue.length >= 4) return;
  event.preventDefault();
  usbCanvas.focus({preventScroll:true});
  const mask = [1,4,2][event.button];
  const gesture = new PictureMouseGesture(target, mask);
  heldPointer = {id:event.pointerId, gesture, geometry};
  usbCanvas.setPointerCapture(event.pointerId);
  pictureQueue.push({target, geometry, gesture});
  processPictureQueue();
});
usbCanvas.addEventListener('pointermove', event => {
  if (heldPointer?.id !== event.pointerId) return;
  const point = mousePoint(event, heldPointer.geometry, true);
  if (point) heldPointer.gesture.move(point);
});
usbCanvas.addEventListener('pointerup', event => {
  if (heldPointer?.id !== event.pointerId) return;
  const {geometry, gesture} = heldPointer;
  heldPointer = null;
  const end = mousePoint(event, geometry, true);
  if (end) gesture.end(end);
  else stopControl();
});
for (const event of ['pointercancel','lostpointercapture']) {
  usbCanvas.addEventListener(event, e => { if (heldPointer?.id === e.pointerId) stopControl(); });
}
usbCanvas.addEventListener('contextmenu', event => { if (canPoint()) event.preventDefault(); });
usbCanvas.addEventListener('auxclick', event => { if (canPoint()) event.preventDefault(); });

let wheelRemainder = 0, lastWheelTime = 0;
usbCanvas.addEventListener('wheel', event => {
  if (currentAction?.probe) { event.preventDefault(); return; }
  if (!canPoint() || heldPointer) return;
  const geometry = pictureGeometry(), target = mousePoint(event, geometry);
  if (!target) return;
  event.preventDefault();
  const now = performance.now();
  if (now - lastWheelTime > 240) wheelRemainder = 0;
  lastWheelTime = now;
  const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? usbCanvas.clientHeight : 1;
  wheelRemainder -= event.deltaY*units/40;
  const whole = Math.trunc(wheelRemainder);
  wheelRemainder -= whole;
  if (!whole) return;
  const action = pictureQueue.at(-1) || currentAction;
  if (action?.target && !action.gesture && Math.hypot(action.target.x-target.x,action.target.y-target.y) <= 8) {
    action.wheel = Math.max(-127, Math.min(127, action.wheel+whole));
  } else if (pictureQueue.length < 4) {
    pictureQueue.push({target, geometry, wheel:Math.max(-127,Math.min(127,whole))});
  }
  processPictureQueue();
}, {passive:false});
