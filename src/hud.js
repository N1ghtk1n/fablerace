import { formatTime } from './timing.js';

const GAUGE_MAX_KMH = 240;
const GAUGE_MAX_RPM = 7500;
const REDLINE_RPM = 6400;
// dial sweep: 135° (bottom-left) clockwise through the top to 45° (bottom-right)
const ANG_START = Math.PI * 0.75;
const ANG_SWEEP = Math.PI * 1.5;

export class HUD {
  constructor(track) {
    this.el = {
      lapnum: document.getElementById('lapnum'),
      curlap: document.getElementById('curlap'),
      lastlap: document.getElementById('lastlap'),
      bestlap: document.getElementById('bestlap'),
      message: document.getElementById('message'),
      lapflash: document.getElementById('lapflash'),
      drift: document.getElementById('drift'),
      menu: document.getElementById('menu'),
    };
    const gauge = document.getElementById('speedo-canvas');
    this.gaugeCtx = gauge.getContext('2d');
    this.gaugeSize = gauge.width;
    this._initMinimap(track);
  }

  _initMinimap(track) {
    const canvas = document.getElementById('minimap-canvas');
    this.mapCtx = canvas.getContext('2d');
    this.mapW = canvas.width; this.mapH = canvas.height;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of track.samples) {
      minX = Math.min(minX, s.pos.x); maxX = Math.max(maxX, s.pos.x);
      minZ = Math.min(minZ, s.pos.z); maxZ = Math.max(maxZ, s.pos.z);
    }
    const pad = 12;
    const scale = Math.min((this.mapW - pad * 2) / (maxX - minX), (this.mapH - pad * 2) / (maxZ - minZ));
    this.mapProject = (x, z) => [
      pad + (x - minX) * scale + ((this.mapW - pad * 2) - (maxX - minX) * scale) / 2,
      pad + (z - minZ) * scale + ((this.mapH - pad * 2) - (maxZ - minZ) * scale) / 2,
    ];

