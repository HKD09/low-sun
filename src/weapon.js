// The rifle: a bolt-action view model with procedural handling. All motion is springs and timed curves.
import * as THREE from 'three';
import { Spring, Spring2, damp, clamp, smooth, rnd } from './physics.js';
import { HDR_GLSL } from './materials.js';

const MAG = 5;
// Model space (glTF): +X muzzle, +Y up, +Z right-hand side (bolt handle). The model is turned so +X faces -Z.
const MUZZLE = new THREE.Vector3(0.615, 0.0505, 0);
const EJECT = new THREE.Vector3(-0.2, 0.062, 0.012);
const POSE = {
  hip:    { p: [0.098, -0.128, -0.5],  r: [0.012, 0.05, -0.05] },
  aim:    { p: [0.0, -0.0722, -0.5], r: [0.0, 0.0, 0.0] },
  sprint: { p: [0.14, -0.2, -0.4],    r: [-0.2, 0.66, 0.16] },
};
const seg = (t, a, b) => smooth((t - a) / (b - a));

export class Weapon {
  constructor(G) {
    this.G = G;
    this.root = new THREE.Group(); this.gun = new THREE.Group(); this.root.add(this.gun);
    G.viewRoot.add(this.root);
    this.ammo = MAG; this.state = 'ready'; this.t = 0; this.fovKick = 0; this.blockSprint = false; this.busyReload = false;
    this.kz = new Spring2(260, 20); this.kp = new Spring2(210, 17); this.kr = new Spring2(190, 14); this.ky = new Spring2(200, 16);
    this.jy = new Spring2(110, 12);                       // vertical bounce from jumps and landings
    this.lagX = 0; this.lagY = 0; this.time = 0; this.queued = false; this.sprintBlockT = 0; this.shots = 0; this.hits = 0;
    this.flashT = 1; this.chambered = true; this.pos = new THREE.Vector3(); this.eul = new THREE.Euler();
    this.muzzleWorld = new THREE.Vector3(); this.onShot = null; this.dmg = 100; this.holster = 0; this.name = 'rifle'; this.mag = MAG;
  }

