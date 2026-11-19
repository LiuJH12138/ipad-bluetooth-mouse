'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {picturePoint} = require('../web/pointing');
const {PictureMouseGesture} = require('../web/mouse-gestures');
const IpadKeyboard = require('../web/keyboard');
const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');

class Control extends EventTarget {
  children = [];
  showModal() { this.open = true; }
  close() { this.open = false; }
  replaceChildren(...nodes) { this.children = nodes; }
  append(child) { this.children.push(child); child.parentElement = this; }
  contains(node) { return node === this; }
  classList = {toggle() {}, add() {}, remove() {}};
  setAttribute(name, value) { this[name] = value; }
  setPointerCapture(id) { this.captured = id; }
  getBoundingClientRect() { return {left: 0, top: 0, width: 420, height: 315}; }
  getContext() { return {drawImage() {}}; }
  toBlob() {} // Keep JPEG encoding pending so a rotation cannot rely on an upload.
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition) {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= deadline) throw Error('Timed out waiting for a picture input event');
    await delay(4);
  }
}

// Exercise app.js from USB start and the status poll through the actual DOM
// event listeners. Replace only hardware, image recognition, and browser I/O.
async function openConsole({alignmentGate, heldMoveGate, absolute = false, probeError, family, status = {}, devices = [{id:"test-phone", family:"iPhone", driver:"ready"}], autoStart = true} = {}) {
  const controls = new Map();
  function element(id) {
    if (!controls.has(id)) {
      const control=new Control();
      control.focus=()=>{document.activeElement=control;};
      controls.set(id,control);
    }
    return controls.get(id);
  }
  const document = Object.assign(new EventTarget(), {
    body: new Control(), getElementById: element, createElement: () => new Control(), hasFocus: () => true
  });
  const window = new EventTarget();
  window.requestAnimationFrame = callback => setTimeout(callback, 0);
  window.matchMedia = () => Object.assign(new EventTarget(), {matches: false});
  const timers = new Map();
  const output = {targets: [], heldTargets: [], reports: [], stops: 0, physicalButtons: 0, lease: null};
  async function fetch(url, options) {
    const data = options.body && JSON.parse(options.body);
    let result = {};
    switch (url) {
      case '/api/connect':
        (output.bluetoothActions ||= []).push('connect');
        Object.assign(status,{state:'waiting',active:0,keyboardActive:0});
        result = status;
        break;
      case '/api/disconnect':
        (output.bluetoothActions ||= []).push('disconnect');
        Object.assign(status,{state:'idle',active:0,keyboardActive:0});
        break;
      case '/api/devices': result = {devices}; break;
      case '/api/assistant/disable': output.revoked = true; break;
      case '/api/status': result = {activeDeviceId:output.device, active: 1, keyboardActive: 1, absoluteActive: Number(absolute), state: 'connected', ...status}; break;
      case '/api/assistant/enable': result = {view:'shared-view'}; break;
      case '/api/assistant/presence': return new Promise(()=>{});
      case '/api/frame/clear': output.cleared = data; break;
      case '/api/control/identify-relative':
        output.identified = data;
        result = {confirmation:'fresh-challenge'};
        break;
      case '/api/control/confirm-relative':
        assert.equal(data.confirmation,'fresh-challenge');
        output.bound = data;
        status.needsPairing = false;
        break;
      case '/api/control/verify-peer':
        assert.equal(output.lease, data.lease);
        status.needsPairing = false;
        output.bound = {...data};
        break;
      case '/api/control/start':
        (output.starts ||= []).push(data);
        assert.equal(output.lease, null);
        result = {lease: output.lease = 'lease-' + output.stops};
        break;
      case '/api/input':
        assert.equal(data.lease, output.lease);
        output.reports.push(data);
        output.physicalButtons = data.buttons;
        break;
      case '/api/control/stop':
        assert.equal(data.lease, output.lease);
        output.lease = null;
        output.physicalButtons = 0;
        output.stops++;
        break;
      default: throw Error('Unexpected route ' + url);
    }
    return {ok: true, json: async () => result};
  }
  vm.runInNewContext(app, {
    window, document, location: {search: '', hash: ''}, sessionStorage: {getItem() {}},
    performance, setTimeout, clearTimeout, setInterval: (callback, ms) => timers.set(ms, callback),
    URLSearchParams, AbortController, fetch, IpadKeyboard, PictureMouseGesture, picturePoint,
    absoluteCoordinates: require('../web/absolute-pointer').absoluteCoordinates,
    async verifyAbsolutePointer({send,validate}) {
      for (const [x,y] of [[7000,9000],[23000,11000],[15000,23000]]) {
        validate();
        await send(x,y);
      }
      if (typeof probeError === 'function') probeError(output.starts.at(-1));
      else if (probeError) throw Error(probeError);
      return {maxError:1};
    },
    playUsbVideo({deviceId, canvas, onFrame, signal}) {
      output.device = deviceId;
      canvas.width = 840; canvas.height = 630;
      output.rotate = turns => onFrame(1, turns, family);
      output.rotate(0);
      return new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    },
    async aimPointer(target, sample, move, validate) {
      output.targets.push({...target});
      if (alignmentGate) await alignmentGate;
      validate();
      return {position: {...target}, gain: 1};
    },
    createHeldMover(aligned, sample, report, validate) {
      let cursor = aligned.position;
      return async (target, mask) => {
        output.heldTargets.push({...target, mask});
        if (heldMoveGate) await heldMoveGate;
        validate();
        assert.equal(output.physicalButtons, mask);
        await report(target.x - cursor.x, target.y - cursor.y, mask);
        cursor = {...target};
        return cursor;
      };
    }
  });
  const screen = element('usb-canvas');
  screen.requestPointerLock = async () => { document.pointerLockElement = screen; };
  document.exitPointerLock = () => { document.pointerLockElement = null; };
  element('speed').value = '1';
  if (autoStart) {
    element('usb').onclick();
    await waitFor(() => screen.width === 840);
    await timers.get(1000)();
    if (!absolute) await element('point').onclick();
  }
  function emit(type, x, y, extra = {}) {
    const event = Object.assign(new Event(type, {cancelable: true}), {
      pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...extra
    });
    screen.dispatchEvent(event);
    return event;
  }
  function key(type,code) {
    const event=Object.assign(new Event(type,{cancelable:true}),{code});
    document.dispatchEvent(event);
    return event;
  }
  return {window, screen, output, emit, element, key, document, pollStatus: timers.get(1000)};
}

