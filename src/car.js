import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ROAD_HALF_WIDTH, BOUNDARY } from './track.js';

// Arcade-but-plausible drivetrain: engine torque curve -> gearbox -> wheels.
// Acceleration comes from torque * total ratio, so it naturally tapers with
// speed and dips during gear shifts (clutch cut), like a real car.
const TUNING = {
  wheelRadius: 0.34,
  finalDrive: 3.7,
  gearRatios: [3.4, 2.36, 1.8, 1.43, 1.16, 0.95],
  reverseRatio: 3.3,
  idleRpm: 900,
  redlineRpm: 7200,
  shiftUpRpm: 6400,
  shiftDownRpm: 2300,
  shiftTime: 0.38,        // clutch-open pause, s — makes shifts *felt*
  torqueAccel: 0.8,       // peak accel (m/s^2) per unit of total gear ratio
  launchRpm: 2600,        // clutch slip keeps revs up when moving off
  throttleResponse: 3.5,  // 1/s, how fast engine picks up
  drag: 0.0008,           // quadratic aero drag, per (m/s)^2
  rollingResistance: 0.35,
  brakeForce: 13,
  maxReverse: 8,
  wheelbase: 2.6,
  maxSteerAngle: 0.55,    // rad, geometric limit at parking speeds
  maxLatAccel: 9.5,       // m/s^2 of cornering grip: caps steering at speed
  steerRate: 2.6,         // 1/s, how fast the wheel turns toward full lock
  steerReturnRate: 4.2,   // 1/s, self-centering is quicker
  gripRoad: 7.5,
  gripGrass: 2.0,
  gripHandbrake: 1.4,
  // --- drift ---
  driftMinSpeed: 9,       // m/s needed to break loose
  driftSlipEnter: 0.3,    // rad of slip that counts as "sliding" (~17°)
  driftSlipExit: 0.1,     // slide considered caught below this
  driftGrip: 2.1,         // lateral damping while drifting (rear stays loose)
  driftSteerBoost: 2.3,   // extra steering authority for rotation/countersteer
  driftMomentum: 0.5,     // share of scrubbed lateral speed fed back forward
  // --- nitro ---
  nitroAccel: 7.5,        // extra m/s^2 while boosting
  nitroSpeedCap: 64,      // m/s: boost cuts off at ~230 km/h
  nitroDrain: 34,         // %/s while held
  nitroRegenDrift: 14,    // %/s earned while drifting
  nitroRegenIdle: 1.1,    // slow trickle
  grassTraction: 0.45,    // wheels spin on grass: less usable power
  grassBaseDrag: 1.6,     // m/s^2 extra resistance on grass (ramps in below 3 m/s)
  grassSpeedDrag: 0.075,  // + this per m/s: fast on grass bleeds speed hard
  reverseFactor: 0.75,    // reverse thrust vs forward (strong enough to escape grass)
  carHalfWidth: 1.25,     // collision margin: half width incl. wheels
  wallHitSpeed: 3,        // m/s of approach that counts as an impact
  wallHitCooldown: 0.5,   // s between impact penalties (contact itself is free)
};

const RPM_PER_MS = 60 / (2 * Math.PI); // rad/s -> rpm

// Normalized torque: weak at idle, peak around 62% of the rev range.
function torqueCurve(rpm) {
  const x = (rpm - 1000) / (TUNING.redlineRpm - 1000);
  return Math.max(0.15, 1 - Math.pow((x - 0.62) / 0.62, 2) * 0.85);
}

