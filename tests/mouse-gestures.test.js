'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PictureMouseGesture } = require('../web/mouse-gestures');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function recorder() {
  const calls = [];
  return { calls, gain: 1, validate() {}, async report(x, y, buttons) {
    calls.push({ x, y, buttons, at: performance.now() });
  } };
}

test('a hold released during positioning keeps its duration on the iPad', async () => {
  const gesture = new PictureMouseGesture({x: 100, y: 70});
  await delay(65);
  gesture.end();
  const output = recorder();
  await gesture.play(output);
  assert.deepEqual(output.calls.map(c => c.buttons), [1, 0]);
  assert.ok(output.calls[1].at - output.calls[0].at >= 60);
});

test('queued drag follows bends, splits HID moves and releases only at the end', async () => {
  const gesture = new PictureMouseGesture({x: 40, y: 20});
  gesture.move({x: 440, y: 20});
  gesture.end({x: 440, y: 100});
  const output = recorder();
  const result = await gesture.play({...output, gain: 2});
  assert.equal(result.dragged, true);
  assert.deepEqual(result.end, {x: 440, y: 100});
  const moves = output.calls.slice(1, -1);
  assert.ok(moves.every(c => c.buttons === 1 && Math.max(Math.abs(c.x), Math.abs(c.y)) <= 127));
  assert.equal(moves.reduce((sum, c) => sum + c.x, 0), 200);
  assert.equal(moves.reduce((sum, c) => sum + c.y, 0), 40);
  assert.equal(moves.at(-1).x, 0);
  assert.equal(output.calls.at(-1).buttons, 0);
});

test('a live drag presses before pointerup and cancellation promptly releases it', async () => {
  const gesture = new PictureMouseGesture({x: 5, y: 5});
  const output = recorder();
  const playing = gesture.play(output);
  await delay(10);
  assert.deepEqual(output.calls.map(c => c.buttons), [1]);
  gesture.move({x: 65, y: 15});
  await delay(20);
  assert.ok(output.calls.some(c => c.x === 60 && c.y === 10 && c.buttons === 1));
  gesture.cancel();
  await assert.rejects(playing, /取消/);
  assert.equal(output.calls.at(-1).buttons, 0);
});

test('cancelling before alignment cannot send a click', async () => {
  const gesture = new PictureMouseGesture({x: 50, y: 50});
  const output = recorder();
  gesture.end();
  gesture.cancel();
  await assert.rejects(gesture.play(output), /取消/);
  assert.deepEqual(output.calls, []);
});

test('high-rate straight strokes retain the endpoint with bounded HID traffic', async () => {
  const gesture = new PictureMouseGesture({x: 0, y: 0});
  for (let i = 1; i <= 2000; i++) gesture.move({x: i / 4, y: i / 8});
  gesture.end();
  const output = recorder();
  await gesture.play(output);
  const moves = output.calls.slice(1, -1);
  assert.ok(moves.length <= 8, `sent ${moves.length} movement reports`);
  assert.equal(moves.reduce((sum, c) => sum + c.x, 0), 500);
  assert.equal(moves.reduce((sum, c) => sum + c.y, 0), 250);
});

test('a secondary click passes its button mask until release', async () => {
  const gesture = new PictureMouseGesture({x: 25, y: 30}, 2);
  gesture.end();
  const output = recorder();
  await gesture.play(output);
  assert.deepEqual(output.calls.map(c => c.buttons), [2, 0]);
});

test('a stationary held pointer revalidates its lease and geometry without another mouse event', async () => {
  let valid = true;
  const gesture = new PictureMouseGesture({x: 20, y: 30});
  const output = recorder();
  const playing = gesture.play({...output, validate() {
    if (!valid) throw Error('Geometry changed');
  }});
  await delay(5);
  valid = false;
  await assert.rejects(playing, /Geometry changed/);
  assert.deepEqual(output.calls.map(c => c.buttons), [1]);
});

test('a selected minimum hold turns a completed tap into one sustained press', async () => {
  const gesture = new PictureMouseGesture({x: 20, y: 30}, 1, 85);
  gesture.end();
  const output = recorder();
  await gesture.play(output);
  assert.deepEqual(output.calls.map(c => c.buttons), [1, 0]);
  assert.ok(output.calls[1].at - output.calls[0].at >= 80);
});

test('closed-loop drag receives picture-space turning points and owns every held movement', async () => {
  const gesture = new PictureMouseGesture({x: 200, y: 80}, 2);
  gesture.move({x: 275, y: 80});
  gesture.end({x: 275, y: 140});
  const output = recorder(), targets = [];
  await gesture.play({...output, gain: undefined, async moveHeld(target, buttons, options) {
    assert.equal(output.calls.at(-1).buttons, 2);
    targets.push({...target, buttons, intermediate: options?.intermediate ?? false});
  }});
  assert.deepEqual(targets, [
    {x: 275, y: 80, buttons: 2, intermediate: true},
    {x: 275, y: 140, buttons: 2, intermediate: false},
    {x: 275, y: 140, buttons: 2, intermediate: false}
  ]);
  assert.deepEqual(output.calls.map(({x, y, buttons}) => [x, y, buttons]), [[0, 0, 2], [0, 0, 0]]);
});

test('pointerup at an already sampled live waypoint still confirms the actual endpoint', async () => {
  const gesture = new PictureMouseGesture({x: 20, y: 10});
  const output = recorder(), moves = [], traversed = Promise.withResolvers();
  const playing = gesture.play({...output, async moveHeld(point, mask, options) {
    assert.equal(output.calls.at(-1).buttons, mask);
    moves.push({...point, intermediate: options?.intermediate ?? false});
    traversed.resolve();
  }});
  gesture.move({x: 22, y: 13});
  await traversed.promise;
  gesture.end({x: 22, y: 13});
  await playing;
  assert.deepEqual(moves, [
    {x: 22, y: 13, intermediate: true}, {x: 22, y: 13, intermediate: false}
  ]);
  assert.deepEqual(output.calls.map(c => c.buttons), [1, 0]);
});

test('closed-loop drag failing to confirm its target releases the button and stops replay', async () => {
  const gesture = new PictureMouseGesture({x: 100, y: 80});
  gesture.move({x: 160, y: 80});
  gesture.end({x: 160, y: 60});
  const output = recorder();
  let attempts = 0;
  await assert.rejects(gesture.play({...output, async moveHeld() {
    attempts++;
    throw Error('Pointer disappeared');
  }}), /Pointer disappeared/);
  assert.equal(attempts, 1);
  assert.deepEqual(output.calls.map(c => c.buttons), [1, 0]);
});