  async load(loader) {
    const gltf = await loader.loadAsync('./assets/rifle.glb');
    const m = gltf.scene; m.rotation.y = Math.PI / 2;
    this.model = m; this.gun.add(m);
    const find = (s) => { let r = null; m.traverse((o) => { if (o.name && o.name.endsWith(s)) r = r || o; }); return r; };
    this.boltA = find('bolt_a'); this.boltB = find('bolt_b');
    const scope = find('scope'); if (scope) scope.visible = false;
    this.cartridge = find('bullet_54mm'); if (this.cartridge) this.cartridge.visible = false;
    this.boltA0 = this.boltA.position.clone(); this.boltB0 = this.boltB.position.clone();
    m.traverse((o) => {
      o.layers.set(1);
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; o.frustumCulled = false; this.G.world.dressDynamic(o.material); }
    });
    this.buildHands(m);
    // muzzle flash: two crossed blades along the bore and a star facing the shooter
    const tex = this.G.fx.flashTexture;
    const mk = (w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({ uniforms: { map: { value: tex }, uA: { value: 1 }, lsHdr: this.G.fx.hdr }, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: `uniform sampler2D map; uniform float uA; varying vec2 vUv; ${HDR_GLSL} void main(){ vec3 c = texture2D( map, vUv ).rgb; vec2 q = abs( vUv - 0.5 ) * 2.0; float e = ( 1.0 - smoothstep( 0.7, 1.0, q.x ) ) * ( 1.0 - smoothstep( 0.6, 1.0, q.y ) ); gl_FragColor = vec4( lsEncode( c * c * 60.0 * uA * e ), 1.0 ); }` }));
    this.flash = new THREE.Group();
    const a = mk(0.42, 0.2), b = mk(0.42, 0.2), c = mk(0.3, 0.3);
    a.position.x = 0.17; b.position.x = 0.17; b.rotation.x = Math.PI / 2; c.rotation.y = Math.PI / 2; c.position.x = 0.04;
    this.flash.add(a, b, c); this.flash.position.copy(MUZZLE); this.flash.visible = false;
    this.flash.traverse((o) => { o.layers.set(1); o.frustumCulled = false; o.renderOrder = 10; });
    m.add(this.flash);
  }

  // Gloved hands and sleeves, built from simple rounded shapes. Mostly hidden by the rifle, which is the point:
  // they are there so the weapon is held, not to be looked at.
  buildHands(model) {
    const G = this.G, M = G.world.materials;
    const glove = M.set('glove', { color: 0x4a4038 }), sleeve = M.set('glove', { color: 0x2c3230 }); glove.roughness = 0.9; sleeve.roughness = 1;
    G.world.dressDynamic(glove); G.world.dressDynamic(sleeve);
    const cap = (r, len, pos, rot, mat = glove, sc) => { const mm = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, 12), mat); mm.position.fromArray(pos); if (rot) mm.rotation.set(rot[0], rot[1], rot[2]); if (sc) mm.scale.fromArray(sc); return mm; };
    const arm = (from, to, r0, r1) => { const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), len = a.distanceTo(b), g = new THREE.CylinderGeometry(r1, r0, len, 16, 4); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 4);
      const mm = new THREE.Mesh(g, sleeve); mm.position.copy(a).add(b).multiplyScalar(0.5); mm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize()); return mm; };
    // left hand: cupping the fore-end from below, fingers up the right side, thumb along the left
    const L = new THREE.Group();
    L.add(cap(0.02, 0.07, [0.105, -0.006, 0.0], [0, 0, Math.PI / 2], glove, [1, 1, 1.9]));
    for (let i = 0; i < 4; i++) { const x = 0.072 + i * 0.0215; L.add(cap(0.0098, 0.03, [x, 0.02, 0.0245], [0.12, 0, 0])); L.add(cap(0.0092, 0.016, [x, 0.049, 0.016], [0.95, 0, 0])); }
    L.add(cap(0.0112, 0.04, [0.118, 0.03, -0.0255], [0, 0, 1.25])); L.add(cap(0.012, 0.02, [0.09, 0.012, -0.024], [0, 0, 0.6]));
    L.add(cap(0.031, 0.02, [0.065, -0.022, -0.006], [0, 0, 1.1], sleeve, [1, 1, 1.25])); L.add(arm([0.06, -0.026, -0.008], [-0.2, -0.2, -0.17], 0.034, 0.052));
    // right hand: around the wrist of the stock; it leaves to work the bolt
    const R = new THREE.Group();
    R.add(cap(0.021, 0.05, [0, 0, 0], [0, 0, 0.5], glove, [1, 1, 1.5]));
    for (let i = 0; i < 4; i++) { const x = -0.026 + i * 0.02; R.add(cap(0.0098, 0.03, [x + 0.012, -0.024, -0.012], [1.2, 0, 0.35])); }
    R.add(cap(0.0115, 0.035, [0.01, 0.026, -0.016], [1.3, 0, 0.5]));
    R.add(cap(0.032, 0.02, [-0.045, -0.02, 0.022], [0.5, 0, 1.0], sleeve, [1, 1, 1.2])); R.add(arm([-0.04, -0.02, 0.02], [-0.3, -0.19, 0.2], 0.034, 0.055));
    this.handR = R; this.handGrip = new THREE.Vector3(-0.335, 0.0, 0.03); R.position.copy(this.handGrip);
    for (const g of [L, R]) { g.traverse((o) => { o.layers.set(1); if (o.isMesh) { o.frustumCulled = false; o.receiveShadow = true; } }); model.add(g); }
    this.hands = [L, R]; R.visible = false;       // the right hand sits below the frame at the hip and reads badly up close when it works the bolt, so only the supporting arm is shown
    if (G.params.has('nohands')) L.visible = false;
  }

  reset() { this.ammo = MAG; this.state = 'ready'; this.t = 0; this.chambered = true; this.queued = false; this.busyReload = false; this.shots = 0; this.hits = 0; }
  onLand(f) { this.jy.kick(-0.9 * f); this.kp.kick(-1.2 * f); }

  tryFire() {
    const G = this.G, pl = G.player;
    if (this.state !== 'ready') { if (this.state === 'cycle' && this.t > 0.55) this.queued = true; return; }
    if (this.ammo <= 0 || !this.chambered) { G.audio && G.audio.dry(); this.startReload(); return; }
    if (pl.sprintT > 0.35) { this.sprintBlockT = 0.5; this.queued = true; return; }
    this.fire();
  }

  fire() {
    const G = this.G, pl = G.player, aim = pl.aimT;
    this.ammo--; this.chambered = false; this.shots++; this.sprintBlockT = 0.6;
    // where the bullet goes: a small cone that opens when moving or firing from the hip
    const spread = (0.011 * (1 - aim) + 0.0008) * (1 + pl.speed * 0.35 + (pl.grounded ? 0 : 2.5));
    const d = pl.fwd.clone(), r = Math.sqrt(Math.random()) * spread, a = Math.random() * 6.283;
    const right = new THREE.Vector3().crossVectors(d, G.camera.up).normalize(), up = new THREE.Vector3().crossVectors(right, d);
    d.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    this.updateMuzzle();
    if (this.onShot && this.onShot(pl.eye, d, this.muzzleWorld)) this.hits++;
    // kick: the view jumps and settles back on target, the rifle drives into the shoulder
    const k = 1 - 0.28 * aim;
    pl.kick(118 * k, rnd(-26, 26) * k, rnd(-34, 34)); pl.shake = Math.max(pl.shake, 0.55);
    this.kz.kick(2.1 * k); this.kp.kick(2.5 * k); this.kr.kick(rnd(-1.6, 1.6)); this.ky.kick(rnd(-0.5, 0.5));
    this.fovKick = 2.2; this.flashT = 0; this.flash.visible = true;
    this.flash.rotation.x = rnd(6.28); const s = rnd(0.8, 1.25); this.flash.scale.set(s * rnd(0.85, 1.2), s, s);
    G.fx.muzzle(this.muzzleWorld, d); G.audio && G.audio.shot();
    this.state = 'cycle'; this.t = 0; this.ejected = false; this.queued = false;
  }

  startReload() {
    if (this.state !== 'ready' || (this.ammo >= MAG && this.chambered)) return;
    this.state = 'reload'; this.t = 0; this.busyReload = true; this.rs = 0; this.G.audio && this.G.audio.reload(0);
  }

  // Move a point drawn by the view-model camera to where it appears in the world camera.
  updateMuzzle() {
    const G = this.G, v = this.muzzleWorld;
    this.model.updateWorldMatrix(true, false);
    v.copy(MUZZLE).applyMatrix4(this.model.matrixWorld);
    v.applyMatrix4(G.viewCam.matrixWorldInverse);
    const k = Math.tan(G.camera.fov * Math.PI / 360) / Math.tan(G.viewCam.fov * Math.PI / 360);
    v.x *= k; v.y *= k; v.applyMatrix4(G.camera.matrixWorld);
  }

  update(dt, input) {
    const G = this.G, pl = G.player; this.time += dt; this.t += dt;
    const active = G.state === 'play' && !pl.dead;
    if (active) {
      if (input.fire) this.tryFire();
      if (input.hit('KeyR')) this.startReload();
    }
    this.sprintBlockT -= dt; this.blockSprint = this.sprintBlockT > 0 || this.state === 'reload';
    if (this.queued && this.state === 'ready' && pl.sprintT < 0.35 && active) { this.queued = false; this.tryFire(); }

    // ---- bolt cycle and reload curves
    let bRot = 0, bBack = 0, ox = 0, oy = 0, oz = 0, rx = 0, ry = 0, rz = 0;
    if (this.state === 'cycle') {
      const t = this.t;
      bRot = seg(t, 0.2, 0.34) - seg(t, 0.72, 0.86);
      bBack = seg(t, 0.33, 0.47) - seg(t, 0.55, 0.71);
      const w = seg(t, 0.14, 0.36) - seg(t, 0.74, 0.98);        // the rifle rolls out of the shoulder while the hand works the bolt
      rz = -0.2 * w; rx = -0.045 * w; ry = -0.05 * w; ox = 0.012 * w; oy = -0.022 * w * (0.4 + pl.aimT); oz = 0.03 * bBack;
      if (!this.s1 && t > 0.2) { this.s1 = true; G.audio && G.audio.bolt(0); }
      if (!this.ejected && t > 0.43) { this.ejected = true; this.kr.kick(-1.0); this.kz.kick(0.35); this.eject(); G.audio && G.audio.bolt(1); }
      if (!this.s3 && t > 0.58 && this.ejected) { this.s3 = true; G.audio && G.audio.bolt(2); this.kz.kick(-0.3); }
      if (t > 0.72 && this.ammo > 0) this.chambered = true;
      if (t > 1.0) { this.state = 'ready'; this.s1 = this.s3 = false; if (this.ammo <= 0) this.startReload(); }
    } else if (this.state === 'reload') {
      const t = this.t, down = seg(t, 0, 0.42) - seg(t, 1.75, 2.2);
      oy = -0.3 * down; ox = 0.05 * down; rx = 0.62 * down; rz = -0.55 * down; ry = 0.3 * down;
      if (this.rs === 0 && t > 0.62) { this.rs = 1; this.kp.kick(-1.4); this.G.audio && this.G.audio.reload(1); }
      if (this.rs === 1 && t > 1.32) { this.rs = 2; this.kp.kick(1.8); this.jy.kick(0.5); this.ammo = MAG; this.G.audio && this.G.audio.reload(2); }
      const c = t - 1.95;                                          // close the bolt on a fresh round
      if (c > 0) { bRot = 1 - seg(c, 0.38, 0.5); bBack = seg(c, 0.0, 0.14) - seg(c, 0.2, 0.36); rz += -0.12 * (1 - seg(c, 0.35, 0.6));
        if (this.rs === 2 && c > 0.22) { this.rs = 3; this.G.audio && this.G.audio.bolt(2); } }
      else if (!this.chambered) { bRot = seg(t, 0.1, 0.25); }
      if (t > 2.58) { this.state = 'ready'; this.chambered = true; this.busyReload = false; }
    }
    this.boltA.position.copy(this.boltA0); this.boltA.position.x -= bBack * 0.088; this.boltA.rotation.x = -1.42 * bRot;
    this.boltB.position.copy(this.boltB0); this.boltB.position.x -= bBack * 0.088 + bRot * 0.004;
    // the right hand goes to the bolt knob while the bolt is being worked, then back to the grip
    if (this.handR) { const busy = this.state === 'cycle' ? seg(this.t, 0.1, 0.2) - seg(this.t, 0.84, 0.98) : this.state === 'reload' ? seg(this.t, 0.0, 0.2) - seg(this.t, 2.4, 2.56) : 0;
      const a = -1.42 * bRot - 0.45, kx = -0.205 - bBack * 0.088, ky = 0.0507 + Math.sin(a) * -0.052 + 0.012, kz = 0.006 + Math.cos(a) * 0.052 + 0.012;
      this.handR.position.set(this.handGrip.x + (kx - this.handGrip.x) * busy, this.handGrip.y + (ky - this.handGrip.y) * busy, this.handGrip.z + (kz - this.handGrip.z) * busy); this.handR.rotation.set(-0.5 * busy - 0.9 * bRot * busy, 0, 0.25 * busy); }

    // ---- pose
    const hip = POSE.hip, aim = POSE.aim, spr = POSE.sprint, sT = smooth(pl.sprintT), aT = smooth(pl.aimT);
    const P = (i) => { const h = hip.p[i] + (spr.p[i] - hip.p[i]) * sT; return h + (aim.p[i] - h) * aT; };
    const R = (i) => { const h = hip.r[i] + (spr.r[i] - hip.r[i]) * sT; return h + (aim.r[i] - h) * aT; };
    // look inertia: the muzzle trails the eye and catches up
    this.lagX = damp(this.lagX + pl.lookDX, 0, 11, dt); this.lagY = damp(this.lagY + pl.lookDY, 0, 11, dt);
    const lx = clamp(this.lagX, -0.12, 0.12), ly = clamp(this.lagY, -0.1, 0.1), loose = 1 - 0.75 * aT;
    // gait and breathing
    const mv = pl.moveAmt * loose, bx = Math.sin(pl.bob) * 0.0075 * mv, by = Math.sin(pl.bob * 2) * 0.0055 * mv;
    const br = Math.sin(this.time * 1.5), br2 = Math.sin(this.time * 0.9 + 1);
    const sy = Math.sin(pl.yaw), cy = Math.cos(pl.yaw), strafe = pl.vel.x * cy - pl.vel.z * sy, fwdv = -pl.vel.x * sy - pl.vel.z * cy;
    this.kz.update(dt); this.kp.update(dt); this.kr.update(dt); this.ky.update(dt); this.jy.target = clamp(-pl.vel.y * 0.004, -0.03, 0.03); this.jy.update(dt);
    this.pos.set(
      P(0) + ox + bx - lx * 0.05 * loose - strafe * 0.0022 * loose + this.ky.x * 0.004,
      P(1) + oy + by + ly * 0.04 * loose + br * 0.0012 * loose + this.jy.x * 0.6 - this.kp.x * 0.004 - this.holster * 0.34,
      P(2) + oz + this.kz.x * 0.03 - fwdv * 0.0016 * loose);
    this.eul.set(
      R(0) + rx + this.kp.x * 0.034 + ly * 0.5 * loose + this.jy.x * 1.2 + br2 * 0.0018 + Math.sin(pl.bob * 2) * 0.004 * mv - this.holster * 0.6,
      R(1) + ry + lx * 0.55 * loose + this.ky.x * 0.02 + br * 0.0014 * loose + Math.sin(pl.bob) * 0.006 * mv,
      R(2) + rz + this.kr.x * 0.03 - strafe * 0.012 * loose - lx * 0.5 * loose, 'YXZ');
    this.gun.position.copy(this.pos); this.gun.rotation.copy(this.eul);
    this.fovKick = damp(this.fovKick, 0, 10, dt);
    // ---- flash lives for two or three frames
    this.flashT += dt;
    if (this.flash.visible) { const f = 1 - this.flashT / 0.05; if (f <= 0) this.flash.visible = false; else this.flash.children.forEach((c) => (c.material.uniforms.uA.value = f)); }
    G.viewCam.fov = 50 - 13 * aT; G.viewCam.updateProjectionMatrix();
  }

  eject() {
    const G = this.G, p = new THREE.Vector3().copy(EJECT);
    this.model.updateWorldMatrix(true, false);
    p.applyMatrix4(this.model.matrixWorld).applyMatrix4(G.viewCam.matrixWorldInverse).applyMatrix4(G.camera.matrixWorld);
    const q = G.camera.quaternion, v = new THREE.Vector3(rnd(1.6, 2.3), rnd(1.5, 2.2), rnd(0.2, 0.9)).applyQuaternion(q).add(G.player.vel);
    G.fx.casing(p, v);
  }
}
Weapon.MAG = MAG;


