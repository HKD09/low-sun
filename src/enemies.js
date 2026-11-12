// The station's sentries. They hover, pick a firing spot, warn before every shot, break away to cover, and fall when hit.
import * as THREE from 'three';
import { damp, clamp, rnd, smooth } from './physics.js';
import { HDR_GLSL } from './materials.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
const TYPES = {
  scout:  { hp: 100, radius: 0.36, hit: 0.46, speed: 7.5, accel: 16, aim: 1.3, dmg: 18, burst: 1, cool: 0.5, range: [8, 17], height: [2.0, 5.2], bolt: 62, scale: 1.6, eye: [0, -0.012, 0.34], eyeR: 0.07, rotors: 4, tune: 1 },
  lifter: { hp: 2600, radius: 1.15, hit: 1.2, speed: 4.6, accel: 6, aim: 1.6, dmg: 14, burst: 3, cool: 1.2, range: [12, 24], height: [2.6, 5.5], bolt: 58, scale: 1.0, eye: [0, 0.02, 0.9], eyeR: 0.26, rotors: 6, tune: 0.42 },
};

class Drone {
  constructor(E, type, dock, wave) {
    this.E = E; this.G = E.G; this.type = type; this.T = TYPES[type]; this.dock = dock; this.wave = wave;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.post = new THREE.Vector3(); this.aimAt = new THREE.Vector3(); this.eyeW = new THREE.Vector3();
    this.amb = Array.from({ length: 6 }, () => new THREE.Vector3(0.2, 0.2, 0.2));
    const G = this.G, W = G.world, src = E.models[type];
    this.root = new THREE.Group(); this.tilt = new THREE.Group(); this.root.add(this.tilt); this.tilt.scale.setScalar(this.T.scale);
    this.rotors = []; this.mats = [];
    const mat = (name) => { const base = E.baseMats[name]; const m = base.clone(); m.map = base.map; m.normalMap = base.normalMap; m.aoMap = base.aoMap; m.roughnessMap = base.roughnessMap; m.metalnessMap = base.metalnessMap; W.dressDynamic(m, this.amb, { recolor: base.userData.recolor }); this.mats.push(m); return m; };
    for (const o of src) {
      const kind = o.name.split('_')[1].replace(/\d+$/, '');
      let m;
      if (kind === 'eye') { this.eyeU = { uCol: { value: new THREE.Color(1, 0.3, 0.05) }, uI: { value: 0.3 }, lsHdr: W.materials.shared.lsHdr };
        m = new THREE.ShaderMaterial({ uniforms: this.eyeU, vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4( position, 1.0 ); vN = normalMatrix * normal; vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
          fragmentShader: `uniform vec3 uCol; uniform float uI; varying vec3 vN; varying vec3 vV; ${HDR_GLSL} void main(){ float f = pow( max( dot( normalize( vN ), normalize( vV ) ), 0.0 ), 2.0 ); gl_FragColor = vec4( lsEncode( uCol * uI * ( 0.35 + 0.65 * f ) + 0.01 ), 1.0 ); }` }); }
      else m = mat(kind === 'rotor' ? 'dark' : kind);
      const mesh = new THREE.Mesh(o.geometry, m); mesh.position.copy(o.position); mesh.castShadow = false; mesh.receiveShadow = true; this.tilt.add(mesh);
      if (kind === 'rotor') this.rotors.push(mesh);
    }
    // blur discs over the rotors, the eye's glow, and the sight line shown while it aims
    const discM = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    this.discM = discM; this.discs = this.rotors.map((r) => { const d = new THREE.Mesh(E.discGeo, discM); d.position.copy(r.position); d.position.y += 0.012; d.scale.setScalar(type === 'scout' ? 0.118 : 0.31); d.renderOrder = 3; this.tilt.add(d); return d; });
    this.glowU = { map: { value: E.glowTex }, uCol: { value: new THREE.Color(1, 0.3, 0.05) }, uI: { value: 0 }, uS: { value: 1 }, lsHdr: W.materials.shared.lsHdr };
    this.glow = new THREE.Mesh(E.quad, new THREE.ShaderMaterial({ uniforms: this.glowU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'uniform float uS; varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ); mv.xy += position.xy * uS; mv.z += 0.15; gl_Position = projectionMatrix * mv; }',
      fragmentShader: `uniform sampler2D map; uniform vec3 uCol; uniform float uI; varying vec2 vUv; ${HDR_GLSL} void main(){ gl_FragColor = vec4( lsEncode( uCol * uI * texture2D( map, vUv ).a ), 1.0 ); }` }));
    this.glow.position.fromArray(this.T.eye); this.glow.frustumCulled = false; this.glow.renderOrder = 8; this.tilt.add(this.glow);
    this.laserU = { uCol: { value: new THREE.Color(1, 0.16, 0.04) }, uA: { value: 0 }, uEnd: { value: 0 }, lsHdr: W.materials.shared.lsHdr };
    this.laser = new THREE.Mesh(E.quad, new THREE.ShaderMaterial({ uniforms: this.laserU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: `uniform vec3 uCol; uniform float uA; uniform float uEnd; varying vec2 vUv; ${HDR_GLSL} void main(){ float a = smoothstep( 0.5, 0.0, abs( vUv.y - 0.5 ) ); float tail = mix( 1.0 - smoothstep( 0.55, 0.97, vUv.x ), 1.0, uEnd ); gl_FragColor = vec4( lsEncode( uCol * a * a * uA * smoothstep( 0.0, 0.04, vUv.x ) * tail ), 1.0 ); }` }));
    this.laser.frustumCulled = false; this.laser.visible = false; this.laser.renderOrder = 8; G.scene.add(this.laser);
    G.scene.add(this.root); this.track = W.track(this.pos, this.amb);
    this.reset();
  }

