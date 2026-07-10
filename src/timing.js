// Lap timing with sector checkpoints so cutting or reversing over the line
// doesn't count. Progress s ∈ [0,1) comes from the nearest centerline sample.
const SECTORS = [0.25, 0.5, 0.75];

export class LapTimer {
  constructor() {
    this.reset();
    this.onLap = null;
  }

  reset() {
    this.running = false;
    this.lapStart = 0;
    this.lapNumber = 0;
    this.lastLap = null;
    this.bestLap = null;
    this.prevProgress = 0;
    this.sectorsHit = [false, false, false];
  }

  start(now, progress) {
    this.running = true;
    this.lapStart = now;
    this.lapNumber = 1;
    this.prevProgress = progress;
    this.sectorsHit = [false, false, false];
  }

  get currentLapMs() {
    return this.running ? performance.now() - this.lapStart : 0;
  }

  update(progress) {
    if (!this.running) return;
    const p = progress, q = this.prevProgress;

    // sector gates must be crossed in order (forward only)
    SECTORS.forEach((gate, i) => {
      if (i > 0 && !this.sectorsHit[i - 1]) return;
      if (q < gate && p >= gate && p - q < 0.5) this.sectorsHit[i] = true;
    });

    // start/finish crossing: progress wraps from high to low going forward
    if (q > 0.85 && p < 0.15) {
      if (this.sectorsHit.every(Boolean)) {
        const now = performance.now();
        this.lastLap = now - this.lapStart;
        if (this.bestLap === null || this.lastLap < this.bestLap) this.bestLap = this.lastLap;
        this.lapStart = now;
        this.lapNumber += 1;
        if (this.onLap) this.onLap(this.lastLap, this.bestLap, this.lapNumber);
      }
      this.sectorsHit = [false, false, false];
    }
    // reversed over the line — require a clean lap again
    if (q < 0.15 && p > 0.85) this.sectorsHit = [false, false, false];

    this.prevProgress = p;
  }
}

export function formatTime(ms) {
  if (ms === null || ms === undefined) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
}
