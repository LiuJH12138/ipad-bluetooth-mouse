'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DeviceNames} = require('../lib/device-names');

test('local aliases survive separate console processes, can be replaced and cleared independently', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ipad-alias-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const first = new DeviceNames(dir), second = new DeviceNames(dir);
  assert.equal(first.set(a,'  工作平板  '),'工作平板');
  second.set(b,'演示平板');
  assert.equal(second.get(a),'工作平板');
  assert.equal(first.get(b),'演示平板');
  assert.throws(()=>first.set('../outside','new'),{status:400});
  assert.throws(()=>first.set(a,'x\u202Ey'),{status:400});
  second.set(a,'新别名');
  assert.equal(first.get(a),'新别名');
  first.set(a,' ');
  assert.equal(second.get(a),'');
  assert.deepEqual(fs.readdirSync(dir),[b]);
});