// ----------------------------------------------------------------------------------------- the sidearm
// A semi-automatic pistol: eight rounds, fast, half the rifle's punch. Same handling model as the rifle.
const PMAG = 8, P_MUZZLE = new THREE.Vector3(0.18, 0.066, 0), P_EJECT = new THREE.Vector3(0.03, 0.08, 0.014);
const PPOSE = { hip: { p: [0.088, -0.104, -0.285], r: [0.02, 0.07, -0.04] }, aim: { p: [0.0, -0.0782, -0.3], r: [0, 0, 0] }, sprint: { p: [0.12, -0.21, -0.3], r: [-0.6, 0.3, 0.1] } };

export class Pistol {
  constructor(G) {
    this.G = G; this.root = new THREE.Group(); this.gun = new THREE.Group(); this.root.add(this.gun); G.viewRoot.add(this.root);
    this.ammo = PMAG; this.state = 'ready'; this.t = 9; this.fovKick = 0; this.blockSprint = false; this.busyReload = false; this.dmg = 50; this.holster = 0; this.name = 'pistol'; this.mag = PMAG;
    this.kz = new Spring2(300, 22); this.kp = new Spring2(240, 18); this.kr = new Spring2(200, 15); this.ky = new Spring2(200, 16); this.jy = new Spring2(110, 12);
    this.lagX = 0; this.lagY = 0; this.time = 0; this.sprintBlockT = 0; this.shots = 0; this.hits = 0; this.flashT = 1; this.slideT = 1; this.lock = 0;
    this.pos = new THREE.Vector3(); this.eul = new THREE.Euler(); this.muzzleWorld = new THREE.Vector3(); this.onShot = null; this.want = 0;
  }
  async load(loader) {
    const G = this.G, gltf = await loader.loadAsync('./assets/pistol.glb'), m = gltf.scene; m.rotation.y = Math.PI / 2; this.model = m; this.gun.add(m);
    m.traverse((o) => { if (!o.isMesh && !o.isGroup) return; const n = o.name || ''; if (/_b$|magazine|bullet/.test(n)) o.visible = false; if (n.endsWith('slide_a')) this.slide = o; if (n.endsWith('hammer_a')) this.hammer = o; });
    this.slide0 = this.slide.position.clone();
    m.traverse((o) => { o.layers.set(1); if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; o.frustumCulled = false; G.world.dressDynamic(o.material); } });
    // the hand around the grip and the forearm behind it
    const M = G.world.materials, glove = M.set('glove', { color: 0x4a4038 }), sleeve = M.set('glove', { color: 0x2c3230 }); glove.roughness = 0.9; G.world.dressDynamic(glove); G.world.dressDynamic(sleeve);
    const cap = (r, len, pos, rot, mat = glove, sc) => { const mm = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, 12), mat); mm.position.fromArray(pos); if (rot) mm.rotation.set(rot[0], rot[1], rot[2]); if (sc) mm.scale.fromArray(sc); return mm; };
    const H = new THREE.Group();
    H.add(cap(0.026, 0.06, [-0.02, -0.012, 0.0], [0, 0, 0.28], glove, [1.15, 1, 1.25]));                       // palm and fingers wrapped round the grip
    for (let i = 0; i < 3; i++) H.add(cap(0.0105, 0.03, [0.012, -0.004 - i * 0.02, -0.004], [1.57, 0, 0.3]));   // knuckles at the front strap
    H.add(cap(0.0115, 0.03, [0.02, 0.03, -0.019], [0, 0, 1.45]));                                                // thumb along the frame
    H.add(cap(0.034, 0.03, [-0.05, -0.05, 0.004], [0.2, 0, 0.9], sleeve, [1, 1, 1.15]));
    const a = new THREE.Vector3(-0.045, -0.055, 0.006), b = new THREE.Vector3(-0.2, -0.3, 0.13), len = a.distanceTo(b), arm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.036, len, 16), sleeve);
    arm.position.copy(a).add(b).multiplyScalar(0.5); arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); H.add(arm);
    H.traverse((o) => { o.layers.set(1); if (o.isMesh) { o.frustumCulled = false; o.receiveShadow = true; } }); m.add(H);
    const tex = G.fx.flashTexture, mk = (w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({ uniforms: { map: { value: tex }, uA: { value: 1 }, lsHdr: G.fx.hdr }, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: `uniform sampler2D map; uniform float uA; varying vec2 vUv; ${HDR_GLSL} void main(){ vec3 c = texture2D( map, vUv ).rgb; vec2 q = abs( vUv - 0.5 ) * 2.0; float e = ( 1.0 - smoothstep( 0.7, 1.0, q.x ) ) * ( 1.0 - smoothstep( 0.6, 1.0, q.y ) ); gl_FragColor = vec4( lsEncode( c * c * 40.0 * uA * e ), 1.0 ); }` }));
    this.flash = new THREE.Group(); const f1 = mk(0.22, 0.12), f2 = mk(0.22, 0.12), f3 = mk(0.18, 0.18); f1.position.x = 0.09; f2.position.x = 0.09; f2.rotation.x = Math.PI / 2; f3.rotation.y = Math.PI / 2; f3.position.x = 0.02;
    this.flash.add(f1, f2, f3); this.flash.position.copy(P_MUZZLE); this.flash.visible = false; this.flash.traverse((o) => { o.layers.set(1); o.frustumCulled = false; o.renderOrder = 10; }); m.add(this.flash);
  }
  reset() { this.ammo = PMAG; this.state = 'ready'; this.t = 9; this.busyReload = false; this.shots = 0; this.hits = 0; this.lock = 0; this.want = 0; }
  onLand(f) { this.jy.kick(-0.9 * f); this.kp.kick(-1.0 * f); }
  startReload() { if (this.state !== 'ready' || this.ammo >= PMAG) return; this.state = 'reload'; this.t = 0; this.busyReload = true; this.rs = 0; this.G.audio && this.G.audio.reload(0); }
  updateMuzzle() { const G = this.G, v = this.muzzleWorld; this.model.updateWorldMatrix(true, false); v.copy(P_MUZZLE).applyMatrix4(this.model.matrixWorld).applyMatrix4(G.viewCam.matrixWorldInverse);
    const k = Math.tan(G.camera.fov * Math.PI / 360) / Math.tan(G.viewCam.fov * Math.PI / 360); v.x *= k; v.y *= k; v.applyMatrix4(G.camera.matrixWorld); }
  fire() {
    const G = this.G, pl = G.player, aim = pl.aimT; this.ammo--; this.shots++; this.sprintBlockT = 0.45; this.t = 0; this.slideT = 0; if (this.ammo === 0) this.lock = 1;
    const spread = (0.013 * (1 - aim) + 0.0028) * (1 + pl.speed * 0.25 + (pl.grounded ? 0 : 2));
    const d = pl.fwd.clone(), r = Math.sqrt(Math.random()) * spread, a = Math.random() * 6.283, right = new THREE.Vector3().crossVectors(d, G.camera.up).normalize(), up = new THREE.Vector3().crossVectors(right, d);
    d.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize(); this.updateMuzzle();
    if (this.onShot && this.onShot(pl.eye, d, this.muzzleWorld)) this.hits++;
    const k = 1 - 0.3 * aim; pl.kick(52 * k, rnd(-18, 18) * k, rnd(-20, 20)); pl.shake = Math.max(pl.shake, 0.3);
    this.kz.kick(1.2 * k); this.kp.kick(2.3 * k); this.kr.kick(rnd(-1.3, 1.3)); this.ky.kick(rnd(-0.5, 0.5)); this.fovKick = 1.0;
    this.flashT = 0; this.flash.visible = true; this.flash.rotation.x = rnd(6.28); const s = rnd(0.8, 1.2); this.flash.scale.set(s, s, s);
    G.fx.muzzle(this.muzzleWorld, d, 0.6); G.audio && G.audio.pistol();
    const p = new THREE.Vector3().copy(P_EJECT); p.applyMatrix4(this.model.matrixWorld).applyMatrix4(G.viewCam.matrixWorldInverse).applyMatrix4(G.camera.matrixWorld);
    G.fx.casing(p, new THREE.Vector3(rnd(1.4, 2.2), rnd(1.6, 2.4), rnd(-0.3, 0.5)).applyQuaternion(G.camera.quaternion).add(pl.vel), 0.55);
  }
  update(dt, input) {
    const G = this.G, pl = G.player; this.time += dt; this.t += dt; this.slideT += dt; const active = G.state === 'play' && !pl.dead;
    this.sprintBlockT -= dt; this.blockSprint = this.sprintBlockT > 0 || this.state === 'reload';
    // A click is remembered for a moment, so one made while running, or a hair too soon after the last shot, still fires instead of vanishing.
    if (active && input.fire) this.want = 0.35; else this.want -= dt;
    if (active && this.state === 'ready') {
      if (this.want > 0) { if (this.ammo <= 0) { this.want = 0; G.audio && G.audio.dry(); this.startReload(); } else if (pl.sprintT >= 0.4) this.sprintBlockT = 0.4; else if (this.t > 0.13) { this.want = 0; this.fire(); } }
      if (input.hit('KeyR')) this.startReload();
    }
    let ox = 0, oy = 0, rx = 0, rz = 0, ry = 0;
    if (this.state === 'reload') { const t = this.t, down = seg(t, 0, 0.3) - seg(t, 1.05, 1.4); oy = -0.2 * down; rx = 0.7 * down; rz = -0.5 * down; ry = 0.2 * down;
      if (this.rs === 0 && t > 0.38) { this.rs = 1; this.kp.kick(-1.2); G.audio && G.audio.reload(1); }
      if (this.rs === 1 && t > 0.9) { this.rs = 2; this.kp.kick(1.6); this.ammo = PMAG; G.audio && G.audio.reload(2); }
      if (this.rs === 2 && t > 1.3) { this.rs = 3; this.lock = 0; G.audio && G.audio.bolt(2); this.kz.kick(-0.4); }
      if (t > 1.5) { this.state = 'ready'; this.busyReload = false; this.t = 9; } }
    const sl = Math.max(this.lock, this.slideT < 0.035 ? this.slideT / 0.035 : Math.max(0, 1 - (this.slideT - 0.035) / 0.05));
    this.slide.position.copy(this.slide0); this.slide.position.x -= sl * 0.03;
    const hip = PPOSE.hip, aim = PPOSE.aim, spr = PPOSE.sprint, sT = smooth(pl.sprintT), aT = smooth(pl.aimT);
    const P = (i) => { const h = hip.p[i] + (spr.p[i] - hip.p[i]) * sT; return h + (aim.p[i] - h) * aT; }, R = (i) => { const h = hip.r[i] + (spr.r[i] - hip.r[i]) * sT; return h + (aim.r[i] - h) * aT; };
    this.lagX = damp(this.lagX + pl.lookDX, 0, 13, dt); this.lagY = damp(this.lagY + pl.lookDY, 0, 13, dt);
    const lx = clamp(this.lagX, -0.12, 0.12), ly = clamp(this.lagY, -0.1, 0.1), loose = 1 - 0.75 * aT, mv = pl.moveAmt * loose, bx = Math.sin(pl.bob) * 0.008 * mv, by = Math.sin(pl.bob * 2) * 0.006 * mv;
    const br = Math.sin(this.time * 1.5), sy = Math.sin(pl.yaw), cy = Math.cos(pl.yaw), strafe = pl.vel.x * cy - pl.vel.z * sy;
    this.kz.update(dt); this.kp.update(dt); this.kr.update(dt); this.ky.update(dt); this.jy.target = clamp(-pl.vel.y * 0.004, -0.03, 0.03); this.jy.update(dt);
    this.gun.position.set(P(0) + ox + bx - lx * 0.04 * loose - strafe * 0.002 * loose, P(1) + oy + by + ly * 0.035 * loose + br * 0.0015 * loose + this.jy.x * 0.6 - this.holster * 0.3, P(2) + this.kz.x * 0.03);
    this.gun.rotation.set(R(0) + rx + this.kp.x * 0.05 + ly * 0.4 * loose + this.jy.x - this.holster * 0.7, R(1) + ry + lx * 0.45 * loose + this.ky.x * 0.02, R(2) + rz + this.kr.x * 0.03 - strafe * 0.01 * loose - lx * 0.4 * loose, 'YXZ');
    this.fovKick = damp(this.fovKick, 0, 12, dt); this.flashT += dt;
    if (this.flash.visible) { const f = 1 - this.flashT / 0.04; if (f <= 0) this.flash.visible = false; else this.flash.children.forEach((c) => (c.material.uniforms.uA.value = f)); }
    G.viewCam.fov = 50 - 12 * aT; G.viewCam.updateProjectionMatrix();
  }
}