test('picture pointer events forward drag coordinates with the button held', async () => {
  const {screen, output, emit} = await openConsole();
  emit('pointerdown', 30, 30);
  assert.equal(screen.captured, 1);
  emit('pointermove', 60, 50);
  emit('pointerup', 70, 50);
  emit('lostpointercapture', 70, 50); // automatic release after a normal up
  await waitFor(() => output.stops === 1);
  assert.deepEqual(output.targets, [{x: 60, y: 60}]);
  assert.deepEqual(output.heldTargets.at(-1), {x: 140, y: 100, mask: 1});
  assert.deepEqual(output.reports.map(r => r.buttons).filter((b, i, a) => !i || b !== a[i-1]), [1, 0]);
  assert.equal(output.reports.reduce((sum, r) => sum + r.x, 0), 80);
  assert.equal(output.reports.reduce((sum, r) => sum + r.y, 0), 40);
});

test('wheel bursts target the pane under the arrow and keep signed wheel ticks', async () => {
  const {output, emit} = await openConsole();
  const event = emit('wheel', 200, 70, {deltaMode: 0, deltaY: 40});
  emit('wheel', 200, 70, {deltaMode: 0, deltaY: 80});
  await waitFor(() => output.stops === 1);
  assert.ok(event.defaultPrevented);
  assert.deepEqual(output.targets, [{x: 400, y: 140}]);
  assert.equal(output.reports.reduce((sum, r) => sum + r.wheel, 0), -3);
  assert.ok(output.reports.every(r => r.buttons === 0));
});

