'use strict';

let setupRun = null;
const setupPanel = $('setup-panel');
function showSetup(title, detail, {next, store = false} = {}) {
  $('setup-title').textContent = title;
  $('setup-detail').textContent = detail;
  $('setup-store').hidden = !store;
  $('setup-devices').replaceChildren();
  $('setup-next').hidden = !next;
  $('setup-next').textContent = next || '';
  $('setup-skip').hidden = !!setupRun?.videoOnly;
  $('setup-cancel').textContent = usbLive ? '结束配置' : '取消配置';
}
function checkSetup(run) {
  if (setupRun !== run || run.signal.aborted) throw Error('配置已取消。');
}
function checkSetupScreen(run) {
  checkSetup(run);
  if (!usbLive || run.session !== usbSession || usbDeviceId !== run.deviceId) throw Error('投屏连接已改变，请重新检测。');
}
function waitForSetup(run, subscribe) {
  checkSetup(run);
  return new Promise((resolve, reject) => {
    const stop = () => finish(false);
    let cleanup, settled = false;
    function finish(ok, value) {
      if (settled) return;
      settled = true;
      run.signal.removeEventListener('abort', stop);
      cleanup?.();
      if (ok) resolve(value);
      else reject(Error('配置已取消。'));
    }
    run.signal.addEventListener('abort', stop, {once:true});
    cleanup = subscribe(value => finish(true, value));
  });
}
function setupPause(run, ms) {
  return waitForSetup(run, done => {
    const timer = setTimeout(done, ms);
    return () => clearTimeout(timer);
  });
}
function awaitSetupAction(run, choices) {
  return waitForSetup(run, done => {
    $('setup-next').onclick = event => { if (!(event?.detail > 1)) done(null); };
    for (const device of choices || []) {
      const button = document.createElement('button');
      button.textContent = usbDeviceLabel(device, choices);
      button.onclick = () => done(device.id);
      $('setup-devices').append(button);
    }
    return () => {
      $('setup-next').onclick = null;
      $('setup-devices').replaceChildren();
    };
  });
}
function finishSetup(run, focus = true) {
  if (setupRun !== run) return;
  setupRun = null;
  run.controller.abort();
  setupPanel.hidden = true;
  if (focus) (usbLive ? modeSummary : $('setup-start')).focus({preventScroll:true});
}
function cancelSetup(focus = true) {
  const run = setupRun;
  if (!run) return;
  if (run.session && run.session === usbSession) {
    relativeChallenge = null;
    pointMode = false;
    stopControl();
  }
  finishSetup(run, focus);
}
$('setup-cancel').onclick = () => cancelSetup();
$('setup-skip').onclick = () => {
  const run = setupRun;
  if (!run) return;
  run.videoOnly = true;
  $('setup-skip').hidden = true;
  if (usbLive && run.session === usbSession) cancelSetup();
};
// Any explicit manual action takes over from the guide before its handler runs.
for (const id of ['usb','stop-usb','connect','preview-mode','point','control','verify-position','confirm-relative','assistant']) {
  $(id).addEventListener('click', () => cancelSetup(false), true);
}
window.addEventListener('pagehide', () => cancelSetup(false));

