// Transient effects: muzzle light, tracers, impacts, decals, debris, casings, smoke.
import * as THREE from 'three';
import { rnd, clamp } from './physics.js';
import { HDR_GLSL } from './materials.js';

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const flashTex = () => canvasTex(256, 128, (g, w, h) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'lighter';
  let r = g.createRadialGradient(40, 64, 0, 40, 64, 58); r.addColorStop(0, 'rgba(255,244,214,1)'); r.addColorStop(0.3, 'rgba(255,190,96,.75)'); r.addColorStop(1, 'rgba(255,90,10,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {       // tongues of flame thrown forward
    const a = (Math.random() - 0.5) * 0.9, len = 70 + Math.random() * 150, wd = 3 + Math.random() * 9;
    g.save(); g.translate(30, 64); g.rotate(a * 0.42);
    const lg = g.createLinearGradient(0, 0, len, 0); lg.addColorStop(0, 'rgba(255,232,180,.55)'); lg.addColorStop(0.5, 'rgba(255,150,50,.28)'); lg.addColorStop(1, 'rgba(255,80,10,0)');
    g.fillStyle = lg; g.beginPath(); g.moveTo(0, -wd); g.quadraticCurveTo(len * 0.5, -wd * 1.4, len, 0); g.quadraticCurveTo(len * 0.5, wd * 1.4, 0, wd); g.fill(); g.restore();
  }
});
const puffTex = () => canvasTex(128, 128, (g, w) => {
  g.clearRect(0, 0, w, w);
  for (let i = 0; i < 28; i++) {
    const x = 64 + (Math.random() - 0.5) * 52, y = 64 + (Math.random() - 0.5) * 52, r = 14 + Math.random() * 26, d = Math.hypot(x - 64, y - 64);
    const k = clamp(1 - (d + r) / 64, 0, 1); if (k <= 0) continue;
    const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, `rgba(255,255,255,${0.16 * k + 0.05})`); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
}, false);
const holeTex = (metal) => canvasTex(128, 128, (g) => {
  g.clearRect(0, 0, 128, 128);
  if (!metal) {
    for (let i = 0; i < 40; i++) {          // pale chipped rim
      const a = Math.random() * 6.283, d = 14 + Math.random() * 26, r = 3 + Math.random() * 9;
      g.fillStyle = `rgba(${188 + Math.random() * 40 | 0},${180 + Math.random() * 36 | 0},${166 + Math.random() * 30 | 0},${0.25 + Math.random() * 0.4})`;
      g.beginPath(); g.ellipse(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, r, r * (0.5 + Math.random() * 0.5), a, 0, 7); g.fill();
    }
    g.strokeStyle = 'rgba(20,18,16,.55)'; g.lineWidth = 1;
    for (let i = 0; i < 6; i++) { const a = Math.random() * 6.283; let x = 64 + Math.cos(a) * 9, y = 64 + Math.sin(a) * 9; g.beginPath(); g.moveTo(x, y);
      for (let j = 0; j < 4; j++) { x += Math.cos(a + (Math.random() - 0.5)) * 9; y += Math.sin(a + (Math.random() - 0.5)) * 9; g.lineTo(x, y); } g.stroke(); }
    const rg = g.createRadialGradient(64, 64, 2, 64, 64, 24); rg.addColorStop(0, 'rgba(8,7,6,.98)'); rg.addColorStop(0.45, 'rgba(26,23,20,.9)'); rg.addColorStop(0.8, 'rgba(60,54,48,.35)'); rg.addColorStop(1, 'rgba(60,54,48,0)');
    g.fillStyle = rg; g.beginPath();
    for (let i = 0; i <= 14; i++) { const a = i / 14 * 6.283, r = 17 + Math.random() * 8; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); } g.fill();
  } else {
    let rg = g.createRadialGradient(64, 64, 8, 64, 64, 54); rg.addColorStop(0, 'rgba(10,9,8,.6)'); rg.addColorStop(1, 'rgba(10,9,8,0)'); g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
    rg = g.createRadialGradient(60, 60, 4, 64, 64, 22); rg.addColorStop(0, 'rgba(6,6,6,1)'); rg.addColorStop(0.5, 'rgba(30,30,32,.95)'); rg.addColorStop(0.78, 'rgba(214,214,220,.9)'); rg.addColorStop(1, 'rgba(120,120,126,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(64, 64, 22, 0, 7); g.fill();
  }
});