test('rapid picture clicks retain both presses and releases in order', async () => {
  const {output, emit} = await openConsole();
  for (const x of [40, 40, 55]) {
    emit('pointerdown', x, 50);
    emit('pointerup', x, 50);
    emit('lostpointercapture', x, 50);
  }
  await waitFor(() => output.stops === 1);
  assert.deepEqual(output.targets.map(p => p.x), [80, 80, 110]);
  assert.deepEqual(output.reports.map(r => r.buttons), [1, 0, 1, 0, 1, 0]);
});

test('blur while aiming cancels pending and queued clicks before button-down', async () => {
  const gate = Promise.withResolvers();
  const {window, output, emit} = await openConsole({alignmentGate: gate.promise});
  emit('pointerdown', 10, 20); emit('pointerup', 10, 20);
  emit('pointerdown', 30, 20); emit('pointerup', 30, 20);
  await waitFor(() => output.targets.length === 1);
  window.dispatchEvent(new Event('blur'));
  gate.resolve();
  await waitFor(() => output.stops === 1);
  await new Promise(setImmediate);
  assert.deepEqual(output.reports, []);
  assert.equal(output.targets.length, 1);
});

test('loss of pointer capture during a live hold stops the lease and ignores a late up', async () => {
  const {output, emit} = await openConsole();
  emit('pointerdown', 10, 20);
  await waitFor(() => output.physicalButtons === 1);
  emit('lostpointercapture', 10, 20);
  await waitFor(() => output.stops === 1);
  emit('pointermove', 150, 70); emit('pointerup', 150, 70);
  await new Promise(setImmediate);
  assert.equal(output.physicalButtons, 0);
  assert.deepEqual(output.reports.map(r => r.buttons), [1]);
});

test('blur during held-position feedback cannot send a delayed drag or press again', async () => {
  const gate = Promise.withResolvers();
  const {window, output, emit} = await openConsole({heldMoveGate: gate.promise});
  emit('pointerdown', 10, 20);
  await waitFor(() => output.physicalButtons === 1);
  emit('pointermove', 70, 20);
  await waitFor(() => output.heldTargets.length === 1);
  window.dispatchEvent(new Event('blur'));
  gate.resolve();
  emit('pointerup', 70, 20);
  await waitFor(() => output.stops === 1);
  await new Promise(setImmediate);
  assert.equal(output.physicalButtons, 0);
  assert.deepEqual(output.reports.map(r => [r.x, r.y, r.buttons]), [[0, 0, 1]]);
});


for (const ok of [true,false]) {
  test('explicit verification reports '+(ok?'direct':'visual')+' mode without clicking', async () => {
    const {element,output}=await openConsole({absolute:true,probeError:ok?'':'检查失败'});
    await element('point').onclick();
    assert.equal(output.reports.length,0);
    await element('verify-position').onclick();
    await waitFor(()=>output.stops===1 && element('position-status').textContent!=='正在验证');
    assert.equal(element('position-status').textContent,ok?'绝对坐标直达':'视觉定位');
    assert.match(element('position-detail').textContent,ok?/三点通过/:/背景清晰/);
    assert.equal(output.reports.length,3);
    assert.ok(output.reports.every(r=>r.kind==='absolute' && r.buttons===0));
  });
}

test('picture click followed immediately by typing delivers mouse-up before the first key', async()=>{
  const gate=Promise.withResolvers();
  const {output,emit,key}=await openConsole({alignmentGate:gate.promise});
  emit('pointerdown',24,26); emit('pointerup',24,26);
  assert.equal(key('keydown','Digit7').defaultPrevented,true);
  key('keyup','Digit7');
  gate.resolve();
  await waitFor(()=>output.stops===1);
  assert.deepEqual(output.reports.map(r=>r.kind==='keyboard' ? r.keys : r.buttons),[1,0,[36],[]]);
  assert.ok(output.reports.filter(r=>r.kind==='keyboard').every(r=>r.settle));
});

