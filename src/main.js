import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  EffectComposer, RenderPass, EffectPass,
  BloomEffect, VignetteEffect, HueSaturationEffect, BrightnessContrastEffect,
} from 'postprocessing';
import { Track } from './track.js';
import { Car } from './car.js';
import { Input } from './input.js';
import { LapTimer } from './timing.js';
import { HUD } from './hud.js';
import { Settings } from './settings.js';
import { CARS, carStats } from './cars.js';
import { EngineAudio } from './audio.js';
import { Ghost } from './ghost.js';
import { BOTS, Bot, resolveCarCollisions } from './ai.js';
import { SmokePool } from './smoke.js';

const app = document.getElementById('app');

// --- renderer / scene ---
const renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false, depth: false, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// warm late-afternoon haze
scene.fog = new THREE.Fog(0xc8d8e8, 240, 700);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);

// --- atmospheric sky + image-based lighting ---
const SUN_ELEVATION = 16;  // degrees above horizon: long soft shadows
const SUN_AZIMUTH = 145;
const sky = new Sky();
sky.scale.setScalar(2000);
const sunDir = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - SUN_ELEVATION),
  THREE.MathUtils.degToRad(SUN_AZIMUTH)
);
Object.assign(sky.material.uniforms.turbidity, { value: 5 });
Object.assign(sky.material.uniforms.rayleigh, { value: 2.4 });
Object.assign(sky.material.uniforms.mieCoefficient, { value: 0.003 });
Object.assign(sky.material.uniforms.mieDirectionalG, { value: 0.8 });
sky.material.uniforms.sunPosition.value.copy(sunDir);
scene.add(sky);

// bake the sky into an environment map: realistic ambient + reflections
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(2000);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'sunPosition']) {
    const u = envSky.material.uniforms[k], s = sky.material.uniforms[k];
    u.value = s.value.clone ? s.value.clone() : s.value;
  }
  envScene.add(envSky);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

// --- lights ---
scene.add(new THREE.HemisphereLight(0xbfd4ee, 0x53683d, 0.35));
const sun = new THREE.DirectionalLight(0xffdfb0, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(3072, 3072);
sun.shadow.camera.left = sun.shadow.camera.bottom = -75;
sun.shadow.camera.right = sun.shadow.camera.top = 75;
sun.shadow.camera.far = 500;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const sunOffset = sunDir.clone().multiplyScalar(160);

// --- cinematic post-processing ---
const composer = new EffectComposer(renderer, { multisampling: 4 });
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new EffectPass(
  camera,
  new BloomEffect({ luminanceThreshold: 0.85, luminanceSmoothing: 0.2, intensity: 0.4, mipmapBlur: true }),
  new HueSaturationEffect({ saturation: 0.12 }),
  new BrightnessContrastEffect({ contrast: 0.07 }),
  new VignetteEffect({ darkness: 0.42, offset: 0.28 })
));

// --- world ---
const track = new Track();
scene.add(track.group);

const car = new Car(track);
scene.add(car.group);

const input = new Input();
const timer = new LapTimer();
const hud = new HUD(track);
const ghost = new Ghost(scene);

// --- rivals ---
const RACE_LAPS = 3;
const bots = BOTS.map((def) => new Bot(track, def));
for (const b of bots) scene.add(b.car.group);
let raceMode = 'practice'; // 'practice' | 'race'
let playerLaps = 0;
let playerPrevProg = null;
const finishOrder = []; // racer refs in the order they finish

const settings = new Settings();
settings.onChange = (v) => car.applySettings(v);
car.applySettings(settings.values);

// sound is off by default; M turns it on and the choice is remembered
const SOUND_KEY = 'fablerace.sound';
const audio = new EngineAudio();
audio.setMuted(localStorage.getItem(SOUND_KEY) !== 'on');
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
    audio.setMuted(audio.enabled);
    localStorage.setItem(SOUND_KEY, audio.enabled ? 'on' : 'off');
    hud.toast(audio.enabled ? '🔊 Звук включён' : '🔇 Звук выключен');
  }
});

