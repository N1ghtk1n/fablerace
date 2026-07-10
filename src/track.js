import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { asset } from './asset.js';

export const ROAD_HALF_WIDTH = 7;            // asphalt half-width, m
export const CURB_WIDTH = 1.3;                // red/white curb strip
export const BOUNDARY = ROAD_HALF_WIDTH + 9;  // wall distance from centerline
const WALL_HEIGHT = 1.1;
const SAMPLES = 700;

// Control points of the circuit (x, z), smoothed by a closed Catmull-Rom.
const LAYOUT_SCALE = 2.4;
const CONTROL_POINTS = [
  [0, 0], [34, -6], [58, 2], [72, 24], [64, 46], [42, 50],
  [34, 68], [44, 88], [30, 104], [4, 100], [-12, 82], [-8, 60],
  [-24, 46], [-46, 52], [-62, 38], [-58, 14], [-38, 2], [-18, -4],
];

function makeCurve() {
  const pts = CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x * LAYOUT_SCALE, 0, z * LAYOUT_SCALE));
  return new THREE.CatmullRomCurve3(pts, true, 'centripetal');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// Real asphalt photo (ambientCG, CC0) with painted road markings on top.
// One texture tile spans the full 14 m road width.
function roadTexture(asphaltImg) {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.drawImage(asphaltImg, 0, 0, 1024, 1024);
  g.fillStyle = 'rgba(10, 10, 14, 0.42)'; // race-track dark tint
  g.fillRect(0, 0, 1024, 1024);
  // solid edge lines (~0.25 m at 1024px / 14 m)
  g.fillStyle = 'rgba(232, 232, 235, 0.92)';
  g.fillRect(26, 0, 18, 1024);
  g.fillRect(1024 - 44, 0, 18, 1024);
  // dashed center line: two 3 m dashes per 14 m tile
  g.fillStyle = 'rgba(225, 225, 230, 0.6)';
  g.fillRect(506, 40, 12, 220);
  g.fillRect(506, 552, 12, 220);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function curbTexture() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#d43c3c'; g.fillRect(0, 0, 8, 32);
  g.fillStyle = '#eeeeee'; g.fillRect(0, 32, 8, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function wallTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#e8e8ea'; g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#d03535'; g.fillRect(0, 0, 64, 32);
  // seam shading between segments
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, 0, 3, 32); g.fillRect(64, 0, 3, 32);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 0, 128, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const g = c.getContext('2d');
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Flat ribbon following the curve between lateral offsets [a, b].
function ribbonGeometry(samples, a, b, y, vScale) {
  const n = samples.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const s = samples[i % n];
    const px = s.pos.x, pz = s.pos.z;
    const nx = s.normal.x, nz = s.normal.z;
    pos.set([px + nx * a, y, pz + nz * a, px + nx * b, y, pz + nz * b], i * 6);
    const v = (i / n) * vScale;
    uv.set([0, v, 1, v], i * 4);
    if (i < n) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Vertical ribbon (a wall) at a fixed lateral offset from the centerline.
function wallGeometry(samples, offset, height, uScale) {
  const n = samples.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const s = samples[i % n];
    const x = s.pos.x + s.normal.x * offset;
    const z = s.pos.z + s.normal.z * offset;
    pos.set([x, 0, z, x, height, z], i * 6);
    const u = (i / n) * uScale;
    uv.set([u, 0, u, 1], i * 4);
    if (i < n) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export class Track {
  constructor() {
    this.curve = makeCurve();
    this.samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / SAMPLES;
      const pos = this.curve.getPointAt(t);
      const tangent = this.curve.getTangentAt(t).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x); // points left
      this.samples.push({ pos, tangent, normal });
    }
    this.group = new THREE.Group();
  }

  // Loads photo textures (ambientCG, CC0) and builds all meshes.
  async load() {
    const loader = new THREE.TextureLoader();
    const [asphaltImg, asphaltNormal, grassColor, grassNormal] = await Promise.all([
      loadImage(asset('textures/asphalt_color.jpg')),
      loader.loadAsync(asset('textures/asphalt_normal.jpg')),
      loader.loadAsync(asset('textures/grass_color.jpg')),
      loader.loadAsync(asset('textures/grass_normal.jpg')),
    ]);

    const trackLen = this.curve.getLength();

    // road: one texture tile per 14 m of length (square tiles)
    asphaltNormal.wrapS = asphaltNormal.wrapT = THREE.RepeatWrapping;
    const road = new THREE.Mesh(
      ribbonGeometry(this.samples, ROAD_HALF_WIDTH, -ROAD_HALF_WIDTH, 0.02, trackLen / 14),
      new THREE.MeshStandardMaterial({
        map: roadTexture(asphaltImg),
        normalMap: asphaltNormal,
        normalScale: new THREE.Vector2(0.6, 0.6),
        roughness: 0.96,
      })
    );
    road.receiveShadow = true;
    this.group.add(road);

    // curbs
    const curbMat = new THREE.MeshStandardMaterial({ map: curbTexture(), roughness: 0.8 });
    curbMat.map.repeat.set(1, trackLen / 4);
    for (const side of [1, -1]) {
      const curb = new THREE.Mesh(
        ribbonGeometry(this.samples, side * ROAD_HALF_WIDTH, side * (ROAD_HALF_WIDTH + CURB_WIDTH), 0.03, trackLen / 4),
        curbMat
      );
      curb.receiveShadow = true;
      this.group.add(curb);
    }

    // barrier walls on both sides — the physical edge of the world
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTexture(),
      roughness: 0.7,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      const wall = new THREE.Mesh(
        wallGeometry(this.samples, side * BOUNDARY, WALL_HEIGHT, trackLen / 8),
        wallMat
      );
      wall.castShadow = wall.receiveShadow = true;
      this.group.add(wall);
    }

    // grass ground (photo texture)
    grassColor.wrapS = grassColor.wrapT = THREE.RepeatWrapping;
    grassNormal.wrapS = grassNormal.wrapT = THREE.RepeatWrapping;
    grassColor.repeat.set(170, 170);
    grassNormal.repeat.set(170, 170);
    grassColor.anisotropy = 4;
    grassColor.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.MeshStandardMaterial({ map: grassColor, normalMap: grassNormal, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);

    this._addStartLine();
    this._addTrees();
    this._addHills();
    this._addBillboards();
    await this._addCones().catch(() => {});
  }

  _addStartLine() {
    const s0 = this.samples[0];
    // one group yawed to the track direction: local X runs across the road
    const gate = new THREE.Group();
    gate.position.copy(s0.pos);
    gate.rotation.y = Math.atan2(s0.tangent.x, s0.tangent.z);

    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, 3),
      new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.9 })
    );
    strip.rotation.x = -Math.PI / 2;
    strip.position.y = 0.035;
    gate.add(strip);

    const pillarGeo = new THREE.CylinderGeometry(0.25, 0.25, 7, 10);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 });
    for (const side of [1, -1]) {
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set(side * (ROAD_HALF_WIDTH + 1.2), 3.5, 0);
      p.castShadow = true;
      gate.add(p);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_HALF_WIDTH * 2 + 3, 1.2, 0.4),
      new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.8 })
    );
    beam.position.set(0, 6.6, 0);
    beam.castShadow = true;
    gate.add(beam);

    this.group.add(gate);
  }

  _addTrees() {
    const rng = mulberry32(42);
    const spots = [];
    let guard = 0;
    while (spots.length < 190 && guard++ < 6000) {
      const x = (rng() - 0.5) * 520;
      const z = (rng() - 0.35) * 520;
      const p = new THREE.Vector3(x, 0, z);
      const d = this.distanceToCenterline(p).dist;
      if (d > BOUNDARY + 6 && d < 140) spots.push(p);
    }
    const pines = spots.filter((_, i) => i % 3 !== 2);
    const leafy = spots.filter((_, i) => i % 3 === 2);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }); // tinted per-instance
    const m = new THREE.Matrix4();
    const tint = new THREE.Color();

    const plant = (list, crownGeo, crownYFactor, hueBase) => {
      const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.38, 2, 6), trunkMat, list.length);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMat.clone(), list.length);
      list.forEach((p, i) => {
        const scale = 0.75 + rng() * 1.0;
        m.makeScale(scale, scale, scale).setPosition(p.x, scale, p.z);
        trunks.setMatrixAt(i, m);
        m.makeScale(scale, scale * (0.9 + rng() * 0.3), scale).setPosition(p.x, scale * crownYFactor, p.z);
        crowns.setMatrixAt(i, m);
        // natural green variation
        tint.setHSL(hueBase + (rng() - 0.5) * 0.05, 0.5 + rng() * 0.25, 0.28 + rng() * 0.14);
        crowns.setColorAt(i, tint);
      });
      trunks.castShadow = crowns.castShadow = true;
      crowns.receiveShadow = true;
      this.group.add(trunks, crowns);
    };
    plant(pines, new THREE.ConeGeometry(2.2, 5.8, 7), 4.4, 0.35);
    plant(leafy, new THREE.IcosahedronGeometry(2.6, 1), 4.6, 0.28);
  }

  // Distant hill ring: gives the horizon depth through the haze.
  _addHills() {
    const rng = mulberry32(7);
    const mat = new THREE.MeshStandardMaterial({ color: 0x7290a8, roughness: 1, fog: true });
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2 + rng() * 0.3;
      const dist = 480 + rng() * 120;
      const h = 40 + rng() * 55;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(90 + rng() * 80, h, 5, 1), mat);
      hill.position.set(Math.cos(ang) * dist, h / 2 - 6, Math.sin(ang) * dist + 120);
      hill.rotation.y = rng() * Math.PI;
      this.group.add(hill);
    }
  }

  // Sponsor boards along the straights.
  _addBillboards() {
    const texts = ['FableRace', 'GP · 2026', 'FABLE MOTORS', 'RACE DAY'];
    const colors = ['#7dd3fc', '#f4a259', '#b57bff', '#4ade80'];
    const legGeo = new THREE.BoxGeometry(0.3, 3, 0.3);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x444a52, roughness: 0.6, metalness: 0.6 });
    let placed = 0;
    for (let i = 40; i < SAMPLES - 20 && placed < 4; i += 8) {
      const a = this.samples[i];
      const b = this.samples[(i + 16) % SAMPLES];
      if (a.tangent.angleTo(b.tangent) > 0.06) continue; // straights only
      const c = document.createElement('canvas');
      c.width = 512; c.height = 160;
      const g = c.getContext('2d');
      g.fillStyle = '#12161d'; g.fillRect(0, 0, 512, 160);
      g.strokeStyle = colors[placed]; g.lineWidth = 10; g.strokeRect(8, 8, 496, 144);
      g.fillStyle = colors[placed];
      g.font = '800 64px "Avenir Next", system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(texts[placed], 256, 84);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;

      const board = new THREE.Group();
      const side = placed % 2 === 0 ? 1 : -1;
      const pos = a.pos.clone().addScaledVector(a.normal, side * (BOUNDARY + 3.5));
      const face = new THREE.Mesh(
        new THREE.BoxGeometry(11, 3.4, 0.25),
        [legMat, legMat, legMat, legMat,
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }),
          legMat]
      );
      face.position.y = 4.4;
      face.castShadow = true;
      for (const lx of [-4.5, 4.5]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, 1.5, 0);
        leg.castShadow = true;
        board.add(leg);
      }
      board.add(face);
      board.position.copy(pos);
      board.rotation.y = Math.atan2(-side * a.normal.x, -side * a.normal.z);
      this.group.add(board);
      placed++;
      i += 120; // spread the boards around the lap
    }
  }

  // Knockable cones on the outside of corners (CC0 Kenney kit).
  async _addCones() {
    const gltf = await new GLTFLoader().loadAsync(asset('models/cone.glb'));
    const cone = gltf.scene;
    cone.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.cones = [];
    for (let i = 0; i < SAMPLES; i += 6) {
      const a = this.samples[i];
      const b = this.samples[(i + 12) % SAMPLES];
      const turn = a.tangent.angleTo(b.tangent);
      if (turn > 0.22) {
        const side = Math.sign(a.normal.dot(new THREE.Vector3().subVectors(b.tangent, a.tangent))) || 1;
        const c = cone.clone();
        c.position.copy(a.pos).addScaledVector(a.normal, -side * (ROAD_HALF_WIDTH + CURB_WIDTH + 0.7));
        c.scale.setScalar(1.6);
        this.group.add(c);
        this.cones.push({
          obj: c,
          home: c.position.clone(),
          vel: new THREE.Vector3(),
          angVel: new THREE.Vector3(),
          state: 'idle', // idle | flying | down
        });
      }
    }
  }

  // Cheap cone physics: launched by any car, tumbles, bounces, stays down.
  updateCones(dt, cars) {
    if (!this.cones) return;
    const HIT_R = 1.4; // car body + cone base
    for (const cone of this.cones) {
      const o = cone.obj;
      if (cone.state !== 'flying') {
        for (const c of cars) {
          const carPos = c.group.position, carVel = c.velocity;
          const dx = o.position.x - carPos.x, dz = o.position.z - carPos.z;
          if (dx * dx + dz * dz < HIT_R * HIT_R && carVel.lengthSq() > 2) {
            const away = new THREE.Vector3(dx, 0, dz).normalize();
            cone.vel.copy(carVel).multiplyScalar(0.8).addScaledVector(away, 2.5);
            cone.vel.y = 3 + Math.min(carVel.length() * 0.18, 5.5);
            cone.angVel.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14);
            cone.state = 'flying';
            break;
          }
        }
      }
      if (cone.state === 'flying') {
        cone.vel.y -= 22 * dt; // slightly gamey gravity reads better than 9.8
        o.position.addScaledVector(cone.vel, dt);
        o.rotation.x += cone.angVel.x * dt;
        o.rotation.y += cone.angVel.y * dt;
        o.rotation.z += cone.angVel.z * dt;
        if (o.position.y <= 0 && cone.vel.y < 0) {
          o.position.y = 0;
          if (Math.abs(cone.vel.y) > 2) {
            cone.vel.y *= -0.35; // bounce
            cone.vel.x *= 0.55;
            cone.vel.z *= 0.55;
            cone.angVel.multiplyScalar(0.55);
          } else {
            cone.state = 'down'; // rests where it fell, can be hit again
            cone.vel.set(0, 0, 0);
          }
        }
      }
    }
  }

  resetCones() {
    for (const cone of this.cones ?? []) {
      cone.obj.position.copy(cone.home);
      cone.obj.rotation.set(0, 0, 0);
      cone.vel.set(0, 0, 0);
      cone.state = 'idle';
    }
  }

  distanceToCenterline(p) {
    let best = Infinity, bestIdx = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const s = this.samples[i].pos;
      const dx = s.x - p.x, dz = s.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bestIdx = i; }
    }
    return { dist: Math.sqrt(best), index: bestIdx, sample: this.samples[bestIdx], progress: bestIdx / SAMPLES };
  }

  get startPose() {
    const s = this.samples[SAMPLES - 8]; // slightly before the line
    return { position: s.pos.clone().setY(0), heading: Math.atan2(s.tangent.x, s.tangent.z) };
  }
}

// Deterministic PRNG so the scenery is stable between runs.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
