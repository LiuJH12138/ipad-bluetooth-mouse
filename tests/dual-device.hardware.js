// Loaded only by the opt-in native hardware runner. Screen samples stay in memory.
async function verifyHardware(firstDevice, inputTest, recoverMarker, accessoryTest, preparedSearch, knownDevices, cycleDevice, auditPhoneRadio, namesOnly) {
  const notes = [];
  function note(message) {
    notes.push(message);
    console.info('USB verification: '+message);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  const bindings = new Map();
  async function waitFor(check, ms, detail) {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (await check()) return;
      await sleep(150);
    }
    throw Error(detail());
  }
  async function show(device) {
    note('Opening '+device.family+' '+device.id.slice(-8));
    let ended = false;
    openUsbDevice(device.id,{device}).finally(()=>{ ended=true; });
    // A switch may first wait for the previous QuickTime stream to release USB.
    await waitFor(()=>{
      if (ended) throw Error('USB first frame unavailable: '+($('notice').textContent || $('video-status').textContent));
      return usbLive && usbDeviceId===device.id && displaySessionId;
    },150000,
      ()=>'USB first frame unavailable: '+($('notice').textContent || $('video-status').textContent));
    let status;
    await waitFor(async()=>{
      status = await api('status');
      return status.activeDeviceId===device.id && status.frameSerial>0 && usbCanvas.width>=2 && usbCanvas.height>=2;
    },2500,()=>'Selected USB target did not produce a decoded frame');
    note('USB '+device.family+' '+device.id.slice(-8)+' '+usbCanvas.width+'x'+usbCanvas.height+' frame '+status.frameSerial);
    if (inputTest && bindings.has(device.id)) {
      const expected=bindings.get(device.id), started=performance.now();
      let attempts=0;
      await waitFor(async()=>{
        await updateBluetooth();
        const s=await api('status');
        if (s.activeDeviceId!==device.id) return false;
        if (!s.needsPairing && s.verifiedPeerId===expected) return true;
        if (s.needsPairing && !pairing && !aiming && performance.now()-started>2000 && attempts<2 &&
            availablePeers.some(peer=>peer.id===expected && peer.absolute)) {
          attempts++;
          note(device.family+' rechecking its previously verified candidate on the new picture');
          await verifyBluetoothDevice(()=>usbDeviceId===device.id,true,expected);
        }
        return false;
      },30000,()=>device.family+' previously verified subscriber could not be proven again');
    }
  }
  let passed = false;
  const input = inputTest?.({note,waitFor,sleep,recoverMarker});
  const accessories=accessoryTest?.({...input.tools,note,waitFor,sleep});
  try {
    const {devices} = await api('devices');
    if (devices.length!==2 || devices.some(d=>d.driver!=='ready')) throw Error('Expected two ready USB devices; found '+devices.length);
    // USBMux may temporarily lose the model while Windows retains the same
    // physical identifier in capture mode. These operator-supplied labels
    // select test markers only. Every input still requires fresh visual proof.
    for (const [family,code] of Object.entries(knownDevices || {})) {
      if (!code) continue;
      const found=devices.filter(d=>d.id.endsWith(code.toLowerCase()));
      if (found.length!==1 || !['Apple',family].includes(found[0].family)) throw Error('Known hardware label is ambiguous');
      found[0].family=family;
    }
    if (firstDevice) {
      const original = devices.findIndex(d=>d.id.endsWith(firstDevice.toLowerCase()));
      if (original<0) throw Error('Original USB target not present');
      if (original===1) devices.reverse();
    }
    const initial = devices[0];
    for (const device of devices) {
      await show(device);
      if (!bluetoothRunning()) await changeBluetooth(false,true);
      let restartedService=false;
      await waitFor(async()=>{
        await updateBluetooth();
        if (input && !restartedService && bluetoothState==='error') {
          restartedService=true;
          await sleep(1500);
          await changeBluetooth(false,true);
        }
        return availablePeers.filter(p=>p.absolute).length>=2;
      },65000,()=>'Expected at least two absolute Bluetooth receivers; observed '+availablePeers.filter(p=>p.absolute).length+' (state '+bluetoothState+')');
      note('Bluetooth candidates '+availablePeers.length+', absolute '+availablePeers.filter(p=>p.absolute).length);
      const seenPeers = new Set(availablePeers.map(p=>p.id));
      await verifyBluetoothDevice();
      if (input && !absoluteVerified) {
        // The second receiver may subscribe before the actual USB target has
        // finished reconnecting. Retry the normal proof once after it settles.
        for (let pause=0;pause<18;pause++) {
          await sleep(600); await updateBluetooth();
          if (availablePeers.some(p=>!seenPeers.has(p.id))) break;
        }
        note('Retrying pointer verification with '+availablePeers.length+' subscribed receivers');
        await verifyBluetoothDevice();
      }
      const status=await api('status');
      if (!absoluteVerified || status.needsPairing || !status.verifiedPeerId ||
          status.activeDeviceId!==device.id || status.controlling || status.assistantEnabled)
        throw Error('Independent pointer verification failed: '+verificationDetail.split(' 请在「')[0]);
      if ([...bindings.values()].includes(status.verifiedPeerId)) throw Error('Bluetooth target already belongs to the other tablet');
      bindings.set(device.id,status.verifiedPeerId);
      note('Matched '+device.id.slice(-8)+' to BLE '+status.verifiedPeerId.slice(-8)+'; '+verificationDetail);
      if (accessories) { if (!cycleDevice) await accessories.inspect(device); }
      else if (input) {
        if (preparedSearch) await input.resume(device);
        else await input.prepare(device);
        if (preparedSearch) await input.enter(device);
      }
    }
    if (cycleDevice && accessories) {
      const target=devices.find(d=>d.family===cycleDevice), other=devices.find(d=>d!==target);
      if (!target || !other) throw Error('Unrecognized cycle target');
      if (usbDeviceId!==target.id) await show(target);
      await accessories.cycle(target,bindings.get(target.id),other,bindings.get(other.id),auditPhoneRadio);
    } else {
      await show(initial);
      let lastStatus;
      await waitFor(async()=>{
        const s=lastStatus=await api('status');
        return !s.controlling && !s.assistantEnabled && s.activeDeviceId===initial.id && s.verifiedPeerId===bindings.get(initial.id) &&
          !s.needsPairing && s.peers.some(p=>p.id===s.verifiedPeerId && p.boundDeviceId===initial.id);
      },8000,()=>{
        const s=lastStatus;
        return 'Original target or idle lease did not restore: '+JSON.stringify({
          usb:s?.activeDeviceId?.slice(-8), verified:s?.verifiedPeerId?.slice(-8), needsPairing:s?.needsPairing,
          controlling:s?.controlling,assistant:s?.assistantEnabled,
          peers:s?.peers?.map(p=>[p.id.slice(-8),p.boundDeviceId?.slice(-8)])
        });
      });
      notes.push('Returned to original USB and Bluetooth target with no active input or assistant lease');
      if (accessories) {
        await accessories.check(initial);
        await show(devices[1]);
        await accessories.check(devices[1]);
        if (namesOnly) {
          const unconfirmed=devices.filter(device=>!accessories.nameConfirmed(device));
          if (unconfirmed.length) throw Error('Per-device accessory names not confirmed: '+unconfirmed.map(d=>d.family).join(', '));
        } else {
          const preferred=devices.find(d=>d.family==='iPad');
          const target=!accessories.canCycle || accessories.canCycle(preferred) ? preferred :
            devices.find(d=>accessories.canCycle(d));
          if (!target) throw Error('Neither inspected accessory provides an individual Disconnect action');
          const other=devices.find(d=>d.id!==target.id);
          if (usbDeviceId!==target.id) await show(target);
          await accessories.cycle(target,bindings.get(target.id),other,bindings.get(other.id));
        }
      } else if (input) {
        // Both physical devices now have an independently recognized, focused
        // empty target. This makes a broadcast or stale route observable.
        if (!preparedSearch) {
          await input.enter(initial);
          await show(devices[1]);
          await input.enter(devices[1]);
          await show(initial);
        }
        await input.clear(initial,true);
        await show(devices[1]);
        await input.clear(devices[1],true);
      }
    }
    passed=true;
  } catch (error) { notes.push('Stopped: '+error.message); }
  finally {
    if (!passed && input) for (const device of input.pending()) {
      try {
        if (!usbLive || usbDeviceId!==device.id) await show(device);
        await input.clear(device);
      } catch (error) { notes.push('Marker cleanup '+device.family+': '+error.message); }
    }
    try { await stopUsb(); await changeBluetooth(true,true); }
    catch (error) { notes.push('Cleanup: '+error.message); passed=false; }
  }
  return notes.concat(passed?'PASS':'FAIL').join('\n');
}