test('picture keyboard holds modifiers across mouse clicks and releases on focus loss', async()=>{
  const {output,emit,key,screen,element}=await openConsole();
  key('keydown','ShiftLeft');
  await waitFor(()=>output.reports.some(r=>r.modifiers===2));
  emit('pointerdown',20,30); emit('pointerup',20,30);
  await waitFor(()=>output.reports.some(r=>r.buttons===0));
  assert.equal(output.stops,0);
  element('speed').focus();
  element('picture-keyboard').dispatchEvent(new Event('blur'));
  await waitFor(()=>output.stops===1);
  assert.equal(key('keydown','Digit7').defaultPrevented,false);
});

test('the mode picker selects picture input and preview, with independent assistant permission', async () => {
  const {element, output, key, document} = await openConsole({absolute:true});
  const current = element('mode-current');
  assert.equal(current.textContent, '仅预览');
  assert.equal(element('preview-mode')['aria-pressed'], 'true');
  await element('assistant').onclick();
  await element('point').onclick();
  assert.equal(current.textContent, '画面操控');
  assert.equal(element('point')['aria-pressed'], 'true');
  assert.equal(document.activeElement, element('picture-keyboard'));
  key('keydown', 'ShiftLeft');
  await waitFor(() => output.reports.some(report => report.modifiers === 2));
  await element('point').onclick();
  assert.ok(output.lease);
  await element('preview-mode').onclick();
  assert.equal(output.lease, null);
  assert.equal(current.textContent, '仅预览');
  assert.equal(document.activeElement, element('mode-summary'));
  assert.equal(element('assistant')['aria-pressed'], 'true');
  assert.equal(key('keydown', 'KeyA').defaultPrevented, false);
});

test('capture requests pointer lock inside the choice activation, switches out cleanly and follows native unlock', async () => {
  const {element, screen, output, key, document} = await openConsole();
  const current = element('mode-current');
  key('keydown', 'ShiftLeft');
  await waitFor(() => !!output.lease);
  let requested = false;
  screen.requestPointerLock = async () => {
    requested = true;
    document.pointerLockElement = screen;
  };
  const capture = element('control').onclick();
  assert.equal(requested, true);
  await capture;
  assert.equal(output.stops, 1);
  assert.equal(current.textContent, '键鼠控制');
  assert.equal(element('capture-hint').hidden, false);
  await element('point').onclick();
  assert.equal(document.pointerLockElement, null);
  assert.equal(output.lease, null);
  assert.equal(current.textContent, '画面操控');
  assert.equal(element('capture-hint').hidden, true);
  await element('control').onclick();
  document.exitPointerLock();
  document.dispatchEvent(new Event('pointerlockchange'));
  await waitFor(() => current.textContent === '仅预览');
  assert.equal(output.lease, null);
  assert.equal(element('control')['aria-pressed'], 'false');
});

for (const exit of ['native', 'keyboard', 'other control', 'window blur']) {
  test('fullscreen capture restores focus after the toolbar reappears: ' + exit, async () => {
    const {element, document, window, key} = await openConsole({absolute:true});
    const monitor = element('monitor');
    const frames = [];
    let captured = false;
    let inFront = true;
    monitor.classList.toggle = (name, enabled) => { if (name === 'captured') captured = enabled; };
    document.hasFocus = () => inFront;
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    document.fullscreenElement = monitor;
    const summary = element('mode-summary');
    summary.focus = () => { if (!captured && inFront) document.activeElement = summary; };
    await element('control').onclick();
    assert.equal(captured, true);
    document.activeElement = document.body;
    if (exit === 'keyboard') key('keydown', 'Escape');
    document.exitPointerLock();
    document.dispatchEvent(new Event('pointerlockchange'));
    await waitFor(() => element('mode-current').textContent === '仅预览');
    if (exit === 'other control') element('assistant').focus();
    if (exit === 'window blur') inFront = false;
    for (const callback of frames) callback();
    const expected = exit === 'other control' ? element('assistant') : exit === 'window blur' ? document.body : summary;
    assert.equal(document.activeElement === expected, true);
  });
}

test('a rejected capture in fullscreen restores preview, focus and an actionable error', async () => {
  const {element, screen, output, document} = await openConsole();
  document.fullscreenElement = element('monitor');
  screen.requestPointerLock = async () => { throw Error('permission denied'); };
  await element('control').onclick();
  assert.equal(element('mode-current').textContent, '仅预览');
  assert.equal(element('capture-hint').hidden, true);
  assert.equal(output.lease, null);
  assert.equal(document.activeElement, element('mode-summary'));
  assert.match(element('fullscreen-error').textContent, /permission denied/);
});

