'use strict';

// Measure error if an intermediate point is omitted from the captured stroke.
function distanceFromStroke(point, from, to) {
  const x = to.x - from.x, y = to.y - from.y;
  const lengthSquared = x * x + y * y;
  const t = lengthSquared ? Math.max(0, Math.min(1,
    ((point.x - from.x) * x + (point.y - from.y) * y) / lengthSquared)) : 0;
  return Math.hypot(point.x - from.x - t * x, point.y - from.y - t * y);
}

class PictureMouseGesture {
  constructor(start, buttonMask = 1, minimumHoldMs = 24) {
    this.start = {...start};
    this.last = this.start;
    this.buttonMask = buttonMask;
    this.minimumHoldMs = minimumHoldMs;
    this.startedAt = performance.now();
    this.path = [];
    this.endTime = null;
    this.cancelled = false;
    this.playing = false;
    this.wake = null;
  }

  move(point) {
    if (!point || this.cancelled || this.endTime !== null) return;
    if (this.last.x === point.x && this.last.y === point.y) return;
    const next = {x: point.x, y: point.y, time: performance.now() - this.startedAt};
    this.last = next;
    const middle = this.path.at(-1);
    const before = this.path.at(-2);
    // Keep corners. Merge redundant samples from a fast mouse within two frames.
    if (before && next.time - before.time <= 32 && distanceFromStroke(middle, before, next) <= 1) {
      this.path.pop();
    }
    this.path.push(next);
    // Bound memory while alignment is pending. Preserve endpoints and sharp turns.
    if (this.path.length > 96) {
      let best = 1, minError = Infinity;
      for (let i = 1; i < this.path.length - 1; i++) {
        const error = distanceFromStroke(this.path[i], this.path[i - 1], this.path[i + 1]);
        if (error < minError) { minError = error; best = i; }
      }
      this.path.splice(best, 1);
    }
    this.wake?.();
  }

  end(point) {
    if (this.endTime !== null || this.cancelled) return;
    this.move(point);
    this.endTime = performance.now() - this.startedAt;
    this.wake?.();
  }

  cancel() {
    this.cancelled = true;
    this.wake?.();
  }

  wait(milliseconds) {
    return new Promise(resolve => {
      let timer;
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      if (Number.isFinite(milliseconds)) timer = setTimeout(this.wake, milliseconds);
    });
  }

  async play({gain, report, validate, moveHeld, paceAbsoluteDrag = false}) {
    if (this.playing || (!moveHeld && !(Number.isFinite(gain) && gain > 0))) throw Error('鼠标定位状态无效。');
    this.playing = true;
    const check = () => {
      if (this.cancelled) throw Error('鼠标操作已取消。');
      validate();
    };
    check();
    let sentX = 0, sentY = 0, dragged = false;
    let reached = this.start;
    let heldMs = 0, lastMotionAt = 0;
    const waitUntil = async deadline => {
      while (performance.now() < deadline) {
        check();
        await this.wait(deadline - performance.now());
      }
      check();
    };
    try {
      await report(0, 0, this.buttonMask);
      const downAt = performance.now();
      for (;;) {
        check();
        const elapsed = performance.now() - downAt;
        let next = this.path[0];
        if (next && next.time <= elapsed) {
          this.path.shift();
          // If acknowledgement lagged behind the hand, skip overdue points
          // on the same segment rather than sending a burst of tiny reports.
          while (this.path[0]?.time <= elapsed && distanceFromStroke(next, reached, this.path[0]) <= 1) {
            next = this.path.shift();
          }
          if (moveHeld) {
            const intermediate = this.path.length > 0 || this.endTime === null;
            const dx = next.x - reached.x, dy = next.y - reached.y;
            const distance = Math.hypot(dx, dy);
            // A fast automation drag can contain only down and up. iOS needs
            // to observe held movement between those edges across input frames.
            if (paceAbsoluteDrag && distance >= 12 && next.time - (reached.time || 0) <= 45) {
              const steps = Math.min(8, Math.max(3, Math.ceil(distance / 32)));
              await waitUntil(Math.max(downAt + 50, lastMotionAt + 16));
              for (let i = 1; i <= steps; i++) {
                if (i > 1) await waitUntil(lastMotionAt + 16);
                await moveHeld({x: reached.x + dx*i/steps, y: reached.y + dy*i/steps},
                  this.buttonMask, {intermediate: i < steps || intermediate});
                lastMotionAt = performance.now();
              }
            } else {
              await moveHeld({x: next.x, y: next.y}, this.buttonMask, {intermediate});
              if (paceAbsoluteDrag) lastMotionAt = performance.now();
            }
            dragged = true;
            reached = next;
            continue;
          }
          const tx = Math.round((next.x - this.start.x) / gain);
          const ty = Math.round((next.y - this.start.y) / gain);
          const dx = tx - sentX, dy = ty - sentY;
          const packets = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 127);
          for (let i = 0; i < packets; i++) {
            check();
            // Distribute rounding over the segment so diagonal moves stay straight.
            const x = Math.round((tx - sentX) / (packets - i));
            const y = Math.round((ty - sentY) / (packets - i));
            await report(x, y, this.buttonMask);
            sentX += x;
            sentY += y;
            dragged = true;
          }
          reached = next;
          continue;
        }
        const releaseAt = this.endTime === null ? Infinity : Math.max(this.minimumHoldMs, this.endTime,
          lastMotionAt ? lastMotionAt - downAt + 32 : 0);
        if (!next && elapsed >= releaseAt) break;
        // A rotation or lease change must also interrupt a stationary long press.
        await this.wait(Math.min(200, (next ? next.time : releaseAt) - elapsed));
      }
      // A small waypoint may have been deferred while the hand was moving.
      // Require the endpoint under the held button before allowing release.
      if (moveHeld && dragged) {
        check();
        await moveHeld({x: this.last.x, y: this.last.y}, this.buttonMask);
      }
      heldMs = Math.round(performance.now() - downAt);
    } finally {
      // A stale owner must never release another controller's button.
      // The server releases all buttons when the original lease ends.
      validate();
      await report(0, 0, 0);
    }
    return {dragged, heldMs, end: {x: this.last.x, y: this.last.y}};
  }
}

if (typeof module !== 'undefined') module.exports = {PictureMouseGesture};
