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
  contains(node) { return node === this; }
  classList = {toggle() {}, add() {}, remove() {}};
  setAttribute(name, value) { this[name] = value; }
  setPointerCapture(id) { this.captured = id; }
  getBoundingClientRect() { return {left: 0, top: 0, width: 420, height: 315}; }
  getContext() { return {drawImage() {}}; }
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
async function openConsole({alignmentGate, heldMoveGate, absolute = false, probeError} = {}) {
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
    body: new Control(), getElementById: element, createElement: () => new Control()
  });
  const window = new EventTarget();
  window.matchMedia = () => Object.assign(new EventTarget(), {matches: false});
  const timers = new Map();
  const output = {targets: [], heldTargets: [], reports: [], stops: 0, physicalButtons: 0, lease: null};
  async function fetch(url, options) {
    const data = options.body && JSON.parse(options.body);
    let result = {};
    switch (url) {
      case '/api/status': result = {active: 1, keyboardActive: 1, absoluteActive: Number(absolute), state: 'connected'}; break;
      case '/api/frame/clear': break;
      case '/api/control/start':
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
      if (probeError) throw Error(probeError);
      return {maxError:1};
    },
    playUsbVideo({canvas, onFrame, signal}) {
      canvas.width = 840; canvas.height = 630; onFrame(1);
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
  element('usb').onclick();
  await waitFor(() => screen.width === 840);
  await timers.get(1000)();
  if (!absolute) await element('point').onclick();
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
  return {window, screen, output, emit, element, key, document};
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
