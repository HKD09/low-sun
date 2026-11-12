// Unattended capture: fixed camera shots, a camera tour of the route, and frame-time recording.
//   ?shot=hero1          park the camera on a named shot (no menu, no HUD)
//   ?tour=1              fly the route once and record frame times into window.__perf
//   ?res=2940x1840       force the drawing-buffer size, to measure at a full-window pixel count
import * as THREE from 'three';

// pos, yaw (degrees, 0 = north, positive = turn left), pitch (degrees), fov
export const SHOTS = {
  hero1: { pos: [2.4, 1.55, -19.6], yaw: -90, pitch: 1, fov: 52 },
  hero2: { pos: [24.2, 1.6, -23.4], yaw: -38, pitch: 9, fov: 62 },
  hero3: { pos: [41.2, 1.6, -31.0], yaw: -90, pitch: 3, fov: 50 },
  r01: { pos: [2.0, 1.66, -2.0], yaw: 0, pitch: 0, fov: 62 },
  r02: { pos: [2.0, 1.66, -11.0], yaw: 0, pitch: 0, fov: 62 },
  r03: { pos: [3.0, 1.66, -18.6], yaw: -75, pitch: 0, fov: 62 },
  r04: { pos: [14.0, 1.66, -19.4], yaw: -100, pitch: -4, fov: 62 },
  r05: { pos: [20.5, 1.66, -18.0], yaw: -25, pitch: 2, fov: 62 },
  r06: { pos: [31.0, 1.66, -20.5], yaw: 100, pitch: 0, fov: 62 },
  r07: { pos: [24.0, 1.66, -25.5], yaw: 0, pitch: 6, fov: 62 },
  r08: { pos: [18.0, 1.66, -29.0], yaw: -75, pitch: 10, fov: 62 },
  r09: { pos: [33.0, 1.66, -33.5], yaw: -150, pitch: 12, fov: 62 },
  r10: { pos: [38.5, 1.66, -42.5], yaw: -20, pitch: 2, fov: 62 },
  r11: { pos: [41.0, 1.66, -26.0], yaw: 55, pitch: 8, fov: 62 },
  r12: { pos: [27.0, 1.66, -43.4], yaw: 90, pitch: 14, fov: 62 },
  r13: { pos: [15.2, 5.86, -43.0], yaw: -120, pitch: -12, fov: 62 },
  r14: { pos: [15.3, 5.86, -27.0], yaw: -40, pitch: -8, fov: 62 },
  r15: { pos: [11.5, 5.86, -40.6], yaw: 150, pitch: -3, fov: 62 },
  r16: { pos: [8.0, 5.86, -31.0], yaw: -80, pitch: -4, fov: 62 },
  r17: { pos: [46.5, 1.66, -40.5], yaw: -125, pitch: 2, fov: 62 },
  r18: { pos: [57.5, 1.66, -24.5], yaw: 115, pitch: 6, fov: 62 },
  r19: { pos: [42.5, 1.66, -33.3], yaw: 0, pitch: -24, fov: 62 },
  r20: { pos: [42.4, -2.74, -41.6], yaw: 82, pitch: 0, fov: 62 },
  r21: { pos: [31.5, -2.74, -41.0], yaw: 60, pitch: 2, fov: 62 },
  r22: { pos: [17.2, -2.74, -40.9], yaw: -100, pitch: 2, fov: 62 },
};

// The route for the camera tour: the path a player takes, as eye positions.
export const ROUTE = [
  [2, 1.66, -1.6], [2, 1.66, -14], [3.2, 1.66, -18.6], [12, 1.66, -19.2], [22, 1.66, -19], [24, 1.66, -22.5], [24.5, 1.66, -28], [32, 1.66, -31], [40, 1.66, -43.9],
  [41, 1.66, -37], [41.2, 1.66, -33.2], [42.5, 1.66, -33.6], [42.5, -2.74, -40.2], [42.3, -2.74, -41.5], [36.5, -2.74, -41.5], [28.5, -2.74, -42.2], [20.5, -2.74, -41.6], [28.5, -2.74, -42.4], [39, -2.74, -41.5],
  [42.5, -2.74, -41.2], [42.5, -2.74, -40.2], [42.5, 1.66, -33.6], [40, 1.66, -33],
  [30, 1.66, -44.2], [28.6, 1.66, -45.2], [17.4, 5.86, -45.2], [15.2, 5.86, -44], [15.2, 5.86, -41.3], [12.5, 5.86, -41.2], [8, 5.86, -35], [12.5, 5.86, -41.2], [15.2, 5.86, -41.3],
  [15.2, 5.86, -45.2], [17.4, 5.86, -45.2], [28.6, 1.66, -45.2], [36, 1.66, -33], [43, 1.66, -31], [50, 1.66, -31], [57, 1.66, -33],
];

