// First-person body: input, movement with weight, camera motion.
import * as THREE from 'three';
import { Spring, Spring2, damp, clamp } from './physics.js';

const RADIUS = 0.34, HEIGHT = 1.8, EYE = 1.66, STEP = 0.34;
const WALK = 4.3, SPRINT = 6.6, AIM = 2.3, GRAVITY = 19, JUMP = 6.1;

export class Input {
  constructor(canvas) {
    this.keys = new Set(); this.dx = 0; this.dy = 0; this.fire = false; this.fireHeld = false; this.aim = false;
    this.pressed = new Set(); this.locked = false; this.enabled = false; this.sens = 1; this.wheel = 0;
    addEventListener('wheel', (e) => { if (this.locked) this.wheel = Math.sign(e.deltaY); }, { passive: true });
    addEventListener('keydown', (e) => { if (e.repeat) return; this.keys.add(e.code); this.pressed.add(e.code); if (this.locked && ['Space', 'Tab', 'KeyR', 'KeyE', 'KeyQ', 'Digit1', 'Digit2'].includes(e.code)) e.preventDefault(); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.aim = false; this.fireHeld = false; });
    addEventListener('mousemove', (e) => { if (!this.locked) return; this.dx += e.movementX; this.dy += e.movementY; });
    addEventListener('mousedown', (e) => { if (!this.locked) return; if (e.button === 0) { this.fire = true; this.fireHeld = true; } if (e.button === 2) this.aim = true; });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.fireHeld = false; if (e.button === 2) this.aim = false; });
    addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; if (!this.locked) { this.aim = false; this.fireHeld = false; } this.onLock && this.onLock(this.locked); });
    this.canvas = canvas;
  }
  async lock() {
    try { await this.canvas.requestPointerLock({ unadjustedMovement: true }); }
    catch { try { await this.canvas.requestPointerLock(); } catch { /* headless */ } }
  }
  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  endFrame() { this.dx = this.dy = 0; this.fire = false; this.wheel = 0; this.pressed.clear(); }
}

export class Player {
  constructor(G) {
    this.G = G;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.grounded = true; this.surf = 'concrete';
    this.health = 100; this.hurtT = 99; this.dead = false;
    this.bob = 0; this.bobAmt = 0; this.stepSide = 1; this.speed = 0; this.moveAmt = 0;
    this.stepOff = 0;                         // camera lag after stepping up or down
    this.land = new Spring2(150, 15);         // dip on landing
    this.recP = new Spring2(190, 21); this.recY = new Spring2(150, 20); this.recR = new Spring2(160, 16);
    this.fovS = new Spring(9); this.aimT = 0; this.sprintT = 0; this.sprinting = false;
    this.coyote = 0; this.jumpBuf = 0; this.airT = 0; this.fallV = 0;
    this.lookDX = 0; this.lookDY = 0;         // per-frame look delta in radians, read by the weapon
    this.eye = new THREE.Vector3(); this.fwd = new THREE.Vector3(); this.shake = 0; this.shakeT = 0;
    this.baseFov = 62;
    this.reset();
  }
  reset(at) {
    const s = at || this.G.level.ent.start;
    this.pos.fromArray(s.pos); this.vel.set(0, 0, 0); this.yaw = s.yaw || 0; this.pitch = 0;
    this.health = 100; this.dead = false; this.grounded = true; this.stepOff = 0; this.hurtT = 99;
  }
  damage(n, from) {
    if (this.dead || this.G.state !== 'play') return;
    this.health -= n; this.hurtT = 0;
    this.recP.kick((Math.random() - 0.3) * 2.2); this.recR.kick((Math.random() - 0.5) * 3); this.shake = Math.max(this.shake, 0.5);
    this.G.hud.hurt(from, this); this.G.audio && this.G.audio.hurt();
    if (this.health <= 0) { this.health = 0; this.dead = true; this.G.onDeath(); }
  }
  kick(pitch, yaw, roll) { this.recP.kick(pitch); this.recY.kick(yaw); this.recR.kick(roll); }