export class Car {
  constructor(track) {
    this.track = track;
    this.group = new THREE.Group();
    this.wheels = [];
    this.frontWheels = [];

    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.steerAngle = 0;
    this.steerInput = 0;   // ramped wheel position, -1..1
    this.wheelRoll = 0;
    this.onGrass = false;
    this.spec = null;       // active roster entry (model, length, profile)
    this.wheelbase = TUNING.wheelbase;
    this._model = null;
    this._lastSettings = { power: 1, aero: 1, steer: 1, grip: 1 };
    this.applySettings(this._lastSettings);

    // drivetrain state
    this.gearIndex = 1;      // 1..6
    this.mode = 'D';         // 'D' | 'R'
    this.rpm = TUNING.idleRpm;
    this.shiftTimer = 0;     // >0 while the clutch is open
    this.pendingGear = 0;
    this.throttleSm = 0;     // smoothed engine demand
    this.lastImpact = 0;     // impact strength for camera shake / HUD
    this.wallCooldown = 0;   // no repeat impact penalty while touching the wall
    this.drifting = false;
    this.slipAngle = 0;      // signed angle between velocity and heading
    this.nitro = 50;         // 0..100, earned by drifting
    this.boosting = false;

    const start = track.startPose;
    this.group.position.copy(start.position);
    this.heading = start.heading;
    this.group.rotation.y = this.heading;
  }

  // Multipliers from the settings menu, composed with the car's own profile.
  applySettings(settings) {
    this._lastSettings = settings;
    const p = this.spec?.profile ?? { power: 1, aero: 1, steer: 1, grip: 1 };
    const power = (settings.power ?? 1) * p.power;
    const aero = (settings.aero ?? 1) * p.aero;
    const steer = (settings.steer ?? 1) * p.steer;
    const grip = (settings.grip ?? 1) * p.grip;
    this.cfg = {
      torqueAccel: TUNING.torqueAccel * power,
      drag: TUNING.drag / (aero * aero),
      steerRate: TUNING.steerRate * steer,
      steerReturnRate: TUNING.steerReturnRate * (0.7 + 0.3 * steer),
      maxSteerAngle: TUNING.maxSteerAngle * (0.75 + 0.25 * steer),
      maxLatAccel: TUNING.maxLatAccel * grip,
      gripRoad: TUNING.gripRoad * grip,
    };
  }