test('keyboard navigation keeps an open mode picker local and Escape leaves picture input on the next press', async () => {
  const {element, document, key, output} = await openConsole();
  const picker = element('mode-picker');
  const arrow = key => picker.dispatchEvent(Object.assign(new Event('keydown', {cancelable:true}), {key}));
  element('mode-summary').focus();
  arrow('ArrowDown');
  assert.equal(picker.open, true);
  assert.equal(document.activeElement, element('preview-mode'));
  arrow('End');
  assert.equal(document.activeElement, element('control'));
  assert.equal(key('keydown','Escape').defaultPrevented, true);
  assert.equal(picker.open, false);
  assert.equal(element('mode-current').textContent, '画面操控');
  assert.equal(document.activeElement, element('mode-summary'));
  key('keydown','Escape');
  await waitFor(() => element('mode-current').textContent === '仅预览');
  assert.deepEqual(output.reports, []);
});

test('verified mouse capture delivers pending motion and both button edges on one absolute pointer', async () => {
  const {document, element, output} = await openConsole({absolute:true});
  await element('verify-position').onclick();
  await waitFor(() => output.stops === 1);
  output.reports.length = 0;
  await element('control').onclick();
  const mouse = (type, fields) => document.dispatchEvent(Object.assign(new Event(type), fields));
  mouse('mousemove', {movementX:25, movementY:0});
  mouse('mousedown', {button:0, buttons:1});
  mouse('mousemove', {movementX:12, movementY:4});
  mouse('mouseup', {button:0, buttons:0});
  await waitFor(() => output.reports.length >= 3 || output.reports.some(r => r.buttons === 1));
  await new Promise(setImmediate);
  assert.deepEqual(output.reports.map(r=>[r.kind,r.buttons]), [['absolute',0],['absolute',0],['absolute',1],['absolute',1],['absolute',0]]);
  const [center, hover, down, held, up] = output.reports;
  assert.ok(hover.x > center.x && hover.x === down.x);
  assert.ok(held.x > down.x && held.x === up.x && held.y === up.y);
});

test('capture keeps relative mouse reports on unverified devices', async () => {
  const {document, element, output} = await openConsole({absolute:true});
  await element('control').onclick();
  for (const [type, buttons] of [['mousedown', 1], ['mouseup', 0]]) {
    document.dispatchEvent(Object.assign(new Event(type), {button:0, buttons}));
  }
  await waitFor(() => output.reports.length === 2);
  assert.deepEqual(output.reports.map(r=>[r.kind,r.buttons]), [[undefined,1],[undefined,0]]);
});

test('clicking the picture focuses its keyboard and immediately forwards native text input after the click', async () => {
  const gate = Promise.withResolvers();
  const {element, emit, output, document} = await openConsole({alignmentGate:gate.promise});
  emit('pointerdown',45,25); emit('pointerup',45,25);
  const input = element('picture-keyboard');
  assert.equal(document.activeElement, input);
  input.value = 'AA5!';
  input.dispatchEvent(new Event('input'));
  gate.resolve();
  await waitFor(()=>output.stops===1);
  assert.deepEqual(output.reports.map(r=>r.kind==='keyboard' ? [r.modifiers,...r.keys] : r.buttons),
    [1,0,[2,4],[0],[2,4],[0],[0,34],[0],[2,30],[0]]);
  assert.equal(input.value,'');
});

test('native deletion without a physical key code forwards one backspace and ignores unfocused edits', async () => {
  const {element,emit,output} = await openConsole();
  emit('pointerdown',45,25); emit('pointerup',45,25);
  await waitFor(()=>output.stops===1);
  const input = element('picture-keyboard');
  const deletion = Object.assign(new Event('beforeinput',{cancelable:true}),{inputType:'deleteContentBackward'});
  input.dispatchEvent(deletion);
  assert.equal(deletion.defaultPrevented,true);
  await waitFor(()=>output.stops===2);
  assert.deepEqual(output.reports.slice(-2).map(r=>r.keys), [[42],[]]);
  element('speed').focus();
  input.value='5';input.dispatchEvent(new Event('input'));
  await new Promise(setImmediate);
  assert.equal(output.stops,2);
});

