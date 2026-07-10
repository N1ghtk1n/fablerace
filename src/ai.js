import * as THREE from 'three';
import { Car } from './car.js';
import { asset } from './asset.js';

// A bot is a full-physics Car plus a pursuit driver. Skill controls how far
// ahead it looks, how late it brakes and how much throttle it dares to use.
export const BOTS = [
  {
    name: 'Нико',
    title: 'Новичок',
    spec: { id: 'sedan-sports', model: asset('models/sedan-sports.glb'), length: 4.3, profile: { power: 0.95, aero: 1.0, steer: 1.1, grip: 1.2 } },
    skill: { look0: 8, lookV: 0.85, brakeErr: 0.26, brakeMinV: 12, cap: 0.66, grip: 0.78, drift: 0, nitro: false },
  },
  {
    name: 'Кай',
    title: 'Гонщик',
    spec: { id: 'hatchback-sports', model: asset('models/hatchback-sports.glb'), length: 3.9, profile: { power: 1.0, aero: 0.9, steer: 1.3, grip: 0.8 } },
    skill: { look0: 10, lookV: 1.0, brakeErr: 0.33, brakeMinV: 14, cap: 0.86, grip: 1.05, drift: 0.8, nitro: true },
  },
  {
    name: 'Вера',
    title: 'Профи',
    spec: { id: 'race-future', model: asset('models/race-future.glb'), length: 4.5, profile: { power: 1.3, aero: 1.22, steer: 0.8, grip: 0.85 } },
    skill: { look0: 10, lookV: 1.15, brakeErr: 0.45, brakeMinV: 16, cap: 1.0, grip: 1.3, drift: 0.45, nitro: true },
  },
];

export class Bot {
  constructor(track, def) {
    this.track = track;
    this.def = def;
    this.car = new Car(track);
    this.car.group.visible = false;
    this.active = false;
    this.laps = 0;
    this.prevProg = 0;
    this.finishTime = null;
  }

  async load() {
    await this.car.setModel(this.def.spec);
    // bots run their own baseline; the player's sliders don't tune them
    this.car.applySettings({ power: 1, aero: 1, steer: 1, grip: this.def.skill.grip });
  }

  placeOnGrid(sampleIndex, lateral) {
    const s = this.track.samples[sampleIndex];
    this.car.group.position.copy(s.pos).addScaledVector(s.normal, lateral).setY(0);
    this.car.heading = Math.atan2(s.tangent.x, s.tangent.z);
    this.car._settle();
    this.car.group.visible = true;
    this.laps = this.car.trackInfo && this.car.trackInfo.progress < 0.5 ? 0 : -1;
    this.prevProg = null;
    this.finishTime = null;
    this.gridLateral = lateral; // hold this line while clearing the grid
    this.activeTime = 0;
  }

  hide() {
    this.car.group.visible = false;
    this.active = false;
  }

  update(dt) {
    const car = this.car;
    if (!car.trackInfo) {
      car.update(dt, { throttle: 0, brake: 0, steer: 0, handbrake: false }, false);
      this.laps = car.trackInfo.progress < 0.5 ? 0 : -1;
      return;
    }
    const skill = this.def.skill;
    const samples = this.track.samples;
    const n = samples.length;

    const look = Math.round(skill.look0 + car.speed * skill.lookV);
    const target = samples[(car.trackInfo.index + look) % n];
    // hold the grid lane through the whole start zone (until ~50 m past the
    // line) so bots weave AROUND the player instead of ramming his slot
    const p = car.trackInfo.progress;
    const laneHold = this.laps < 0 ? 1
      : this.laps === 0 && p < 0.06 ? 1 - p / 0.06
      : 0;
    const ahead = target.pos.clone().addScaledVector(target.normal, (this.gridLateral ?? 0) * laneHold);
    const to = ahead.clone().sub(car.group.position);
    let err = Math.atan2(to.x, to.z) - car.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;

    const brake = Math.abs(err) > skill.brakeErr && car.speed > skill.brakeMinV;
    const steer = THREE.MathUtils.clamp(err / 0.12, -1, 1);

    // corner sharpness ahead decides drift kicks and nitro use
    const t0 = samples[car.trackInfo.index].tangent;
    const t1 = samples[(car.trackInfo.index + 26) % n].tangent;
    const turnAhead = t0.angleTo(t1);
    // drift-prone bots flick the handbrake into sharp corners
    const handbrake = skill.drift > 0
      && turnAhead > 0.72 - skill.drift * 0.25
      && car.speed > 16
      && Math.abs(car.slipAngle) < 0.15;
    // nitro on straights with a decent reserve
    const nitro = skill.nitro
      && turnAhead < 0.2
      && !brake
      && car.nitro > 15
      && Math.abs(car.slipAngle) < 0.12;

    car.update(dt, {
      throttle: brake || !this.active ? 0 : skill.cap,
      brake: brake && this.active ? 1 : 0,
      steer: this.active ? steer : 0,
      handbrake: handbrake && this.active,
      nitro: nitro && this.active,
    }, this.active);

    // lap counting by progress wrap (both directions), post-update position
    const pNow = car.trackInfo.progress;
    if (this.prevProg !== null) {
      if (this.prevProg > 0.85 && pNow < 0.15) this.laps++;
      else if (this.prevProg < 0.15 && pNow > 0.85) this.laps--;
    } else {
      this.laps = pNow < 0.5 ? 0 : -1;
    }
    this.prevProg = pNow;
  }

  // race distance for live ranking
  get totalProgress() {
    return this.laps + (this.prevProg ?? 0);
  }
}

// Arcade car-to-car collision: push apart, trade the closing velocity.
export function resolveCarCollisions(cars) {
  const R = 2.3; // combined collision radius
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = b.group.position.x - a.group.position.x;
      const dz = b.group.position.z - a.group.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const half = (R - d) / 2;
      a.group.position.x -= nx * half; a.group.position.z -= nz * half;
      b.group.position.x += nx * half; b.group.position.z += nz * half;
      const rel = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
      if (rel < 0) {
        const imp = -rel * 0.55; // inelastic bump
        a.velocity.x -= nx * imp; a.velocity.z -= nz * imp;
        b.velocity.x += nx * imp; b.velocity.z += nz * imp;
      }
    }
  }
}