const smoke = new SmokePool(scene);
let driftScore = 0;
let wasDrifting = false;

// --- game state machine: menu -> countdown -> racing ---
let state = 'loading';
let countdownEnd = 0;

hud.showMessage('<span style="font-size:40px">Загрузка…</span>');

// --- car roster / selection ---
const CAR_KEY = 'fablerace.car';
const storedCarId = localStorage.getItem(CAR_KEY) ?? 'sedan-sports'; // default ride
let carIndex = Math.max(0, CARS.findIndex((c) => c.id === storedCarId));

function renderCarCard() {
  const spec = CARS[carIndex];
  document.getElementById('car-name').textContent = spec.name;
  document.getElementById('car-blurb').textContent = spec.blurb;
  const statsBox = document.getElementById('car-stats');
  statsBox.innerHTML = '';
  for (const [label, v] of Object.entries(carStats(spec))) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `<span class="stat-label">${label}</span>
      <span class="stat-bar"><span class="stat-fill" style="width:${Math.round(v * 100)}%"></span></span>`;
    statsBox.append(row);
  }
}

let carLoading = Promise.resolve();
function selectCar(delta) {
  carIndex = (carIndex + delta + CARS.length) % CARS.length;
  localStorage.setItem(CAR_KEY, CARS[carIndex].id);
  renderCarCard();
  // queue swaps so a fast clicker can't interleave two loads
  carLoading = carLoading.then(() => car.setModel(CARS[carIndex]));
}
document.getElementById('car-prev').addEventListener('click', () => selectCar(-1));
document.getElementById('car-next').addEventListener('click', () => selectCar(1));
renderCarCard();

Promise.all([car.setModel(CARS[carIndex]), track.load(), ...bots.map((b) => b.load())]).then(() => {
  hud.hideMessage();
  goToMenu();
});

const resultsEl = document.getElementById('results');

function goToMenu() {
  state = 'menu';
  car.resetToStart();
  timer.reset();
  ghost.clear(); // best lap died with the timer reset
  track.resetCones();
  for (const b of bots) b.hide();
  resultsEl.classList.add('hidden');
  hud.hideMessage();
  hud.showMenu(true);
}

function startRace(mode) {
  raceMode = mode ?? raceMode;
  audio.init(); // needs a user gesture; the start click is one
  audio.ctx?.resume();
  hud.showMenu(false);
  resultsEl.classList.add('hidden');
  car.resetToStart();
  timer.reset();
  ghost.clear();
  track.resetCones();
  playerLaps = 0;
  playerPrevProg = null;
  finishOrder.length = 0;

  if (raceMode === 'race') {
    // staggered grid behind the player, alternating sides wide enough to
    // clear his slot on the launch
    const N = track.samples.length;
    bots.forEach((b, i) => {
      b.placeOnGrid((N - 8 - (i + 1) * 12) % N, i % 2 === 0 ? -4.2 : 4.2);
      b.active = false;
    });
  } else {
    for (const b of bots) b.hide();
  }

  state = 'countdown';
  countdownEnd = performance.now() + 3000;
}

document.getElementById('btn-start').addEventListener('click', () => {
  if (state === 'menu') carLoading.then(() => startRace('practice'));
});
document.getElementById('btn-race').addEventListener('click', () => {
  if (state === 'menu') carLoading.then(() => startRace('race'));
});

// menu <-> settings views
const menuMain = document.getElementById('menu-main');
const menuSettings = document.getElementById('menu-settings');
document.getElementById('btn-settings').addEventListener('click', () => {
  menuMain.classList.add('hidden');
  menuSettings.classList.remove('hidden');
});
document.getElementById('btn-back').addEventListener('click', () => {
  menuSettings.classList.add('hidden');
  menuMain.classList.remove('hidden');
});

input.onReset = () => {
  if (state === 'racing') car.resetToTrack();
};

input.onRestart = () => {
  if (state === 'racing' || state === 'countdown' || state === 'finished') startRace();
};