    const off = document.createElement('canvas');
    off.width = this.mapW; off.height = this.mapH;
    const g = off.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 5;
    g.lineJoin = 'round';
    g.beginPath();
    track.samples.forEach((s, i) => {
      const [x, y] = this.mapProject(s.pos.x, s.pos.z);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    });
    g.closePath();
    g.stroke();
    const [sx, sy] = this.mapProject(track.samples[0].pos.x, track.samples[0].pos.z);
    g.fillStyle = '#ffd34d';
    g.beginPath(); g.arc(sx, sy, 4, 0, Math.PI * 2); g.fill();
    this.mapBase = off;
  }

  _angleFor(frac) {
    return ANG_START + Math.min(1, Math.max(0, frac)) * ANG_SWEEP;
  }

  _drawGauge(car) {
    const g = this.gaugeCtx;
    const S = this.gaugeSize, cx = S / 2, cy = S / 2;
    const R = S / 2 - 6;
    g.clearRect(0, 0, S, S);

    // dial face + rim
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = 'rgba(12, 16, 24, 0.88)'; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = 'rgba(255,255,255,0.25)'; g.stroke();

    // speed ticks + labels
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= GAUGE_MAX_KMH; v += 10) {
      const a = this._angleFor(v / GAUGE_MAX_KMH);
      const major = v % 40 === 0;
      const r1 = R - (major ? 13 : 8), r2 = R - 3;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      g.lineWidth = major ? 2.4 : 1.2;
      g.strokeStyle = major ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
      g.stroke();
      if (major) {
        g.font = `600 ${S * 0.062}px system-ui, sans-serif`;
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillText(String(v), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
      }
    }

    // rpm arc (inner): grey track, live orange fill, red zone
    const rpmR = R - 34;
    const arc = (from, to, color, w) => {
      g.beginPath();
      g.arc(cx, cy, rpmR, this._angleFor(from), this._angleFor(to));
      g.lineWidth = w; g.strokeStyle = color; g.lineCap = 'round'; g.stroke();
    };
    arc(0, 1, 'rgba(255,255,255,0.13)', 5);
    arc(REDLINE_RPM / GAUGE_MAX_RPM, 1, 'rgba(230,60,60,0.45)', 5);
    const rpmFrac = car.rpm / GAUGE_MAX_RPM;
    arc(0, rpmFrac, rpmFrac > REDLINE_RPM / GAUGE_MAX_RPM ? '#f4433c' : '#ff9f3c', 5);

    // nitro reserve: inner cyan arc, flashes while boosting
    const nitroR = rpmR - 9;
    const nArc = (from, to, color, w) => {
      g.beginPath();
      g.arc(cx, cy, nitroR, this._angleFor(from), this._angleFor(to));
      g.lineWidth = w; g.strokeStyle = color; g.lineCap = 'round'; g.stroke();
    };
    nArc(0, 1, 'rgba(255,255,255,0.10)', 4);
    if (car.nitro > 0.5) {
      nArc(0, car.nitro / 100, car.boosting ? '#9ff2ff' : '#38bdf8', 4);
    }
    g.lineCap = 'butt';

    // needle
    const kmh = Math.min(car.speedKmh, GAUGE_MAX_KMH);
    const na = this._angleFor(kmh / GAUGE_MAX_KMH);
    g.beginPath();
    g.moveTo(cx - Math.cos(na) * 12, cy - Math.sin(na) * 12);
    g.lineTo(cx + Math.cos(na) * (R - 16), cy + Math.sin(na) * (R - 16));
    g.lineWidth = 3; g.strokeStyle = '#ff4444'; g.lineCap = 'round'; g.stroke();
    g.lineCap = 'butt';

    // hub: gear on top, speed digits duplicated below it, slightly bigger
    g.beginPath(); g.arc(cx, cy, S * 0.21, 0, Math.PI * 2);
    g.fillStyle = 'rgba(8, 11, 17, 0.95)'; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,0.2)'; g.stroke();

    const gear = car.gearLabel;
    g.font = `700 ${S * 0.085}px system-ui, sans-serif`;
    g.fillStyle = gear === 'R' ? '#7dd3fc' : car.shiftTimer > 0 ? '#ffd34d' : '#ffffff';
    g.fillText(gear, cx, cy - S * 0.065);
    g.font = `800 ${S * 0.115}px system-ui, sans-serif`;
    g.fillStyle = '#ffffff';
    g.fillText(String(Math.round(car.speedKmh)), cx, cy + S * 0.05);
    g.font = `500 ${S * 0.05}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText('км/ч', cx, cy + S * 0.135);

    // surface indicator under the hub
    if (car.onGrass) {
      g.font = `700 ${S * 0.052}px system-ui, sans-serif`;
      g.fillStyle = '#a3e635';
      g.fillText('ТРАВА', cx, cy + R - 14);
    }
  }

  update(car, timer, raceInfo = null, rivalPositions = []) {
    this._drawGauge(car);
    if (raceInfo) {
      this.el.lapnum.textContent = `${raceInfo.lap}/${raceInfo.laps} · P${raceInfo.pos} из ${raceInfo.total}`;
    } else {
      this.el.lapnum.textContent = timer.running ? timer.lapNumber : '–';
    }
    this.el.curlap.textContent = timer.running ? formatTime(timer.currentLapMs) : '--:--.---';
    this.el.lastlap.textContent = formatTime(timer.lastLap);
    this.el.bestlap.textContent = formatTime(timer.bestLap);

    const g = this.mapCtx;
    g.clearRect(0, 0, this.mapW, this.mapH);
    g.drawImage(this.mapBase, 0, 0);
    for (const p of rivalPositions) {
      const [rx, ry] = this.mapProject(p.x, p.z);
      g.fillStyle = '#ffb02e';
      g.beginPath(); g.arc(rx, ry, 4, 0, Math.PI * 2); g.fill();
    }
    const [cx, cy] = this.mapProject(car.group.position.x, car.group.position.z);
    g.fillStyle = '#ff5252';
    g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1.5;
    g.stroke();
  }

  showMessage(html) {
    this.el.message.innerHTML = html;
    this.el.message.style.opacity = 1;
  }

  hideMessage() {
    this.el.message.style.opacity = 0;
  }

  showMenu(show) {
    this.el.menu.classList.toggle('hidden', !show);
  }

  // live drift counter; when the slide ends the score fades out
  updateDrift(active, score) {
    const el = this.el.drift;
    if (active) {
      el.textContent = `ДРИФТ ${Math.round(score)}`;
      el.classList.add('live');
      el.classList.remove('done');
    } else if (el.classList.contains('live')) {
      el.classList.remove('live');
      if (score > 40) {
        el.classList.remove('done');
        void el.offsetWidth;
        el.classList.add('done');
      }
    }
  }

  toast(text) {
    const el = this.el.lapflash;
    el.textContent = text;
    el.style.color = '#fff';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  flashLap(ms, isBest) {
    const el = this.el.lapflash;
    el.textContent = `${isBest ? '★ Лучший круг! ' : 'Круг: '}${formatTime(ms)}`;
    el.style.color = isBest ? '#b57bff' : '#fff';
    el.classList.remove('show');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('show');
  }
}
