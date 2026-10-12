'use strict';
class FakeClock {
  constructor() { this.now = 0; this.next = 0; this.timers = new Map(); }
  setTimeout(fn, delay) { const id = ++this.next; this.timers.set(id, { at: this.now + delay, fn }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const until = this.now + ms;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, t]) => t.at <= until);
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].fn();
      for (let i = 0; i < 30; i++) await Promise.resolve();
    }
    this.now = until;
  }
}
module.exports = { FakeClock };
