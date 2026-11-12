// Sound. Almost everything is synthesised; impacts and footsteps layer CC0 samples (Kenney) under synthesis.
// Every room has its own generated reverb, and the mix runs through a limiter so nothing clips.
import * as THREE from 'three';
import { clamp, rnd } from './physics.js';

const SAMPLES = { step: ['footstep_concrete', 5], metalL: ['impactMetal_light', 5], metalM: ['impactMetal_medium', 5], metalH: ['impactMetal_heavy', 5], plateL: ['impactPlate_light', 5], plateM: ['impactPlate_medium', 5], plateH: ['impactPlate_heavy', 5],
  rock: ['impactMining', 5], thud: ['impactGeneric_light', 5], glass: ['impactGlass_light', 5], wood: ['impactWood_medium', 5], tin: ['impactTin_medium', 5] };
const ROOMS = { adit: { len: 1.2, bright: 0.5, wet: 0.5, taps: [] }, gallery: { len: 2.3, bright: 0.62, wet: 0.42, taps: [] }, hall: { len: 3.6, bright: 0.55, wet: 0.5, taps: [0.09, 0.17] },
  control: { len: 0.7, bright: 0.4, wet: 0.3, taps: [] }, under: { len: 1.7, bright: 0.42, wet: 0.6, taps: [0.045, 0.11] }, ext: { len: 1.9, bright: 0.35, wet: 0.24, taps: [0.31, 0.62, 0.97] } };
const AMB = { adit: { wind: 0.05, rumble: 0.5, drip: 1, birds: 0 }, gallery: { wind: 0.4, rumble: 0.35, drip: 0.7, birds: 0.12 }, hall: { wind: 0.22, rumble: 0.5, drip: 0.5, birds: 0.03 }, control: { wind: 0.05, rumble: 0.35, drip: 0, birds: 0 }, under: { wind: 0.02, rumble: 0.75, drip: 1.5, birds: 0 }, ext: { wind: 1, rumble: 0.2, drip: 0, birds: 1 } };
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();

export class AudioEngine {
  constructor(G) { this.G = G; this.ready = false; this.vol = G.store.get('vol', 0.8); this.buf = {}; this.voices = new Map(); this.zone = ''; this.t = 0; this.dripT = 1; this.birdT = 2; this.creakT = 6; this.peak = 0; this.alarmOn = false; this.doorSrc = {}; this.heart = 0; this.pumpOn = false; this.pumpLvl = 0; }
  reset() { this.alarmOn = false; this.humOn = false; this.pumpOn = false; }

