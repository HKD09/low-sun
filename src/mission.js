// The morning's work: objectives, the scripted beats between them, interlocks, checkpoints and the ending.
// Nothing can be skipped: each door or switch stays locked until the sentries guarding it are down.
import * as THREE from 'three';
import { damp } from './physics.js';

const K = (s) => `<kbd>${s}</kbd>`;
const _v = new THREE.Vector3();
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const STAIR_TOP = [42.5, 1.4, -34.2], PRIME = 75, ROOF = [[22, 9, -30], [31, 9, -38.5], [37, 9, -28.5], [19, 9, -40], [34, 9, -33]];

export class Mission {
  constructor(G) {
    this.G = G; this.stage = 'menu'; this.t = 0; this.clock = 0; this.timers = []; this.flags = {}; this.menuT = 0; this.botI = 0; this.valvesOpen = 0; this.kills = 0;
    const e = G.level.ent, W = G.world;
    const red = () => { const m = new THREE.MeshStandardMaterial({ color: 0xc2261a, roughness: 0.45, metalness: 0.2 }); W.dressDynamic(m); return m; };
    const dress = (g) => { g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); W.group.add(g); };
    // levers for the main switch and the master cut-out
    const lever = (pos, face) => { const g = new THREE.Group(); g.position.fromArray(pos); g.rotation.y = face; const m = red();
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.5, 0.045), m); arm.position.set(0, 0.23, 0.035);
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.22, 12), m); grip.rotation.z = Math.PI / 2; grip.position.set(0, 0.48, 0.035);
      const piv = new THREE.Group(); piv.add(arm, grip); piv.rotation.x = -0.7; g.add(piv); dress(g); return { piv, on: 0, target: 0 }; };
    // handwheels for the three riser valves
    const wheel = (pos) => { const g = new THREE.Group(); g.position.fromArray(pos); const m = red();
      g.add(new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.022, 8, 28), m));
      for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.028, 0.02), m); s.rotation.z = i * Math.PI / 3; g.add(s); }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 10), m); hub.rotation.x = Math.PI / 2; hub.position.z = -0.04; g.add(hub); dress(g); return { g, on: 0, target: 0 }; };
    this.breaker = lever(e.breaker.pos, 0); this.cutout = lever(e.cutout.pos, Math.PI / 2);
    this.use = [
      { key: 'breaker', lever: this.breaker, pos: V(e.breaker.pos), stage: 'switch', text: `${K('E')} Throw the main switch`, run: () => this.powerOn(), mark: W.addMarker(V(e.breaker.pos).add(_v.set(0, 0.75, 0.1))) },
      { key: 'cutout', lever: this.cutout, pos: V(e.cutout.pos), stage: 'control', text: `${K('E')} Pull the master cut-out`, run: () => this.cutOut(), mark: W.addMarker(V(e.cutout.pos).add(_v.set(0.1, 0.8, 0)), 0xff4020) },
    ];
    (e.valves || []).forEach((v, i) => { const w = wheel(v.pos); this.use.push({ key: 'valve' + i, lever: w, wheel: true, pos: V(v.pos), stage: 'valves', hold: 2.4, text: `Hold ${K('E')} to open the riser valve`, run: () => this.valve(i), mark: W.addMarker(V(v.pos).add(_v.set(0, 0.42, 0.06))) }); });
    this.stairMark = W.addMarker(new THREE.Vector3(42.5, 1.3, -34.2));
    const E = G.enemies;
    if (E) { E.onKill = (d) => this.onKill(d); E.onAim = () => this.once('aimHint', () => G.hud.hint('Quickening beeps and a red line mean it is about to fire. Step aside, or shoot it first', 7));
      E.onPhase = (l) => this.onPhase(l); E.onSweep = () => this.once('sweep', () => G.hud.hint('It sweeps a beam across the room. Get behind something solid', 6)); }
  }
  after(s, fn) { this.timers.push({ t: s, fn }); }
  once(k, fn) { if (this.flags[k]) return; this.flags[k] = true; fn(); }
  set(stage) { this.stage = stage; this.t = 0; this.botI = 0; }
  say(text, secs) { this.G.hud.radio(text, secs); this.G.audio && this.G.audio.radio(); }
  objective(text, at) { const G = this.G; G.hud.objective(text); this.goal = at ? V(at) : null; G.hud.mark(this.goal); G.audio && G.audio.chime(); }
  point(at) { if (this.goal && Math.abs(this.goal.x - at[0]) + Math.abs(this.goal.y - at[1]) + Math.abs(this.goal.z - at[2]) < 0.05) return; this.goal = V(at); this.G.hud.mark(this.goal); }

  reset() {
    const G = this.G; this.timers.length = 0; this.flags = {}; this.clock = 0; this.kills = 0; this.valvesOpen = 0;
    for (const u of this.use) { u.lever.on = u.lever.target = 0; u.done = false; u.mark.on = false; u.held = 0; } this.stairMark.on = false;
    G.world.setState({ power: false, door: false, doors: { hall: false, control: false } }); G.world.setAlarm(false); G.enemies && G.enemies.reset(); G.enemies && (G.enemies.lifterInside = false);
    this.set('menu'); G.showWeapon = false; G.hud.objective(null); G.hud.mark(null); G.hud.prompt(null); G.hud.hint(''); G.hud.radio(''); G.hud.boss(null); G.audio && G.audio.reset();
  }
  begin() {
    const G = this.G; G.hud.fade(1, 350);
    setTimeout(() => { G.player.reset(); G.weapon.reset(); G.showWeapon = true; this.set('enter'); G.hud.fade(0, 2200); G.pipeline.reset = 3;
      this.after(1.4, () => G.hud.hint(`${K('W')}${K('A')}${K('S')}${K('D')} move &nbsp;&middot;&nbsp; ${K('Mouse')} look`, 7));
      this.after(2.6, () => this.say('Morning. Skarn Head went dark at four and nothing in there is answering. Go in and see what tripped it.', 7));
      this.after(5, () => this.objective('Go through the gallery to the pump hall', [24, 1.6, -22])); }, 380);
  }

  checkpoint() {
    return { hall: { pos: [20.5, 0, -19.4], yaw: -Math.PI / 2 }, switch: { pos: [24, 0, -24], yaw: 0 }, valves: { pos: [41.7, 0, -44.2], yaw: Math.PI / 2 }, alarm: { pos: [42.5, 0, -33.2], yaw: Math.PI / 2 },
      control: { pos: [36, 0, -33], yaw: Math.PI / 2 }, lifter: { pos: [8.6, 4.2, -35], yaw: -Math.PI / 2 }, out: { pos: [40, 0, -31], yaw: -Math.PI / 2 } }[this.stage] || null;
  }
  retry() {
    const G = this.G, E = G.enemies, f = this.flags; this.timers.length = 0; G.hud.fade(1, 0); setTimeout(() => G.hud.fade(0, 900), 60);
    if (!E) return; E.bolts.length = 0; G.hud.boss(null); const st = this.stage;
    if (st === 'enter' || st === 'gallery') { E.reset([0]); f.w0 = false; this.set('enter'); }
    else if (st === 'hall') { E.reset([1]); f.w1 = false; }
    else if (st === 'valves') { E.reset([5, 6]); this.after(2, () => { if (this.valvesOpen >= 1) E.wake(5, 1.2); if (this.valvesOpen >= 2) E.wake(6, 1.2); }); }
    else if (st === 'alarm') { E.reset([2, 3, 10]); f.w2 = f.w3 = f.primed = false; G.hud.boss(null); }
    else if (st === 'control') { E.reset([4]); f.w4 = false; }
    else if (st === 'lifter') { E.reset([9, 10]); E.lifterInside = false; this.t = 6; this.after(1.5, () => E.spawnLifter()); }
  }

  // ---- beats
  powerOn() {
    const G = this.G; G.world.setPower(true); G.audio && G.audio.breaker(); this.set('valves');
    this.after(2.8, () => this.say('Power is back, but the pumps are dry. Open the three riser valves in the pipe gallery. The stairs down are by the east wall.', 8));
    this.after(3.4, () => this.objective('Open the three riser valves in the pipe gallery below', STAIR_TOP));
  }
  valve(i) {
    const G = this.G, E = G.enemies; this.valvesOpen++; G.audio && G.audio.valve();
    if (this.valvesOpen === 1) { E && E.wake(5, 1.4); this.after(1.2, () => this.say('That noise has woken something down there.', 4)); }
    if (this.valvesOpen === 2) E && E.wake(6, 1.4);
    if (this.valvesOpen >= 3) { this.set('alarm'); G.audio && G.audio.pumps(); G.player.shake = 0.5; this._alarmI = false;
      this.after(1.5, () => this.say('Pumps are turning, and that has woken every sentry in the building. Get back up to the hall.', 7));
      this.after(2.2, () => { G.world.setAlarm(true); G.audio && G.audio.alarm(true); this.objective('Go back up to the pump hall', [42.5, 1.4, -33.4]); }); }
    else { G.hud.objective(`Open the riser valves (${this.valvesOpen} of 3)`); G.audio && G.audio.chime(); }
  }
  cutOut() {
    const G = this.G, E = G.enemies; G.audio && G.audio.cutout(); this.set('lifter'); G.world.setAlarm(false); G.audio && G.audio.alarm(false); E && E.shutdownAll(); G.hud.mark(null); this.goal = null;
    this.after(1.6, () => this.say('Sentries are down. Wait. The lifter is not on the network, and it is bringing itself in.', 7));
    this.after(2.6, () => { G.world.openDoor(true, 'roller'); G.player.shake = 0.4; });
    this.after(5.4, () => { E && E.spawnLifter(); G.audio && G.audio.roar(); this.objective('Bring down the lifter', null); G.hud.hint('Its eye is the weak spot, but only while it glows. The rifle hits it hardest', 8); });
  }
  onPhase(l) { if (l.phase === 2) this.say('You have hurt it. It will sweep the room now. Stay behind something solid.', 6); else this.say('One rotor left. Finish it.', 4); }
  onKill(d) {
    const G = this.G; this.kills++;
    if (d.type === 'lifter') { this.set('out'); G.hud.boss(null); for (const s of G.enemies.list) if (s !== d) s.shutdown();
      this.after(3, () => this.say('That is all of them. Step outside. You have earned the view.', 7)); this.after(3.6, () => this.objective('Step outside', [54, 1.6, -31])); }
  }
  finish() {
    const G = this.G, w = G.weapon; if (this.flags.done) return; this.flags.done = true; G.hud.el.fade.style.background = '#f6ead6'; G.hud.fade(1, 2600); G.audio && G.audio.ending();
    const s = Math.round(this.clock), acc = w.shots ? Math.round(100 * w.hits / w.shots) : 0;
    setTimeout(() => { G.end(`Time ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}  ·  ${this.kills} machines down  ·  ${w.shots} rounds fired  ·  ${acc}% on target`); G.hud.el.fade.style.background = '#000'; G.hud.fade(0.55, 600); }, 3000);
  }

  update(dt) {
    const G = this.G, pl = G.player, E = G.enemies, p = pl.pos, f = this.flags; if (G.state !== 'play') return;
    this.t += dt; if (!f.done) this.clock += dt;
    for (let i = this.timers.length - 1; i >= 0; i--) { const tm = this.timers[i]; tm.t -= dt; if (tm.t <= 0) { this.timers.splice(i, 1); tm.fn(); } }
    const inHall = p.x > 14 && p.x < 44 && p.z < -23.0 && p.y > -0.6, st = this.stage;
    if (st === 'enter') {
      if (!f.run && p.z < -16.5 && p.x > 5) { f.run = true; G.hud.hint(`Hold ${K('Shift')} to run`, 4); }
      if (!f.w0 && p.z < -16 && p.x > 11) { f.w0 = true; this.set('gallery'); E && E.wake(0, 0);
        this.after(0.5, () => this.say('That is a sentry, and it should not be awake. It has you down as an intruder.', 6));
        this.after(0.9, () => G.hud.hint(`${K('Right click')} aim &nbsp;&middot;&nbsp; ${K('Left click')} fire`, 8)); this.objective('Deal with the sentry. The hall door is locked while it is up', null); }
    } else if (st === 'gallery') {
      if (!E || E.waveDown(0)) { this.set('hall'); G.world.openDoor(true, 'hall'); this.after(0.8, () => this.say('Door has released. There are more inside, by the sound of it.', 5)); this.objective('Go into the pump hall', [24, 1.6, -24.5]); }
    } else if (st === 'hall') {
      if (!f.w1 && inHall) { f.w1 = true; E && E.wake(1, 1.5); this.objective('Clear the sentries in the hall', null); this.after(6, () => G.hud.hint(`${K('Q')} swaps between the rifle and the pistol`, 6)); }
      if (f.w1 && (!E || E.waveDown(1))) { this.set('switch'); this.after(1, () => this.say('Hall is quiet. The main switch is on the north wall, under the lamp. Get the lights on.', 6)); this.objective('Throw the main switch on the north wall', G.level.ent.breaker.pos); }
    } else if (st === 'valves') {
      const below = p.y < -1.5; this.stairMark.on = !below;
      if (this.t > 3.5) { if (below) { const next = this.use.find((u) => u.wheel && !u.done); if (next) this.point(next.pos.toArray()); } else this.point(STAIR_TOP); }
    } else if (st === 'alarm') {
      // hold the hall while the pumps come up to pressure; sentries keep arriving through the roof lights until they do
      this.stairMark.on = false;
      if (!f.w2 && p.y > -0.6) { f.w2 = true; this.prime = 0; this.nextIn = 20; this.sent = 0; E && E.wake(2, 1.2); G.hud.mark(null); this.goal = null; G.hud.objective('Hold the hall while the pumps prime'); G.audio && G.audio.chime();
        this.after(1.5, () => this.say('Stay in the hall. The pumps need a minute to come up to pressure, and the control room stays locked until they do.', 7)); }
      if (f.w2 && !f.primed) {
        this.prime += dt; G.hud.boss(Math.min(1, this.prime / PRIME), 'Pumps priming', 'prime');
        if (!f.w3 && this.prime > 10) { f.w3 = true; E && E.wake(3, 1.5); }
        if (E && this.prime > this.nextIn && this.prime < PRIME - 6) { this.nextIn = this.prime + (E.aliveCount() < 2 ? 5 : 9);
          if (E.aliveCount() < 5) { const heavy = this.sent % 3 === 2; if (E.reinforce(ROOF[this.sent % ROOF.length], heavy)) { this.sent++; this.once('roof', () => this.say('More of them, coming in through the roof lights.', 4)); if (heavy) this.once('heavy', () => this.after(1.5, () => this.say('That one is armoured. It will take more than one round.', 5))); } } }
        if (this.prime >= PRIME) { f.primed = true; G.hud.boss(null); this.say('Pumps are at pressure. Clear what is left and the control room will open.', 6); G.hud.objective('Clear the last sentries'); G.audio && G.audio.chime(); }
      }
      if (f.primed && (!E || (E.waveDown(2, 3) && E.sparesUp() === 0))) { this.set('control'); G.world.openDoor(true, 'control'); G.world.setAlarm(false); G.audio && G.audio.alarm(false); f.step = -1;
        this.say('Control room is open. Up the stairs on the north wall, along the walkway, and pull the master cut-out. That kills the sentry network.', 8); G.hud.objective('Climb to the control room and pull the master cut-out'); G.audio && G.audio.chime(); }
    } else if (st === 'control') {
      // lead the eye in steps: foot of the stairs, top of the stairs, the door, the lever
      const steps = [[28.6, 1.3, -45.2], [17.2, 5.6, -45.2], [14.4, 5.5, -41.3], G.level.ent.cutout.pos]; let i = Math.max(0, f.step);
      if (i === 0 && p.y > 0.8 && p.z < -44.4) i = 1; if (i <= 1 && p.y > 3.9 && p.x < 18.2) i = 2; if (i <= 2 && p.x < 13.7 && p.y > 3.9) i = 3;
      if (i !== f.step) { f.step = i; this.point(steps[i]); }
      if (!f.w4 && p.y > 2.2) { f.w4 = true; E && E.wake(4, 1.2); }
    } else if (st === 'lifter') {
      if (E && E.lifter.active) { G.hud.boss(Math.max(0, E.lifter.hp / E.lifter.T.hp)); if (!E.lifterInside && this.t > 17) E.lifterInside = true; }   // it holds outside for a moment, then comes in after you
    } else if (st === 'out') {
      if (p.x > 49.5 && this.t > 3.8) this.finish();
    }
    if (!f.reloadHint && G.weapon.ammo === 0) { f.reloadHint = true; G.hud.hint(`${K('R')} reloads. It also reloads itself when empty`, 5); }
    // things to operate
    let prompt = null;
    for (const u of this.use) {
      u.lever.on = damp(u.lever.on, u.lever.target, u.wheel ? 7 : 9, dt);
      if (u.wheel) u.lever.g.rotation.z = -u.lever.on * 9; else u.lever.piv.rotation.x = -0.7 + u.lever.on * 1.5;
      const live = u.stage === st && !u.done; u.mark.on = live;
      if (!live) continue;
      const d = _v.copy(u.pos).sub(pl.eye), dist = d.length(); if (dist > 2.4) continue;
      if (d.multiplyScalar(1 / dist).dot(pl.fwd) < 0.5) continue;
      prompt = u.text;
      if (u.hold) {                                  // a valve: hold to wind it open
        const down = G.input.keys.has('KeyE') || G.input.keys.has('KeyF'); u.held = Math.max(0, (u.held || 0) + (down ? dt : -dt * 1.5)); u.lever.target = Math.min(0.999, u.held / u.hold);
        if (down) { this.turnT = (this.turnT || 0) - dt; if (this.turnT <= 0) { this.turnT = 0.34; G.audio && G.audio.valveTurn(); G.weapon.kz.kick(-0.25); } }
        if (u.held > 0) prompt += `<i><u style="transform:scaleX(${Math.min(1, u.held / u.hold).toFixed(3)})"></u></i>`;
        if (u.held >= u.hold) { u.done = true; u.lever.target = 1; u.run(); }
      } else if (G.input.hit('KeyE') || G.input.hit('KeyF')) { u.done = true; u.lever.target = 1; G.weapon.kz.kick(-0.6); this.after(0.22, u.run); }
    }
    if (!prompt && st === 'hall') { const d = _v.copy(this.use[0].pos).sub(pl.eye); if (d.length() < 2.4 && d.normalize().dot(pl.fwd) > 0.5) prompt = 'Locked out while sentries are active'; }
    G.hud.prompt(prompt);
  }

  // Where the automatic player should head next. hold = stay near here and fight.
  botGoal() {
    const pl = this.G.player, st = this.stage, f = this.flags, low = pl.pos.y < -0.6;
    const R = {
      enter: [[2, -14], [3.2, -18.6], [13, -19]], gallery: [[17, -19, 'hold']], hall: f.w1 ? [[27, -28.5, 'hold']] : [[22, -19], [24, -21.6], [24.4, -26.5]],
      switch: [[32, -31], [40, -43.9], [41.7, -44.75, 'breaker']],
      valves: [[41, -44], [40.6, -36.5], [41.0, -33.2], [42.5, -33.2], [42.5, -39.8], [42.5, -41.3], [38.6, -41.4], [36.5, -41.05, 'valve2'], [34.7, -42.3], [31.3, -42.3], [28.5, -41.05, 'valve1'], [24.8, -42.0], [22.0, -41.9], [20.5, -41.05, 'valve0']],
      alarm: low ? [[22.0, -41.9], [24.8, -42.0], [28.5, -41.4], [31.3, -42.3], [34.7, -42.3], [36.5, -41.4], [39.5, -41.4], [42.5, -41.2], [42.5, -34.4], [42.5, -33.0], [39, -32.5]] : [[38, -32, 'hold']],
      control: [[30, -44.2], [28.9, -45.2], [17.3, -45.2], [15.2, -44.2], [15.2, -41.3], [12.6, -41.2], [7.8, -35, 'cutout']],
      lifter: [[12.6, -41.2], [15.2, -41.3], [15.2, -44.6], [17.3, -45.2], [28.9, -45.2], [27, -36, 'hold']], out: [[36, -33], [43, -31], [53, -31]] }[st];
    if (!R) return null;
    if (st === 'alarm' && low && !this._alarmI) { this._alarmI = true; let best = 0, bd = 1e9; R.forEach((w, i) => { const d = Math.hypot(pl.pos.x - w[0], pl.pos.z - w[1]); if (d < bd) { bd = d; best = i; } }); this.botI = best; }
    if (st === 'alarm' && !low && this.botI) this.botI = 0;
    const w = R[Math.min(this.botI, R.length - 1)], goal = { pos: new THREE.Vector3(w[0], pl.pos.y + 1.66, w[1]), radius: 0.5 };
    if (Math.hypot(pl.pos.x - w[0], pl.pos.z - w[1]) < 0.6) {
      if (w[2] === 'hold') goal.hold = true;
      else if (w[2]) { const u = this.use.find((x) => x.key === w[2]); if (u.done) { if (this.botI < R.length - 1) this.botI++; } else { goal.use = true; goal.look = u.pos; goal.radius = 5; } }
      else if (this.botI < R.length - 1) this.botI++; else goal.radius = 5;
    }
    return goal;
  }

  menuCamera(dt) {
    const cam = this.G.camera; this.menuT += dt; const t = this.menuT;
    cam.position.set(5.5 + Math.min(t * 0.16, 12), 1.5 + Math.sin(t * 0.21) * 0.04, -19.4 + Math.sin(t * 0.13) * 0.25);
    cam.rotation.set(0.02, -Math.PI / 2 + Math.sin(t * 0.09) * 0.05, 0, 'YXZ'); cam.fov = 50; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  }

  // Capture mode can put the station into any state:  ?stage=lifter etc.
  async captureSetup(params) {
    const G = this.G, st = params.get('stage'), E = G.enemies;
    if (st === 'lifter' || st === 'out') { await G.world.setState({ power: true, door: true, doors: { hall: true, control: true } }); if (st === 'lifter' && E) { E.spawnLifter(); const l = E.lifter; l.pos.set(51.6, 3.5, -31.3); l.post.copy(l.pos); l.yaw = -Math.PI / 2; l.state = 'hide'; l.hideT = 1e9; l.vel.set(0, 0, 0); G.state = 'capture'; } }
    else await G.world.setState({ doors: { hall: true, control: true } });
    if (st === 'fight' && E) { await G.world.setState({ power: true }); G.world.setAlarm(true); E.wake(2, 0); E.wake(3, 0); }
  }
}