// Both weapons, and the business of swapping between them.
const NO_INPUT = { fire: false, aim: false, hit: () => false };
export class Arsenal {
  constructor(G) { this.G = G; this.rifle = new Weapon(G); this.pistol = new Pistol(G); this.list = [this.rifle, this.pistol]; this.cur = this.rifle; this.next = null; this.sw = 1; }
  async load(loader) { await Promise.all(this.list.map((w) => w.load(loader))); this.pistol.root.visible = false; }
  set onShot(f) { for (const w of this.list) w.onShot = (o, d, m) => f(o, d, m, w.dmg); }
  get ammo() { return this.cur.ammo; } get state() { return this.next ? 'switch' : this.cur.state; } get fovKick() { return this.cur.fovKick; } get blockSprint() { return this.cur.blockSprint; } get busyReload() { return this.cur.busyReload; }
  get kz() { return this.cur.kz; } get shots() { return this.rifle.shots + this.pistol.shots; } get hits() { return this.rifle.hits + this.pistol.hits; } get models() { return this.list.map((w) => w.model); }
  reset() { for (const w of this.list) { w.reset(); w.holster = 0; } this.cur = this.rifle; this.next = null; this.sw = 1; this.rifle.root.visible = true; this.pistol.root.visible = false; }
  onLand(f) { this.cur.onLand(f); }
  swap(w) { if (w === this.cur || this.next || this.cur.busyReload) return; this.next = w; this.sw = 0; this.G.audio && this.G.audio.swap(); }
  update(dt, input) {
    const G = this.G, active = G.state === 'play' && !G.player.dead;
    if (active) { if (input.hit('Digit1')) this.swap(this.rifle); if (input.hit('Digit2')) this.swap(this.pistol); if (input.hit('KeyQ') || input.wheel) this.swap(this.cur === this.rifle ? this.pistol : this.rifle); }
    if (this.next) { this.sw += dt / 0.46;
      if (this.sw >= 0.5 && this.cur !== this.next) { this.cur.root.visible = false; this.cur.holster = 0; this.cur = this.next; this.cur.root.visible = true; }
      this.cur.holster = this.sw < 0.5 ? smooth(this.sw * 2) : 1 - smooth((this.sw - 0.5) * 2);
      if (this.sw >= 1) { this.cur.holster = 0; this.next = null; } }
    this.cur.update(dt, this.next ? NO_INPUT : input);
    G.hud.setAmmo(this.cur.ammo, this.cur.mag, this.cur.name);
  }
}
