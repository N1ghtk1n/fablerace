// Synthesized engine audio (Web Audio, no samples).
// Pitch tracks rpm, timbre and volume track throttle load, so gear shifts
// are audible as a load dip + rpm step. A noise layer adds wind at speed.
export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._targetVol = 0;
  }

  // Must be called from a user gesture (autoplay policy).
  init() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // gentle limiter so full throttle doesn't clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    this.master.connect(comp).connect(ctx.destination);

    // shared lowpass: engine gets brighter under load
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 500;
    this.tone.Q.value = 0.8;
    this.tone.connect(this.master);

    // engine layers: [waveform, freq multiple of firing rate, base gain]
    this.layers = [
      ['sawtooth', 1.0, 0.34],   // firing pulses
      ['sawtooth', 0.5, 0.22],   // crankshaft rumble
      ['square', 2.0, 0.10],     // exhaust rasp
      ['triangle', 3.0, 0.05],   // valvetrain whine
    ].map(([type, mult, vol]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 30 * mult;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      osc.connect(gain).connect(this.tone);
      osc.start();
      return { osc, gain, mult, vol };
    });

    // wind / road noise
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windFilter.Q.value = 0.4;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(this.windFilter).connect(this.windGain).connect(this.master);
    noise.start();

    // mute when the tab goes to background
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    });
  }

  setMuted(muted) {
    this.enabled = !muted;
  }

  // active: engine running (countdown / racing); car: the Car instance
  update(car, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpm = car.rpm;
    const load = car.shiftTimer > 0 ? 0.12 : 0.3 + car.throttleSm * 0.7;

    // four-stroke firing frequency (~4 cyl): rpm/60 * 2
    const firing = (rpm / 60) * 2;
    for (const l of this.layers) {
      l.osc.frequency.setTargetAtTime(firing * l.mult, t, 0.03);
      l.gain.gain.setTargetAtTime(l.vol * (0.55 + load * 0.45), t, 0.05);
    }
    // brighter under load and revs
    this.tone.frequency.setTargetAtTime(320 + rpm * 0.22 + load * 1400, t, 0.06);

    // wind grows with speed; nitro adds a bright jet hiss
    const wind = Math.min(car.speed / 55, 1);
    const boost = car.boosting ? 1 : 0;
    this.windGain.gain.setTargetAtTime(wind * 0.16 + boost * 0.22, t, 0.08);
    this.windFilter.frequency.setTargetAtTime(500 + wind * 900 + boost * 1600, t, 0.08);

    const vol = this.enabled && active && !document.hidden ? 0.5 : 0;
    if (vol !== this._targetVol) {
      this.master.gain.setTargetAtTime(vol, t, 0.15);
      this._targetVol = vol;
    }
  }
}
