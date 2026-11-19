'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {Setup} = require('../lib/setup');

const files = [
  'iphone-usb.exe', 'iPhoneMirror.UsbConfigurationSwitch.exe', 'libgcc_s_seh-1.dll',
  'libstdc++-6.dll', 'libusb-1.0.dll', 'libusb0.dll', 'libwinpthread-1.dll',
  'driver/usb-driver.ps1', 'driver/install-filter.exe', 'driver/libusb0.sys',
  'driver/libusb0.dll', 'driver/libusb0_x86.dll'
];

const testPe = Buffer.alloc(1024);
testPe.write('MZ');
testPe.writeUInt32LE(128, 60);
testPe.write('PE\0\0',128);
testPe.writeUInt16LE(0x8664,132);
testPe.writeUInt16LE(1,134);
testPe.writeUInt16LE(240,148);
testPe.writeUInt16LE(0x20b,152);
testPe.writeUInt32LE(512,152+240+16);
testPe.writeUInt32LE(512,152+240+20);

async function fixture(t, source=true) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'console-setup-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=path.join(root,source?'.local/usb-v0.2.0':'usb');
  const write=async(relative,data)=>{
    const file=path.join(root,relative);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,data);
  };
  if(source) {
    await write('Install-UsbReceiver.ps1','# test');
    await write('packaging/Build-UsbCapture.ps1','# test');
  } else await write('runtime/node.exe','installed');
  async function fill() {
    for(const name of files) await write(path.relative(root,path.join(runtime,name)),name.endsWith('.ps1')?'# test':testPe);
  }
  let state='ready', attempts=0, starts=0;
  let install=fill, start=async()=>{state='ready'};
  const run=async(file,args,options)=>{
    assert.equal(path.basename(file),'powershell.exe');
    assert.equal(options.windowsHide,true);
    if(args.includes('-File')){
      assert.equal(args.at(-1),path.join(root,'Install-UsbReceiver.ps1'));
      attempts++;await install();
    } else if(args.at(-1).includes("$info.Verb = 'runas'")){
      assert.match(args.at(-1),/sc\.exe/);
      assert.match(args.at(-1),/Apple Mobile Device Service/);
      starts++;await start();
    } else return {stdout:state+'\r\n'};
    return {stdout:''};
  };
  const setup=new Setup({root,run});
  return {root,runtime,setup,write,fill,attempts:()=>attempts,starts:()=>starts,
    setInstall(fn){install=fn},setStart(fn){start=fn},setState(s){state=s}};
}

test('setup reports source and packaged components and requires every driver asset',async t=>{
  for(const source of [true,false]){
    const f=await fixture(t,source);
    await f.fill();
    assert.deepEqual(await f.setup.status(),{receiverReady:true,sourceInstallable:source,appleService:'ready',computerName:os.hostname()});
    for(const name of files.filter(name=>name.startsWith('driver/'))){
      const file=path.join(f.runtime,name),saved=await fs.readFile(file);
      await fs.unlink(file);
      assert.equal((await f.setup.status()).receiverReady,false,name);
      await fs.writeFile(file,saved);
    }
    const exe=path.join(f.runtime,files[0]);
    await fs.writeFile(exe,testPe.subarray(0,800));
    assert.equal((await f.setup.status()).receiverReady,false);
    await fs.writeFile(exe,'not a Windows binary');
    assert.equal((await f.setup.status()).receiverReady,false);
  }
});

test('source prepare uses the fixed script, joins concurrent calls and rechecks the resulting files',async t=>{
  const f=await fixture(t);
  await f.fill();
  await fs.unlink(path.join(f.runtime,'driver/libusb0_x86.dll'));
  const result=await Promise.all([f.setup.prepareReceiver(),f.setup.prepareReceiver()]);
  assert(result.every(s=>s.receiverReady));
  assert.equal(f.attempts(),1);
  await f.setup.prepareReceiver();
  assert.equal(f.attempts(),1);
  await fs.unlink(path.join(f.runtime,'iphone-usb.exe'));
  f.setInstall(async()=>{});
  await assert.rejects(f.setup.prepareReceiver(),/组件/);
  f.setInstall(f.fill);
  assert.equal((await f.setup.prepareReceiver()).receiverReady,true);
});

test('damaged MSI asks for repair without running the source installer',async t=>{
  const f=await fixture(t,false);
  await f.write('Install-UsbReceiver.ps1','# unexpected file');
  assert.equal((await f.setup.status()).sourceInstallable,false);
  await assert.rejects(f.setup.prepareReceiver(),/修复/);
  assert.equal(f.attempts(),0);
});

test('service state preserves unknown and missing and declines to elevate except when stopped',async t=>{
  const f=await fixture(t);
  for(const state of ['missing','unknown','unexpected','ready']){
    f.setState(state);
    assert.equal((await f.setup.status()).appleService,state==='unexpected'?'unknown':state);
    if(state==='ready')assert.equal((await f.setup.startAppleService()).appleService,'ready');
    else await assert.rejects(f.setup.startAppleService());
  }
  assert.equal(f.starts(),0);
  f.setState('stopped');
  f.setStart(async()=>{throw Object.assign(new Error('private output'),{code:1223})});
  await assert.rejects(f.setup.startAppleService(),/取消/);
  f.setStart(async()=>f.setState('ready'));
  const result=await Promise.all([f.setup.startAppleService(),f.setup.startAppleService()]);
  assert(result.every(s=>s.appleService==='ready'));
  assert.equal(f.starts(),2);
});

test('a failed service probe remains unknown; setup actions do not expose subprocess errors', async t=>{
  const f=await fixture(t);
  const setup=new Setup({root:f.root,run:async()=>{throw new Error('private details')}});
  assert.equal((await setup.status()).appleService,'unknown');
  await assert.rejects(setup.prepareReceiver(),err=>err.message.includes('组件') && !err.message.includes('private'));
});
