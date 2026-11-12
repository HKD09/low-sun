// Collision world: axis-aligned boxes and vertical cylinders. Small enough to test by brute force.
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class Colliders {
  constructor(list) {
    this.boxes = [];
    this.cyls = [];
    for (const c of list) this.add(c);
  }
  add(c) {
    if (c.t === 'box') { const b = { a: c.a.slice(), b: c.b.slice(), surf: c.surf || 'concrete', on: true }; this.boxes.push(b); return b; }
    const y = { x: c.c[0], z: c.c[1], r: c.r, y0: c.y0, y1: c.y1, surf: c.surf || 'metal', on: true }; this.cyls.push(y); return y;
  }

  // Push a vertical cylinder (the player) out of everything that overlaps the height range [y0, y1].
  // Colliders whose top is at or below stepY are treated as steps, not walls.
  resolveCircle(pos, r, y0, y1, stepY) {
    let hit = false;
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (const b of this.boxes) {
        if (!b.on || b.b[1] <= stepY || b.a[1] >= y1 || b.b[1] <= y0) continue;
        const cx = Math.max(b.a[0], Math.min(pos.x, b.b[0])), cz = Math.max(b.a[2], Math.min(pos.z, b.b[2]));
        let dx = pos.x - cx, dz = pos.z - cz; const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) { const d = Math.sqrt(d2), k = (r - d) / d; pos.x += dx * k; pos.z += dz * k; }
        else { // centre is inside: leave by the nearest face
          const l = pos.x - b.a[0], rr = b.b[0] - pos.x, n = pos.z - b.a[2], f = b.b[2] - pos.z, m = Math.min(l, rr, n, f);
          if (m === l) pos.x = b.a[0] - r; else if (m === rr) pos.x = b.b[0] + r; else if (m === n) pos.z = b.a[2] - r; else pos.z = b.b[2] + r;
        }
        moved = hit = true;
      }
      for (const c of this.cyls) {
        if (!c.on || c.y1 <= stepY || c.y0 >= y1 || c.y1 <= y0) continue;
        let dx = pos.x - c.x, dz = pos.z - c.z; const R = r + c.r, d2 = dx * dx + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) || 1e-5; pos.x = c.x + dx / d * R; pos.z = c.z + dz / d * R; moved = hit = true;
      }
      if (!moved) break;
    }
    return hit;
  }

  // Highest surface under a circle whose top is no higher than maxY. Returns null over a void.
  groundAt(x, z, r, maxY) {
    let best = -Infinity, surf = null;
    for (const b of this.boxes) {
      if (!b.on || b.b[1] > maxY || b.b[1] <= best) continue;
      const cx = Math.max(b.a[0], Math.min(x, b.b[0])), cz = Math.max(b.a[2], Math.min(z, b.b[2]));
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < r * r) { best = b.b[1]; surf = b.surf; }
    }
    for (const c of this.cyls) {
      if (!c.on || c.y1 > maxY || c.y1 <= best) continue;
      const dx = x - c.x, dz = z - c.z, R = r + c.r;
      if (dx * dx + dz * dz < R * R) { best = c.y1; surf = c.surf; }
    }
    return surf ? { y: best, surf } : null;
  }

  ceilingAt(x, z, r, minY) {
    let best = Infinity;
    for (const b of this.boxes) {
      if (!b.on || b.a[1] < minY || b.a[1] >= best) continue;
      const cx = Math.max(b.a[0], Math.min(x, b.b[0])), cz = Math.max(b.a[2], Math.min(z, b.b[2]));
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < r * r) best = b.a[1];
    }
    return best;
  }

  // Push a sphere out of the world (drones, debris). Returns true if it touched something; n receives the last normal.
  resolveSphere(p, r, n) {
    let hit = false;
    for (const b of this.boxes) {
      if (!b.on || b.surf === 'edge') continue;
      const cx = Math.max(b.a[0], Math.min(p.x, b.b[0])), cy = Math.max(b.a[1], Math.min(p.y, b.b[1])), cz = Math.max(b.a[2], Math.min(p.z, b.b[2]));
      const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) { const d = Math.sqrt(d2), k = (r - d) / d; p.x += dx * k; p.y += dy * k; p.z += dz * k; if (n) n.set(dx / d, dy / d, dz / d); }
      else { p.y = b.b[1] + r; if (n) n.set(0, 1, 0); }
      hit = true;
    }
    for (const c of this.cyls) {
      if (!c.on || p.y - r > c.y1 || p.y + r < c.y0) continue;
      const dx = p.x - c.x, dz = p.z - c.z, R = r + c.r, d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      if (p.y > c.y1) { p.y = c.y1 + r; if (n) n.set(0, 1, 0); }
      else { const d = Math.sqrt(d2) || 1e-5; p.x = c.x + dx / d * R; p.z = c.z + dz / d * R; if (n) n.set(dx / d, 0, dz / d); }
      hit = true;
    }
    return hit;
  }

  // Ray against all colliders. Returns distance (or Infinity). Used for line of sight and cheap sweeps.
  raycast(o, d, far = 1e9, out) {
    let best = far, bn = null, bs = null;
    const ix = 1 / (d.x || 1e-9), iy = 1 / (d.y || 1e-9), iz = 1 / (d.z || 1e-9);
    for (const b of this.boxes) {
      if (!b.on || b.surf === 'edge') continue;
      let t0 = (b.a[0] - o.x) * ix, t1 = (b.b[0] - o.x) * ix; let ax = 0, sg = t0 < t1 ? -1 : 1;
      let tmin = Math.min(t0, t1), tmax = Math.max(t0, t1);
      t0 = (b.a[1] - o.y) * iy; t1 = (b.b[1] - o.y) * iy;
      let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      if (lo > tmin) { tmin = lo; ax = 1; sg = t0 < t1 ? -1 : 1; } tmax = Math.min(tmax, hi);
      t0 = (b.a[2] - o.z) * iz; t1 = (b.b[2] - o.z) * iz;
      lo = Math.min(t0, t1); hi = Math.max(t0, t1);
      if (lo > tmin) { tmin = lo; ax = 2; sg = t0 < t1 ? -1 : 1; } tmax = Math.min(tmax, hi);
      if (tmax < Math.max(tmin, 0) || tmin < 0 || tmin >= best) continue;
      best = tmin; bs = b.surf; bn = [ax === 0 ? sg : 0, ax === 1 ? sg : 0, ax === 2 ? sg : 0];
    }
    for (const c of this.cyls) {
      if (!c.on) continue;
      const ox = o.x - c.x, oz = o.z - c.z, a = d.x * d.x + d.z * d.z;
      if (a < 1e-9) continue;
      const bb = ox * d.x + oz * d.z, cc = ox * ox + oz * oz - c.r * c.r, disc = bb * bb - a * cc;
      if (disc < 0) continue;
      const t = (-bb - Math.sqrt(disc)) / a;
      if (t < 0 || t >= best) continue;
      const y = o.y + d.y * t;
      if (y < c.y0 || y > c.y1) continue;
      best = t; bs = c.surf; bn = [(ox + d.x * t) / c.r, 0, (oz + d.z * t) / c.r];
    }
    if (out && bn) { out.normal.set(bn[0], bn[1], bn[2]); out.surf = bs; out.point.copy(d).multiplyScalar(best).add(o); }
    return bn ? best : Infinity;
  }

  // True when nothing blocks the straight line a -> b.
  clear(a, b) {
    _v.subVectors(b, a); const len = _v.length(); if (len < 1e-4) return true;
    _v.multiplyScalar(1 / len);
    return this.raycast(a, _v, len - 0.05) === Infinity;
  }
}

// Critically damped spring on a scalar, exact for any dt.
export class Spring {
  constructor(freq = 8, x = 0) { this.w = freq; this.x = x; this.v = 0; this.target = 0; }
  update(dt) {
    const w = this.w, d = this.x - this.target, e = Math.exp(-w * dt), t = (this.v + w * d) * dt;
    this.x = this.target + (d + t) * e; this.v = (this.v - w * t) * e; return this.x;
  }
  kick(v) { this.v += v; }
}

// Under-damped spring for things that should overshoot (camera landing, weapon kick).
export class Spring2 {
  constructor(k = 120, c = 14, x = 0) { this.k = k; this.c = c; this.x = x; this.v = 0; this.target = 0; }
  update(dt) {
    let n = Math.max(1, Math.ceil(dt / 0.004)); const h = dt / n;
    while (n--) { this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h; this.x += this.v * h; }
    return this.x;
  }
  kick(v) { this.v += v; }
}

export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const smooth = (t) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
export const remap = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
export const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
