'use strict';
const $ = id => document.getElementById(id);
const startUsb = new URLSearchParams(location.search).get('source') === 'usb';
const token = location.hash.slice(1) || sessionStorage.getItem('control-token');
if (location.hash) { sessionStorage.setItem('control-token', token); history.replaceState(null, '', '/'); }
let lease, seq = 0, connected = false, keyboardConnected = false;
let bluetoothState = 'idle', connecting = false;
let computerName = '';
let inputChain = Promise.resolve(), releaseWait = Promise.resolve(), leaseWait = null, controlEpoch = 0;
let dx = 0, dy = 0, buttons = 0, inputBusy = false, frameBusy = false, frameEpoch = 0;
let capturedPosition = null;
const keyboard = new IpadKeyboard.KeyboardState();
let noticeSource = '', lastBluetoothError = '';
function notice(message, error = false, source = '') {
  noticeSource = source;
  const shownInSidebar = message === verificationDetail && !$('inspector').hidden && !document.fullscreenElement;
  $('notice').textContent = shownInSidebar ? '' : message;
  $('notice').classList.toggle('error', error);
  $('fullscreen-error').textContent = error && document.fullscreenElement === $('monitor') ? message : '';
}
async function api(route, data, options = {}) {
  const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Control-Token': token || '', 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), ...options });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
const usbCanvas = $('usb-canvas');
const pictureKeyboard = $('picture-keyboard');
let usbSession = null, usbLive = false, usbFamily = '';
let usbDeviceId = null, deviceListing = 0, openingDevice = false;
let currentDevice = null, relativeBlocked = false, targetDisplayState = '', remoteControlling = false;
const relativeBlockedHelp = '这台旧式键鼠需要单独核对。请只保留目标设备的 USB 线和它到电脑的蓝牙连接，再点「刷新连接」。';
let needsPairing = false, availablePeers = [], pairing = false;
// A remembered candidate can only trigger the same three-point test on a new stream.
const previousAbsolutePeers = new Map();
let reconnectCandidate = null;
let relativePeerId = null, relativeChallenge = null;
let pointMode = false, aiming = false, usbFrameNumber = 0;
let absoluteActive = false, absoluteVerified = false, absoluteTried = false, usbTurns = 0;
let displaySessionId = null, decodedAt = 0, lastProgress = -Infinity;
let progressPending = null, publishedSerial = 0, reportedSerial = 0;
function flushDisplayProgress(force = false) {
  const id=displaySessionId, serial=usbFrameNumber;
  if (!id || progressPending || serial===reportedSerial || (!force && performance.now()-lastProgress<280)) return;
  lastProgress=performance.now();
  const pending=reportProgress(id,pointerLayout,serial,decodedAt);
  progressPending=pending;
  pending.then(()=>{if (displaySessionId===id) reportedSerial=serial;},()=>{}).finally(()=>{
    if (progressPending===pending) progressPending=null;
  });
}
setInterval(flushDisplayProgress,300);
async function reportProgress(id, layout, serial, capturedAt) {
  return api('display/progress',{sessionId:id,layout,serial,ageMs:Math.max(0,performance.now()-capturedAt)});
}
async function watchDisplay(id, session) {
  const current = () => displaySessionId===id && usbSession===session && !session.signal.aborted;
  while (current()) {
    try {
      const response=await fetch('/api/display/watch',{method:'POST',signal:session.signal,
        headers:{'X-Control-Token':token,'Content-Type':'application/json'},body:JSON.stringify({sessionId:id})});
      if (!response.ok) throw Error('无法连接画面核对。');
      const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer='';
      while (current()) {
        const {value,done}=await reader.read();
        if (done) break;
        buffer+=value;
        const lines=buffer.split('\n'); buffer=lines.pop();
        for (const line of lines) {
          const request=JSON.parse(line);
          if (!request.id || request.layout!==pointerLayout || !current()) continue;
          if (request.after===usbFrameNumber) await waitForUsbFrame(request.after,60);
          if (!current() || request.layout!==pointerLayout) continue;
          const {w,h}=pictureGeometry();
          const canvas=document.createElement('canvas');
          canvas.width=w; canvas.height=h;
          const ctx=canvas.getContext('2d',{willReadFrequently:true});
          ctx.drawImage(usbCanvas,0,0,w,h);
          await fetch('/api/display/pixels',{method:'POST',signal:session.signal,headers:{
            'X-Control-Token':token,'X-USB-Session':id,'X-Layout':String(pointerLayout),'X-Sample-Id':request.id,
            'X-Width':String(w),'X-Height':String(h),'X-Serial':String(usbFrameNumber),'X-Frame-Age':String(performance.now()-decodedAt)},
            body:ctx.getImageData(0,0,w,h).data});
        }
      }
    } catch { /* A new stream or a restarted service replaces this channel. */ }
    if (current()) await new Promise(resolve=>setTimeout(resolve,350));
  }
}
let wakePointSample = null;
let lastPoint = null, heldPointer = null, currentAction = null;
const pictureQueue = [];
let verificationDetail = '';
let pointerLayout = 1;
function resetVerification() {
  pointerLayout++;
  lastInput('');
  relativeChallenge = null;
  if (capturedPosition || (pointMode && (aiming || heldPointer))) stopControl();
  if (assistantView) {
    lastFrameUpload = -Infinity;
    api('frame/clear', {view:assistantView, layout:pointerLayout,sessionId:displaySessionId}).catch(error => notice(error.message,true));
  }
  absoluteVerified = absoluteTried = false;
  verificationDetail = '';
}
const pointFrame = document.createElement('canvas');
const pointContext = pointFrame.getContext('2d', {willReadFrequently:true});
let assistantView = null;
let assistantChanging = false;
async function disableAssistant() {
  const view=assistantView;
  assistantView = null;
  frameEpoch++;
  await api('assistant/disable', {view,sessionId:displaySessionId});
  update();
}
$('assistant').onclick = async () => {
  assistantChanging = true;
  update();
  try {
    if (assistantView) await disableAssistant();
    else {
      await stopControl();
      const id=displaySessionId;
      const result = await api('assistant/enable', {sessionId:id});
      if (!usbLive || id!==displaySessionId) return;
      publishedSerial=0; lastFrameUpload=-Infinity;
      assistantView = result.view;
      // The open response binds this grant to this page, including while its
      // image encoder or background timers are paused. Unload closes the stream.
      watchAssistantWindow(result.view);
      if (!usbLive) await disableAssistant();
    }
  } catch (error) { notice(error.message, true); }
  finally { assistantChanging = false; update(); }
};
async function watchAssistantWindow(view) {
  try {
    const response = await fetch('/api/assistant/presence', {method:'POST',
      headers:{'X-Control-Token':token, 'Content-Type':'application/json'}, body:JSON.stringify({view})});
    if (!response.ok) throw Error('无法保持分享窗口连接。');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = '';
    while (assistantView === view) {
      const {value,done} = await reader.read();
      if (done) break;
      buffered += value;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const id of lines) {
        if (id === 'sharing' || !usbLive || assistantView !== view) continue;
        const {w,h} = pictureGeometry();
        const canvas = document.createElement('canvas');
        canvas.width=w; canvas.height=h;
        const ctx=canvas.getContext('2d');
        ctx.drawImage(usbCanvas,0,0,w,h);
        await fetch('/api/assistant/pixels',{method:'POST',headers:{'X-Control-Token':token,
          'X-Assistant-View':view,'X-Sample-Id':id,'X-Width':String(w),'X-Height':String(h),
          'X-Layout':pointerLayout,'X-Serial':String(usbFrameNumber)},
          body:ctx.getImageData(0,0,w,h).data});
      }
    }
  } catch { /* A disconnected window no longer owns a live share. */ }
  if (assistantView === view) {
    assistantView = null;
    frameEpoch++;
    notice('助手授权已结束，可在当前窗口重新开启。');
    update();
  }
}
function bluetoothRunning() { return connected || ['starting','waiting','connected'].includes(bluetoothState); }
function lastInput(message) {
  $('input-result').textContent = message;
  $('input-row').hidden = !message;
}
function ready() { return connected && usbLive; }
const monitor = $('monitor');
const modePicker = $('mode-picker');
const modeSummary = $('mode-summary');
const modeChoices = [$('preview-mode'), $('point'), $('control')];
let startingCapture = false;
let capturedSession = null;
function updateCaptureFocus(captured) {
  if (captured) {
    capturedSession = usbSession;
  } else if (capturedSession && !document.pointerLockElement) {
    const session = capturedSession;
    capturedSession = null;
    if (!document.hasFocus() || document.hidden) return;
    // Fullscreen hides the entire toolbar during capture. Let the browser
    // finish unlocking and make the summary focusable on the next frame.
    window.requestAnimationFrame(() => {
      const focus = document.activeElement;
      if (session !== usbSession || !usbLive || pointMode || document.pointerLockElement || document.hidden || !document.hasFocus()) return;
      if (focus === document.body || focus === usbCanvas || focus === $('control')) modeSummary.focus({preventScroll:true});
    });
  }
}
function closeModePicker(restoreFocus = false) {
  modePicker.open = false;
  if (restoreFocus) modeSummary.focus({preventScroll:true});
}
document.addEventListener('pointerdown', event => {
  if (modePicker.open && !modePicker.contains(event.target)) closeModePicker();
});
modePicker.addEventListener('focusout', event => {
  if (event.relatedTarget && !modePicker.contains(event.relatedTarget)) closeModePicker();
});
modePicker.addEventListener('keydown', event => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault();
  modePicker.open = true;
  const choices = modeChoices.filter(button => !button.disabled);
  const index = choices.indexOf(document.activeElement);
  const first = event.key === 'Home' || (index < 0 && event.key === 'ArrowDown');
  const last = event.key === 'End' || (index < 0 && event.key === 'ArrowUp');
  const step = event.key === 'ArrowDown' ? 1 : -1;
  choices[first ? 0 : last ? choices.length-1 : (index+step+choices.length)%choices.length]?.focus();
});
const inspectorButton = $('toggle-inspector');
function setSidebarVisible(visible) {
  const sidebar = $('inspector');
  if (!visible && sidebar.contains(document.activeElement)) inspectorButton.focus();
  sidebar.hidden = !visible;
  inspectorButton.setAttribute('aria-expanded', String(visible));
  inspectorButton.title = visible ? '收起设备设置' : '显示设备设置';
  inspectorButton.setAttribute('aria-label', inspectorButton.title);
}
inspectorButton.onclick = () => setSidebarVisible($('inspector').hidden);
const compactWindow = window.matchMedia('(max-width: 760px)');
setSidebarVisible(!compactWindow.matches);
compactWindow.addEventListener('change', event => setSidebarVisible(!event.matches));
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
function setUsbFamily(family) {
  usbFamily = family === 'iPhone' || family === 'iPad' ? family : '';
}
function targetState() {
  if (targetDisplayState === 'checking') return '正在核对画面';
  if (targetDisplayState === 'stale') return '等待画面更新 · 输入已暂停';
  if (pairing) return '正在核对蓝牙';
  if (!connected) {
    if (needsPairing && availablePeers.length) return '仅预览 · 蓝牙待核对';
    return bluetoothRunning() ? '仅预览 · 等待蓝牙' : '仅预览';
  }
  if (pointMode || document.pointerLockElement || remoteControlling) return '控制目标已核对 · 正在操控';
  if (assistantView) return '控制目标已核对 · 助手已获授权';
  return '控制目标已核对 · 仅预览';
}
$('device-alias').onsubmit = async event => {
  event.preventDefault();
  const device = currentDevice;
  if (!usbLive || !device) return;
  const session = usbSession;
  $('save-alias').disabled = true;
  try {
    const {alias} = await api('device/alias',{deviceId:device.id,alias:$('alias-input').value});
    if (session !== usbSession) return;
    statusRevision++;
    device.alias = alias;
    $('alias-input').value = alias;
    $('alias-result').textContent = alias ? '已保存到这台电脑。' : '已恢复设备名称。';
    update();
  } catch (error) {
    if (session === usbSession) $('alias-result').textContent = error.message;
  } finally { if (session === usbSession) $('save-alias').disabled = false; }
};
$('refresh-pairing').onclick = async () => {
  const session = usbSession;
  $('refresh-pairing').disabled = true;
  try {
    await api('devices');
    if (session === usbSession) await updateBluetooth();
  } catch (error) { if (session === usbSession) notice(error.message,true); }
  finally { $('refresh-pairing').disabled = false; }
};
function update() {
  const probing = !!currentAction?.probe;
  const canPair = usbLive && needsPairing && availablePeers.some(peer => peer.absolute && (!peer.boundDeviceId || peer.boundDeviceId === usbDeviceId));
  const available = usbLive && (absoluteActive || canPair || !!relativePeerId);
  let status = '等待 USB 投屏', detail = '连接 USB 画面与蓝牙后可验证。';
  if (usbLive) {
    if (needsPairing && availablePeers.length) {
      status = pairing ? '正在识别蓝牙设备' : '待核对蓝牙设备';
      detail = relativePeerId ?
        (relativeChallenge ? '确认当前设备上的指针刚刚向右移动。' : '请先把设备指针放在画面中间，然后移动指针核对键鼠。') :
        (relativeBlocked && !canPair ? relativeBlockedHelp : verificationDetail) || (canPair ?
        '在设备上打开静止页面，例如「设置 → 通用」。' :
        '请在这台设备上开启辅助触控，并在蓝牙设置中连接这台电脑。');
    } else if (!connected) { status = '等待蓝牙'; detail = '连接蓝牙后检查设备的指针输入。'; }
    else if (!absoluteActive) { status = '视觉定位'; detail = '设备尚未订阅绝对坐标输入。'; }
    else {
      status = probing ? '正在验证' : absoluteVerified ? '绝对坐标直达' : absoluteTried ? '视觉定位' : '等待验证';
      detail = verificationDetail || '在设备上打开静止页面，例如「设置 → 通用」。';
    }
  }
  $('position-status').textContent = status;
  $('position-status').classList.toggle('verified', absoluteVerified && available);
  const verified = absoluteVerified && available;
  $('position-detail').hidden = verified;
  if ($('position-detail').textContent !== detail) $('position-detail').textContent = detail;
  $('verification-row').hidden = !verified;
  $('verification-result').textContent = verified ? verificationDetail : '';
  const captured = !!document.pointerLockElement;
  $('transport').hidden = !usbLive;
  if (!usbLive) closeModePicker();
  const captureMode = document.pointerLockElement === usbCanvas && !!lease;
  const pictureMode = pointMode && ready() && !captured;
  $('mode-current').textContent = captureMode ? '键鼠控制' : pictureMode ? '画面操控' : '仅预览';
  $('preview-mode').setAttribute('aria-pressed', String(!pictureMode && !captureMode));
  $('point').setAttribute('aria-pressed', String(pictureMode));
  $('control').setAttribute('aria-pressed', String(captureMode));
  $('capture-hint').hidden = !captureMode;
  const device = usbLive && currentDevice;
  const label = device ? usbDeviceLabel(device) : '';
  const stateSummary = label ? targetState() : '';
  $('source-status').textContent = label || (usbSession ? '正在连接…' : '未连接');
  $('preview-name').textContent = device ? usbDeviceName(device) : '设备屏幕';
  $('preview-code').textContent = device ? ' · ' + usbDeviceCode(device) : '';
  $('preview-heading').title = label;
  usbCanvas.setAttribute('aria-label', (label || '设备') + ' USB 实时画面');
  pictureKeyboard.setAttribute('aria-label', label ? label + ' 画面键盘' : '设备画面键盘');
  $('target-state').textContent = stateSummary;
  $('target-state').hidden = !label;
  $('fullscreen-name').textContent = device ? usbDeviceName(device) : '';
  $('fullscreen-code').textContent = $('preview-code').textContent;
  $('fullscreen-state').textContent = stateSummary;
  $('fullscreen-target').hidden = !label;
  $('device-alias').hidden = !label;
  $('refresh-pairing').hidden = !relativeBlocked || canPair;
  $('position-panel').hidden = !usbLive || (!connected && !(needsPairing && availablePeers.length));
  $('keyboard-row').hidden = !connected;
  $('verify-position').disabled = !available || aiming || pairing || !!document.pointerLockElement;
  $('verify-position').hidden = !available;
  $('confirm-relative').hidden = !relativeChallenge;
  $('confirm-relative').disabled = pairing || !relativeChallenge;
  $('verify-position').textContent = pairing ? '正在核对…' : relativePeerId ? (relativeChallenge ? '再移动一次' : '移动指针核对') : needsPairing ? '核对蓝牙设备' : probing ? '验证中…' : absoluteVerified ? '重新验证' : '验证坐标';
  $('point').disabled = !ready() || pairing || startingCapture;
  usbCanvas.classList.toggle('point-mode', pictureMode);
  pictureKeyboard.disabled = !canPoint() || !keyboardConnected;
  $('assistant').disabled = aiming || assistantChanging || !usbLive;
  $('assistant').textContent = assistantView ? '停止助手控制' : '允许助手控制';
  $('assistant').setAttribute('aria-pressed', String(!!assistantView));
  fullscreenButton.hidden = !document.fullscreenEnabled || (!usbLive && document.fullscreenElement !== monitor);
  monitor.classList.toggle('captured', captureMode);
  updateCaptureFocus(captureMode);
  $('control').disabled = aiming || !ready() || pairing || startingCapture;
  const running = bluetoothRunning();
  $('connect').disabled = connecting;
  $('connect').textContent = running ? '断开' : '连接';
  $('connect').setAttribute('aria-label', running ? '断开蓝牙' : '连接蓝牙');
  const waitingPairing = running && !connected && !availablePeers.length;
  $('pairing-help').hidden = !waitingPairing;
  if (waitingPairing) $('pairing-help').textContent = '在' + (device ? '所选设备' : '要操控的设备') + '的「设置 → 蓝牙」中选择' + pairingComputer() + '，核对两端的配对码。';
  $('stop-usb').disabled = !usbSession;
  $('stop-usb').hidden = $('stop-usb').disabled;
  const usbAction = $('usb');
  const usbSlot = $(usbLive ? 'active-usb-action' : 'idle-usb-action');
  if (usbAction.parentElement !== usbSlot) usbSlot.append(usbAction);
  usbAction.disabled = openingDevice || (!!usbSession && !usbLive);
  const opening = !usbLive && !!(usbSession || openingDevice || usbRelease);
  $('connection-heading').textContent = opening ? (currentDevice ? '正在连接 ' + usbDeviceName(currentDevice) : '正在结束上一次投屏') : '连接 iPhone 或 iPad';
  $('connection-instruction').hidden = opening;
  $('opening-progress').hidden = !opening;
  $('start-actions').hidden = opening;
  $('cancel-opening').hidden = !usbSession || usbLive;
  $('setup-start').disabled = openingDevice || !!usbSession;
  usbAction.textContent = usbLive ? '切换设备' : usbSession ? '正在连接…' : '仅投屏';
  document.body.classList.toggle('controlling', !!lease);
}
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
  if (old) releaseWait = api('control/stop', { lease: old }, { keepalive: true }).catch(()=>{});
  await releaseWait;
  update();
}
async function ensureLease() {
  if (!ready()) throw new Error('画面和蓝牙都就绪后才能控制。');
  if (lease) return;
  if (leaseWait) return leaseWait;
  const epoch = controlEpoch;
  leaseWait = (async () => {
    await releaseWait;
    if (epoch !== controlEpoch || !ready()) throw new Error('控制已取消。');
    const result = await api('control/start', usbDeviceId ? {deviceId:usbDeviceId,sessionId:displaySessionId} : {});
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
let usbRelease = null;
async function stopUsb() {
  if (usbRelease) return usbRelease;
  const session = usbSession, id = displaySessionId;
  statusRevision++;
  pointMode=false;
  resetVerification();
  const assistantClosed = assistantView ? disableAssistant().catch(() => {}) : null;
  usbSession = null;
  usbDeviceId = null;
  currentDevice = null;
  relativeBlocked = remoteControlling = false;
  targetDisplayState = '';
  displaySessionId=null; lastProgress=-Infinity; progressPending=null; publishedSerial=reportedSerial=0;
  needsPairing = false;
  reconnectCandidate = null;
  relativePeerId = relativeChallenge = null;
  availablePeers = [];
  usbLive = false;
  setUsbFamily('');
  usbCanvas.hidden = true;
  usbCanvas.width = usbCanvas.height = 1;
  const controlClosed = stopControl();
  $('placeholder').hidden = false; $('video-dot').classList.remove('on');
  $('video-status').textContent = id ? '正在释放上一台设备…' : '等待画面';
  if (id) $('opening-progress').textContent = '正在释放 USB 连接，请稍候。';
  frameEpoch++;
  // Keep the stream open until its owner tells the capture process to restore USB.
  // Aborting the HTTP reader alone can race the next device's request.
  const captureClosed = id ? api('usb/stop',{sessionId:id}) : null;
  if (!id) session?.abort();
  usbRelease = Promise.all([controlClosed,assistantClosed,captureClosed]);
  update();
  try { await usbRelease; }
  finally {
    session?.abort();
    usbRelease = null;
    $('video-status').textContent = '等待画面';
    update();
  }
}
const devicePicker = $('device-picker');
function closeDevicePicker() {
  deviceListing++;
  if (devicePicker.open) devicePicker.close();
}
function usbDeviceName(device) { return device.alias || device.name || device.model || device.family || 'Apple 设备'; }
function usbDeviceCode(device) { return device.id.slice(-8).toUpperCase(); }
function usbDeviceLabel(device) { return usbDeviceName(device) + ' · ' + usbDeviceCode(device); }
function pairingComputer() { return computerName ? '电脑「' + computerName + '」' : '这台电脑'; }
async function chooseUsbDevice(autoConnect) {
  if (openingDevice) return;
  const revision = ++deviceListing;
  if (!devicePicker.open) devicePicker.showModal();
  $('device-list').replaceChildren();
  $('device-picker-status').textContent = '正在查找设备…';
  $('refresh-devices').disabled = true;
  try {
    const {devices} = await api('devices');
    if (revision !== deviceListing || !devicePicker.open) return;
    if (autoConnect && devices.length === 1 && devices[0].driver === 'ready') {
      openUsbDevice(devices[0].id, {device:devices[0]});
      return;
    }
    $('device-picker-status').textContent = devices.length ? '' : '没有发现设备。请接好数据线、解锁设备，再刷新。';
    for (const device of devices) {
      const option = document.createElement('button');
      const current = device.id === usbDeviceId;
      const state = current ? '正在投屏' : device.driver === 'ready' ? '' :
        device.driver === 'replug' ? '配置此设备（需重新插线）' : '配置此设备';
      option.textContent = usbDeviceLabel(device) + (state ? ' · ' + state : '');
      option.disabled = current;
      option.onclick = () => {
        if (device.driver === 'ready') return openUsbDevice(device.id, {device});
        const label = usbDeviceLabel(device);
        closeDevicePicker();
        return startConsoleSetup({deviceId:device.id, label, videoOnly:!usbLive});
      };
      $('device-list').append(option);
    }
  } catch (error) {
    if (revision === deviceListing) {
      $('device-picker-status').textContent = error.message;
      if (!usbSession) {
        const configure = document.createElement('button');
        configure.textContent = '配置 USB 投屏';
        configure.onclick = () => { closeDevicePicker(); return startConsoleSetup({videoOnly:true}); };
        $('device-list').append(configure);
      }
    }
  } finally {
    if (revision === deviceListing) $('refresh-devices').disabled = false;
  }
}
$('usb').onclick = () => chooseUsbDevice(!usbLive);
$('refresh-devices').onclick = () => chooseUsbDevice(false);
$('close-devices').onclick = closeDevicePicker;
devicePicker.addEventListener('cancel', () => { deviceListing++; });
async function openUsbDevice(deviceId, {signal, onLive, device} = {}) {
  if (openingDevice || !deviceId || signal?.aborted) return;
  openingDevice = true;
  closeDevicePicker();
  update();
  try {
    await stopUsb();
  } catch (error) {
    notice(error.message,true);
    if (onLive) throw error;
    return;
  } finally {
    openingDevice = false;
    update();
  }
  if (signal?.aborted) return;
  usbDeviceId = deviceId;
  reconnectCandidate = onLive ? null : previousAbsolutePeers.get(deviceId);
  currentDevice = {...device,id:deviceId};
  $('alias-input').value = currentDevice.alias || '';
  $('alias-result').textContent = '';
  $('save-alias').disabled = false;
  needsPairing = true;
  connected = keyboardConnected = absoluteActive = false;
  const session = new AbortController();
  usbSession = session;
  $('opening-progress').textContent = '等待 USB 画面 · ' + usbDeviceCode(currentDevice);
  const cancelStartup = () => session.abort();
  signal?.addEventListener('abort', cancelStartup, {once:true});
  update();
  if (!onLive) $('cancel-opening').focus({preventScroll:true});
  $('video-status').textContent = '正在打开 USB 视频…';
  let frames = 0, decodeMs = 0, last = performance.now();
  try {
    let previousSize = '';
    const onRetry = message => {
      if (usbSession !== session) return;
      $('video-status').textContent = message;
      $('opening-progress').textContent = message;
      if (onLive && !$('setup-panel').hidden) $('setup-detail').textContent = message;
    };
    await playUsbVideo({ token, deviceId, canvas: usbCanvas, signal: session.signal, onRetry, onFrame(ms, turns = 0, family, id) {
      if (usbSession !== session) return;
      const size = usbCanvas.width + 'x' + usbCanvas.height;
      if (previousSize !== size || usbTurns !== turns) {
        previousSize = size;
        usbTurns = turns;
        resetVerification();
        lastPoint = null;
        if (usbLive) update();
      }
      usbFrameNumber++;
      decodedAt=performance.now();
      if (id && !displaySessionId) {
        displaySessionId=id;
        watchDisplay(id,session);
      }
      flushDisplayProgress(!usbLive);
      if (assistantView) publishFrame();
      wakePointSample?.();
      if (!usbLive) {
        const focusPreview = document.activeElement === $('cancel-opening');
        usbLive = true;
        signal?.removeEventListener('abort', cancelStartup);
        setUsbFamily(family);
        usbCanvas.hidden = false;
        $('placeholder').hidden = true;
        $('video-dot').classList.add('on');
        $('video-status').textContent = 'USB 直连 · 已收到画面';
        notice('');
        last = performance.now();
        update();
        if (focusPreview) modeSummary.focus({preventScroll:true});
        onLive?.();
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
    if (onLive) throw error;
  } finally {
    signal?.removeEventListener('abort', cancelStartup);
    if (usbSession === session) {
      try { await stopUsb(); } catch (error) { notice(error.message,true); }
    }
  }
}
$('stop-usb').onclick = async () => {
  try { await stopUsb(); notice(''); } catch (error) { notice(error.message,true); }
};
$('cancel-opening').onclick = async () => {
  await $('stop-usb').onclick();
  if (!usbSession) $('usb').focus({preventScroll:true});
};
$('connect').onclick = () => changeBluetooth(bluetoothRunning());
async function changeBluetooth(disconnect, reportFailure = false) {
  if (connecting) return;
  connecting = true;
  statusRevision++;
  update();
  try {
    if (disconnect) {
      pointMode = false;
      await stopControl();
      await api('disconnect', {});
      connected = keyboardConnected = false;
      bluetoothState = 'idle';
    } else {
      const status = await api('connect', {});
      bluetoothState = status.state;
    }
    await updateBluetooth();
  } catch (error) {
    notice(error.message,true);
    if (reportFailure) throw error;
  } finally { connecting = false; update(); }
}
$('control').onclick = async () => {
  if (!ready() || startingCapture || aiming || pairing) return;
  closeModePicker();
  if (document.pointerLockElement === usbCanvas && lease) return;
  const previousFocus = document.activeElement;
  startingCapture = true;
  pointMode = false;
  try {
    const released = stopControl();
    const epoch = controlEpoch;
    // Request the browser lock in the actual menu button's activation, before
    // awaiting cleanup of the preceding mode or acquiring its replacement lease.
    await Promise.all([usbCanvas.requestPointerLock(), released, leaseWait?.catch(() => {})]);
    if (epoch !== controlEpoch || !ready()) throw new Error('控制已取消。');
    if(document.pointerLockElement !== usbCanvas) throw new Error('鼠标捕获已取消。');
    await ensureLease();
    if (usbLive && absoluteVerified && absoluteActive) {
      capturedPosition = {x:0.5, y:0.5};
      await send();
      if (!lease) return;
    }
    notice('');
  } catch(e) {
    await stopControl();
    if (usbLive && document.hasFocus() && (document.activeElement === previousFocus || document.activeElement === document.body)) modeSummary.focus({preventScroll:true});
    notice('未进入鼠标捕获。' + e.message, true);
  } finally { startingCapture = false; update(); }
};
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && !pointMode && (lease || startingCapture)) {
    stopControl();
  }
  update();
});
document.addEventListener('mousemove', e => { if (document.pointerLockElement && lease) { dx += e.movementX * Number($('speed').value); dy += e.movementY * Number($('speed').value); dx=Math.max(-508,Math.min(508,dx)); dy=Math.max(-508,Math.min(508,dy)); } });
function flushCaptureMotion() {
  if (capturedPosition) {
    if (dx || dy) send(dx,dy);
    dx = dy = 0;
    return;
  }
  // Enqueue motion under the old button state before the next button or wheel report.
  while (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
    const x = Math.max(-127,Math.min(127,Math.trunc(dx)));
    const y = Math.max(-127,Math.min(127,Math.trunc(dy)));
    dx -= x; dy -= y;
    send(x,y);
  }
}
for (const event of ['mousedown','mouseup']) document.addEventListener(event, e => {
  if (document.pointerLockElement && lease && e.button >= 0 && e.button <= 2) {
    flushCaptureMotion();
    buttons = e.buttons & 7;
    send(0,0,0,buttons);
  }
});
document.addEventListener('wheel', e => {
  if (!document.pointerLockElement || !lease) return;
  e.preventDefault();
  flushCaptureMotion();
  if (e.deltaY) send(0,0,Math.sign(-e.deltaY)*3);
}, { passive: false });
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
setInterval(async () => {
  const owner = lease;
  if (!owner) return;
  try { await api('heartbeat',{lease:owner}); }
  catch (error) {
    if (lease !== owner) return;
    await stopControl();
    notice(error.message,true);
  }
},350);
let statusRevision = 0;
let keyboardGeneration;
async function updateBluetooth() {
  const revision = ++statusRevision, deviceId = usbDeviceId;
  try {
    const status=await api('status');
    if (revision !== statusRevision || deviceId !== usbDeviceId) return;
    if (status.computerName) computerName = status.computerName;
    const ambiguous = status.active > 1 || status.keyboardActive > 1;
    bluetoothState=status.state;
    const matchingSource = !usbLive || usbDeviceId === status.activeDeviceId;
    if (usbLive && currentDevice && matchingSource) {
      if (status.deviceLabel && (!currentDevice.name || status.deviceLabel !== currentDevice.family)) currentDevice.name = status.deviceLabel;
      if (typeof status.deviceAlias === 'string' && currentDevice.alias !== status.deviceAlias) {
        if (document.activeElement !== $('alias-input') && $('alias-input').value === (currentDevice.alias || '')) $('alias-input').value = status.deviceAlias;
        currentDevice.alias = status.deviceAlias;
      }
    }
    relativeBlocked = usbLive && matchingSource && !!status.relativeBlocked;
    targetDisplayState = matchingSource ? status.displayState || '' : '';
    remoteControlling = matchingSource && !!status.controlling;
    availablePeers = matchingSource ? status.peers || [] : [];
    needsPairing = usbLive && (!matchingSource || !!status.needsPairing);
    relativePeerId = needsPairing && status.canIdentifyRelative && availablePeers.length===1 && !availablePeers[0].absolute ?
      availablePeers[0].id : null;
    if (relativeChallenge && (relativeChallenge.peerId !== relativePeerId || relativeChallenge.expires <= performance.now())) relativeChallenge = null;
    connected=!needsPairing && !ambiguous && status.active===1;
    const hadKeyboard = keyboardConnected;
    keyboardConnected=connected && status.keyboardActive===1;
    const keyboardChanged = Number.isSafeInteger(keyboardGeneration) &&
      Number.isSafeInteger(status.keyboardGeneration) && keyboardGeneration !== status.keyboardGeneration;
    keyboardGeneration = status.keyboardGeneration;
    if (hadKeyboard && (!keyboardConnected || keyboardChanged) && (lease || leaseWait || keyboard.pressed.size || aiming)) {
      await stopControl();
      if (revision !== statusRevision || deviceId !== usbDeviceId) return;
      if (connected) notice(keyboardConnected ? '键盘已重新连接，已释放之前按住的键。' : '键盘已断开，已释放按键。键盘重新连接后可继续输入。');
    }
    absoluteActive = connected && status.absoluteActive === 1;
    if (!absoluteActive && (absoluteTried || absoluteVerified || currentAction?.probe)) {
      resetVerification();
      if (currentAction?.probe && lease) await stopControl();
    }
    if (assistantView && !assistantChanging && !status.assistantEnabled) { assistantView=null; notice('助手控制已结束。'); }
    $('keyboard-status').textContent = keyboardConnected ? '已连接' : connected ? '需重新配对' : '尚未连接';
    const text={idle:'未连接',starting:'正在启动…',waiting:'等待配对',connected:'已连接',error:'连接失败'};
    $('bluetooth-status').textContent = needsPairing && availablePeers.length ? '等待设备核对' :
      ambiguous ? '检测到多个蓝牙连接' : (text[status.state] || status.state);
    if (status.error && status.error !== lastBluetoothError) notice(status.error, true, 'bluetooth');
    if (!status.error && noticeSource === 'bluetooth') notice('');
    lastBluetoothError = status.error || '';
    if (!connected) { pointMode = false; if (lease) await stopControl(); }
    if (revision !== statusRevision || deviceId !== usbDeviceId) return;
    update();
    if (usbLive && matchingSource && connected) reconnectCandidate = null;
    if (reconnectCandidate && usbLive && matchingSource && needsPairing && !status.verifiedPeerId &&
        !pairing && !remoteControlling && !assistantView && !document.hidden &&
        availablePeers.some(p=>p.id===reconnectCandidate && p.absolute && !p.boundDeviceId)) {
      const candidate = reconnectCandidate, session = usbSession;
      reconnectCandidate = null;
      await verifyBluetoothDevice(()=>usbSession===session,false,candidate);
    }
  } catch(e) {
    if (revision !== statusRevision || deviceId !== usbDeviceId) return;
    pointMode = connected = keyboardConnected = absoluteActive = false;
    resetVerification();
    await stopControl();
    if (revision === statusRevision && deviceId === usbDeviceId) notice('本机服务不可用，请重新运行启动器。',true);
  }
}
setInterval(updateBluetooth,1000);
function frameCanvas() {
  const {width, height} = usbCanvas;
  if (!usbLive || !width || !height) return null;
  const canvas=document.createElement('canvas'); const scale=Math.min(1,1600/width);
  canvas.width=Math.round(width*scale); canvas.height=Math.round(height*scale);
  canvas.getContext('2d').drawImage(usbCanvas,0,0,canvas.width,canvas.height); return canvas;
}
let lastFrameUpload = -Infinity;
async function publishFrame() {
  if(!assistantView || frameBusy || !displaySessionId || publishedSerial===usbFrameNumber ||
      performance.now()-decodedAt>4000 || performance.now() - lastFrameUpload < 490) return;
  const canvas=frameCanvas(); if(!canvas) return; frameBusy=true; const epoch=frameEpoch;
  lastFrameUpload = performance.now();
  const layout=pointerLayout, serial=usbFrameNumber, capturedAt=decodedAt, id=displaySessionId, view=assistantView;
  const verified=absoluteVerified;
  try {
    await reportProgress(id,layout,serial,capturedAt);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
    if(epoch!==frameEpoch || assistantView!==view || id!==displaySessionId || layout!==pointerLayout) return;
    const response=await fetch('/api/frame',{method:'POST',headers:{'X-Control-Token':token,'Content-Type':'image/jpeg','X-Assistant-View':assistantView || '',
      'X-USB-Session':id,'X-Serial':String(serial),'X-Layout':layout,'X-Verified':String(verified),'X-Width':String(canvas.width),'X-Height':String(canvas.height),
      'X-View-Mode':document.fullscreenElement === monitor ? 'fullscreen' : 'window'},body:blob});
    if(response.ok && id===displaySessionId && view===assistantView) publishedSerial=serial;
    if(!response.ok && epoch===frameEpoch && assistantView && layout===pointerLayout)
      throw new Error('本机画面更新失败');
  } catch(e) { notice(e.message,true); } finally { frameBusy=false; }
}
setInterval(publishFrame,500);

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
  if (e.code==='Escape' && type==='keydown' && modePicker.open) {
    e.preventDefault(); e.stopImmediatePropagation();
    closeModePicker(true);
    return;
  }
  if (e.code==='Escape' && pointMode && type==='keydown') {
    pointMode=false; stopControl(); modeSummary.focus({preventScroll:true}); return;
  }
  const pictureFocused = hasPictureKeyboardFocus();
  if (!pictureFocused && !(document.pointerLockElement && lease)) return;
  if(e.code==='Escape'){ stopControl(); return; }
  if (!keyboardConnected) { notice('键盘尚未连接，请检查蓝牙。',true); return; }
  if (pictureFocused && e.ctrlKey && !e.altKey && (e.code==='KeyV' || e.key?.toLowerCase()==='v')) return;
  const code = e.code && e.code !== 'Unidentified' ? e.code : e.key;
  const report=keyboard.change(code,type==='keydown');
  if (!report) {
    // Some native automation delivers a printable key without a hardware scan code.
    if (pictureFocused && e.key?.length===1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      if (type==='keydown') forwardPictureText(e.key);
    }
    return;
  }
  e.preventDefault();e.stopPropagation();
  if(e.repeat)return;
  if (!pictureFocused) { sendKeys(report); return; }
  if (currentAction?.probe) { keyboard.clear(); return; }
  if (pictureQueue.length >= 96) {
    stopControl(); notice('输入积压，已释放键鼠。',true); return;
  }
  pictureQueue.push({keyboardReport:report});
  processPictureQueue();
},true);
$('command-control').onchange=()=>{keyboard.commandControl=$('command-control').checked;keyboard.clear();if(lease&&keyboardConnected)sendKeys(keyboard.report());};
$('preview-mode').onclick=async () => {
  pointMode=false;
  closeModePicker(true);
  await stopControl();
  notice('');
};
function hasPictureKeyboardFocus() {
  return canPoint() && document.activeElement === pictureKeyboard;
}
function focusPictureKeyboard() {
  if (keyboardConnected && canPoint()) {
    pictureKeyboard.disabled = false;
    pictureKeyboard.focus({preventScroll:true});
  }
}
function queueStrokes(strokes) {
  if (!hasPictureKeyboardFocus() || !keyboardConnected || currentAction?.probe) return;
  if (pictureQueue.length >= 96) { stopControl(); notice('输入积压，已释放键鼠。',true); return; }
  pictureQueue.push({strokes, restore:keyboard.report()});
  processPictureQueue();
}
function forwardPictureText(text) {
  if (!text || !hasPictureKeyboardFocus()) return;
  if (text.length > 256) { notice('每次最多输入 256 个字符，请分段输入。',true); return; }
  try { queueStrokes(IpadKeyboard.textStrokes(text)); }
  catch (error) { notice(error.message,true); }
}
pictureKeyboard.addEventListener('input', e => {
  if (e.isComposing) return;
  const text = pictureKeyboard.value;
  pictureKeyboard.value = '';
  forwardPictureText(text);
});
pictureKeyboard.addEventListener('compositionend', () => {
  const text = pictureKeyboard.value;
  pictureKeyboard.value = '';
  forwardPictureText(text);
});
pictureKeyboard.addEventListener('beforeinput', e => {
  if (!hasPictureKeyboardFocus() || e.isComposing) return;
  const key = e.inputType === 'deleteContentBackward' ? 42 : e.inputType === 'deleteContentForward' ? 76 : 0;
  if (key) { e.preventDefault(); queueStrokes([{modifiers:0,keys:[key]}]); }
});
if (startUsb) $('usb').click();

$('point').onclick = enterPictureMode;
async function enterPictureMode() {
  if (!ready() || startingCapture || pairing) return;
  closeModePicker();
  if (!pointMode) {
    pointMode = true;
    await stopControl();
  }
  if (canPoint()) focusPictureKeyboard();
  notice('');
  update();
}

$('verify-position').onclick = async () => {
  if (relativePeerId) { await identifyRelative(false); return; }
  if (needsPairing) { await verifyBluetoothDevice(); return; }
  if (aiming || !usbLive || !absoluteActive || document.pointerLockElement) return;
  if (!pointMode) { pointMode = true; await stopControl(); }
  if (aiming || !canPoint() || !absoluteActive) return;
  focusPictureKeyboard();
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

async function waitForUsbFrame(afterSerial, timeoutMs) {
  if (usbFrameNumber !== afterSerial) return;
  await new Promise(resolve => {
    const wake = () => {
      clearTimeout(timer);
      if (wakePointSample === wake) wakePointSample = null;
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    wakePointSample = wake;
  });
}
function pointSampler(geometry, validate) {
  if (pointFrame.width !== geometry.w || pointFrame.height !== geometry.h) {
    pointFrame.width = geometry.w;
    pointFrame.height = geometry.h;
    lastPoint = null;
  }
  let sampledFrame;
  async function sample(afterSerial) {
    await waitForUsbFrame(afterSerial,80);
    validate();
    if (sampledFrame?.serial === usbFrameNumber) return sampledFrame;
    pointContext.drawImage(usbCanvas, 0, 0, geometry.w, geometry.h);
    sampledFrame = {width:geometry.w, height:geometry.h, serial:usbFrameNumber,
      data:pointContext.getImageData(0, 0, geometry.w, geometry.h).data};
    return sampledFrame;
  }
  return sample;
}

$('confirm-relative').onclick = () => identifyRelative(true);
async function identifyRelative(confirm, isCurrent = () => true) {
  if (pairing || !usbLive || !relativePeerId || !needsPairing) return;
  const deviceId = usbDeviceId, peerId = relativePeerId, layout = pointerLayout;
  const challenge = relativeChallenge;
  relativeChallenge = null;
  pairing = true;
  update();
  try {
    if (confirm) {
      if (!challenge || challenge.expires <= performance.now() || challenge.peerId !== peerId) return;
      await api('control/confirm-relative',{deviceId,peerId,sessionId:displaySessionId,confirmation:challenge.confirmation});
      await updateBluetooth();
    } else {
      const {confirmation} = await api('control/identify-relative',{deviceId,peerId,sessionId:displaySessionId});
      if (isCurrent() && usbLive && needsPairing && deviceId === usbDeviceId && layout === pointerLayout && relativePeerId === peerId) {
        relativeChallenge = {peerId, confirmation, expires:performance.now()+60000};
      }
    }
  } catch (error) {
    if (layout === pointerLayout) notice(error.message,true);
  } finally {
    pairing=false;
    update();
  }
}

async function verifyBluetoothDevice(isCurrent = () => true, recheckBound = false, candidateId = null) {
  if (pairing || !usbLive || (!needsPairing && !recheckBound) || document.pointerLockElement) return;
  const deviceId = usbDeviceId, layout = pointerLayout;
  const candidates = availablePeers.filter(peer => peer.absolute && (!candidateId || peer.id===candidateId) &&
    (peer.boundDeviceId === deviceId || (needsPairing && !peer.boundDeviceId)));
  if (!candidates.length) return;
  pairing = true;
  await stopControl();
  const epoch = controlEpoch;
  function validate() {
    if (!isCurrent() || epoch !== controlEpoch || layout !== pointerLayout || deviceId !== usbDeviceId || !usbLive || document.hidden)
      throw Error('画面已改变，蓝牙核对已取消。');
  }
  try {
    for (const [index,peer] of candidates.entries()) {
      validate();
      verificationDetail = '正在核对第 ' + (index+1) + ' 个蓝牙连接，仅移动指针。请保持画面静止。';
      update();
      let probeLease;
      try {
        const result = await api('control/start', {probe:true,peerId:peer.id,deviceId,sessionId:displaySessionId});
        probeLease = result.lease;
        validate();
        const checked=await api('control/verify-peer',{lease:probeLease,peerId:peer.id,deviceId});
        validate();
        await updateBluetooth();
        validate();
        if (needsPairing || !connected) throw Error('蓝牙设备已改变，请重新核对。');
        previousAbsolutePeers.set(deviceId,peer.id);
        absoluteTried = absoluteVerified = true;
        verificationDetail = '已识别当前设备 · 三点最大偏差 ' + checked.maxError.toFixed(1) + ' 个采样像素。';
        notice(verificationDetail);
        return;
      } catch (error) {
        validate();
        if (index === candidates.length-1) throw error;
      } finally {
        if (probeLease) await api('control/stop',{lease:probeLease}).catch(()=>{});
      }
    }
  } catch (error) {
    if (isCurrent() && deviceId === usbDeviceId && layout === pointerLayout) {
      const target = currentDevice ? usbDeviceLabel(currentDevice) : '当前投屏设备';
      verificationDetail = error.message + ' 请在「' + target + '」的蓝牙设置中确认电脑显示“已连接”，开启辅助触控，停在静止页面后再核对。';
      notice(verificationDetail,true);
    }
  } finally {
    pairing = false;
    update();
  }
}

async function runPictureAction(action) {
  const {geometry, target} = action;
  const epoch = controlEpoch;
  function validate() {
    if (epoch !== controlEpoch || !pointMode || !lease || !usbLive || !connected || document.hidden ||
        (action.probe && !absoluteActive) ||
        usbSession !== geometry.session || usbTurns !== geometry.turns || usbCanvas.width !== geometry.width || usbCanvas.height !== geometry.height)
      throw Error('画面或控制状态已变化，操作已取消。');
  }
  await ensureLease();
  validate();
  const sample = pointSampler(geometry, validate);
  async function report(x, y, buttons = 0, wheel = 0) {
    validate();
    await api('input', {lease, seq:++seq, buttons, x, y, wheel, settle:true});
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
  const phoneScroll = direct && usbFamily === 'iPhone' && action.wheel !== undefined;
  if (phoneScroll && !action.wheel) return;
  const gesture = action.gesture;
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
      if (phoneScroll) {
        // Let iOS position the pointer before activating its relative mouse wheel.
        const movedAt = performance.now(), serial = usbFrameNumber;
        await waitForUsbFrame(serial,650);
        validate();
        if (usbFrameNumber === serial) throw Error('没有收到新的 USB 画面，请稍后再滚动。');
        await new Promise(resolve => setTimeout(resolve, Math.max(50, 180 - (performance.now() - movedAt))));
        validate();
      }
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
  if (phoneScroll) {
    // On iPhone the wheel belongs to the relative mouse report. Wake that
    // collection without clicking or leaving the absolute-positioned target.
    await report(1,0);
    await new Promise(resolve => setTimeout(resolve,32));
    await report(-1,0);
    do {
      while (action.wheel) {
        const step = Math.sign(action.wheel);
        action.wheel -= step;
        await new Promise(resolve => setTimeout(resolve,32));
        await report(0,0,0,-step);
      }
      // Keep the lease through the last notification and drain wheel input
      // that arrived while the iPhone was finishing the preceding burst.
      await new Promise(resolve => setTimeout(resolve,64));
      validate();
    } while (action.wheel);
    lastInput('滚轮');
    return;
  }
  if (gesture) {
    update();
    const moveHeld = direct ? async (point, mask) => {
      const next = absoluteCoordinates(point,geometry.w,geometry.h);
      if (next.x !== absolutePoint.x || next.y !== absolutePoint.y) {
        await absoluteReport(next.x,next.y,mask);
        absolutePoint = next;
      }
    } : createHeldMover(aligned, sample, report, validate);
    const sendButton = direct ? (_x,_y,mask) => absoluteReport(absolutePoint.x,absolutePoint.y,mask) : report;
    const result = await gesture.play({report:sendButton, validate, moveHeld, paceAbsoluteDrag:direct});
    if (result.dragged) lastPoint = null;
    const label = result.dragged ? '拖动完成' : '按键已松开';
    lastInput(label + ' · 按住 ' + result.heldMs + ' ms · 定位 ' + aimMs + ' ms');
  } else {
    let scrolled = 0;
    while (action.wheel) {
      const ticks = action.wheel;
      action.wheel = 0;
      await report(0,0,0,ticks);
      scrolled += ticks;
    }
    if (scrolled) lastInput('滚轮 · 定位 ' + aimMs + ' ms');
  }
}

async function processPictureQueue() {
  if (aiming) return;
  aiming = true;
  const epoch = controlEpoch;
  try {
    while (pictureQueue.length && epoch === controlEpoch) {
      currentAction = pictureQueue.shift();
      if (currentAction.strokes) {
        const {strokes,restore} = currentAction;
        await ensureLease();
        for (const stroke of strokes) {
          if (epoch !== controlEpoch || !hasPictureKeyboardFocus() || !keyboardConnected) break;
          await sendKeys(stroke);
          if (epoch !== controlEpoch) break;
          await sendKeys({modifiers:0, keys:[]});
        }
        if (epoch === controlEpoch && hasPictureKeyboardFocus() && keyboardConnected) {
          if (restore.modifiers || restore.keys.length) await sendKeys(restore);
          lastInput('键盘输入');
        }
      } else if (currentAction.keyboardReport) {
        await ensureLease();
        if (epoch !== controlEpoch || !hasPictureKeyboardFocus()) break;
        await sendKeys(currentAction.keyboardReport);
        if (epoch===controlEpoch && !currentAction?.keyboardReport?.keys.length && !keyboard.pressed.size) lastInput('键盘输入');
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

pictureKeyboard.addEventListener('blur', () => {
  pictureKeyboard.value = '';
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
  focusPictureKeyboard();
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