  update(dt, input) {
    const G = this.G, col = G.col, k = input.keys;
    const active = G.state === 'play' && !this.dead;
    // ---- look
    const s = 0.0021 * input.sens * (1 - 0.45 * this.aimT);
    this.lookDX = active ? -input.dx * s : 0; this.lookDY = active ? -input.dy * s : 0;
    this.yaw += this.lookDX; this.pitch = clamp(this.pitch + this.lookDY, -1.5, 1.5);
    // ---- wish direction
    let fx = 0, fz = 0;
    if (active) { fz = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0); fx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0); }
    const aiming = active && input.aim && !G.weapon.busyReload;
    this.aimT = damp(this.aimT, aiming ? 1 : 0, aiming ? 13 : 11, dt);
    const wantSprint = active && (k.has('ShiftLeft') || k.has('ShiftRight')) && fz > 0 && !aiming && this.grounded;
    this.sprinting = wantSprint && !G.weapon.blockSprint;
    this.sprintT = damp(this.sprintT, this.sprinting ? 1 : 0, 9, dt);
    const max = this.sprinting ? SPRINT : aiming ? AIM : WALK * (fz < 0 ? 0.8 : 1);
    const len = Math.hypot(fx, fz) || 1; fx /= len; fz /= len;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const wx = (fx * cy - fz * sy) * max, wz = (-fx * sy - fz * cy) * max;
    const has = fx !== 0 || fz !== 0;
    // ---- horizontal velocity: eased on the ground, loose in the air
    const lam = this.grounded ? (has ? 11 : 13) : (has ? 1.6 : 0.15);
    this.vel.x = damp(this.vel.x, wx, lam, dt); this.vel.z = damp(this.vel.z, wz, lam, dt);
    // ---- jump
    this.coyote = this.grounded ? 0.11 : this.coyote - dt;
    this.jumpBuf = active && input.hit('Space') ? 0.13 : this.jumpBuf - dt;
    if (this.jumpBuf > 0 && this.coyote > 0) { this.vel.y = JUMP; this.grounded = false; this.coyote = 0; this.jumpBuf = 0; G.audio && G.audio.jump(this.surf); }
    // ---- integrate in small steps
    let n = Math.max(1, Math.ceil(dt / 0.008)); const h = dt / n; const wasGround = this.grounded;
    while (n--) {
      if (!this.grounded) this.vel.y -= GRAVITY * h;
      this.pos.x += this.vel.x * h; this.pos.z += this.vel.z * h; this.pos.y += this.vel.y * h;
      const stepY = this.pos.y + (this.grounded || this.vel.y <= 0.5 ? STEP : 0.05);
      const bx = this.pos.x, bz = this.pos.z;
      if (col.resolveCircle(this.pos, RADIUS, this.pos.y + 0.02, this.pos.y + HEIGHT, stepY)) {
        // lose the velocity that pointed into the wall
        const px = this.pos.x - bx, pz = this.pos.z - bz, pl = Math.hypot(px, pz);
        if (pl > 1e-6) { const nx = px / pl, nz = pz / pl, vn = this.vel.x * nx + this.vel.z * nz; if (vn < 0) { this.vel.x -= vn * nx; this.vel.z -= vn * nz; } }
      }
      const g = col.groundAt(this.pos.x, this.pos.z, RADIUS * 0.82, stepY);
      if (this.vel.y > 0) { // rising: watch the ceiling
        const c = col.ceilingAt(this.pos.x, this.pos.z, RADIUS * 0.8, this.pos.y + HEIGHT - 0.3);
        if (this.pos.y + HEIGHT > c) { this.pos.y = c - HEIGHT; this.vel.y = 0; }
      }
      if (g && this.vel.y <= 0 && (this.pos.y <= g.y || (this.grounded && this.pos.y - g.y < STEP + 0.05))) {
        if (!this.grounded) { this.fallV = -this.vel.y; }
        const d = g.y - this.pos.y; this.stepOff -= d; this.pos.y = g.y; this.vel.y = 0; this.grounded = true; this.surf = g.surf;
      } else if (!g || this.pos.y > g.y + 0.02) this.grounded = false;
      if (this.pos.y < -30) { this.pos.fromArray(G.level.ent.start.pos); this.vel.set(0, 0, 0); }
    }
    if (this.grounded && !wasGround) { // landed
      const f = clamp(this.fallV / 9, 0.25, 1.6); this.land.kick(-2.0 * f); this.stepOff = clamp(this.stepOff, -0.2, 0.2);
      G.audio && G.audio.land(this.surf, f); G.weapon.onLand(f);
      if (this.fallV > 13) this.damage((this.fallV - 13) * 6);
    }
    this.airT = this.grounded ? 0 : this.airT + dt;
    this.stepOff = damp(this.stepOff, 0, 15, dt);
    // ---- gait
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    const moving = this.grounded && this.speed > 0.4;
    this.moveAmt = damp(this.moveAmt, moving ? clamp(this.speed / WALK, 0, 1.5) : 0, 8, dt);
    const stride = this.sprinting ? 1.92 : 1.42;         // metres per step
    if (moving) {
      const before = Math.floor(this.bob / Math.PI);
      this.bob += this.speed * dt / stride * Math.PI;
      if (Math.floor(this.bob / Math.PI) !== before) { this.stepSide = -this.stepSide; G.audio && G.audio.step(this.surf, this.sprinting ? 1 : 0.7, this.stepSide); }
    }
    // ---- health comes back after a quiet moment
    this.hurtT += dt;
    if (!this.dead && this.hurtT > 3.2 && this.health < 100) this.health = Math.min(100, this.health + 26 * dt);
    // ---- camera
    this.land.update(dt); this.recP.update(dt); this.recY.update(dt); this.recR.update(dt);
    const cam = G.camera, bobK = this.moveAmt * (1 - 0.72 * this.aimT);
    const bv = Math.sin(this.bob * 2) * 0.021 * bobK * (1 + 0.6 * this.sprintT), bh = Math.sin(this.bob) * 0.017 * bobK * (1 + 0.8 * this.sprintT);
    this.shake = Math.max(0, this.shake - dt * 2.4); this.shakeT += dt * 38;
    const sh = this.shake * this.shake;
    const shx = (Math.sin(this.shakeT * 1.3) + Math.sin(this.shakeT * 2.9)) * 0.004 * sh, shy = (Math.sin(this.shakeT * 1.7 + 1) + Math.sin(this.shakeT * 3.3)) * 0.004 * sh;
    const strafe = (this.vel.x * cy - this.vel.z * sy);
    const roll = -strafe * 0.0042 * (1 - this.aimT * 0.6) + this.recR.x * 0.0174 + Math.sin(this.bob) * 0.0022 * bobK + shx * 0.8;
    const pitch = this.pitch + this.recP.x * 0.0174 + this.land.x * 0.012 + shy;
    const yaw = this.yaw + this.recY.x * 0.0174 + shx;
    cam.rotation.set(pitch, yaw, roll, 'YXZ');
    const dead = this.dead ? Math.min(1, (this.deadT = (this.deadT || 0) + dt) * 1.4) : (this.deadT = 0);
    cam.position.set(this.pos.x + cy * bh, this.pos.y + EYE + this.stepOff + bv + this.land.x * 0.05 - dead * 1.15, this.pos.z - sy * bh);
    if (dead) cam.rotation.z += dead * 0.7;
    this.fovS.target = this.sprintT * 5 - this.aimT * (this.baseFov - 36);
    this.fovS.update(dt);
    const fov = this.baseFov + this.fovS.x + G.weapon.fovKick;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    this.eye.copy(cam.position); cam.getWorldDirection(this.fwd);
  }
}
Player.RADIUS = RADIUS; Player.EYE = EYE; Player.HEIGHT = HEIGHT;
