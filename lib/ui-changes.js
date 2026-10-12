'use strict';

// Native Homey controls can emit every intermediate wheel/slider value. Keep
// one draft per operation until the user has stopped changing it for 1 second.
// This is separate from the gateway FIFO: explicit Flow actions never debounce.
class UiChanges {
  constructor({ dispatch, settled, error, setTimer = setTimeout, clearTimer = clearTimeout, delay = 1000 }) {
    Object.assign(this, { dispatch, settled, error, setTimer, clearTimer, delay });
    this.pending = new Map(); this.current = new Map(); this.running = new Set();
  }
  submit(key, values, id, discard = []) {
    let draft = this.pending.get(key);
    if (!draft) { draft = { key, values: {}, cancelled: false }; this.pending.set(key, draft); }
    if (draft.timer !== undefined) this.clearTimer(draft.timer);
    for (const cap of discard) delete draft.values[cap];
    Object.assign(draft.values, values); draft.id = id;
    this.current.set(key, draft);
    draft.timer = this.setTimer(() => this.flush(draft), this.delay);
    return draft;
  }
  isCurrent(draft) { return !draft.cancelled && this.current.get(draft.key) === draft; }
  isHolding() { return this.pending.size > 0 || [...this.running].some(draft => !draft.cancelled); }
  flush(draft) {
    if (this.pending.get(draft.key) !== draft || !this.isCurrent(draft)) return;
    this.pending.delete(draft.key); this.running.add(draft);
    draft.task = Promise.resolve().then(() => this.dispatch(draft)).catch(error => this.error(error))
      .finally(async () => {
        this.running.delete(draft);
        if (this.current.get(draft.key) === draft) this.current.delete(draft.key);
        await this.settled(draft);
      });
    // A UI acknowledgement does not await this task, so contain every rejection.
    draft.task.catch(error => this.error(error));
  }
  cancel() {
    for (const draft of this.pending.values()) this.clearTimer(draft.timer);
    for (const draft of this.running) draft.cancelled = true;
    this.pending.clear(); this.current.clear();
  }
}
module.exports = { UiChanges };
