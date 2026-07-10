import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Best-lap ghost: records [t, x, z, heading] while you drive, and replays the
// best lap as a translucent car. Purely visual — it has no collision.
export class Ghost {
  constructor(scene) {
    this.recording = [];
    this.best = null;        // { samples, specId, modelUrl, length }
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this._model = null;
    this._modelUrl = null;
    this._cursor = 0;
    this._lastT = -1;
  }

  // Call every frame while the lap timer runs. t = ms since lap start.
  record(t, car) {
    // ~60 Hz is plenty; skip duplicates when paused
    const last = this.recording[this.recording.length - 1];
    if (last && t - last[0] < 12) return;
    this.recording.push([t, car.group.position.x, car.group.position.z, car.heading]);
  }

  // Lap crossed the line. Keep the recording only if it's the new best.
  onLapDone(isBest, carSpec) {
    if (isBest && this.recording.length > 10) {
      this.best = { samples: this.recording, modelUrl: carSpec.model, length: carSpec.length };
      this._ensureModel();
    }
    this.recording = [];
    this._cursor = 0;
  }

  async _ensureModel() {
    if (!this.best || this._modelUrl === this.best.modelUrl) return;
    this._modelUrl = this.best.modelUrl;
    if (this._model) {
      this.group.remove(this._model);
      this._model.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); } });
      this._model = null;
    }
    const gltf = await new GLTFLoader().loadAsync(this.best.modelUrl);
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = this.best.length / Math.max(size.x, size.z);
    model.scale.setScalar(scale);
    box.setFromObject(model);
    model.position.y -= box.min.y;
    if (size.x > size.z) model.rotation.y = Math.PI / 2;
    // spectral look: translucent, unlit-ish, no shadows, never blocks the view
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = o.receiveShadow = false;
        o.material = new THREE.MeshStandardMaterial({
          color: 0x8fd8ff,
          transparent: true,
          opacity: 0.32,
          roughness: 0.6,
          metalness: 0,
          depthWrite: false,
          emissive: 0x4aa8d8,
          emissiveIntensity: 0.35,
        });
      }
    });
    this.group.add(model);
    this._model = model;
  }

  // Replay position for the current lap time (ms). Monotonic per lap;
  // t jumping backwards means a new lap started.
  update(t, running) {
    if (!this.best || !this._model || !running) {
      this.group.visible = false;
      return;
    }
    const s = this.best.samples;
    if (t < this._lastT) this._cursor = 0;
    this._lastT = t;

    // clamp: ghost already finished — parks at the line until your lap ends
    if (t >= s[s.length - 1][0]) {
      const last = s[s.length - 1];
      this.group.position.set(last[1], 0, last[2]);
      this.group.rotation.y = last[3];
      this.group.visible = true;
      return;
    }
    while (this._cursor < s.length - 2 && s[this._cursor + 1][0] <= t) this._cursor++;
    const a = s[this._cursor], b = s[this._cursor + 1];
    const k = Math.min(1, Math.max(0, (t - a[0]) / Math.max(1, b[0] - a[0])));
    this.group.position.set(
      a[1] + (b[1] - a[1]) * k,
      0,
      a[2] + (b[2] - a[2]) * k
    );
    // shortest-arc heading interpolation
    let dh = b[3] - a[3];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    this.group.rotation.y = a[3] + dh * k;
    this.group.visible = true;
  }

  clear() {
    this.best = null;
    this.recording = [];
    this._cursor = 0;
    this.group.visible = false;
  }
}