  // Swap the vehicle: physics profile + 3D model (disposable at runtime).
  async setModel(spec) {
    this.spec = spec;
    this.wheelbase = spec.length * 0.62;
    this.applySettings(this._lastSettings);
    if (this._model) {
      this.group.remove(this._model);
      this._model.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); }
      });
      this._model = null;
    }
    this.wheels.length = 0;
    this.frontWheels.length = 0;

    const gltf = await new GLTFLoader().loadAsync(spec.model);
    const model = gltf.scene;

    // Deepen the kit's pastel palette so the paint pops under filmic tonemapping.
    let paintMap = null;
    model.traverse((o) => {
      if (!paintMap && o.isMesh && o.material?.map?.image) {
        const img = o.material.map.image;
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.filter = 'saturate(1.65) brightness(0.92) contrast(1.08)';
        g.drawImage(img, 0, 0);
        paintMap = new THREE.CanvasTexture(c);
        paintMap.colorSpace = THREE.SRGBColorSpace;
        paintMap.flipY = false; // glTF texture convention
      }
    });

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = spec.length / Math.max(size.x, size.z);
    model.scale.setScalar(scale);
    box.setFromObject(model);
    model.position.y -= box.min.y;
    if (size.x > size.z) model.rotation.y = Math.PI / 2;

    model.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; }
      const n = o.name.toLowerCase();
      if (n.includes('wheel')) {
        o.rotation.order = 'YXZ';
        this.wheels.push(o);
        if (n.includes('front')) this.frontWheels.push(o);
        // matte rubber + dark metal
        if (o.material) {
          o.material = new THREE.MeshStandardMaterial({
            map: paintMap ?? o.material.map, roughness: 0.9, metalness: 0.1, envMapIntensity: 0.4,
          });
        }
      } else if (o.isMesh && o.material) {
        // glossy clear-coated car paint over the deepened color map
        o.material = new THREE.MeshPhysicalMaterial({
          map: paintMap ?? o.material.map,
          metalness: 0.1,
          roughness: 0.35,
          clearcoat: 0.7,
          clearcoatRoughness: 0.12,
          envMapIntensity: 0.45,
        });
      }
    });
    this.group.add(model);
    this._model = model;
  }

  get forward() {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  get speed() { return this.velocity.length(); }
  get forwardSpeed() { return this.velocity.dot(this.forward); }
  get speedKmh() { return Math.abs(this.forwardSpeed) * 3.6; }
  get gearLabel() {
    if (this.mode === 'R') return 'R';
    return String(this.shiftTimer > 0 ? this.pendingGear : this.gearIndex);
  }

  _totalRatio() {
    const ratio = this.mode === 'R' ? TUNING.reverseRatio : TUNING.gearRatios[this.gearIndex - 1];
    return ratio * TUNING.finalDrive;
  }

  update(dt, input, controlsActive) {
    const fwd = this.forward;
    const fSpeed = this.velocity.dot(fwd);
    const absSpeed = Math.abs(fSpeed);

    const throttle = controlsActive ? input.throttle : 0;
    const brake = controlsActive ? input.brake : 0;
    const steerInput = controlsActive ? input.steer : 0;
    const handbrake = controlsActive && input.handbrake;

    // --- D/R mode: S at a standstill engages reverse, W re-engages drive ---
    if (this.mode === 'D' && brake && fSpeed < 0.5 && !throttle) {
      this.mode = 'R';
      this.gearIndex = 1;
      this.shiftTimer = 0;
    } else if (this.mode === 'R' && throttle && fSpeed > -0.5) {
      this.mode = 'D';
      this.shiftTimer = 0;
    }

    // pedal mapping depends on mode: in R, "brake" key is the accelerator
    const accelPedal = this.mode === 'D' ? throttle : brake;
    const brakePedal = this.mode === 'D' ? brake : throttle;

    // --- engine rpm from wheel speed through the gearbox ---
    const total = this._totalRatio();
    this.rpm = Math.max(TUNING.idleRpm, (absSpeed / TUNING.wheelRadius) * total * RPM_PER_MS);
    this.rpm = Math.min(this.rpm, TUNING.redlineRpm);
    // clutch slip off the line keeps revs usable
    if (accelPedal && absSpeed < 6) this.rpm = Math.max(this.rpm, TUNING.launchRpm);

    // --- automatic gearbox with a real shift pause ---
    if (this.mode === 'D') {
      if (this.shiftTimer > 0) {
        this.shiftTimer -= dt;
        if (this.shiftTimer <= 0) this.gearIndex = this.pendingGear;
      } else if (this.rpm >= TUNING.shiftUpRpm && this.gearIndex < TUNING.gearRatios.length && accelPedal) {
        this.pendingGear = this.gearIndex + 1;
        this.shiftTimer = TUNING.shiftTime;
      } else if (this.rpm <= TUNING.shiftDownRpm && this.gearIndex > 1) {
        this.pendingGear = this.gearIndex - 1;
        this.shiftTimer = TUNING.shiftTime * 0.6;
      }
    }

    // --- engine force (smoothed throttle, cut while shifting) ---
    this.throttleSm += (accelPedal - this.throttleSm) * Math.min(1, TUNING.throttleResponse * dt);
    let engineAccel = 0;
    if (this.shiftTimer <= 0 && this.rpm < TUNING.redlineRpm - 20) {
      engineAccel = torqueCurve(this.rpm) * this.cfg.torqueAccel * total * this.throttleSm;
      if (this.onGrass) engineAccel *= TUNING.grassTraction;
    }

    let accel = 0;
    if (this.mode === 'D') {
      accel += engineAccel;
      if (brakePedal && fSpeed > 0.05) accel -= TUNING.brakeForce * brakePedal;
    } else {
      if (fSpeed > -TUNING.maxReverse) accel -= engineAccel * TUNING.reverseFactor;
      if (brakePedal && fSpeed < -0.05) accel += TUNING.brakeForce * brakePedal;
    }
    if (handbrake && absSpeed > 0.4) accel -= Math.sign(fSpeed) * TUNING.brakeForce * 0.5;

    // --- nitro: flat extra thrust while held, earned back by drifting ---
    const wantBoost = controlsActive && input.nitro;
    this.boosting = wantBoost && this.nitro > 0 && this.mode === 'D' && fSpeed > 1
      && fSpeed < TUNING.nitroSpeedCap;
    if (this.boosting) {
      accel += TUNING.nitroAccel * (this.onGrass ? TUNING.grassTraction : 1);
      this.nitro = Math.max(0, this.nitro - TUNING.nitroDrain * dt);
    } else {
      const regen = this.drifting ? TUNING.nitroRegenDrift : TUNING.nitroRegenIdle;
      this.nitro = Math.min(100, this.nitro + regen * dt);
    }

    this.velocity.addScaledVector(fwd, accel * dt);

    // --- rolling / aero / surface resistance ---
    const v = this.speed;
    if (v > 0.001) {
      let resist = TUNING.rollingResistance + this.cfg.drag * v * v;
      // grass drag ramps in with speed so it never pins a car that's
      // trying to pull away from a standstill
      if (this.onGrass) resist += (TUNING.grassBaseDrag + TUNING.grassSpeedDrag * v) * Math.min(1, v / 3);
      const drop = Math.min(v, resist * dt);
      this.velocity.multiplyScalar((v - drop) / v);
    }

    // --- steering ---
    // The "wheel" ramps toward the player's input instead of snapping, and the
    // reachable angle shrinks with speed so cornering is capped by tyre grip
    // (lat accel = v^2 * tan(steer) / wheelbase <= maxLatAccel), like a real car.
    const rate = steerInput !== 0 && Math.sign(steerInput) !== -Math.sign(this.steerInput)
      ? this.cfg.steerRate : this.cfg.steerReturnRate;
    const dSteer = steerInput - this.steerInput;
    this.steerInput += Math.sign(dSteer) * Math.min(Math.abs(dSteer), rate * dt);

    const vv = Math.max(absSpeed, 0.5);
    // in a drift the front wheels aren't the limit: extra authority to rotate
    // the car and to countersteer out of the slide
    const latLimit = this.cfg.maxLatAccel * (this.drifting ? TUNING.driftSteerBoost : 1);
    const gripLimit = Math.atan(this.wheelbase * latLimit / (vv * vv));
    const steerMax = Math.min(this.cfg.maxSteerAngle, gripLimit);
    this.steerAngle = this.steerInput * steerMax;
    if (absSpeed > 0.1) {
      this.heading += (fSpeed / this.wheelbase) * Math.tan(this.steerAngle) * dt;
    }

    // --- slip + drift state ---
    const newFwd = this.forward;
    const fComp = this.velocity.dot(newFwd);
    const latSigned = this.velocity.dot(new THREE.Vector3(-newFwd.z, 0, newFwd.x));
    this.slipAngle = Math.atan2(latSigned, Math.abs(fComp) + 0.001);
    if (!this.drifting) {
      const kicked = handbrake && Math.abs(this.steerInput) > 0.25; // handbrake flick
      const slid = Math.abs(this.slipAngle) > TUNING.driftSlipEnter; // natural breakaway
      if (absSpeed > TUNING.driftMinSpeed && (kicked || slid)) this.drifting = true;
    } else if (Math.abs(this.slipAngle) < TUNING.driftSlipExit || absSpeed < TUNING.driftMinSpeed * 0.6) {
      this.drifting = false;
    }

    // --- lateral grip ---
    const lat = this.velocity.clone().addScaledVector(newFwd, -fComp);
    let grip = this.onGrass ? TUNING.gripGrass : this.cfg.gripRoad;
    if (this.drifting) grip = Math.min(grip, TUNING.driftGrip);
    if (handbrake) grip = Math.min(grip, TUNING.gripHandbrake);
    const damp = Math.max(0, 1 - grip * dt);
    // arcade drift momentum: the tyres convert part of the scrubbed sideways
    // motion into forward drive instead of burning it all off
    let fKeep = fComp;
    if (this.drifting && !this.onGrass) {
      const scrubbed = lat.length() * (1 - damp);
      const align = Math.max(0, Math.cos(this.slipAngle)); // no push when sideways
      fKeep += Math.sign(fComp || 1) * scrubbed * TUNING.driftMomentum * align;
    }
    lat.multiplyScalar(damp);
    this.velocity.copy(lat).addScaledVector(newFwd, fKeep);

    // --- integrate ---
    this.group.position.addScaledVector(this.velocity, dt);
    this.group.rotation.y = this.heading;

    // --- surface + wall collision ---
    const info = this.track.distanceToCenterline(this.group.position);
    this.onGrass = info.dist > ROAD_HALF_WIDTH + 0.9;
    const wallDist = BOUNDARY - TUNING.carHalfWidth;
    this.lastImpact = Math.max(0, this.lastImpact - dt * 4);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    if (info.dist > wallDist) {
      const away = this.group.position.clone().sub(info.sample.pos).setY(0).normalize();
      this.group.position.addScaledVector(away, wallDist - info.dist);
      const outSpeed = this.velocity.dot(away);
      if (outSpeed > 0) {
        // sustained contact only strips the into-wall component: the car
        // slides along the barrier and can always drive or reverse away
        this.velocity.addScaledVector(away, -outSpeed);
        // a real impact costs speed once, not every frame of contact
        if (outSpeed > TUNING.wallHitSpeed && this.wallCooldown <= 0) {
          const hitRatio = outSpeed / Math.max(this.speed + outSpeed, 0.01); // 1 = head-on
          this.velocity.multiplyScalar(Math.max(0.35, 1 - 0.15 - hitRatio * 0.45));
          this.velocity.addScaledVector(away, -outSpeed * 0.2); // small rebound
          this.lastImpact = Math.min(1, outSpeed / 15);
          this.wallCooldown = TUNING.wallHitCooldown;
        }
      }
    }
    this.trackInfo = info;

    // --- wheel + body animation ---
    this.wheelRoll += (fSpeed / TUNING.wheelRadius) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelRoll;
    // front wheels show the wheel position, not the grip-limited angle
    for (const w of this.frontWheels) w.rotation.y = this.steerInput * 0.4;

    const latSpeed = this.velocity.dot(new THREE.Vector3(-newFwd.z, 0, newFwd.x));
    this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, latSpeed * 0.012, 0.15);
    // pitch: squat under power, dive under braking
    this.group.rotation.x = THREE.MathUtils.lerp(this.group.rotation.x, -accel * 0.0045, 0.12);
  }

  resetToTrack() {
    const info = this.track.distanceToCenterline(this.group.position);
    this.group.position.copy(info.sample.pos).setY(0);
    this.heading = Math.atan2(info.sample.tangent.x, info.sample.tangent.z);
    this._settle();
  }

  resetToStart() {
    const start = this.track.startPose;
    this.group.position.copy(start.position);
    this.heading = start.heading;
    this._settle();
  }

  _settle() {
    this.group.rotation.set(0, this.heading, 0);
    this.velocity.set(0, 0, 0);
    this.steerAngle = 0;
    this.steerInput = 0;
    this.gearIndex = 1;
    this.mode = 'D';
    this.shiftTimer = 0;
    this.throttleSm = 0;
    this.rpm = TUNING.idleRpm;
    this.drifting = false;
    this.slipAngle = 0;
    this.nitro = 50;
    this.boosting = false;
  }
}
