'use strict';
// Mirrorlab's loopback stream is a sequence of 24-byte MLB1 headers and access units.
// A USB frame may span several HTTP reads, or share a read with the next frame.
class UsbPackets {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.header = new Uint8Array(24);
    this.buffer = this.header;
    this.offset = 0;
  }
  push(bytes) {
    while (bytes.length) {
      const count = Math.min(bytes.length, this.buffer.length - this.offset);
      this.buffer.set(bytes.subarray(0, count), this.offset);
      this.offset += count;
      bytes = bytes.subarray(count);
      if (this.offset !== this.buffer.length) continue;
      this.offset = 0;
      const view = new DataView(this.header.buffer);
      if (this.buffer === this.header) {
        const size = view.getUint32(4, true);
        if (view.getUint32(0) !== 0x4d4c4231 || !size || size > 16 * 1024 * 1024) {
          throw new Error('USB 视频帧格式异常，请重新连接。');
        }
        this.buffer = new Uint8Array(size);
      } else {
        if (view.getUint32(8, true) === 1) {
          this.onPacket(this.buffer, Number(view.getBigUint64(16, true)), view.getUint32(12, true) % 4);
        }
        this.buffer = this.header;
      }
    }
  }
}

function describeH264(bytes) {
  let codec, key = false;
  for (let i = 2; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 1 || bytes[i-1] !== 0 || bytes[i-2] !== 0) continue;
    const type = bytes[++i] & 31;
    if (type === 7 && i + 3 < bytes.length) {
      codec = 'avc1.' + Array.from(bytes.subarray(i + 1, i + 4), b => b.toString(16).padStart(2, '0')).join('');
    }
    if (type === 5) key = true;
    if (type === 5 || type === 1) break;
  }
  return { codec, key };
}

async function openUsbStream(token, deviceId, signal, onRetry) {
  const options = {
    method:'POST', headers:{'X-Control-Token':token,'Content-Type':'application/json'},
    body:deviceId ? JSON.stringify({deviceId}) : undefined, signal
  };
  for (let attempt=0; ; attempt++) {
    signal.throwIfAborted();
    const response=await fetch('/api/usb/video',options);
    if (response.ok) return response;
    const {error,code}=await response.json();
    if (attempt || !deviceId || response.status!==503 || code!=='USB_MODE_UNCHANGED') {
      throw Object.assign(new Error(error || 'USB 采集失败。'),{code,status:response.status});
    }
    onRetry?.('设备尚未进入投屏模式，正在重新连接所选设备…');
    await new Promise(resolve=>{
      if (signal.aborted) return resolve();
      const finish=()=>{
        clearTimeout(timer);
        signal.removeEventListener('abort',finish);
        resolve();
      };
      const timer=setTimeout(finish,1200);
      signal.addEventListener('abort',finish,{once:true});
    });
  }
}

async function playUsbVideo({ token, deviceId, canvas, signal, onFrame, onRetry }) {
  if (!globalThis.VideoDecoder) throw new Error('USB 解码需要支持 WebCodecs 的 Chrome 或 Edge。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let codec, waitingForKey = true, failure, deviceFamily, sessionId;
  let firstFrameTimer, receivedVideoPacket = false, submittedVideo = false;
  const submissions = new Map();
  const context = canvas.getContext('2d', { alpha: false });
  const decoder = new VideoDecoder({
    output(frame) {
      try {
        const item = submissions.get(frame.timestamp);
        submissions.delete(frame.timestamp);
        if (!item || signal.aborted) return;
        const { turns, submitted } = item;
        const w = frame.displayWidth, h = frame.displayHeight;
        const width = turns % 2 ? h : w, height = turns % 2 ? w : h;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        context.setTransform(1, 0, 0, 1, width / 2, height / 2);
        context.rotate(turns * Math.PI / 2);
        context.drawImage(frame, -w / 2, -h / 2, w, h);
        onFrame(performance.now() - submitted, turns, deviceFamily, sessionId);
        if (firstFrameTimer !== undefined) { clearTimeout(firstFrameTimer); firstFrameTimer = undefined; }
      } catch (error) {
        failure = error;
        abort();
      } finally { frame.close(); }
    },
    error(error) { failure = error; abort(); }
  });
  let sequence = 0;
  const packets = new UsbPackets((data, pts, turns) => {
    receivedVideoPacket = true;
    const info = describeH264(data);
    if ((info.codec && info.codec !== codec) || decoder.decodeQueueSize > 8 || submissions.size > 32) {
      codec = info.codec || codec;
      decoder.reset();
      submissions.clear();
      decoder.configure({ codec, optimizeForLatency: true });
      waitingForKey = true;
    }
    if (!codec || (waitingForKey && !info.key)) return;
    waitingForKey = false;
    // Use a unique timestamp to associate output with orientation and decoder time.
    const timestamp = Math.max(pts, sequence + 1);
    sequence = timestamp;
    submissions.set(timestamp, { turns, submitted: performance.now() });
    decoder.decode(new EncodedVideoChunk({ type: info.key ? 'key' : 'delta', timestamp, data }));
    submittedVideo = true;
  });
  try {
    const response = await openUsbStream(token,deviceId,controller.signal,onRetry);
    if (deviceId && response.headers.get('X-Apple-Device-Id') !== deviceId) throw Error('USB 设备已改变，请重新选择。');
    sessionId = response.headers.get('X-USB-Session');
    if (deviceId && !sessionId) throw Error('缺少 USB 会话标识，请重新打开投屏。');
    deviceFamily = response.headers.get('X-Apple-Device-Family');
    // The native startup deadline ends at the first transport byte. A partial
    // packet, missing key frame or stalled decoder can still leave a blank view.
    firstFrameTimer = setTimeout(() => {
      let message = 'USB 已开始传输，但未收到完整的视频帧。请重新投屏。';
      if (submittedVideo) message = '已收到 USB 视频关键帧，但解码器未能显示首帧。请重新打开控制台。';
      else if (receivedVideoPacket) message = '已收到 USB 视频数据，但未等到可解码的 H.264 关键帧。请重新投屏。';
      failure = new Error(message);
      abort();
    }, 12000);
    const reader = response.body.getReader();
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      packets.push(value);
    }
    if (!signal.aborted) throw failure || new Error('USB 视频已断开。');
  } catch (error) { throw failure || error; }
  finally {
    clearTimeout(firstFrameTimer);
    abort();
    signal.removeEventListener('abort', abort);
    if (decoder.state !== 'closed') decoder.close();
  }
}
if (typeof module !== 'undefined') module.exports = { UsbPackets, describeH264 };