test('preview identifies only the family of the current USB session', async () => {
  for (const [family, label] of [['iPhone','iPhone'], ['iPad','iPad'], ['Apple','设备'], ['Private Name','设备']]) {
    const {element} = await openConsole({family});
    assert.equal(element('preview-heading').textContent, label === '设备' ? '设备屏幕' : label + ' 屏幕');
    assert.equal(element('usb-canvas')['aria-label'], label + ' USB 实时画面');
    assert.equal(element('source-status').textContent, label === '设备' ? '已连接' : label);
    await element('stop-usb').onclick();
    assert.equal(element('preview-heading').textContent, '设备屏幕');
    assert.equal(element('picture-keyboard')['aria-label'], '设备画面键盘');
  }
});

test('a half turn retires verified coordinates even when frame dimensions stay the same', async () => {
  const {output,element} = await openConsole({absolute:true});
  await element('verify-position').onclick();
  await waitFor(()=>output.stops===1 && element('position-status').textContent==='绝对坐标直达');
  await element('assistant').onclick();
  output.rotate(2);
  assert.equal(element('position-status').textContent,'等待验证');
  assert.equal(output.cleared.view,'shared-view');
  assert.ok(output.cleared.layout > 1);
});

test('rotating away and back while aiming cancels the stale picture click', async () => {
  const gate = Promise.withResolvers();
  const {output,emit} = await openConsole({alignmentGate:gate.promise});
  emit('pointerdown',30,30);
  emit('pointerup',30,30);
  await waitFor(()=>output.targets.length===1);
  output.rotate(2);
  output.rotate(0);
  gate.resolve();
  await waitFor(()=>output.stops===1);
  assert.ok(output.reports.every(report=>report.buttons===0));
});

test('portrait targeting follows the live canvas bounds across window and fullscreen', async () => {
  const {document,element,screen,output,emit} = await openConsole();
  screen.width=400; screen.height=840; output.rotate(1);
  for (const [index,rect] of [
    {left:10,top:20,width:600,height:420}, {left:0,top:0,width:1700,height:840}
  ].entries()) {
    screen.getBoundingClientRect=()=>rect;
    if (index===1) {
      document.fullscreenElement=element('monitor');
      document.dispatchEvent(new Event('fullscreenchange'));
    }
    const tap = (x,y) => { emit('pointerdown',x,y); emit('pointerup',x,y); };
    tap(rect.left+1, rect.top+rect.height/2);
    tap(rect.left+rect.width/2, rect.top+rect.height/2);
    await waitFor(()=>output.stops===index+1);
    assert.deepEqual(output.targets.at(-1),{x:200,y:420});
    assert.equal(output.targets.length,index+1);
  }
});

test('one Bluetooth action starts pairing and can stop while waiting for a device', async () => {
  const status = {state:'idle',active:0,keyboardActive:0};
  const {element,output} = await openConsole({status,absolute:true});
  const action = element('connect');
  assert.equal(action['aria-label'],'连接蓝牙');
  await action.onclick();
  assert.equal(action['aria-label'],'断开蓝牙');
  assert.equal(element('bluetooth-status').textContent,'等待配对');
  await action.onclick();
  assert.equal(action['aria-label'],'连接蓝牙');
  assert.deepEqual(output.bluetoothActions,['connect','disconnect']);
});

test('Bluetooth retry clears its previous notice from the normal and fullscreen display',async()=>{
  const status = {state:'error',active:0,error:'另一控制台正使用蓝牙，请在旧窗口断开蓝牙后重试。'};
  const {element,document,pollStatus}=await openConsole({status,absolute:true});
  assert.equal(element('notice').textContent,status.error);
  document.fullscreenElement=element('monitor');
  await pollStatus();
  Object.assign(status,{state:'connected',active:1,error:''});
  await pollStatus();
  assert.equal(element('notice').textContent,'');
  assert.equal(element('fullscreen-error').textContent,'');
});