  reset() {
    this.maxHp = this.T.hp * (this.heavy ? 2.5 : 1); this.hp = this.maxHp; this.tilt.scale.setScalar(this.T.scale * (this.heavy ? 1.32 : 1)); this.state = 'dock'; this.t = 0; this.spin = 0; this.spinV = 0; this.yaw = this.dock.yaw ?? Math.PI; this.pitch = 0; this.roll = 0; this.eyeI = 0.25; this.charge = 0; this.shots = 0; this.hideN = 0; this.smoke = 0; this.stuck = 0; this.phase = 1; this.attackN = 0; this.swept = false; this.stagT = 0; this.deadRotors = 0;
    this.pos.fromArray(this.dock.pos); this.vel.set(0, 0, 0); this.root.visible = true; this.laser.visible = false; this.wq = null; this.bob = Math.random() * 10; this.summoned = [false, false]; this.dead = false;
    this.apply(0);
  }
  get active() { return this.state !== 'dock' && this.state !== 'dead' && this.state !== 'dying' && this.state !== 'off'; }
  aimPoint() { return this.eyeW; }

  wake(delay = 0) { if (this.state !== 'dock') return; this.state = 'wake'; this.t = -delay; this.G.audio && this.G.audio.droneWake(this); }

  // Somewhere to hover: with a view of the player when it wants to shoot, hidden from them when it wants cover.
  pickPost(wantLos) {
    const G = this.G, pl = G.player, T = this.T, area = this.E.area(this), eye = pl.eye; let best = null, bs = -1e9;
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.283, d = rnd(T.range[0], T.range[1]);
      _a.set(eye.x + Math.cos(a) * d, rnd(T.height[0], T.height[1]) + (pl.pos.y > 3 ? 3.2 : 0), eye.z + Math.sin(a) * d);
      _a.x = clamp(_a.x, area.a[0], area.b[0]); _a.z = clamp(_a.z, area.a[2], area.b[2]); _a.y = clamp(_a.y, area.a[1], area.b[1]);
      if (G.col.resolveSphere(_b.copy(_a), T.radius * T.scale + 0.25)) continue;
      const los = G.col.clear(_a, eye); if (wantLos && !los) continue;
      let s = Math.random() * 2 - _a.distanceTo(this.pos) * 0.12; if (!wantLos) s += los ? -6 : 6;
      for (const o of this.E.list) if (o !== this && o.active) s -= 4 / (0.6 + o.post.distanceTo(_a));
      if (G.col.clear(this.pos, _a)) s += 2.5;
      if (s > bs) { bs = s; best = best || new THREE.Vector3(); best.copy(_a); }
    }
    if (best) this.post.copy(best); return !!best;
  }

  hit(h, dir) {
    if (!this.active && this.state !== 'wake') return false;
    const open = this.state === 'aim' || this.state === 'sweepWarm' || this.state === 'sweep';       // the eye is only a weak spot while it is charging
    const crit = h.crit && open ? 2 : 1, before = this.hp / this.T.hp, armour = this.type === 'lifter' && (h.dmg || 100) < 100 ? 0.4 : 1;      // the lifter's plate stops most of a pistol round
    this.hp -= (h.dmg || 100) * crit * armour; this.vel.addScaledVector(dir, this.type === 'scout' ? 5 : 0.9); this.spinV += rnd(-9, 9);
    this.G.audio && this.G.audio.droneHit(this, crit > 1);
    if (this.hp <= 0) { this.die(dir); return true; }
    if (this.type === 'lifter') { const f = this.hp / this.T.hp; for (const th of [2 / 3, 1 / 3]) if (before > th && f <= th) this.breakRotor(); }
    // a heavy hit knocks its aim off and makes it break away
    this.smoke = 1 - this.hp / this.maxHp; this.flinchT = 0.5; if (this.state === 'aim' && (this.type === 'scout' || crit > 1)) { this.state = 'cool'; this.t = 0; this.laser.visible = false; }
    return false;
  }
  // The lifter loses a rotor at each third of its strength: it drops, recovers, and changes how it fights.
  breakRotor() {
    const G = this.G, r = this.rotors[this.deadRotors * 2 + 1]; this.deadRotors++; this.phase++; this.state = 'stagger'; this.t = 0; this.laser.visible = false; this.vel.y -= 5; this.spinV += 40;
    if (r) { r.userData.dead = true; r.getWorldPosition(_a); G.fx.explosion(_a, 0.9); }
    G.audio && G.audio.droneDie({ type: 'scout', pos: this.pos }); G.player.shake = Math.max(G.player.shake, 0.6); this.E.escort(this); this.E.onPhase && this.E.onPhase(this);
  }
  flinch() { if (this.state === 'aim' && this.type === 'scout') { this.state = 'cool'; this.t = this.T.cool - 0.15; this.laser.visible = false; this.vel.add(_a.set(rnd(-4, 4), rnd(1, 3), rnd(-4, 4))); this.hideN = 0; } }

  die(dir) {
    const G = this.G; this.state = 'dying'; this.t = 0; this.laser.visible = false; this.eyeI = 0; this.dead = true;
    G.fx.explosion(this.pos, this.type === 'scout' ? 0.75 : 2.4); G.audio && G.audio.droneDie(this);
    this.vel.addScaledVector(dir, 3).add(_a.set(rnd(-2, 2), rnd(1, 3), rnd(-2, 2)));
    this.wq = new THREE.Vector3(rnd(-7, 7), rnd(-4, 4), rnd(-7, 7)); if (this.type === 'lifter') { this.wq.multiplyScalar(0.3); G.player.shake = 1.2; G.slowmo = 1.6; this.burstT = 1.4; }
    this.E.onKill && this.E.onKill(this);
  }
  shutdown() { if (this.state === 'dead' || this.state === 'dying') return; if (this.state === 'dock') { this.state = 'off'; this.eyeI = 0; return; } this.state = 'dying'; this.t = 0; this.dead = true; this.laser.visible = false; this.wq = new THREE.Vector3(rnd(-3, 3), rnd(-2, 2), rnd(-3, 3)); this.quiet = true; }

  fire() {
    const G = this.G, T = this.T, dir = _a.copy(this.aimAt).sub(this.eyeW).normalize();
    dir.x += rnd(-0.012, 0.012); dir.y += rnd(-0.012, 0.012); dir.z += rnd(-0.012, 0.012); dir.normalize();
    this.E.bolts.push({ p: this.eyeW.clone().addScaledVector(dir, 0.3), v: dir.clone().multiplyScalar(T.bolt), life: 1.6, dmg: T.dmg, from: this.pos.clone() });
    this.vel.addScaledVector(dir, this.type === 'scout' ? -2.4 : -0.5); G.fx.light(this.eyeW, 0xff7a3a, 60, 0.07, 12); G.audio && G.audio.droneShot(this);
  }

  apply(dt) {
    const sc = this.T.scale;
    this.root.position.copy(this.pos); this.root.rotation.set(0, this.yaw, 0); this.tilt.rotation.set(this.pitch, 0, this.roll, 'YXZ');
    this.spin += this.spinV * dt; for (let i = 0; i < this.rotors.length; i++) if (!this.rotors[i].userData.dead) this.rotors[i].rotation.y = this.spin * (i % 2 ? 1 : -1) + i;
    const fast = clamp((Math.abs(this.spinV) - 25) / 60, 0, 1); this.discM.opacity = fast * 0.3; for (const r of this.rotors) r.visible = fast < 0.9;
    this.root.updateMatrixWorld(true); this.eyeW.fromArray(this.T.eye).multiplyScalar(sc).applyMatrix4(this.root.matrixWorld).y += 0;
    _a.fromArray(this.T.eye).applyMatrix4(this.tilt.matrixWorld); this.eyeW.copy(_a);
    this.eyeU.uI.value = this.eyeI * 9; this.glowU.uI.value = this.eyeI * (this.type === 'scout' ? 2.2 : 3.2); this.glowU.uS.value = (this.type === 'scout' ? 0.5 : 1.3) * (0.7 + 2.0 * this.charge * this.charge);
    const c = this.charge; this.eyeU.uCol.value.setRGB(1, 0.2 + 0.6 * c * c, 0.04 + 0.5 * c * c * c); this.glowU.uCol.value.copy(this.eyeU.uCol.value);
  }

  update(dt) {
    const G = this.G, T = this.T, pl = G.player, col = G.col; this.t += dt; this.bob += dt;
    if (this.state === 'dead' || this.state === 'off') return;
    if (this.state === 'dock') { this.eyeI = 0.16 + 0.06 * Math.sin(this.bob * 1.3); this.apply(dt); return; }
    if (this.state === 'dying') {     // falls as wreckage
      this.vel.y -= 13 * dt; this.pos.addScaledVector(this.vel, dt); this.spinV = damp(this.spinV, 0, 1.5, dt);
      if (this.wq) { this.pitch += this.wq.x * dt; this.roll += this.wq.z * dt; this.yaw += this.wq.y * dt; }
      if (col.resolveSphere(this.pos, T.radius * T.scale * 0.55, _n)) { const vn = this.vel.dot(_n);
        if (vn < -1.2) { G.fx.impact(_a.copy(this.pos).addScaledVector(_n, -T.radius * 0.5), _n, 'metal', _b.copy(this.vel).normalize(), this.type === 'scout' ? 0.7 : 2); G.audio && G.audio.droneCrash(this, -vn); if (this.type === 'lifter') pl.shake = Math.max(pl.shake, 0.8); }
        if (vn < 0) this.vel.addScaledVector(_n, -1.35 * vn); this.vel.multiplyScalar(0.6); if (this.wq) this.wq.multiplyScalar(0.5);
        if (this.vel.lengthSq() < 0.3 && _n.y > 0.6) { this.state = 'dead'; this.smoke = 1; this.t = 0; } }
      if (!this.quiet && Math.random() < dt * 30) G.fx.smoke(this.pos, 0.8, 0.03);
      if (this.burstT > 0) { this.burstT -= dt; if (Math.random() < dt * 9) G.fx.explosion(_a.copy(this.pos).add(_b.set(rnd(-1, 1), rnd(-0.4, 0.4), rnd(-1, 1))), rnd(0.6, 1.2)); }
      this.apply(dt); return;
    }
    // ---- alive
    const toP = _c.copy(pl.eye).sub(this.eyeW), dist = toP.length(), los = col.clear(this.eyeW, pl.eye) && !pl.dead && G.state === 'play';
    this.spinV = damp(this.spinV, 95 + this.vel.length() * 6, 4, dt);
    if (this.state === 'wake') {
      if (this.t < 0) { this.apply(dt); return; }
      this.eyeI = damp(this.eyeI, 1, 5, dt); this.pos.y += dt * 0.9 * smooth(this.t / 0.9) * (this.dock.drop ? -1 : 1); if (this.dock.out) this.pos.addScaledVector(_a.fromArray(this.dock.out), dt * 1.6);
      if (this.t > 1.0) { this.state = 'move'; this.t = 0; this.wantLos = true; if (!this.pickPost(true)) this.post.copy(this.pos); }
      this.apply(dt); return;
    }
    // steering towards the post, with a slow bob so it never sits dead still
    const tgt = _a.copy(this.post); tgt.y += Math.sin(this.bob * 1.1) * 0.12; tgt.x += Math.sin(this.bob * 0.7) * 0.15;
    // the east wall has one way through: line up with the roller door before crossing
    if ((this.pos.x > 44.4) !== (this.post.x > 44.4)) { const out = this.pos.x > 44.4, lined = Math.abs(this.pos.z + 31) < 0.7 && this.pos.y < 2.9 && this.pos.y > 1.7;
      if (lined || Math.abs(this.pos.x - 44.3) < 2.2 && Math.abs(this.pos.z + 31) < 1.4) tgt.set(out ? 40 : 48.5, 2.3, -31); else tgt.set(out ? 47.6 : 41.2, 2.3, -31); }
    const d = _b.copy(tgt).sub(this.pos), dl = d.length(), want = d.multiplyScalar(Math.min(T.speed, dl * 2.2) / (dl || 1));
    const k = 1 - Math.exp(-dt * T.accel / T.speed * 1.6); this.vel.lerp(want, k);
    this.pos.addScaledVector(this.vel, dt);
    if (col.resolveSphere(this.pos, T.radius * T.scale + 0.12, _n)) { const vn = this.vel.dot(_n); if (vn < 0) this.vel.addScaledVector(_n, -1.3 * vn); this.stuck += dt; } else this.stuck = Math.max(0, this.stuck - dt * 0.5);
    for (const o of this.E.list) if (o !== this && o.active) { const dd = _b.copy(this.pos).sub(o.pos), l = dd.length(), min = (T.radius * T.scale + o.T.radius * o.T.scale) * 1.6; if (l < min && l > 1e-3) this.vel.addScaledVector(dd, (min - l) / l * 6 * dt * 10); }
    // face the player (or the way it flies when it cannot see them), lean into its motion
    const face = los || this.state === 'aim' ? Math.atan2(toP.x, toP.z) : this.vel.lengthSq() > 1 ? Math.atan2(this.vel.x, this.vel.z) : this.yaw;
    let dy = face - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); this.yaw += dy * (1 - Math.exp(-dt * 7));
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), fwd = this.vel.x * sy + this.vel.z * cy, side = this.vel.x * cy - this.vel.z * sy;
    const lookP = los ? -Math.atan2(toP.y, Math.hypot(toP.x, toP.z)) * 0.6 : 0;
    this.pitch = damp(this.pitch, clamp(fwd * 0.05, -0.4, 0.4) * T.tune + lookP, 6, dt); this.roll = damp(this.roll, clamp(-side * 0.06, -0.45, 0.45) * T.tune, 6, dt);
    const warm = this.state === 'aim' ? clamp(this.t / T.aim, 0, 1) : this.state === 'sweepWarm' ? clamp(this.t / 1.0, 0, 1) : this.state === 'sweep' ? 1 : 0;
    this.charge = damp(this.charge, warm, warm > 0 ? 30 : 6, dt);
    this.eyeI = damp(this.eyeI, warm > 0 ? 1.5 + 8 * this.charge * this.charge : 0.8, 12, dt);
    if (warm > 0 && los) G.hud.warn(this.eyeW, this.charge);
    for (let i = 0; i < this.rotors.length; i++) if (this.rotors[i].userData.dead && Math.random() < dt * 14) { this.rotors[i].getWorldPosition(_b); G.fx.smoke(_b, 1, 0.02); }
    if (this.state === 'stagger') { this.vel.y -= 3 * dt; this.roll += Math.sin(this.t * 14) * dt * 2; if (this.t > 1.3) { this.state = 'move'; this.t = 0; this.wantLos = true; this.pickPost(true); } this.apply(dt); return; }
    if (this.flinchT > 0) this.flinchT -= dt;

    if (this.state === 'move') {
      if (dl < 1.0 || this.t > 4 || this.stuck > 1.2) {
        if (this.stuck > 1.2) { this.stuck = 0; this.pickPost(this.wantLos); this.t = 0; }
        else if (this.wantLos) { if (los && dist < 34) {
            if (this.type === 'lifter' && this.phase >= 2 && this.attackN % 2 === 1) { this.state = 'sweepWarm'; this.t = 0; this.swept = false; this.sweepSide = Math.random() < 0.5 ? -1 : 1; this.sweepYaw = Math.atan2(toP.x, toP.z); G.audio && G.audio.droneSweep(this); this.E.onSweep && this.E.onSweep(this); }
            else { this.state = 'aim'; this.t = 0; this.shots = 0; this.aimAt.copy(pl.eye); this.aimAt.y -= 0.25; G.audio && G.audio.droneAim(this); this.E.onAim && this.E.onAim(this); }
            this.attackN++; } else if (this.t > 0.8) { this.pickPost(true); this.t = 0; } }
        else { this.state = 'hide'; this.t = 0; this.hideT = rnd(0.9, 2.0); }
      }
    } else if (this.state === 'hide') {
      if (this.t > this.hideT) { this.state = 'move'; this.t = 0; this.wantLos = true; this.pickPost(true); }
    } else if (this.state === 'aim') {
      // the sight line trails the player: keep moving and it will miss, stand still and it will not
      _a.copy(pl.eye); _a.y -= 0.25; this.aimAt.lerp(_a, 1 - Math.exp(-dt * (2.6 - 1.2 * this.charge)));
      if (!los && this.t > 0.25) { this.state = 'move'; this.t = 0; this.wantLos = true; this.pickPost(true); this.laser.visible = false; }
      else if (this.t >= T.aim + this.shots * 0.28) { this.fire(); this.shots++; if (this.shots >= T.burst) { this.state = 'cool'; this.t = 0; } }
    } else if (this.state === 'sweepWarm' || this.state === 'sweep') {
      // a beam drawn across the room at chest height: the only answer is something solid between you and it
      const live = this.state === 'sweep', k = live ? clamp(this.t / 2.0, 0, 1) : 0, ang = this.sweepYaw + this.sweepSide * (-0.62 + 1.24 * k);
      const dy = (pl.pos.y + 1.05 - this.eyeW.y) / Math.max(4, Math.hypot(toP.x, toP.z)), d = _a.set(Math.sin(ang), dy, Math.cos(ang)).normalize();
      const hitI = this.E.hitInfo, tHit = G.col.raycast(this.eyeW, d, 90, hitI), len = tHit === Infinity ? 90 : tHit;
      this.aimAt.copy(this.eyeW).addScaledVector(d, len); this.beamLive = live;
      if (live) {
        if (tHit !== Infinity && Math.random() < dt * 40) G.fx.beamSpark(this.aimAt, hitI.normal);
        const c = _b.copy(pl.pos); c.y += 1.05; c.sub(this.eyeW); const tp = clamp(c.dot(d), 0, len), miss = c.addScaledVector(d, -tp).length();
        if (!this.swept && miss < 0.5 && tp < len - 0.05) { this.swept = true; pl.damage(22, this.pos); }
        if (this.t > 2.0) { this.state = 'cool'; this.t = 0; this.beamLive = false; }
      } else if (this.t > 1.0) { this.state = 'sweep'; this.t = 0; }
    } else if (this.state === 'cool') {
      if (this.t > T.cool * (this.phase >= 3 ? 0.6 : 1)) { this.state = 'move'; this.t = 0; this.hideN++; this.wantLos = this.type === 'lifter' ? true : this.hideN % 2 === 0; this.pickPost(this.wantLos) || this.pickPost(true); }
    }
    // sight line
    const sweeping = this.state === 'sweepWarm' || this.state === 'sweep'; const showL = (this.state === 'aim' && this.t > 0.05) || sweeping;
    this.laser.visible = showL;
    if (showL) { const a = this.eyeW, b = this.aimAt; _a.subVectors(b, a); const len = _a.length(); _a.multiplyScalar(1 / len); const y = _b.subVectors(G.camera.position, a).cross(_a).normalize(), z = _c.crossVectors(_a, y);
      _m.makeBasis(_a, y, z); this.laser.quaternion.setFromRotationMatrix(_m); this.laser.position.copy(a).addScaledVector(_a, len * 0.5); const fl = 0.75 + 0.25 * Math.sin(this.bob * 60); this.laser.scale.set(len, sweeping ? (this.beamLive ? 0.16 : 0.02) : 0.014 + 0.05 * (1 - this.charge), 1); this.laserU.uA.value = sweeping ? (this.beamLive ? 14 : 1.2) : (0.9 + 9 * this.charge * this.charge) * fl; this.laserU.uEnd.value = sweeping ? 1 : 0; }
    if (this.smoke > 0.25 && Math.random() < dt * 22 * this.smoke) G.fx.smoke(this.pos, this.smoke, 0.04);
    // the lifter calls its escorts as it weakens
    this.apply(dt);
  }
}