input.onEscape = () => {
  if (state === 'racing' || state === 'countdown' || state === 'finished') goToMenu();
};

timer.onLap = (lapMs, bestMs) => {
  hud.flashLap(lapMs, lapMs === bestMs);
  if (raceMode === 'practice') {
    ghost.onLapDone(lapMs === bestMs, CARS[carIndex]);
  } else if (timer.lapNumber > RACE_LAPS && state === 'racing') {
    finishRace();
  }
};

// --- race ranking / finish ---
const playerRacer = { name: 'Ты', isPlayer: true };

function standings() {
  const racers = [
    { ...playerRacer, total: playerLaps + (playerPrevProg ?? 0), ref: playerRacer },
    ...bots.map((b) => ({ name: `${b.def.name} · ${b.def.title}`, total: b.totalProgress, ref: b })),
  ];
  const done = finishOrder.map((ref) => racers.find((r) => r.ref === ref)).filter(Boolean);
  const rest = racers.filter((r) => !finishOrder.includes(r.ref)).sort((a, b) => b.total - a.total);
  return [...done, ...rest];
}

function playerPosition() {
  return standings().findIndex((r) => r.ref === playerRacer) + 1;
}

function finishRace() {
  if (!finishOrder.includes(playerRacer)) finishOrder.push(playerRacer);
  state = 'finished';
  const list = document.getElementById('results-list');
  list.innerHTML = '';
  standings().forEach((r, i) => {
    const li = document.createElement('li');
    if (r.ref === playerRacer) li.className = 'you';
    const gap = r.ref === playerRacer || finishOrder.includes(r.ref)
      ? '' : `−${Math.max(0, (playerLaps + (playerPrevProg ?? 0)) - r.total).toFixed(2)} круга`;
    li.innerHTML = `<span>${i + 1}. ${r.name}</span><span class="res-time">${gap}</span>`;
    list.append(li);
  });
  document.querySelector('#results h2').textContent =
    playerPosition() === 1 ? '🏆 Победа!' : `Финиш: P${playerPosition()}`;
  resultsEl.classList.remove('hidden');
}

// --- cameras ---
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camInit = false;

function updateChaseCamera(dt) {
  const fwd = car.forward;
  const desired = car.group.position.clone()
    .addScaledVector(fwd, -9)
    .add(new THREE.Vector3(0, 3.6, 0));
  const look = car.group.position.clone()
    .addScaledVector(fwd, 5)
    .add(new THREE.Vector3(0, 1.1, 0));

  if (!camInit) {
    camPos.copy(desired);
    camLook.copy(look);
    camInit = true;
  }
  const k = 1 - Math.exp(-dt * 5.5);
  camPos.lerp(desired, k);
  camLook.lerp(look, 1 - Math.exp(-dt * 9));

  // impact shake
  if (car.lastImpact > 0.05) {
    const s = car.lastImpact * 0.4;
    camPos.x += (Math.random() - 0.5) * s;
    camPos.y += (Math.random() - 0.5) * s * 0.5;
    camPos.z += (Math.random() - 0.5) * s;
  }

  camera.position.copy(camPos);
  camera.lookAt(camLook);

  const targetFov = 62 + Math.min(car.speedKmh, 190) * 0.075 + (car.boosting ? 9 : 0);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
  camera.updateProjectionMatrix();
}

function updateMenuCamera(now) {
  // slow orbit around the start line while in the menu
  const t = now * 0.00012;
  const c = car.group.position;
  camera.position.set(c.x + Math.sin(t) * 22, 7, c.z + Math.cos(t) * 22);
  camera.lookAt(c.x, 1, c.z);
  camera.fov = 55;
  camera.updateProjectionMatrix();
  camInit = false; // chase cam re-seeds cleanly after the menu
}