test('multiple USB devices require a choice and switching retires the assistant and calibration', async () => {
  const devices = [{family:'iPhone',model:'iPhone15,3',driver:'ready',id:'usb-A-123456'},
    {family:'iPhone',model:'iPhone15,3',driver:'ready',id:'usb-B-654321'}];
  const {element, output, pollStatus} = await openConsole({devices,absolute:true,autoStart:false});
  await element('usb').onclick();
  assert.equal(output.device,undefined);
  assert.equal(element('device-picker').open,true);
  const [one,two] = element('device-list').children;
  assert.notEqual(one.textContent,two.textContent);
  one.onclick();
  await waitFor(()=>output.device===devices[0].id);
  await pollStatus();
  await element('verify-position').onclick();
  await waitFor(()=>element('position-status').textContent==='绝对坐标直达');
  await element('assistant').onclick();
  await element('usb').onclick();
  assert.equal(element('device-list').children[0].disabled,true);
  element('device-list').children[1].onclick();
  await waitFor(()=>output.device===devices[1].id);
  await pollStatus();
  assert.equal(output.revoked,true);
  assert.equal(element('position-status').textContent,'等待验证');
});

test('multiple Bluetooth peers are identified with movement only before clicks or typing become available', async () => {
  const peers = [
    {id:'bound-to-other',absolute:true,boundDeviceId:'another-USB'},
    {id:'wrong',absolute:true},{id:'right',absolute:true}
  ];
  const status = {needsPairing:true,peers};
  const {element,output} = await openConsole({absolute:true,status,
    probeError: req => { if (req.peerId==='wrong') throw Error('No matching cursor on the USB frame'); }});
  assert.equal(element('point').disabled,true);
  assert.equal(element('control').disabled,true);
  assert.equal(element('verify-position').textContent,'核对蓝牙设备');
  await element('verify-position').onclick();
  assert.deepEqual(output.starts.map(r=>r.peerId),['wrong','right']);
  assert.ok(output.reports.every(r=>r.kind==='absolute' && r.buttons===0));
  assert.equal(output.bound.peerId,'right');
  assert.equal(output.bound.deviceId,'test-phone');
  assert.equal(output.lease,null);
  assert.equal(element('point').disabled,false);
  assert.equal(element('position-status').textContent,'绝对坐标直达');
});

test('an endpoint-only drag on a verified device preserves distinct held movement and release intervals', async () => {
  const {output,element,emit} = await openConsole({absolute:true});
  await element('verify-position').onclick();
  await waitFor(()=>element('position-status').textContent==='绝对坐标直达' && output.lease===null);
  output.reports.length = 0;
  const ticks = [];
  const push = output.reports.push.bind(output.reports);
  output.reports.push = report => { ticks.push(performance.now()); return push(report); };
  emit('pointerdown',50,150);
  emit('pointerup',50,40);
  await waitFor(()=>output.stops===2);
  const held = output.reports.filter(report=>report.buttons===1);
  assert.ok(held.length>=4, 'at least two intermediate positions before the endpoint');
  assert.ok(held.every((report,i)=>report.kind==='absolute' && (!i || report.y<held[i-1].y) && report.x===held[0].x));
  assert.ok(ticks[2]-ticks[1]>=40, 'button down is visible before motion');
  assert.ok(ticks.at(-1)-ticks.at(-2)>=20, 'endpoint is visible before release');
  assert.equal(output.reports.at(-1).buttons,0);
  assert.equal(output.reports.at(-1).y,held.at(-1).y);
});