const MAXP = 700;
class Particles {
  constructor(scene, tex, additive, hdr) {
    const g = new THREE.InstancedBufferGeometry(); g.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 3), 3); this.aPar = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 3), 3); this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 3), 3);
    for (const a of [this.aPos, this.aPar, this.aCol, this.aVel]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iPar', this.aPar); g.setAttribute('iCol', this.aCol); g.setAttribute('iVel', this.aVel);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, lsHdr: hdr },
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute vec3 iPos; attribute vec4 iPar; attribute vec3 iCol; attribute vec3 iVel; varying vec2 vUv; varying vec4 vCol; varying float vZ;
        void main(){ vec4 mv = viewMatrix * vec4(iPos,1.0); vec2 q = position.xy; float c = cos(iPar.y), s = sin(iPar.y);
          vec2 off = vec2(q.x*c - q.y*s, q.x*s + q.y*c) * iPar.x;
          if (iPar.w > 0.0) { vec3 vv = (viewMatrix * vec4(iVel,0.0)).xyz; float l = length(vv.xy); vec2 d = l > 1e-4 ? vv.xy / l : vec2(1.0,0.0);
            off = d * q.x * (iPar.x + l * iPar.w) + vec2(-d.y, d.x) * q.y * iPar.x; }
          mv.xy += off; vZ = -mv.z; gl_Position = projectionMatrix * mv; vUv = position.xy + 0.5; vCol = vec4(iCol, iPar.z); }`,
      fragmentShader: additive
        ? `varying vec2 vUv; varying vec4 vCol; ${HDR_GLSL} void main(){ vec2 p = vUv - 0.5; float a = smoothstep(0.5, 0.0, length(p * vec2(1.0, 2.2))); gl_FragColor = vec4(lsEncode(vCol.rgb * a * a * vCol.a), 1.0); }`
        : `uniform sampler2D map; varying vec2 vUv; varying vec4 vCol; varying float vZ; ${HDR_GLSL}
           void main(){ float a = texture2D(map, vUv).a * vCol.a * smoothstep(0.12, 0.5, vZ); gl_FragColor = vec4(lsEncode(vCol.rgb), a); }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 6 : 5; scene.add(this.mesh);
    this.n = 0; this.P = [];
  }
  // p: {x,y,z,vx,vy,vz,size,grow,rot,spin,life,r,g,b,a,drag,grav,stretch}
  add(p) { if (this.P.length >= MAXP) this.P.shift(); p.t = 0; this.P.push(p); }
  update(dt) {
    const P = this.P, pos = this.aPos.array, par = this.aPar.array, col = this.aCol.array, vel = this.aVel.array; let n = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i]; p.t += dt; if (p.t >= p.life) continue;
      const dr = Math.exp(-(p.drag || 0) * dt); p.vx *= dr; p.vy = p.vy * dr - (p.grav || 0) * dt; p.vz *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.size += (p.grow || 0) * dt; p.rot += (p.spin || 0) * dt;
      if (p.floor !== undefined && p.y < p.floor) { p.y = p.floor; p.vy = -p.vy * 0.35; p.vx *= 0.6; p.vz *= 0.6; }
      const k = p.t / p.life, fade = p.fadeIn ? Math.min(1, p.t / p.fadeIn) * (1 - k * k) : 1 - k * k;
      pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z; par[n * 4] = p.size; par[n * 4 + 1] = p.rot; par[n * 4 + 2] = p.a * fade; par[n * 4 + 3] = p.stretch || 0;
      col[n * 3] = p.r; col[n * 3 + 1] = p.g; col[n * 3 + 2] = p.b; vel[n * 3] = p.vx; vel[n * 3 + 1] = p.vy; vel[n * 3 + 2] = p.vz;
      P[n++] = p;
    }
    P.length = n; this.mesh.geometry.instanceCount = n; this.mesh.visible = n > 0;
    this.aPos.needsUpdate = this.aPar.needsUpdate = this.aCol.needsUpdate = this.aVel.needsUpdate = true;
  }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), _c = new THREE.Color();

