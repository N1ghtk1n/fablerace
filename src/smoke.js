import * as THREE from 'three';

function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Recycled pool of smoke sprites for tyre smoke (and any other puffs).
export class SmokePool {
  constructor(scene, count = 140) {
    const tex = puffTexture();
    this.pool = [];
    this.next = 0;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this.pool.push({ sprite, vel: new THREE.Vector3(), life: 0, ttl: 1, base: 0.6 });
    }
  }

  spawn(pos, vel, scale = 0.55, color = 0xffffff) {
    const p = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    p.sprite.visible = true;
    p.sprite.material.color.setHex(color);
    p.sprite.position.copy(pos);
    p.vel.copy(vel).add(new THREE.Vector3(
      (Math.random() - 0.5) * 1.6,
      1.2 + Math.random() * 1.4,
      (Math.random() - 0.5) * 1.6
    ));
    p.life = 0;
    p.ttl = 0.6 + Math.random() * 0.5;
    p.base = scale * (0.8 + Math.random() * 0.5);
    p.sprite.scale.setScalar(p.base);
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.sprite.visible) continue;
      p.life += dt;
      if (p.life >= p.ttl) {
        p.sprite.visible = false;
        p.sprite.material.opacity = 0;
        continue;
      }
      const k = p.life / p.ttl;
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 1.6));
      p.sprite.scale.setScalar(p.base * (1 + k * 2.4));
      p.sprite.material.opacity = 0.34 * (1 - k);
    }
  }
}