// --- main loop with fixed physics timestep ---
const PHYS_DT = 1 / 120;
let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (state === 'countdown') {
    const left = countdownEnd - now;
    if (left <= 0) {
      state = 'racing';
      timer.start(now, car.trackInfo ? car.trackInfo.progress : 0);
      if (raceMode === 'race') for (const b of bots) b.active = true;
      hud.showMessage('<span style="color:#4ade80">GO!</span>');
      setTimeout(() => hud.hideMessage(), 900);
    } else {
      hud.showMessage(String(Math.ceil(left / 1000)));
    }
  }

  const controlsActive = state === 'racing';
  const botsRunning = raceMode === 'race' && (state === 'racing' || state === 'countdown' || state === 'finished');
  accumulator += dt;
  let steps = 0;
  while (accumulator >= PHYS_DT && steps < 10) {
    car.update(PHYS_DT, input, controlsActive);
    if (botsRunning) {
      for (const b of bots) b.update(PHYS_DT);
      resolveCarCollisions([car, ...bots.map((b) => b.car)]);
    }
    accumulator -= PHYS_DT;
    steps++;
  }

  if (state === 'racing' && car.trackInfo) timer.update(car.trackInfo.progress);

  // player race distance + bot finishes
  if (botsRunning && car.trackInfo) {
    const p = car.trackInfo.progress;
    if (playerPrevProg !== null) {
      if (playerPrevProg > 0.85 && p < 0.15) playerLaps++;
      else if (playerPrevProg < 0.15 && p > 0.85) playerLaps--;
    } else {
      playerLaps = p < 0.5 ? 0 : -1;
    }
    playerPrevProg = p;
    for (const b of bots) {
      if (b.finishTime === null && b.laps >= RACE_LAPS) {
        b.finishTime = now;
        finishOrder.push(b);
      }
    }
  }

  if (raceMode === 'practice' && state === 'racing' && timer.running) {
    ghost.record(timer.currentLapMs, car);
    ghost.update(timer.currentLapMs, true);
  } else {
    ghost.update(0, false);
  }
  const activeCars = botsRunning ? [car, ...bots.map((b) => b.car)] : [car];
  track.updateCones(dt, activeCars);
  audio.update(car, state === 'racing' || state === 'countdown' || state === 'finished');

  // --- drift smoke + nitro flames ---
  for (const c of activeCars) {
    const fwd = c.forward;
    const left = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (c.drifting && !c.onGrass && c.speed > 6) {
      for (const side of [1, -1]) {
        const pos = c.group.position.clone()
          .addScaledVector(fwd, -1.1)
          .addScaledVector(left, side * 0.75);
        pos.y = 0.25;
        smoke.spawn(pos, c.velocity.clone().multiplyScalar(0.12));
      }
    }
    if (c.boosting) {
      const pos = c.group.position.clone().addScaledVector(fwd, -1.6);
      pos.y = 0.35;
      smoke.spawn(pos, c.velocity.clone().multiplyScalar(0.25).addScaledVector(fwd, -4), 0.4, 0x66c8ff);
    }
  }
  smoke.update(dt);

  if (state === 'racing' && car.drifting) {
    if (!wasDrifting) driftScore = 0;
    driftScore += dt * car.speedKmh * (0.3 + Math.abs(car.slipAngle));
    hud.updateDrift(true, driftScore);
  } else {
    hud.updateDrift(false, driftScore);
  }
  wasDrifting = state === 'racing' && car.drifting;

  if (state === 'menu' || state === 'loading') updateMenuCamera(now);
  else updateChaseCamera(dt);

  // shadow camera follows the car, staying aligned with the sky's sun
  sun.position.copy(car.group.position).add(sunOffset);
  sun.target.position.copy(car.group.position);

  const raceInfo = raceMode === 'race' && state !== 'menu'
    ? { pos: playerPosition(), total: bots.length + 1, lap: Math.min(Math.max(playerLaps + 1, 1), RACE_LAPS), laps: RACE_LAPS }
    : null;
  hud.update(car, timer, raceInfo, botsRunning ? bots.map((b) => b.car.group.position) : []);
  composer.render();
}
requestAnimationFrame(frame);

// Debug handle for console experiments.
window.__game = { car, track, timer, input, audio, ghost, bots };

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
