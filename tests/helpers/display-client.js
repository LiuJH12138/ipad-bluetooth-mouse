'use strict';
const {Readable} = require('node:stream');
const {createInterface} = require('node:readline');

// Act as the decoding window across the same HTTP boundary as the desktop UI.
// Only a cursor movement or an explicit scene change produces a decoded frame.
async function attachDisplayClient({url, token, sessionId}, options = {}) {
  const {width = 160, height = 120, layout = 1, beforeReply, afterReply} = options;
  let serial = options.serial ?? 1, x = 45, y = 35, background = 0, frozen = false;
  const controller = new AbortController();
  const headers = {'X-Control-Token':token};
  const response = await fetch(url+'/api/display/watch', {method:'POST', signal:controller.signal,
    headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({sessionId})});
  if (!response.ok) throw Error('Display channel failed: '+await response.text());

  function pixels() {
    const bytes = Buffer.alloc(width*height*4, background);
    for (let dy=-4; dy<=4; dy++) for (let dx=-4; dx<=4; dx++) {
      if (dx*dx+dy*dy<=16) bytes[4*((y+dy)*width+x+dx)] = 200;
    }
    return bytes;
  }
  function move(nextX, nextY) {
    nextX = Math.max(4, Math.min(width-5, Math.round(nextX)));
    nextY = Math.max(4, Math.min(height-5, Math.round(nextY)));
    if (!frozen && (nextX!==x || nextY!==y)) { x=nextX; y=nextY; serial++; }
    return true;
  }
  async function listen() {
    const lines = createInterface({input:Readable.fromWeb(response.body), crlfDelay:Infinity});
    try {
      for await (const line of lines) {
        const sample = JSON.parse(line);
        if (!sample.id) continue;
        const captured = {serial, bytes:pixels(), ...sample};
        await beforeReply?.(captured);
        const reply = await fetch(url+'/api/display/pixels', {method:'POST', signal:controller.signal,
          headers:{...headers,'X-USB-Session':sessionId,'X-Layout':String(layout),'X-Sample-Id':sample.id,
            'X-Width':String(width),'X-Height':String(height),'X-Serial':String(captured.serial),
            'X-Frame-Age':String(options.ageMs ?? 0)}, body:captured.bytes});
        await reply.arrayBuffer();
        afterReply?.(reply.status, captured);
      }
    } finally { lines.close(); }
  }
  let failure;
  const finished = listen().catch(error => { if (!controller.signal.aborted) failure=error; });
  return {
    absolute(_buttons, horizontal, vertical) { return move(horizontal*(width-1)/32767, vertical*(height-1)/32767); },
    report(_buttons, dx, dy, _wheel) { return move(x+dx, y+dy); },
    freeze(value = true) { frozen = value; },
    changeScene() { if (!frozen) { background=background ? 0 : 80; serial++; } },
    get serial() { return serial; },
    async close() { controller.abort(); await finished; if (failure) throw failure; }
  };
}
module.exports = {attachDisplayClient};