async function prepareSetup(run) {
  showSetup('检测 Windows 和 USB', '请用数据线连接设备并解锁。需要 Windows 权限时，系统会弹出确认窗口。');
  const settings = await api('setup', undefined, {signal:run.signal});
  checkSetup(run);
  run.computerName = settings.computerName;
  run.appleSupportUncertain = ['missing','unknown'].includes(settings.appleService);
  if (!settings.receiverReady) {
    if (!settings.sourceInstallable) throw Error('当前缺少 USB 采集组件，请使用包含 USB 组件的 MSI 安装包修复控制台。');
    showSetup('准备 USB 采集组件', '首次配置需要下载采集组件，请稍候。');
    await api('setup/receiver', {}, {signal:run.signal});
    checkSetup(run);
  }
  if (settings.appleService === 'stopped') {
    showSetup('启动 Apple 设备服务', '如果 Windows 请求权限，请确认后返回此处。');
    await api('setup/apple-service', {}, {signal:run.signal});
    checkSetup(run);
  }
  let inventory;
  if (run.appleSupportUncertain) {
    try { inventory = (await api('devices', undefined, {signal:run.signal})).devices; }
    catch { checkSetup(run); }
    checkSetup(run);
    if (!inventory?.length) {
      showSetup('检查 Apple 设备支持', '接好并解锁设备。若 Windows 尚未安装「Apple 设备」，可从 Microsoft Store 安装，完成后返回此处重新检测。', {store:true,next:'重新检测'});
      await awaitSetupAction(run);
      return false;
    }
  }
  let configuredId;
  for (;;) {
    checkSetup(run);
    const devices = inventory || (await api('devices', undefined, {signal:run.signal})).devices;
    inventory = null;
    checkSetup(run);
    if (!run.deviceId && devices.length > 1) {
      showSetup('选择要配置的设备', '只会为选中的 USB 设备配置驱动和键鼠。', {next:'刷新设备'});
      run.deviceId = await awaitSetupAction(run, devices);
      continue;
    }
    if (!run.deviceId && devices.length === 1) run.deviceId = devices[0].id;
    const device = devices.find(item => item.id === run.deviceId);
    if (!device || device.driver === 'replug' || (device.id === configuredId && device.driver !== 'ready')) {
      const replug = !!device || !!run.deviceId;
      showSetup(replug ? '等待设备重新连接' : '等待 USB 设备', replug ?
        '请重新拔插刚才选中的设备，解锁并信任这台电脑。检测到后将自动继续。' :
        '请用可传输数据的线连接设备，解锁并确认信任。这一步会自动检测。');
      await setupPause(run, 2000);
      continue;
    }
    if (device.driver === 'ready') return true;
    if (device.driver !== 'missing') throw Error('暂时无法确认所选设备的 USB 驱动。请重新插线并解锁后重试。');
    showSetup('配置所选设备的 USB 驱动', '如果 Windows 请求管理员权限，请确认。设备可能需要重新插线。');
    const result = await api('setup/driver', {deviceId:device.id}, {signal:run.signal});
    checkSetup(run);
    if (result.driver === 'ready') return true;
    if (result.driver !== 'replug') throw Error('所选设备的 USB 驱动尚未就绪。请重新插线并解锁后再检测。');
    configuredId = device.id;
  }
}
async function connectSetupScreen(run) {
  while (!await prepareSetup(run)) checkSetup(run);
  checkSetup(run);
  showSetup('等待 USB 实时画面', '请保持设备解锁，并在设备上确认可能出现的信任提示。');
  await new Promise((resolve, reject) => {
    openUsbDevice(run.deviceId, {signal:run.signal, onLive:resolve})
      .then(() => reject(Error('没有收到所选设备的实时画面，请检查连接并重试。')), reject);
  });
  checkSetup(run);
  run.session = usbSession;
  checkSetupScreen(run);
}
async function setupKeyboard(run) {
  const current = () => setupRun === run && usbLive && run.session === usbSession;
  await updateBluetooth();
  checkSetupScreen(run);
  if (!bluetoothRunning()) {
    showSetup('启动蓝牙键鼠', '如果 Windows 弹出配对请求，请核对两端的配对码。');
    await changeBluetooth(false, true);
    checkSetupScreen(run);
  }
  for (;;) {
    checkSetupScreen(run);
    if (!bluetoothRunning()) throw Error(lastBluetoothError || '蓝牙尚未启动。请检查电脑蓝牙并重试。');
    const candidates = availablePeers.some(peer => peer.absolute && (!peer.boundDeviceId || peer.boundDeviceId === run.deviceId));
    if (relativePeerId) {
      showSetup('核对旧版蓝牙键鼠', '把设备指针放到画面中央，点下方按钮后观察指针是否向右移动。', {next:'移动指针核对'});
      await awaitSetupAction(run);
      checkSetupScreen(run);
      await identifyRelative(false, current);
      checkSetupScreen(run);
      if (!relativeChallenge) throw Error('没有收到新的指针核对请求，请重试。');
      showSetup('确认指针移动', '请亲眼核对刚才移动的是这台投屏设备上的指针。', {next:'我已看到指针移动'});
      await awaitSetupAction(run);
      checkSetupScreen(run);
      await identifyRelative(true, current);
      checkSetupScreen(run);
      if (needsPairing) throw Error('本次指针确认已失效，请重新核对。');
    } else if ((needsPairing || (absoluteActive && !absoluteVerified)) && candidates) {
      showSetup('即将核对三个指针落点', '请打开清晰、静止的页面，例如「设置 → 通用」，并保持不动。核对时指针会移动三次。');
      await setupPause(run, 1800);
      checkSetupScreen(run);
      await verifyBluetoothDevice(current, true);
      checkSetupScreen(run);
      if (!absoluteVerified) throw Error(verificationDetail || '三个指针落点未能全部确认。请打开静止页面后重试。');
    }
    if (connected && keyboardConnected && (absoluteVerified || !absoluteActive)) return;
    const name = run.computerName ? '「' + run.computerName + '」' : '这台电脑';
    const waitingKeyboard = connected && !keyboardConnected;
    showSetup(waitingKeyboard ? '等待键盘连接' : '等待设备蓝牙配对', waitingKeyboard ?
      '已连接指针，请检查设备的蓝牙键盘连接。两项都就绪后会自动进入画面操控。' :
      '在设备上开启「设置 → 辅助功能 → 触控 → 辅助触控」，再到蓝牙设置选择' + name + '，核对两端配对码。连接后会自动继续。');
    await setupPause(run, 1000);
  }
}
$('setup-start').onclick = () => startConsoleSetup();
async function startConsoleSetup({deviceId = null, label = '', videoOnly = false} = {}) {
  if (setupRun || openingDevice || (usbSession && (!deviceId || deviceId === usbDeviceId))) return;
  const controller = new AbortController();
  const run = {controller, signal:controller.signal, deviceId, session:null, videoOnly};
  const previousSession = usbSession;
  setupRun = run;
  setupPanel.hidden = false;
  $('setup-title').focus({preventScroll:true});
  if (previousSession) {
    showSetup('切换到 ' + label, '继续后将停止当前设备的投屏和控制，再配置所选设备。', {next:'切换并配置'});
    try {
      await awaitSetupAction(run);
      checkSetup(run);
      if (usbSession && usbSession !== previousSession) { cancelSetup(); return; }
      await stopUsb();
      checkSetup(run);
    } catch (error) {
      if (setupRun === run) { notice(error.message,true); finishSetup(run); }
      return;
    }
  }
  while (setupRun === run) {
    try {
      if (!run.session || run.session !== usbSession || !usbLive) await connectSetupScreen(run);
      checkSetupScreen(run);
      if (!run.videoOnly) {
        await setupKeyboard(run);
        checkSetupScreen(run);
        await enterPictureMode();
        checkSetupScreen(run);
        if (!pointMode) throw Error('键鼠连接状态已改变，请重新检测。');
      }
      finishSetup(run, run.videoOnly);
      return;
    } catch (error) {
      if (setupRun !== run) return;
      showSetup('配置尚未完成', error.message, {next:'重试', store:run.appleSupportUncertain && !usbLive});
      try { await awaitSetupAction(run); } catch { return; }
    }
  }
}