  async resume() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ctx = this.ctx = new C({ latencyHint: 'interactive' });
    this.master = ctx.createGain(); this.master.gain.value = this.vol;
    this.lim = ctx.createDynamicsCompressor(); this.lim.threshold.value = -6; this.lim.knee.value = 6; this.lim.ratio.value = 10; this.lim.attack.value = 0.002; this.lim.release.value = 0.18;
    this.out = ctx.createGain(); this.out.gain.value = 0.8; this.meter = ctx.createAnalyser(); this.meter.fftSize = 2048; this.meterBuf = new Float32Array(2048);
    this.master.connect(this.lim); this.lim.connect(this.out); this.out.connect(ctx.destination); this.out.connect(this.meter);
    this.dryBus = ctx.createGain(); this.dryBus.connect(this.master);
    // Everything that is not the player's own weapon goes through one levelling stage, so a room full of pumps, alarms, rotors and enemy fire
    // cannot pile up over the gun. Its slow attack lets an explosion's first punch through.
    this.world = ctx.createDynamicsCompressor(); this.world.threshold.value = -24; this.world.knee.value = 8; this.world.ratio.value = 4; this.world.attack.value = 0.03; this.world.release.value = 0.3;
    this.worldTrim = ctx.createGain(); this.worldTrim.gain.value = 0.3; this.world.connect(this.worldTrim); this.worldTrim.connect(this.master);      // the browser's compressor adds its own make-up gain (about +10 dB at these settings); this takes it back out
    this.gun = ctx.createGain(); this.gun.connect(this.master);                    // the player's own weapon: never muffled, and the rest of the mix ducks under it
    this.amb = ctx.createGain(); this.amb.gain.value = 1; this.amb.connect(this.world);
    this.muffle = ctx.createBiquadFilter(); this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000; this.sfx = ctx.createGain(); this.sfx.connect(this.muffle); this.muffle.connect(this.world);
    // two convolvers so the room can change without a click
    this.rev = [0, 1].map(() => { const c = ctx.createConvolver(), g = ctx.createGain(); g.gain.value = 0; c.connect(g); g.connect(this.world); return { c, g, room: '' }; }); this.revI = 0;
    this.send = ctx.createGain(); this.send.gain.value = 1; this.rev.forEach((r) => this.send.connect(r.c));
    this.irs = {}; for (const k in ROOMS) this.irs[k] = this.makeIR(ROOMS[k]);
    this.noise = this.makeNoise(2.5, 0); this.brown = this.makeNoise(4, 1);
    this.startAmbience();
    this.ready = true; this.setRoom(this.G.world.zoneAt(this.G.player.pos), true);
    this.loadSamples();
  }
  async loadSamples() {
    const jobs = [];
    for (const k in SAMPLES) { const [name, n] = SAMPLES[k]; this.buf[k] = []; for (let i = 0; i < n; i++) jobs.push(fetch(`./assets/audio/${name}_00${i}.ogg`).then((r) => r.arrayBuffer()).then((a) => this.ctx.decodeAudioData(a)).then((b) => this.buf[k].push(b)).catch(() => {})); }
    for (const n of ['switch_001', 'switch_002', 'click_001', 'click_002', 'toggle_001']) jobs.push(fetch(`./assets/audio/${n}.ogg`).then((r) => r.arrayBuffer()).then((a) => this.ctx.decodeAudioData(a)).then((b) => (this.buf[n] = [b])).catch(() => {}));
    await Promise.all(jobs);
  }
  makeNoise(sec, brown) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); let last = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
    return b;
  }
  makeIR(r) {
    const ctx = this.ctx, sr = ctx.sampleRate, n = Math.floor(sr * r.len), b = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); let lp = 0, lp2 = 0;
      for (let i = 0; i < n; i++) { const t = i / sr, w = Math.random() * 2 - 1; lp += (w - lp) * (0.08 + r.bright * 0.5); lp2 += (w - lp2) * 0.03;
        const e1 = Math.exp(-t * 6.9 / r.len), e2 = Math.exp(-t * 6.9 / (r.len * 0.45)); d[i] = (lp2 * e1 * 1.6 + lp * e1 * 0.55 + (w - lp) * e2 * 0.5 * r.bright) * Math.min(1, t * 400); }
      for (const tap of r.taps) { const at = Math.floor((tap + ch * 0.007) * sr); for (let i = 0; i < 900 && at + i < n; i++) d[at + i] += (Math.random() * 2 - 1) * Math.exp(-i / 160) * 0.5; }
      let m = 0; for (let i = 0; i < n; i++) m += d[i] * d[i]; const k = 1 / Math.sqrt(m + 1e-9) * 1.1; for (let i = 0; i < n; i++) d[i] *= k; }
    return b;
  }
  setRoom(room, now) {
    if (!this.ready || room === this.zone || !ROOMS[room]) return; this.zone = room;
    const t = this.ctx.currentTime, a = this.rev[this.revI], b = this.rev[1 - this.revI]; b.c.buffer = this.irs[room]; b.room = room;
    const f = now ? 0.01 : 0.7; a.g.gain.cancelScheduledValues(t); a.g.gain.setTargetAtTime(0, t, f / 3); b.g.gain.cancelScheduledValues(t); b.g.gain.setTargetAtTime(ROOMS[room].wet * 1.25, t, f / 3); this.revI = 1 - this.revI;
  }

  // ------------------------------------------------------------------ building blocks
  pan(pos, ref = 4, roll = 1.1) {
    const p = this.ctx.createPanner(); p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = roll; p.maxDistance = 200;
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; return p;
  }
  // A shaped burst of noise or tone. o: {type, f0, f1, dur, gain, q, filter, at, pos, send, attack, noise}
  blip(o) {
    if (!this.ready) return; const ctx = this.ctx, t = ctx.currentTime + (o.at || 0), g = ctx.createGain(), dur = o.dur || 0.1; let src, tail = g;
    if (o.noise) { src = ctx.createBufferSource(); src.buffer = o.noise === 2 ? this.brown : this.noise; src.loop = true; src.playbackRate.value = o.rate || 1;
      const f = ctx.createBiquadFilter(); f.type = o.filter || 'bandpass'; f.Q.value = o.q ?? 0.8; f.frequency.setValueAtTime(o.f0, t); if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur); src.connect(f); f.connect(g); src.start(t, Math.random() * 2); }
    else { src = ctx.createOscillator(); src.type = o.type || 'sine'; src.frequency.setValueAtTime(o.f0, t); if (o.f1) src.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + dur); src.connect(g); src.start(t); }
    const a = o.attack ?? 0.002; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.gain, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.stop(t + dur + 0.05);
    if (o.pos) { const p = this.pan(o.pos, o.ref, o.roll); g.connect(p); tail = p; }
    tail.connect(o.clean ? this.dryBus : (o.gun || this.asGun) ? this.gun : this.sfx); if (o.send !== 0) { const s = ctx.createGain(); s.gain.value = o.send ?? 0.5; tail.connect(s); s.connect(this.send); }
  }
  sample(key, o = {}) {
    if (!this.ready) return; const list = this.buf[key]; if (!list || !list.length) return; const ctx = this.ctx, t = ctx.currentTime + (o.at || 0);
    const src = ctx.createBufferSource(); src.buffer = list[Math.floor(Math.random() * list.length)]; src.playbackRate.value = (o.rate || 1) * rnd(0.94, 1.07);
    const g = ctx.createGain(); g.gain.value = o.gain ?? 0.5; let tail = g; src.connect(g);
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; g.connect(f); tail = f; }
    if (o.pos) { const p = this.pan(o.pos, o.ref, o.roll); tail.connect(p); tail = p; }
    tail.connect((o.gun || this.asGun) ? this.gun : this.sfx); const s = ctx.createGain(); s.gain.value = o.send ?? 0.4; tail.connect(s); s.connect(this.send); src.start(t);
  }
  // Pull the room and every other effect down for a moment so a shot is heard over them.
  duck(depth = 0.45, time = 0.5) { const t = this.ctx.currentTime; for (const [g, d, k] of [[this.amb.gain, depth, 1], [this.sfx.gain, Math.min(0.72, depth * 1.2), 0.75]]) { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(1 - d, t + 0.012); g.linearRampToValueAtTime(1, t + time * k); } }

  // ------------------------------------------------------------------ the rifle
  shot() {
    if (!this.ready) return; const r = rnd(0.95, 1.05);
    this.blip({ noise: 1, filter: 'highpass', f0: 2400 * r, f1: 900, dur: 0.075, gain: 0.95, q: 0.4, send: 0.5 });               // crack
    this.blip({ noise: 1, filter: 'lowpass', f0: 2600 * r, f1: 240, dur: 0.3, gain: 1.0, q: 0.6, send: 1.0 });                  // body
    this.blip({ noise: 2, filter: 'lowpass', f0: 420, f1: 70, dur: 0.5, gain: 0.9, q: 0.5, send: 1.1 });                        // weight
    this.blip({ type: 'sine', f0: 150 * r, f1: 38, dur: 0.24, gain: 0.95, send: 0.2 });                                          // thump in the chest
    this.blip({ type: 'triangle', f0: 3100, f1: 1900, dur: 0.035, gain: 0.16, send: 0, at: 0.004 });                             // action
    this.blip({ noise: 1, filter: 'bandpass', f0: 900, f1: 300, dur: 1.5, gain: 0.07, q: 0.5, send: 1.4, at: 0.09, attack: 0.08 });   // air moving after the shot
    this.duck(0.65, 0.9);
  }
  dry() { this.blip({ type: 'square', f0: 2200, f1: 1200, dur: 0.03, gain: 0.12, send: 0.1 }); this.sample('click_001', { gain: 0.35, rate: 1.3 }); }
  pistol() {
    if (!this.ready) return; const r = rnd(0.96, 1.05);
    this.blip({ noise: 1, filter: 'highpass', f0: 3200 * r, f1: 1400, dur: 0.05, gain: 0.85, q: 0.4, send: 0.45 });              // crack
    this.blip({ noise: 1, filter: 'bandpass', f0: 1300 * r, f1: 650, dur: 0.14, gain: 0.8, q: 0.9, send: 0.6 });                  // bark
    this.blip({ noise: 1, filter: 'lowpass', f0: 3000 * r, f1: 350, dur: 0.26, gain: 0.95, q: 0.6, send: 0.8 });                  // body
    this.blip({ type: 'sine', f0: 190 * r, f1: 60, dur: 0.15, gain: 0.8, send: 0.15 });                                          // thump
    this.blip({ type: 'triangle', f0: 4200, f1: 2600, dur: 0.03, gain: 0.14, send: 0, at: 0.03 });                               // slide
    this.sample('click_002', { gain: 0.25, rate: 1.5, at: 0.05, send: 0.1 }); this.duck(0.6, 0.45);
  }
  swap() { this.blip({ noise: 1, filter: 'bandpass', f0: 900, f1: 2200, dur: 0.16, gain: 0.07, q: 0.7, send: 0.2, attack: 0.06 }); this.sample('click_002', { gain: 0.3, rate: 0.8, at: 0.3, send: 0.2 }); this.sample('toggle_001', { gain: 0.22, rate: 0.9, at: 0.36, send: 0.2 }); }
  bolt(i) {
    if (i === 0) { this.sample('metalL', { gain: 0.3, rate: 1.5, send: 0.2 }); this.blip({ noise: 1, f0: 3800, dur: 0.03, gain: 0.16, q: 3, send: 0.1 }); }
    else if (i === 1) { this.sample('plateL', { gain: 0.34, rate: 1.7, send: 0.2 }); this.blip({ noise: 1, f0: 1800, f1: 700, dur: 0.09, gain: 0.22, q: 1.2, send: 0.15 }); }
    else { this.sample('metalM', { gain: 0.3, rate: 1.9, send: 0.2 }); this.blip({ noise: 1, f0: 2600, f1: 1400, dur: 0.06, gain: 0.2, q: 2, send: 0.15, at: 0.02 }); this.blip({ type: 'sine', f0: 190, f1: 90, dur: 0.07, gain: 0.25, send: 0.1, at: 0.1 }); }
  }
  reload(i) {
    if (i === 0) this.blip({ noise: 1, f0: 700, f1: 300, dur: 0.3, gain: 0.07, q: 0.6, send: 0.1, attack: 0.1 });               // cloth
    else if (i === 1) { this.sample('metalL', { gain: 0.3, rate: 1.1, send: 0.2 }); this.sample('switch_001', { gain: 0.3, rate: 0.8 }); }
    else { this.sample('plateM', { gain: 0.36, rate: 1.4, send: 0.2 }); this.blip({ type: 'sine', f0: 240, f1: 110, dur: 0.07, gain: 0.3, send: 0.1 }); }
  }
  casing(p, n) { this.blip({ type: 'sine', f0: rnd(5200, 6800), f1: 4600, dur: 0.12, gain: 0.07 / (1 + n), pos: p, ref: 1.5, send: 0.5 }); this.blip({ type: 'sine', f0: rnd(8000, 9500), dur: 0.05, gain: 0.03 / (1 + n), pos: p, ref: 1.5, send: 0.5 }); }

  // ------------------------------------------------------------------ the body
  step(surf, v, side) {
    if (!this.ready) return; const wet = this.G.world.wetAt ? this.G.world.wetAt(this.G.player.pos) : 0;
    if (surf === 'metal' || surf === 'grate') { this.sample('plateL', { gain: 0.24 * v, rate: 0.8, send: 0.5 }); this.blip({ type: 'sine', f0: rnd(170, 230), dur: 0.25, gain: 0.07 * v, send: 0.6 }); }
    else if (surf === 'wood') this.sample('wood', { gain: 0.3 * v, rate: 0.9 });
    else { this.sample('step', { gain: 0.5 * v, rate: 0.95, send: 0.5 }); this.blip({ noise: 1, f0: 2800, f1: 1400, dur: 0.05, gain: 0.03 * v, q: 0.7, send: 0.4 }); }
    if (wet > 0.3) { this.blip({ noise: 1, filter: 'bandpass', f0: rnd(1500, 2300), f1: 600, dur: 0.16, gain: 0.16 * v * wet, q: 1.4, send: 0.5 }); this.blip({ noise: 1, filter: 'highpass', f0: 4200, dur: 0.07, gain: 0.05 * v * wet, send: 0.4, at: 0.03 }); }
  }
  jump() { this.blip({ noise: 1, f0: 500, f1: 250, dur: 0.12, gain: 0.07, q: 0.6, send: 0.2 }); }
  land(surf, f) { this.sample(surf === 'metal' || surf === 'grate' ? 'plateM' : 'thud', { gain: 0.45 * f, rate: 0.7, send: 0.6 }); this.blip({ type: 'sine', f0: 95, f1: 45, dur: 0.14, gain: 0.3 * f, send: 0.2 }); }
  hurt() { this.blip({ type: 'sine', f0: 120, f1: 50, dur: 0.22, gain: 0.5, send: 0.1, clean: true }); this.blip({ noise: 1, filter: 'lowpass', f0: 900, f1: 200, dur: 0.18, gain: 0.5, send: 0.2, clean: true }); this.sample('thud', { gain: 0.6, rate: 0.6 }); }

  // ------------------------------------------------------------------ the world
  impact(p, surf) {
    if (surf === 'metal' || surf === 'grate' || surf === 'drone') { this.sample(Math.random() < 0.5 ? 'metalM' : 'plateM', { gain: 0.7, pos: p, ref: 5, send: 0.7 }); this.blip({ type: 'sine', f0: rnd(2200, 4200), f1: 1800, dur: 0.35, gain: 0.07, pos: p, ref: 5, send: 0.9 }); }
    else if (surf === 'glass') this.sample('glass', { gain: 0.7, pos: p, ref: 5, send: 0.6 });
    else if (surf === 'wood') this.sample('wood', { gain: 0.8, pos: p, ref: 5 });
    else { this.sample('rock', { gain: 0.65, pos: p, ref: 5, send: 0.7, rate: 1.1 }); this.blip({ noise: 1, f0: 1900, f1: 500, dur: 0.14, gain: 0.3, q: 0.7, pos: p, ref: 5, send: 0.8 }); this.blip({ noise: 1, filter: 'highpass', f0: 3500, dur: 0.5, gain: 0.03, pos: p, ref: 4, send: 0.3, at: 0.08, attack: 0.05 }); }
  }
  breaker() { this.sample('plateH', { gain: 0.9, rate: 0.7, send: 0.8 }); this.blip({ type: 'sawtooth', f0: 38, f1: 100, dur: 1.6, gain: 0.16, send: 0.6, attack: 0.5 }); for (let i = 0; i < 9; i++) this.sample('switch_002', { gain: 0.25, rate: rnd(0.7, 1.2), at: 0.3 + i * rnd(0.12, 0.28), send: 0.8 }); this.humOn = true; }
  cutout() { this.sample('plateH', { gain: 1, rate: 0.6, send: 0.9 }); this.blip({ type: 'sawtooth', f0: 420, f1: 30, dur: 2.4, gain: 0.12, send: 0.8, attack: 0.02 }); this.blip({ type: 'sine', f0: 60, f1: 28, dur: 1.2, gain: 0.5, send: 0.4 }); }
  alarm(on) { this.alarmOn = on; }
  door(d) {
    if (!this.ready) return; const moving = d.open !== d.target, ctx = this.ctx, big = d.key === 'roller', at = new THREE.Vector3((d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2, (d.a[2] + d.b[2]) / 2); let src = this.doorSrc[d.key];
    if (moving && !src) { const s = ctx.createBufferSource(); s.buffer = this.brown; s.loop = true; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = big ? 160 : 260; f.Q.value = 1.2; const g = ctx.createGain(); g.gain.value = 0.0;
      const p = this.pan(at, 6); s.connect(f); f.connect(g); g.connect(p); p.connect(this.sfx); const sd = ctx.createGain(); sd.gain.value = 0.8; p.connect(sd); sd.connect(this.send); g.gain.linearRampToValueAtTime(big ? 1.3 : 0.8, ctx.currentTime + 0.3); s.start();
      src = this.doorSrc[d.key] = { s, g, n: 0 }; this.sample('plateH', { gain: big ? 0.8 : 0.6, pos: at, ref: 6, rate: big ? 0.8 : 1.1 }); this.sample('switch_001', { gain: 0.5, pos: at, ref: 5, rate: 0.6 }); }
    if (moving && src) { src.n++; if (src.n % 9 === 0) this.sample('tin', { gain: big ? 0.3 : 0.18, pos: at, ref: 5, rate: rnd(0.7, 1.3) }); }
    if (!moving && src) { src.g.gain.setTargetAtTime(0, ctx.currentTime, 0.08); src.s.stop(ctx.currentTime + 0.5); this.doorSrc[d.key] = null; this.sample('metalH', { gain: big ? 0.9 : 0.6, pos: at, ref: 6, rate: big ? 0.6 : 0.85, send: 0.9 }); }
  }
  valveTurn() { this.sample('metalL', { gain: 0.28, rate: rnd(0.45, 0.6), send: 0.9 }); this.blip({ type: 'sawtooth', f0: rnd(260, 330), f1: 200, dur: 0.3, gain: 0.03, send: 0.9, attack: 0.08 }); }      // the spindle complaining
  valve() { if (!this.ready) return; this.sample('plateM', { gain: 0.5, rate: 0.7, send: 0.9 });
    this.blip({ noise: 1, filter: 'bandpass', f0: 500, f1: 2600, dur: 2.6, gain: 0.22, q: 0.9, send: 1.0, at: 0.1, attack: 0.9 });              // water finding the pipe
    this.blip({ noise: 2, filter: 'lowpass', f0: 90, f1: 220, dur: 2.4, gain: 0.55, send: 0.6, at: 0.2, attack: 1.0 }); }
  pumps() { if (!this.ready) return; this.pumpOn = true; this.sample('plateH', { gain: 0.9, rate: 0.5, send: 1.0 });
    this.blip({ type: 'sawtooth', f0: 22, f1: 74, dur: 3.4, gain: 0.2, send: 0.7, attack: 1.6 }); this.blip({ noise: 2, filter: 'lowpass', f0: 60, f1: 300, dur: 3.6, gain: 0.8, send: 0.8, attack: 2.0 }); this.duck(0.3, 2.5); }
  radio() { this.blip({ noise: 1, filter: 'bandpass', f0: 2400, f1: 1800, dur: 0.07, gain: 0.07, q: 2, send: 0, clean: true }); this.blip({ type: 'square', f0: 1320, dur: 0.045, gain: 0.018, send: 0, at: 0.08, clean: true }); this.blip({ noise: 1, filter: 'bandpass', f0: 1900, f1: 2600, dur: 0.05, gain: 0.045, q: 2, send: 0, at: 0.14, clean: true }); }
  roar() { if (!this.ready) return; const p = _v.set(50, 3, -31);
    for (const [f, g] of [[55, 0.34], [82.6, 0.2], [110.6, 0.12]]) this.blip({ type: 'sawtooth', f0: f, f1: f * 0.86, dur: 2.6, gain: g, pos: p, ref: 18, send: 1.3, attack: 0.25 });
    this.blip({ noise: 2, filter: 'lowpass', f0: 500, f1: 80, dur: 3, gain: 0.9, pos: p, ref: 18, send: 1.2, attack: 0.3 }); this.duck(0.5, 2.6); }
  chime() { this.blip({ type: 'sine', f0: 660, dur: 0.5, gain: 0.07, send: 0.8, clean: true }); this.blip({ type: 'sine', f0: 990, dur: 0.7, gain: 0.05, send: 0.8, at: 0.13, clean: true }); }
  ending() { if (!this.ready) return; for (const [f, at] of [[196, 0], [246.9, 0.3], [293.7, 0.6], [392, 1.1]]) this.blip({ type: 'sine', f0: f, dur: 5, gain: 0.06, send: 1.2, at, attack: 1.2, clean: true }); }

  // ------------------------------------------------------------------ the machines
  droneVoice(d) {
    let v = this.voices.get(d); if (v || !this.ready) return v; const ctx = this.ctx, big = d.type === 'lifter';
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    o1.type = 'triangle'; o2.type = 'sawtooth'; f.type = 'lowpass'; f.Q.value = 0.7; n.buffer = this.noise; n.loop = true; nf.type = 'bandpass'; nf.Q.value = 0.7; ng.gain.value = big ? 0.5 : 0.22;
    const p = this.pan(d.pos, big ? 9 : 5, 1.2); o1.connect(f); o2.connect(f); f.connect(g); n.connect(nf); nf.connect(ng); ng.connect(g); g.connect(p); p.connect(this.sfx); const s = ctx.createGain(); s.gain.value = 0.5; p.connect(s); s.connect(this.send);
    g.gain.value = 0; o1.start(); o2.start(); n.start();
    const o2g = ctx.createGain(); o2g.gain.value = 0.3; o2.disconnect(); o2.connect(o2g); o2g.connect(f);
    const chop = ctx.createOscillator(), cg = ctx.createGain(), tr = ctx.createGain(); chop.type = 'sine'; chop.frequency.value = 24; cg.gain.value = 0.32; tr.gain.value = 0.68; chop.connect(cg); cg.connect(tr.gain); g.disconnect(); g.connect(tr); tr.connect(p); chop.start();
    v = { o1, o2, f, g, nf, p, big, chop, beepT: 0 }; this.voices.set(d, v); return v;
  }
  droneWake(d) { this.blip({ type: 'sawtooth', f0: 90, f1: d.type === 'lifter' ? 240 : 620, dur: 1.0, gain: 0.12, pos: d.pos, ref: 6, send: 0.8, attack: 0.3 }); this.sample('switch_001', { gain: 0.5, pos: d.pos, ref: 5, rate: 0.7 }); }
  droneAim(d) { const big = d.type === 'lifter'; this.blip({ type: 'sine', f0: big ? 150 : 240, f1: big ? 420 : 700, dur: d.T.aim + 0.05, gain: 0.07, pos: d.pos, ref: 8, send: 0.6, attack: d.T.aim * 0.8 }); }
  droneSweep(d) { const p = d.pos; this.blip({ type: 'sawtooth', f0: 70, f1: 300, dur: 1.0, gain: 0.16, pos: p, ref: 14, send: 0.9, attack: 0.8 });
    this.blip({ type: 'sawtooth', f0: 300, f1: 285, dur: 2.0, gain: 0.2, pos: p, ref: 14, send: 0.9, at: 1.0, attack: 0.03 }); this.blip({ type: 'square', f0: 602, f1: 570, dur: 2.0, gain: 0.05, pos: p, ref: 14, send: 0.7, at: 1.0, attack: 0.03 });
    this.blip({ noise: 1, filter: 'bandpass', f0: 2400, f1: 2000, dur: 2.0, gain: 0.25, q: 1.5, pos: p, ref: 14, send: 0.8, at: 1.0, attack: 0.03 }); }
  droneShot(d) { const big = d.type === 'lifter'; this.blip({ noise: 1, filter: 'bandpass', f0: big ? 1500 : 2600, f1: 300, dur: 0.16, gain: 0.5, q: 0.7, pos: d.pos, ref: 8, send: 0.9 }); this.blip({ type: 'square', f0: big ? 240 : 420, f1: 60, dur: 0.14, gain: 0.2, pos: d.pos, ref: 8, send: 0.6 }); }
  droneHit(d, crit) { this.sample(crit ? 'glass' : 'metalH', { gain: 0.9, pos: d.pos, ref: 8, rate: d.type === 'lifter' ? 0.7 : 1.2, send: 0.8 }); this.blip({ type: 'sine', f0: 1250, f1: 600, dur: 0.07, gain: 0.12, send: 0, clean: true }); }
  droneDie(d) { const big = d.type === 'lifter', p = d.pos; this.blip({ noise: 2, filter: 'lowpass', f0: 1800, f1: 70, dur: big ? 2.2 : 0.9, gain: 1.0, pos: p, ref: 12, send: 1.2 }); this.blip({ noise: 1, filter: 'bandpass', f0: 3000, f1: 400, dur: 0.3, gain: 0.7, q: 0.5, pos: p, ref: 12, send: 0.8 });
    this.blip({ type: 'sine', f0: big ? 80 : 120, f1: 30, dur: big ? 0.9 : 0.4, gain: 0.9, pos: p, ref: 14, send: 0.4 }); this.duck(0.5, 1); const v = this.voices.get(d); if (v) v.dying = true; }
  droneCrash(d, v) { this.sample(d.type === 'lifter' ? 'metalH' : 'plateH', { gain: clamp(v / 6, 0.3, 1), pos: d.pos, ref: 8, rate: d.type === 'lifter' ? 0.5 : 0.9, send: 0.9 }); this.sample('tin', { gain: 0.4, pos: d.pos, ref: 6, at: 0.05 }); }
  whiz(p) { this.blip({ noise: 1, filter: 'bandpass', f0: 3200, f1: 700, dur: 0.16, gain: 0.3, q: 3, pos: p, ref: 2, send: 0.2 }); }

  // ------------------------------------------------------------------ the air in the building
  startAmbience() {
    const ctx = this.ctx, mk = (buf, type, freq, q) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(this.amb); s.start(0, Math.random()); return { f, g }; };
    this.wind = mk(this.noise, 'bandpass', 420, 0.6); this.wind2 = mk(this.noise, 'bandpass', 1500, 1.4); this.rumble = mk(this.brown, 'lowpass', 110, 0.5);
    const send = ctx.createGain(); send.gain.value = 0.25; this.wind.g.connect(send); send.connect(this.send);
    const mkHum = (f, g0) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0; o.connect(g); g.connect(this.amb); o.start(); return { g, g0 }; };
    this.hum = [mkHum(50, 0.05), mkHum(100, 0.035), mkHum(150, 0.012), mkHum(250, 0.004)]; this.humLvl = 0; this.humOn = false; this.pump = [mkHum(37, 0.048), mkHum(74, 0.03), mkHum(148.6, 0.009), mkHum(223, 0.003)];
  }

  setVolume(v) { this.vol = v; if (this.ready) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setPaused(p) { if (!this.ctx) return; if (p) this.ctx.suspend(); else this.ctx.resume(); }

  update(dt) {
    if (!this.ready) return; const G = this.G, ctx = this.ctx, cam = G.camera, L = ctx.listener, now = ctx.currentTime, pl = G.player; this.t += dt;
    cam.getWorldDirection(_f); _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (L.positionX) { const k = 0.03; L.positionX.setTargetAtTime(cam.position.x, now, k); L.positionY.setTargetAtTime(cam.position.y, now, k); L.positionZ.setTargetAtTime(cam.position.z, now, k);
      L.forwardX.setTargetAtTime(_f.x, now, k); L.forwardY.setTargetAtTime(_f.y, now, k); L.forwardZ.setTargetAtTime(_f.z, now, k); L.upX.setTargetAtTime(_u.x, now, k); L.upY.setTargetAtTime(_u.y, now, k); L.upZ.setTargetAtTime(_u.z, now, k); }
    else { L.setPosition(cam.position.x, cam.position.y, cam.position.z); L.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z); }
    const zone = G.world.zoneAt(cam.position); this.setRoom(zone); const A = AMB[zone] || AMB.hall;
    // the open door lets the outside in
    const open = G.world.door ? G.world.door.open : 0, nearDoor = zone === 'hall' ? open * clamp(1 - cam.position.distanceTo(_v.set(44, 2, -31)) / 30, 0, 1) : 0;
    const gust = 0.6 + 0.4 * Math.sin(this.t * 0.31) * Math.sin(this.t * 0.13 + 1) + 0.15 * Math.sin(this.t * 1.7);
    this.wind.g.gain.setTargetAtTime((A.wind + nearDoor * 0.5) * 0.11 * gust, now, 0.4); this.wind.f.frequency.setTargetAtTime(330 + 240 * gust, now, 0.5);
    this.wind2.g.gain.setTargetAtTime((A.wind + nearDoor * 0.4) * 0.02 * Math.max(0, gust - 0.5) * 2, now, 0.3); this.rumble.g.gain.setTargetAtTime(A.rumble * 0.16, now, 0.5);
    this.humLvl += ((this.humOn && zone !== 'ext' ? (zone === 'control' ? 1.3 : 1) : 0) - this.humLvl) * Math.min(1, dt * 1.5); for (const h of this.hum) h.g.gain.setTargetAtTime(h.g0 * this.humLvl, now, 0.2);
    this.pumpLvl += ((this.pumpOn ? ({ hall: 1, under: 1.25, control: 0.35, gallery: 0.4, ext: 0.12 }[zone] ?? 0.2) : 0) - this.pumpLvl) * Math.min(1, dt * 0.8); for (const h of this.pump) h.g.gain.setTargetAtTime(h.g0 * this.pumpLvl * (0.9 + 0.1 * Math.sin(this.t * 5.3)), now, 0.2);
    // drips, birds and the building settling
    this.dripT -= dt * A.drip; if (this.dripT < 0) { this.dripT = rnd(0.5, 3.2); _v.set(cam.position.x + rnd(-9, 9), 0.1, cam.position.z + rnd(-5, 5)); const f = rnd(1300, 2600);
      this.blip({ type: 'sine', f0: f, f1: f * 0.62, dur: 0.07, gain: 0.07, pos: _v, ref: 2.5, send: 1.6 }); this.blip({ type: 'sine', f0: f * 1.5, f1: f * 1.1, dur: 0.05, gain: 0.03, pos: _v, ref: 2.5, send: 1.4, at: 0.06 }); }
    this.birdT -= dt * (A.birds + nearDoor * 0.5); if (this.birdT < 0) { this.birdT = rnd(1.2, 5); _v.set(cam.position.x + rnd(10, 40), rnd(3, 12), cam.position.z + rnd(-30, 30)); const f = rnd(2800, 4600), n = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) this.blip({ type: 'sine', f0: f * rnd(0.9, 1.15), f1: f * rnd(0.7, 1.4), dur: rnd(0.05, 0.12), gain: 0.02, pos: _v, ref: 12, send: 0.3, at: i * rnd(0.09, 0.16), attack: 0.01 }); }
    this.creakT -= dt; if (this.creakT < 0 && zone !== 'ext') { this.creakT = rnd(7, 18); _v.set(cam.position.x + rnd(-14, 14), rnd(4, 9), cam.position.z + rnd(-10, 10)); this.sample(Math.random() < 0.5 ? 'tin' : 'metalL', { gain: 0.14, pos: _v, ref: 6, rate: rnd(0.4, 0.7), send: 1.5 }); }
    if (this.alarmOn) { this.alarmT = (this.alarmT || 0) - dt; if (this.alarmT < 0) { this.alarmT = 2.4; _v.set(29, 7, -45); this.blip({ type: 'square', f0: 420, f1: 640, dur: 0.9, gain: 0.05, pos: _v, ref: 14, send: 1.4, attack: 0.1 }); } }
    // rotors
    let flying = 0; if (G.enemies) for (const d of G.enemies.list) if (d.active && d.type === 'scout') flying++; const crowd = 1 / Math.sqrt(Math.max(1, flying / 2));      // many rotors at once must not add up to a wall of noise
    if (G.enemies) for (const d of G.enemies.list) {
      const on = d.active || d.state === 'wake' || (d.state === 'dying' && !d.quiet); let v = this.voices.get(d); if (!on && !v) continue; v = v || this.droneVoice(d); if (!v) continue;
      const sp = Math.abs(d.spinV) / 100, base = v.big ? 48 : 104, k = 0.05;
      v.o1.frequency.setTargetAtTime(base * (0.4 + 0.75 * sp), now, k); v.o2.frequency.setTargetAtTime(base * 2.02 * (0.4 + 0.75 * sp), now, k); v.f.frequency.setTargetAtTime((v.big ? 260 : 520) * (0.5 + sp), now, k); v.nf.frequency.setTargetAtTime((v.big ? 420 : 1050) * (0.5 + sp), now, k); v.chop.frequency.setTargetAtTime((v.big ? 13 : 27) * (0.4 + 0.75 * sp), now, k);
      // quickening beeps while it lines up a shot: the warning you can hear
      if (d.state === 'aim' || d.state === 'sweepWarm') { v.beepT -= dt; if (v.beepT <= 0) { const c = clamp(d.charge || 0, 0, 1); v.beepT = 0.3 - 0.22 * c; const f0 = (v.big ? 520 : 880) * (1 + 0.6 * c);
        this.blip({ type: 'square', f0, dur: 0.045, gain: 0.04 + 0.04 * c, pos: d.pos, ref: 10, send: 0.5 }); this.blip({ type: 'sine', f0: f0 * 2, dur: 0.05, gain: 0.04 + 0.035 * c, pos: d.pos, ref: 10, send: 0.5 }); } } else v.beepT = 0;
      v.g.gain.setTargetAtTime(on ? (v.big ? 0.3 : 0.12 * crowd) * clamp(sp, 0, 1.3) : 0, now, 0.08);
      v.p.positionX.setTargetAtTime(d.pos.x, now, k); v.p.positionY.setTargetAtTime(d.pos.y, now, k); v.p.positionZ.setTargetAtTime(d.pos.z, now, k);
    }
    // hurt: the world goes dull and a pulse comes up
    const hp = pl.health / 100; this.muffle.frequency.setTargetAtTime(hp < 0.6 ? 700 + 9000 * hp * hp : 20000, now, 0.15);
    if (hp < 0.55 && !pl.dead) { this.heart -= dt; if (this.heart < 0) { this.heart = 0.62 + hp * 0.5; this.blip({ type: 'sine', f0: 62, f1: 40, dur: 0.12, gain: 0.5 * (1 - hp), send: 0, clean: true }); this.blip({ type: 'sine', f0: 54, f1: 36, dur: 0.12, gain: 0.35 * (1 - hp), send: 0, at: 0.17, clean: true }); } }
    // level meter for the unattended tests
    this.meter.getFloatTimeDomainData(this.meterBuf); let pk = 0, sq = 0; for (let i = 0; i < 2048; i++) { const a = Math.abs(this.meterBuf[i]); if (a > pk) pk = a; sq += a * a; } this.peak = Math.max(this.peak, pk); this.rms = Math.sqrt(sq / 2048); this.peakNow = pk;
    if (pk >= 0.999) this.clips = (this.clips || 0) + 1;
  }
}
// Every sound the player's own weapon makes goes to the gun bus.
for (const k of ['shot', 'pistol', 'dry', 'bolt', 'reload', 'swap']) { const f = AudioEngine.prototype[k]; AudioEngine.prototype[k] = function (...a) { this.asGun = true; try { return f.apply(this, a); } finally { this.asGun = false; } }; }