export class Capture {
  constructor(G) {
    this.G = G; this.mode = null; this.times = []; this.t = 0;
    const p = G.params;
    if (p.get('shot')) { this.mode = 'shot'; this.shot = p.get('shot'); }
    else if (p.has('tour')) { this.mode = 'tour'; this.speed = +(p.get('speed') || 4.3); this.loops = +(p.get('loops') || 1); }
    if (this.mode) document.body.classList.add('is-capture');
    if (p.has('ui')) document.body.classList.remove('is-capture');
    this.curve = new THREE.CatmullRomCurve3(ROUTE.map((a) => new THREE.Vector3(...a)), false, 'catmullrom', 0.15);
    this.len = this.curve.getLength(); this.look = new THREE.Vector3(); this.done = false;
  }
  setShot(name) {
    const s = SHOTS[name]; if (!s) return false; const cam = this.G.camera;
    cam.position.fromArray(s.pos); cam.rotation.set(s.pitch * Math.PI / 180, s.yaw * Math.PI / 180, 0, 'YXZ'); cam.fov = s.fov; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    this.G.player.pos.set(s.pos[0], s.pos[1] - 1.66, s.pos[2]); this.G.player.eye.copy(cam.position);
    this.mode = 'shot'; this.shot = name; return true;
  }
  update(dt, rawMs) {
    const G = this.G, cam = G.camera;
    if (this.mode === 'shot') { this.setShot(this.shot); return; }
    if (this.mode !== 'tour') return;
    this.t += dt;
    const total = this.len / this.speed, u = (this.t / total) % 1, lap = Math.floor(this.t / total);
    if (lap >= this.loops && !this.done) { this.done = true; this.finish(); }
    const p = this.curve.getPointAt(u), a = this.curve.getPointAt(Math.min(1, u + 3.5 / this.len));
    cam.position.copy(p); this.look.lerp(a, 1 - Math.exp(-dt * 4)); if (this.t < 0.1) this.look.copy(a);
    const d = this.look.clone().sub(p); const yaw = Math.atan2(-d.x, -d.z), pitch = Math.atan2(d.y, Math.hypot(d.x, d.z)) * 0.6;
    cam.rotation.set(pitch, yaw + Math.sin(this.t * 0.35) * 0.5, 0, 'YXZ'); cam.fov = 62; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    G.player.pos.set(p.x, p.y - 1.66, p.z); G.player.eye.copy(p);
    if (this.t > 1 && !this.done) this.times.push(rawMs);
  }
  finish() {
    const t = this.times.slice().sort((a, b) => a - b), n = t.length; if (!n) return;
    const avg = t.reduce((a, b) => a + b, 0) / n, p99 = t[Math.floor(n * 0.99)], worst1 = t.slice(Math.floor(n * 0.99)).reduce((a, b) => a + b, 0) / Math.max(1, n - Math.floor(n * 0.99));
    const hitches = this.times.filter((x) => x > 33.4).length;
    const r = this.G.renderer.getDrawingBufferSize(new THREE.Vector2());
    window.__perf = { frames: n, avgMs: +avg.toFixed(2), avgFps: +(1000 / avg).toFixed(1), p50Ms: +t[n >> 1].toFixed(2), p99Ms: +p99.toFixed(2), worst1pctMs: +worst1.toFixed(2), worst1pctFps: +(1000 / worst1).toFixed(1), maxMs: +t[n - 1].toFixed(2), hitchesOver33ms: hitches,
      buffer: `${r.x}x${r.y}`, internal: `${this.G.pipeline.iw}x${this.G.pipeline.ih}`, quality: this.G.quality, calls: this.G.info?.calls, tris: this.G.info?.tris };
    console.log('PERF ' + JSON.stringify(window.__perf));
  }
}
