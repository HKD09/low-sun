// A simple automatic player for unattended tests (?bot=1). It walks the route, fights what it sees, and uses what it must.
// It drives the same Input object a person does, so it exercises the real game code.
import * as THREE from 'three';
import { ROUTE } from './capture.js';

const _d = new THREE.Vector3(), m0 = (G) => (G.mission ? G.mission.stage : '');
export class Bot {
  constructor(G) { this.G = G; this.human = G.params.get('bot') === 'human'; this.seenT = 0; this.pauseT = 0; this.i = 1; this.stuckT = 0; this.last = new THREE.Vector3(); this.log = []; this.t = 0; this.fireT = 0; this.goal = null; this.done = false; this.aimErr = 0.02; }
  note(s) { const m = `LOG bot ${this.t.toFixed(1)}s ${s}`; this.log.push(m); console.log(m); }
  // Turn the view toward a world point at a human rate. Returns the remaining angle.
  lookAt(p, dt, rate = 7) {
    const pl = this.G.player; _d.copy(p).sub(pl.eye);
    const yaw = Math.atan2(-_d.x, -_d.z), pitch = Math.atan2(_d.y, Math.hypot(_d.x, _d.z));
    let dy = yaw - pl.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); const dp = pitch - pl.pitch, k = 1 - Math.exp(-rate * dt);
    pl.yaw += dy * k; pl.pitch += dp * k; return Math.hypot(dy, dp);
  }
  update(dt) {
    const G = this.G, pl = G.player, keys = G.input.keys;
    if (G.state === 'end' || G.state === 'dead') { this.waitT = (this.waitT || 0) + dt; if (this.waitT > 3) { this.waitT = 0; this.note(G.state === 'end' ? 'finished a run, starting another' : 'went down, retrying'); this.runs = (this.runs || 0) + (G.state === 'end' ? 1 : 0); this.deaths = (this.deaths || 0) + (G.state === 'dead' ? 1 : 0); G.restart(G.state === 'dead'); } keys.clear(); return; }
    if (G.state !== 'play') { keys.clear(); return; }
    this.t += dt; keys.clear(); G.input.aim = false;
    if (m0(G) !== this.stage) { this.stage = m0(G); this.note(`stage ${this.stage} at ${G.mission.clock.toFixed(0)}s, health ${pl.health.toFixed(0)}`); }
    if (G.weapon.cur && G.weapon.cur.ammo === 0 && G.weapon.cur.busyReload && !G.weapon.next && Math.random() < dt * 2) G.input.pressed.add('KeyQ');     // swap rather than wait on a reload, as a person would
    const m = G.mission, target = G.enemies ? G.enemies.visibleTarget(pl.eye) : null;
    if (target) {                                        // fight: stop, aim, shoot when on target
      // the "human" setting reacts late, aims slower, misses sometimes and never aims for the weak spot
      this.seenT += dt; if (this.human && this.seenT < 0.55) return;
      const pt = this.human ? target.pos.clone().add(this.off || (this.off = new THREE.Vector3())) : target.aimPoint();
      const err = this.lookAt(pt, dt, this.human ? 4.5 : 9); G.input.aim = true; this.fireT -= dt;
      if (err < (this.human ? 0.035 : this.aimErr) && this.fireT <= 0 && G.weapon.state === 'ready') { G.input.fire = true; this.fireT = this.human ? 0.5 : 0.25; if (this.human) this.off.set((Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.1, (Math.random() - 0.5) * 1.4).multiplyScalar(Math.random() < 0.45 ? 1 : 0.2); }
      if (pl.health < 55) keys.add(Math.sin(this.t * 2.3) > 0 ? 'KeyA' : 'KeyD');
      return;
    }
    this.seenT = 0;
    if (this.human) { this.pauseT -= dt; if (this.pauseT > 0) { pl.yaw += Math.sin(this.t * 0.9) * dt * 0.7; return; } if (Math.random() < dt / 9) this.pauseT = 1.5 + Math.random() * 3; }
    let goal = m ? m.botGoal() : null;
    if (!goal) { if (this.i >= ROUTE.length) { if (!this.done) { this.done = true; this.note('route complete'); } return; } goal = { pos: new THREE.Vector3(...ROUTE[this.i]), route: true }; }
    _d.copy(goal.pos).sub(pl.eye); const flat = Math.hypot(_d.x, _d.z);
    if (goal.hold) { this.holdT = (this.holdT || 0) + dt; pl.yaw += Math.sin(this.holdT * 0.7) * 0.9 * dt;        // look about, as a person waiting for the next one would
      pl.pitch += (0.22 - pl.pitch) * Math.min(1, dt * 3); if (this.holdT % 6 > 4.6) keys.add(Math.floor(this.holdT / 6) % 2 ? 'KeyA' : 'KeyD'); this.last.copy(pl.pos); return; } this.holdT = 0;
    const look = goal.pos.clone(); look.y = pl.eye.y + THREE.MathUtils.clamp(_d.y, -1.5, 1.5) * (flat < 3 ? 0.2 : 0.6);
    const err = this.lookAt(goal.look || look, dt, 6);
    if (flat > (goal.radius || 0.6)) { if (err < 0.6) keys.add('KeyW'); if (flat > 6 && err < 0.2 && !this.human) keys.add('ShiftLeft'); }
    else if (goal.route) { this.note(`reached waypoint ${this.i} at ${pl.pos.x.toFixed(1)}, ${pl.pos.y.toFixed(2)}, ${pl.pos.z.toFixed(1)}`); this.i++; }
    else if (goal.use) { G.input.pressed.add('KeyE'); keys.add('KeyE'); }
    // unstick: hop and sidestep if we have not moved
    if (pl.pos.distanceTo(this.last) < 0.25 * dt) { this.stuckT += dt; if (this.stuckT > 0.8) { G.input.pressed.add('Space'); keys.add(Math.random() < 0.5 ? 'KeyA' : 'KeyD'); } if (this.stuckT > 4) { this.note(`STUCK at ${pl.pos.x.toFixed(1)}, ${pl.pos.y.toFixed(2)}, ${pl.pos.z.toFixed(1)} heading to waypoint ${this.i}`); this.stuckT = 0; } } else this.stuckT = 0;
    this.last.copy(pl.pos);
  }
}