export class Enemies {
  constructor(G) { this.G = G; this.list = []; this.bolts = []; this.models = {}; this.onKill = null; this.hitInfo = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surf: '' }; }
  async load() {
    const G = this.G, gltf = await G.gltf.loadAsync('./assets/drones.glb');
    this.models.scout = []; this.models.lifter = [];
    gltf.scene.traverse((o) => { if (o.isMesh) (o.name.startsWith('scout') ? this.models.scout : this.models.lifter).push(o); });
    const M = G.world.materials;
    this.baseMats = { body: M.set('steel', { color: 0xc9cdc6 }), dark: M.set('metal_dark', {}), trim: M.set('metal_yellow', {}) }; this.baseMats.dark.userData.recolor = [0.3, 0.31, 0.33]; this.baseMats.trim.userData.recolor = [2.5, 1.62, 0.2];
    this.quad = new THREE.PlaneGeometry(1, 1); this.discGeo = new THREE.CircleGeometry(1, 24); this.discGeo.rotateX(-Math.PI / 2);
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.1, 'rgba(255,255,255,.5)'); r.addColorStop(0.35, 'rgba(255,255,255,.12)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); this.glowTex = new THREE.CanvasTexture(c);
    let w4 = 0; for (const d of G.level.ent.docks) { const s = new Drone(this, 'scout', d, d.wave); if (d.wave === 4 && w4++ === 0) { s.heavy = true; s.reset(); } this.list.push(s); }
    this.lifter = new Drone(this, 'lifter', { pos: [66, -9, -33], yaw: -Math.PI / 2 }, 9); this.list.push(this.lifter); this.lifter.root.visible = false;
    this.spares = [0, 1, 2, 3, 4, 5].map((i) => { const s = new Drone(this, 'scout', { pos: [70, -20, -30 - i * 4] }, 10); s.root.visible = false; this.list.push(s); return s; });
  }
  // Where a machine may fly.
  area(d) {
    if (d.type === 'lifter') return this.lifterInside && this.G.player.pos.x < 44 ? { a: [24, 2.6, -37], b: [41, 6.2, -25.5] } : { a: [47, 2.6, -41], b: [58, 7.5, -25] };
    const home = d.dock.zone;
    if (home === 'gallery') return { a: [3, 1.5, -21.2], b: [43, 4.6, -16.9] };
    if (home === 'under') return { a: [17.2, -3.5, -45.5], b: [42.6, -1.8, -40.7] };
    const z = this.G.world.zoneAt(this.G.player.pos);
    return z === 'ext' ? { a: [46, 2, -43], b: [59, 7, -23] } : { a: [15.5, 1.8, -44], b: [41, 9.2, -24] };
  }
  wake(wave, stagger = 0.7) { let i = 0; for (const d of this.list) if (d.wave === wave) d.wake(i++ * stagger); }
  spawnLifter() { const l = this.lifter; l.reset(); for (const r of l.rotors) r.userData.dead = false; l.root.visible = true; l.state = 'move'; l.pos.set(63.6, -7, -31.5); l.post.set(63.2, 5.4, -31.5); l.wantLos = true; l.spinV = 110; l.eyeI = 1; this.G.audio && this.G.audio.droneWake(l); }
  // A sentry arriving from somewhere else: through the roof lights of the hall. heavy = armoured, takes more than one round.
  reinforce(at, heavy) { const s = this.spares.find((x) => x.state === 'dock' || x.state === 'dead' || x.state === 'off'); if (!s) return null; s.heavy = !!heavy; s.reset(); s.root.visible = true; s.pos.fromArray(at); s.state = 'move'; s.wantLos = true; s.spinV = 100; s.eyeI = 1; s.vel.set(rnd(-2, 2), -5, rnd(-2, 2)); s.pickPost(true); this.G.audio && this.G.audio.droneWake(s); return s; }
  sparesUp() { let n = 0; for (const s of this.spares) if (s.active) n++; return n; }
  escort(l) { const s = this.spares.find((x) => x.state === 'dock' || x.state === 'dead' || x.state === 'off'); if (!s) return; s.heavy = false; s.reset(); s.root.visible = true; s.pos.copy(l.pos); s.pos.y -= 0.9; s.state = 'move'; s.wantLos = true; s.spinV = 100; s.eyeI = 1; s.vel.set(rnd(-3, 3), -2, rnd(-3, 3)); s.pickPost(true); }
  shutdownAll() { for (const d of this.list) if (d.type === 'scout' && d.wave < 9) d.shutdown(); }
  waveDown(...waves) { for (const d of this.list) if (waves.includes(d.wave) && !d.dead) return false; return true; }
  reset(waves) { this.bolts.length = 0; for (const d of this.list) { if (!waves || waves.includes(d.wave)) { d.reset(); if (d.wave >= 9) d.root.visible = false; } } }
  aliveCount(wave) { let n = 0; for (const d of this.list) if (d.active || d.state === 'wake') if (wave === undefined || d.wave === wave) n++; return n; }
  pending(wave) { let n = 0; for (const d of this.list) if (d.wave === wave && (d.state === 'dock' || d.active || d.state === 'wake')) n++; return n; }
  casting() { for (const d of this.list) if (d.active || d.state === 'dying' || d.state === 'wake') return true; return false; }
  visibleTarget(eye) { let best = null, bd = 1e9; for (const d of this.list) { if (!d.active) continue; const dist = d.eyeW.distanceTo(eye); if (dist < bd && this.G.col.clear(eye, d.eyeW)) { bd = dist; best = d; } } return best; }
  heard() {}

  // The player's bullet against the machines. Generous radius: this is a rifle, not a needle.
  raycast(o, dir, far) {
    let best = null;
    for (const d of this.list) {
      if (!d.active && d.state !== 'wake') continue;
      const T = d.T, toC = _a.copy(d.pos).sub(o), t = toC.dot(dir); if (t < 0 || t > far + T.hit) continue;
      const perp = Math.sqrt(Math.max(0, toC.lengthSq() - t * t)), R = T.hit * T.scale;
      if (perp < R) { const th = t - Math.sqrt(R * R - perp * perp) * 0.6; if (th < far && (!best || th < best.t)) {
        const eyeD = _b.copy(d.eyeW).sub(o), te = eyeD.dot(dir), pe = Math.sqrt(Math.max(0, eyeD.lengthSq() - te * te));
        best = { t: th, enemy: d, crit: d.type === 'lifter' && pe < T.eyeR * 1.5 }; } }
      else if (perp < R + 1.1 && t < far) d.flinch();       // a near miss makes a scout break off
    }
    if (!best) return null;
    best.point = o.clone().addScaledVector(dir, best.t); best.normal = dir.clone().negate(); return best;
  }

  update(dt) {
    const G = this.G, pl = G.player;
    for (const d of this.list) d.update(dt);
    // slugs in flight
    let n = 0; const hitInfo = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surf: '' };
    for (const b of this.bolts) {
      b.life -= dt; if (b.life <= 0) continue;
      const step = b.v.length() * dt, dir = _a.copy(b.v).multiplyScalar(1 / (step / dt)), prev = _b.copy(b.p);
      const t = G.col.raycast(b.p, dir, step, hitInfo);
      // the player: a vertical capsule from the knees to the head
      const c = _c.copy(pl.pos); c.y += clamp(b.p.y - pl.pos.y, 0.3, 1.7); const toC = c.sub(b.p), tp = clamp(toC.dot(dir), 0, step), miss = toC.addScaledVector(dir, -tp).length();
      if (miss < 0.36 && tp < t && !pl.dead) { pl.damage(b.dmg, b.from); b.life = 0; continue; }
      if (t !== Infinity) { G.fx.impact(hitInfo.point, hitInfo.normal, hitInfo.surf, dir, 0.6); continue; }
      b.p.addScaledVector(dir, step); G.fx.tracer(prev, b.p, 0xff8a40, 0.05, 0.07);
      if (miss < 1.6 && !b.whiz) { b.whiz = true; G.audio && G.audio.whiz(b.p); }
      this.bolts[n++] = b;
    }
    this.bolts.length = n;
  }
}
