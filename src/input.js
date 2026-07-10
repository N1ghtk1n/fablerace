// Keyboard state tracker. Exposes analog-style axes so the rest of the
// game doesn't care which physical keys are bound.
export class Input {
  constructor() {
    this.keys = new Set();
    this.onReset = null;
    this.onRestart = null;
    this.onEscape = null;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // don't fight with the settings form fields
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR' && this.onReset) this.onReset();
      if (e.code === 'Enter' && this.onRestart) this.onRestart();
      if (e.code === 'Escape' && this.onEscape) this.onEscape();
      // Keep the page from scrolling with arrows/space.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  has(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  get throttle() { return this.has('KeyW', 'ArrowUp') ? 1 : 0; }
  get brake() { return this.has('KeyS', 'ArrowDown') ? 1 : 0; }
  get steer() {
    let s = 0;
    if (this.has('KeyA', 'ArrowLeft')) s += 1;
    if (this.has('KeyD', 'ArrowRight')) s -= 1;
    return s;
  }
  get handbrake() { return this.has('Space'); }
  get nitro() { return this.has('ShiftLeft', 'ShiftRight'); }
}