export class FX {
  constructor(G) {
    this.G = G; const scene = G.scene;
    this.flashTexture = flashTex();
    const hdr = G.world.materials.shared.lsHdr; this.hdr = hdr;
    this.puffs = new Particles(scene, puffTex(), false, hdr); this.sparks = new Particles(scene, null, true, hdr);
    // decals
    this.decals = {};
    for (const [k, metal] of [['concrete', false], ['metal', true]]) {
      const mat = new THREE.MeshStandardMaterial({ map: holeTex(metal), transparent: true, depthWrite: false, roughness: metal ? 0.45 : 0.95, metalness: metal ? 0.7 : 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      G.world.dressDynamic(mat, 'decal');
      const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, 96); im.count = 0; im.frustumCulled = false; im.renderOrder = 2; im.receiveShadow = true; scene.add(im);
      this.decals[k] = { im, i: 0 };
    }
    // lights: one for the muzzle, a few for sentry shots and explosions. Always present so shaders never recompile.
    this.lights = [];
    for (let i = 0; i < 3; i++) { const l = new THREE.PointLight(0xffc27a, 0, 16, 2); l.layers.enableAll(); l.userData = { t: 1, life: 0.06, peak: 0 }; scene.add(l); this.lights.push(l); }
    // tracers
    this.tracers = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uCol: { value: new THREE.Color(1, 0.8, 0.5) }, uA: { value: 0 }, lsHdr: hdr }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 uCol; uniform float uA; varying vec2 vUv; ${HDR_GLSL} void main(){ float a = smoothstep(0.5,0.0,abs(vUv.y-0.5)) * smoothstep(0.0,0.25,vUv.x) * uA; gl_FragColor = vec4(lsEncode(uCol*a),1.0); }` }));
      m.visible = false; m.frustumCulled = false; m.userData = { t: 1, life: 0.1 }; scene.add(m); this.tracers.push(m);
    }
    // debris chunks
    const dg = new THREE.TetrahedronGeometry(1, 0);
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x8d877c, roughness: 0.95 }); G.world.dressDynamic(this.debrisMat, 'debris');
    this.debris = new THREE.InstancedMesh(dg, this.debrisMat, 90); this.debris.count = 0; this.debris.frustumCulled = false; this.debris.castShadow = false; scene.add(this.debris);
    this.D = [];
    // casings
    this.casings = []; this.casingGeo = new THREE.CylinderGeometry(0.006, 0.0062, 0.054, 10);
    this.casingMat = new THREE.MeshStandardMaterial({ color: 0xb08a3c, roughness: 0.32, metalness: 1 }); G.world.dressDynamic(this.casingMat, 'debris');
  }

  light(pos, color, peak, life = 0.07, dist = 16) {
    let l = this.lights[0]; for (const c of this.lights) if (c.userData.t >= c.userData.life) { l = c; break; }
    l.position.copy(pos); l.color.set(color); l.distance = dist; l.userData.t = 0; l.userData.life = life; l.userData.peak = peak; l.intensity = peak; return l;
  }

  muzzle(pos, dir, power = 1) {
    this.light(_p.copy(pos).addScaledVector(dir, 0.25), 0xffb86a, 140 * power, 0.075, 22);
    const amb = this.G.world.ambientAt(pos, _c);
    for (let i = 0; i < 5; i++) { const s = rnd(1.5, 5); this.puffs.add({ x: pos.x + dir.x * 0.1, y: pos.y + dir.y * 0.1, z: pos.z + dir.z * 0.1, vx: dir.x * s + rnd(-0.5, 0.5), vy: dir.y * s + rnd(-0.2, 0.6), vz: dir.z * s + rnd(-0.5, 0.5),
      size: rnd(0.05, 0.1), grow: rnd(0.35, 0.8), rot: rnd(6.28), spin: rnd(-1, 1), life: rnd(0.5, 1.3), r: amb.r * 0.75 + 0.02, g: amb.g * 0.75 + 0.02, b: amb.b * 0.75 + 0.02, a: 0.2, drag: 4.5, grav: -0.25, fadeIn: 0.03 }); }
    for (let i = 0; i < 5; i++) { const s = rnd(8, 22); this.sparks.add({ x: pos.x, y: pos.y, z: pos.z, vx: dir.x * s + rnd(-3, 3), vy: dir.y * s + rnd(-3, 3), vz: dir.z * s + rnd(-3, 3), size: 0.012, life: rnd(0.04, 0.1), r: 9, g: 5, b: 1.6, a: 1, drag: 6, stretch: 0.02, rot: 0 }); }
  }

  tracer(a, b, color = 0xffd9a0, width = 0.022, life = 0.09) {
    let m = this.tracers[0]; for (const c of this.tracers) if (!c.visible) { m = c; break; }
    const len = a.distanceTo(b); if (len < 0.5) return;
    m.position.copy(a).add(b).multiplyScalar(0.5); m.userData.a = a.clone(); m.userData.b = b.clone(); m.userData.w = width; m.userData.t = 0; m.userData.life = life;
    m.material.uniforms.uCol.value.set(color).multiplyScalar(3); m.visible = true; this._aimTracer(m);
  }
  _aimTracer(m) {
    const a = m.userData.a, b = m.userData.b, cam = this.G.camera.position;
    const x = _p.subVectors(b, a); const len = x.length(); x.multiplyScalar(1 / len);
    const y = _n.subVectors(cam, m.position).cross(x).normalize(); const z = _s.crossVectors(x, y);
    _m.makeBasis(x, y, z); m.quaternion.setFromRotationMatrix(_m); m.scale.set(len, m.userData.w, 1);
  }

  decal(point, normal, surf) {
    const d = this.decals[surf === 'metal' || surf === 'grate' || surf === 'drone' ? 'metal' : 'concrete'];
    _q.setFromUnitVectors(_z, normal); const r = new THREE.Quaternion().setFromAxisAngle(_z, rnd(6.28)); _q.multiply(r);
    const s = surf === 'concrete' ? rnd(0.13, 0.2) : rnd(0.07, 0.1);
    _m.compose(_p.copy(point).addScaledVector(normal, 0.004), _q, _s.set(s, s, s));
    d.im.setMatrixAt(d.i, _m); d.i = (d.i + 1) % 96; d.im.count = Math.min(96, d.im.count + 1); d.im.instanceMatrix.needsUpdate = true;
  }

  // A bullet strikes a surface. dir is the incoming direction.
  impact(point, normal, surf, dir, power = 1) {
    const G = this.G, amb = G.world.ambientAt(point, _c), lit = G.world.sunAt(point) ? 1 : 0;
    const refl = _n.copy(dir).reflect(normal);
    const metal = surf === 'metal' || surf === 'grate' || surf === 'drone';
    const sunC = G.world.sunColor;
    const dr = (surf === 'glass' ? 0.8 : 0.52) , dg = dr * 0.96, db = dr * 0.9;
    const cr = dr * (amb.r + lit * sunC.r * 0.5), cg = dg * (amb.g + lit * sunC.g * 0.5), cb = db * (amb.b + lit * sunC.b * 0.5);
    if (surf !== 'drone') this.decal(point, normal, surf);
    const nDust = metal ? 4 : 13;
    for (let i = 0; i < nDust * power; i++) {
      const s = rnd(0.6, metal ? 2.5 : 4.2), sp = 0.9;
      this.puffs.add({ x: point.x + normal.x * 0.03, y: point.y + normal.y * 0.03, z: point.z + normal.z * 0.03,
        vx: normal.x * s + rnd(-sp, sp), vy: normal.y * s + rnd(-sp, sp) + 0.3, vz: normal.z * s + rnd(-sp, sp),
        size: rnd(0.06, 0.14), grow: rnd(0.5, 1.5), rot: rnd(6.28), spin: rnd(-1.2, 1.2), life: rnd(0.6, metal ? 1.1 : 2.4), r: cr, g: cg, b: cb, a: metal ? 0.22 : rnd(0.28, 0.5), drag: 3.6, grav: 0.35, fadeIn: 0.02 });
    }
    const nSp = metal ? 22 : surf === 'glass' ? 6 : 5;
    for (let i = 0; i < nSp * power; i++) {
      const s = rnd(3, metal ? 17 : 8), k = metal ? 0.75 : 0.3;
      this.sparks.add({ x: point.x, y: point.y, z: point.z, vx: (refl.x * k + normal.x * (1 - k)) * s + rnd(-3.5, 3.5), vy: (refl.y * k + normal.y * (1 - k)) * s + rnd(-3.5, 3.5), vz: (refl.z * k + normal.z * (1 - k)) * s + rnd(-3.5, 3.5),
        size: rnd(0.008, 0.016), life: rnd(0.12, metal ? 0.55 : 0.25), r: 10, g: rnd(4, 6), b: 1.2, a: 1, drag: 1.2, grav: 9, stretch: 0.028, rot: 0 });
    }
    if (metal) this.light(_p.copy(point).addScaledVector(normal, 0.15), 0xffa860, 14, 0.09, 6);
    if (!metal && surf !== 'glass') {
      for (let i = 0; i < 8 * power; i++) {
        if (this.D.length >= 90) this.D.shift();
        const s = rnd(1.5, 5.5);
        this.D.push({ p: new THREE.Vector3().copy(point).addScaledVector(normal, 0.03), v: new THREE.Vector3(normal.x * s + rnd(-1.6, 1.6), normal.y * s + rnd(-1, 2.4), normal.z * s + rnd(-1.6, 1.6)),
          q: new THREE.Quaternion().random(), w: new THREE.Vector3(rnd(-18, 18), rnd(-18, 18), rnd(-18, 18)), s: rnd(0.007, 0.024), t: 0, life: rnd(4, 9), rest: false });
      }
    }
    G.audio && G.audio.impact(point, surf);
  }

  casing(pos, vel, scale = 1) {
    let c = this.casings.find((x) => x.t > 12);
    if (!c) { if (this.casings.length < 8) { c = { mesh: new THREE.Mesh(this.casingGeo, this.casingMat) }; c.mesh.castShadow = true; this.G.scene.add(c.mesh); this.casings.push(c); } else c = this.casings.reduce((a, b) => (a.t > b.t ? a : b)); }
    c.p = pos.clone(); c.v = vel.clone(); c.w = new THREE.Vector3(rnd(-25, 25), rnd(-10, 10), rnd(-25, 25)); c.t = 0; c.bounces = 0; c.rest = false; c.mesh.visible = true; c.mesh.scale.setScalar(scale); c.mesh.quaternion.random();
  }

  explosion(pos, scale = 1) {
    const G = this.G, amb = G.world.ambientAt(pos, _c);
    this.light(pos, 0xff9a50, 260 * scale, 0.22, 26 * scale);
    for (let i = 0; i < 46 * scale; i++) { const a = rnd(6.28), b = Math.acos(rnd(-1, 1)), s = rnd(4, 22);
      this.sparks.add({ x: pos.x, y: pos.y, z: pos.z, vx: Math.sin(b) * Math.cos(a) * s, vy: Math.cos(b) * s + 3, vz: Math.sin(b) * Math.sin(a) * s, size: rnd(0.012, 0.03), life: rnd(0.3, 1.1), r: 12, g: rnd(4, 7), b: 1.4, a: 1, drag: 1.4, grav: 9, stretch: 0.03, rot: 0 }); }
    for (let i = 0; i < 22 * scale; i++) { const s = rnd(0.5, 4);
      this.puffs.add({ x: pos.x + rnd(-0.2, 0.2) * scale, y: pos.y + rnd(-0.2, 0.2) * scale, z: pos.z + rnd(-0.2, 0.2) * scale, vx: rnd(-1, 1) * s, vy: rnd(-0.4, 1.4) * s, vz: rnd(-1, 1) * s,
        size: rnd(0.25, 0.5) * scale, grow: rnd(0.7, 1.8) * scale, rot: rnd(6.28), spin: rnd(-0.8, 0.8), life: rnd(1.2, 3.4), r: 0.06 + amb.r * 0.25, g: 0.055 + amb.g * 0.25, b: 0.05 + amb.b * 0.25, a: rnd(0.4, 0.7), drag: 2.2, grav: -0.5, fadeIn: 0.04 }); }
    for (let i = 0; i < 6 * scale; i++) this.puffs.add({ x: pos.x, y: pos.y, z: pos.z, vx: rnd(-2, 2), vy: rnd(-1, 2), vz: rnd(-2, 2), size: 0.4 * scale, grow: 3, rot: rnd(6.28), life: 0.16, r: 14, g: 7, b: 2, a: 0.9, drag: 3 });
  }

  beamSpark(p, n) { for (let i = 0; i < 3; i++) { const s = rnd(2, 9); this.sparks.add({ x: p.x, y: p.y, z: p.z, vx: n.x * s + rnd(-3, 3), vy: n.y * s + rnd(-2, 4), vz: n.z * s + rnd(-3, 3), size: rnd(0.01, 0.02), life: rnd(0.15, 0.5), r: 12, g: 3, b: 1, a: 1, drag: 1.2, grav: 9, stretch: 0.03, rot: 0 }); }
    if (Math.random() < 0.3) this.light(_p.copy(p).addScaledVector(n, 0.2), 0xff3a1a, 30, 0.08, 9); }
  smoke(pos, amount = 1, dark = 0.1) {
    const amb = this.G.world.ambientAt(pos, _c);
    this.puffs.add({ x: pos.x, y: pos.y, z: pos.z, vx: rnd(-0.2, 0.2), vy: rnd(0.3, 0.8), vz: rnd(-0.2, 0.2), size: rnd(0.1, 0.18), grow: rnd(0.25, 0.5), rot: rnd(6.28), spin: rnd(-0.6, 0.6), life: rnd(1.2, 2.4),
      r: dark + amb.r * 0.3, g: dark + amb.g * 0.3, b: dark + amb.b * 0.3, a: 0.4 * amount, drag: 0.6, grav: -0.3, fadeIn: 0.15 });
  }

  update(dt) {
    const G = this.G, col = G.col;
    for (const l of this.lights) { const u = l.userData; if (u.t < u.life) { u.t += dt; const k = Math.max(0, 1 - u.t / u.life); l.intensity = u.peak * k * k; } else l.intensity = 0; }
    for (const m of this.tracers) if (m.visible) { const u = m.userData; u.t += dt; if (u.t >= u.life) m.visible = false; else { m.material.uniforms.uA.value = 1 - u.t / u.life; this._aimTracer(m); } }
    this.puffs.update(dt); this.sparks.update(dt);
    // debris
    let n = 0; const D = this.D;
    for (let i = 0; i < D.length; i++) {
      const d = D[i]; d.t += dt; if (d.t > d.life) continue;
      if (!d.rest) {
        d.v.y -= 16 * dt; d.p.addScaledVector(d.v, dt);
        _q.set(d.w.x * dt * 0.5, d.w.y * dt * 0.5, d.w.z * dt * 0.5, 1).normalize(); d.q.premultiply(_q);
        if (col.resolveSphere(d.p, d.s * 0.7, _n)) { const vn = d.v.dot(_n); if (vn < 0) d.v.addScaledVector(_n, -1.4 * vn); d.v.multiplyScalar(0.55); d.w.multiplyScalar(0.5); if (d.v.lengthSq() < 0.15 && _n.y > 0.7) d.rest = true; }
      }
      const fade = Math.min(1, (d.life - d.t) * 2);
      _m.compose(d.p, d.q, _s.setScalar(d.s * fade)); this.debris.setMatrixAt(n, _m); D[n++] = d;
    }
    D.length = n; this.debris.count = n; this.debris.instanceMatrix.needsUpdate = true;
    for (const c of this.casings) {
      c.t += dt; if (c.t > 12) { c.mesh.visible = false; continue; }
      if (!c.rest) {
        c.v.y -= 15 * dt; c.p.addScaledVector(c.v, dt);
        _q.set(c.w.x * dt * 0.5, c.w.y * dt * 0.5, c.w.z * dt * 0.5, 1).normalize(); c.mesh.quaternion.premultiply(_q);
        if (col.resolveSphere(c.p, 0.012, _n)) { const vn = c.v.dot(_n); if (vn < 0) { c.v.addScaledVector(_n, -1.45 * vn); if (vn < -0.8) G.audio && G.audio.casing(c.p, c.bounces); c.bounces++; }
          c.v.multiplyScalar(0.62); c.w.multiplyScalar(0.6); if (c.bounces > 1 && c.v.lengthSq() < 0.1 && _n.y > 0.7) { c.rest = true; c.mesh.rotation.set(Math.PI / 2, 0, rnd(6.28)); } }
      }
      c.mesh.position.copy(c.p);
    }
  }
}