test('verified iPhone sends individual wheel ticks in the Windows scroll direction without any click', async () => {
  const {output,element,emit} = await openConsole({family:'iPhone',absolute:true});
  await element('verify-position').onclick();
  await waitFor(()=>element('position-status').textContent==='绝对坐标直达' && output.lease===null);
  for (const sign of [1,-1]) {
    const before=output.stops;
    output.reports.length=0;
    emit('wheel',160,150,{deltaMode:0,deltaY:120*sign});
    await waitFor(()=>output.reports.length>0);
    output.rotate(0);
    await waitFor(()=>output.reports.filter(r=>r.wheel).length===3);
    // Another notch arriving during the last notification's tail must survive.
    emit('wheel',160,150,{deltaMode:0,deltaY:40*sign});
    await waitFor(()=>output.stops>before);
    assert.ok(output.reports.every(r=>r.buttons===0));
    assert.equal(output.reports[0].kind,'absolute');
    assert.equal(output.reports[0].x,Math.round(320/839*32767));
    assert.deepEqual(output.reports.slice(1,3).map(r=>[r.x,r.y,r.wheel]),[[1,0,0],[-1,0,0]]);
    assert.deepEqual(output.reports.filter(r=>r.wheel).map(r=>r.wheel),[sign,sign,sign,sign]);
  }
});

test('verified iPad preview wheel keeps native wheel reports', async () => {
  const {output,element,emit} = await openConsole({family:'iPad',absolute:true});
  await element('verify-position').onclick();
  await waitFor(()=>element('position-status').textContent==='绝对坐标直达' && output.lease===null);
  const before = output.stops;
  output.reports.length=0;
  emit('wheel',160,140,{deltaMode:0,deltaY:120});
  await waitFor(()=>output.stops>before);
  assert.ok(output.reports.every(r=>r.buttons===0));
  assert.equal(output.reports.filter(r=>r.wheel).reduce((n,r)=>n+r.wheel,0),-3);
});

test('changing the USB layout during an iPhone wheel burst stops the remaining ticks', async () => {
  const {output,element,emit} = await openConsole({family:'iPhone',absolute:true});
  await element('verify-position').onclick();
  await waitFor(()=>element('position-status').textContent==='绝对坐标直达' && output.lease===null);
  output.reports.length=0;
  emit('wheel',160,150,{deltaMode:0,deltaY:120});
  await waitFor(()=>output.reports.length>0);
  output.rotate(0);
  await waitFor(()=>output.reports.some(r=>r.wheel));
  output.rotate(2);
  await waitFor(()=>output.lease===null && output.physicalButtons===0);
  const count=output.reports.length;
  await delay(70);
  assert.equal(output.reports.length,count);
});

test('iPhone wheel checks the frame after moving the pointer to a distant pane', async () => {
  const {output,element,emit} = await openConsole({family:'iPhone',absolute:true});
  await element('verify-position').onclick();
  await waitFor(()=>element('position-status').textContent==='绝对坐标直达' && output.lease===null);
  for (const fresh of [false,true]) {
    const before=output.stops;
    output.reports.length=0;
    emit('wheel',35,45,{deltaMode:0,deltaY:-120});
    await waitFor(()=>output.reports.length>0);
    if (fresh) output.rotate(0);
    await delay(110);
    assert.ok(output.reports.every(r=>!r.wheel));
    await waitFor(()=>output.stops>before);
    assert.ok(output.reports.every(r=>r.buttons===0));
    assert.equal(output.reports.some(r=>r.wheel),fresh);
  }
});

test('relative-only peer stays locked until the displayed pointer motion is confirmed for that device', async () => {
  const status = {needsPairing:true,canIdentifyRelative:true,peers:[{id:'legacy-peer',absolute:false}]};
  const {element,output,pollStatus} = await openConsole({status});
  assert.equal(element('verify-position').textContent,'移动指针核对');
  await element('verify-position').onclick();
  assert.deepEqual(output.identified,{deviceId:'test-phone',peerId:'legacy-peer'});
  assert.equal(element('confirm-relative').hidden,false);
  assert.equal(element('control').disabled,true);
  assert.equal(output.bound,undefined);
  status.peers = [{id:'replacement-peer',absolute:false}];
  await pollStatus();
  assert.equal(element('confirm-relative').hidden,true);
  await element('confirm-relative').onclick();
  assert.equal(output.bound,undefined);
  await element('verify-position').onclick();
  await element('confirm-relative').onclick();
  assert.equal(output.bound.peerId,'replacement-peer');
  assert.equal(element('control').disabled,false);
  assert.equal(element('position-status').textContent,'视觉定位');
});
