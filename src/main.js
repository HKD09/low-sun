// LOW SUN: boot, game state and the frame loop.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Colliders } from './physics.js';
import { Input, Player } from './player.js';
import { Arsenal } from './weapon.js';
import { World } from './world.js';
import { FX } from './fx.js';
import { HUD } from './hud.js';
import { Pipeline } from './post.js';
import { Capture } from './capture.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const store = { get(k, d) { try { const v = localStorage.getItem('lowsun.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('lowsun.' + k, JSON.stringify(v)); } catch { /* private window */ } } };

const QUALITY = {
  low:    { scale: 0.5,  shadow: 2048, aniso: 4 },     // scale = internal render size as a fraction of the window's device pixels
  medium: { scale: 0.62, shadow: 4096, aniso: 8 },
  high:   { scale: 0.72, shadow: 4096, aniso: 16 },
};

const G = { params, state: 'load', quality: params.get('q') || store.get('quality', 'medium'), QUALITY, showWeapon: true, time: 0, store };
window.__game = G;

async function boot() {
  const canvas = $('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false });
  G.renderer = renderer; renderer.info.autoReset = false;
  G.scene = new THREE.Scene();
  G.camera = new THREE.PerspectiveCamera(62, 1, 0.03, 600); G.camera.rotation.order = 'YXZ';
  G.viewCam = new THREE.PerspectiveCamera(50, 1, 0.03, 600); G.viewCam.layers.set(1);
  G.viewRoot = new THREE.Group(); G.scene.add(G.viewRoot);
  const msg = (t, f) => { $('load-msg').textContent = t; $('load-bar').style.width = Math.round(f * 100) + '%'; };

  msg('Reading the plans', 0.05);
  G.level = await (await fetch('./assets/level.json')).json();
  G.col = new Colliders(G.level.colliders);
  G.ktx2 = new KTX2Loader().setTranscoderPath('./vendor/three/addons/libs/basis/').detectSupport(renderer);
  G.gltf = new GLTFLoader().setKTX2Loader(G.ktx2).setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(new DRACOLoader().setDecoderPath('./vendor/three/addons/libs/draco/'));
  G.input = new Input(canvas); G.input.sens = store.get('sens', 1);
  G.hud = new HUD(G);
  G.world = new World(G);
  G.pipeline = new Pipeline(G);
  msg('Pouring concrete', 0.15);
  await G.world.load((f) => msg('Pouring concrete', 0.15 + f * 0.6));
  G.fx = new FX(G);
  G.player = new Player(G);
  msg('Oiling the bolt', 0.8);
  G.weapon = new Arsenal(G); await G.weapon.load(G.gltf);
  G.weapon.onShot = shoot;
  G.capture = new Capture(G);
  const mods = await Promise.all(['./audio.js', './enemies.js', './mission.js'].map((m) => import(m).catch((e) => { console.error('module failed: ' + m + ' ' + e.message); return null; })));
  if (mods[0]) { G.audio = new mods[0].AudioEngine(G); }
  if (mods[1]) { G.enemies = new mods[1].Enemies(G); await G.enemies.load(); }
  if (mods[2]) { G.mission = new mods[2].Mission(G); }
  try { G.recorder = new (await import('./recorder.js')).Recorder(G); } catch (e) { console.error('module failed: ./recorder.js ' + e.message); }
  if (params.has('bot')) { G.bot = new (await import('./bot.js')).Bot(G); document.body.classList.add('is-bot'); }
  msg('Ready', 1);

  resize(); addEventListener('resize', resize);
  bindUI();
  G.onDeath = () => { setTimeout(() => { if (G.state === 'play') { G.state = 'dead'; document.exitPointerLock(); G.hud.menu('dead'); } }, 1600); };
  if (params.has('power') || params.has('door')) { await G.world.setState({ power: params.has('power'), door: params.has('door') }); if (params.has('power')) { G.world.setAlarm(true); G.world.alarm = 1; } }
  if (G.capture.mode) { G.state = 'capture'; G.showWeapon = params.has('gun'); if (G.mission) await G.mission.captureSetup(params); if (params.get('gun') === 'pistol') { const A = G.weapon; A.cur = A.pistol; A.rifle.root.visible = false; A.pistol.root.visible = true; } }
  else { G.state = 'menu'; G.hud.menu('title'); G.mission && G.mission.reset(); }
  // warm up behind the loading screen: compile every shader and upload the rifle's textures now, not at first sight
  msg('Letting the dust settle', 1);
  try { renderer.setRenderTarget(G.pipeline.scene); await renderer.compileAsync(G.scene, G.camera); await renderer.compileAsync(G.scene, G.viewCam); renderer.setRenderTarget(null); } catch (e) { console.warn('precompile skipped', e.message); }
  for (const m of G.weapon.models) m.traverse((o) => { if (o.isMesh) for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap']) if (o.material[k]) renderer.initTexture(o.material[k]); });
  for (let i = 0; i < 3; i++) { update(1 / 60, 16.7); G.pipeline.render(1 / 60); await new Promise((r) => requestAnimationFrame(r)); }
  $('load').style.opacity = 0; setTimeout(() => ($('load').style.display = 'none'), 900); G.hud.fade(0, 1400);
  G.ready = true; let last = performance.now();
  // ?rec=1 keeps every frame time so a test can ask for statistics over any stretch of play:  window.__rec()
  const rec = params.has('rec') ? [] : null;
  window.__rec = () => { if (!rec || !rec.length) return null; const t = rec.slice().sort((a, b) => a - b), n = t.length, avg = t.reduce((a, b) => a + b, 0) / n, w = t.slice(Math.floor(n * 0.99)), w1 = w.reduce((a, b) => a + b, 0) / w.length;
    const out = { frames: n, seconds: +(avg * n / 1000).toFixed(1), avgFps: +(1000 / avg).toFixed(1), avgMs: +avg.toFixed(2), medianMs: +t[n >> 1].toFixed(2), worst1pctMs: +w1.toFixed(2), worst1pctFps: +(1000 / w1).toFixed(1), maxMs: +t[n - 1].toFixed(1), over33ms: rec.filter((x) => x > 33.4).length, over50ms: rec.filter((x) => x > 50).length,
      internal: `${G.pipeline.iw}x${G.pipeline.ih}`, dynScale: G.dynScale || 1, quality: G.quality, calls: G.info?.calls, tris: G.info?.tris }; rec.length = 0; return out; };
  if (params.has('autostart')) start();
  // One bad frame must never stop the game with the mouse captured: the next frame is queued first, a failed frame is logged and skipped,
  // and if frames keep failing the mouse is released and the player is told.
  let faults = 0;
  const loop = (now) => { requestAnimationFrame(loop); const raw = now - last; last = now; let dt = Math.min(0.05, raw / 1000); if (G.slowmo > 0) { G.slowmo -= dt; dt *= 0.3 + 0.7 * Math.max(0, 1 - G.slowmo / 0.5); }
    try { update(dt, raw); G.pipeline.render(dt); G.recorder && G.recorder.frame(); faults = 0; }
    catch (e) { if (faults === 0) console.error('frame failed:', e); G.faultCount = (G.faultCount || 0) + 1; if (++faults === 30) { document.exitPointerLock(); $('fault').style.display = 'flex'; } renderer.setRenderTarget(null); }
    G.info = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; G.input.endFrame(); adapt(raw); if (rec) rec.push(raw); };
  requestAnimationFrame(loop);
}

function resize() {
  const r = G.renderer, q = QUALITY[G.quality] || QUALITY.medium, forced = params.get('res');
  let w = innerWidth, h = innerHeight;
  if (forced) { const [fw, fh] = forced.split('x').map(Number); r.setPixelRatio(1); r.setSize(fw, fh, false); w = fw; h = fh; }
  else { r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.setSize(w, h, false); }
  G.camera.aspect = G.viewCam.aspect = w / h; G.camera.updateProjectionMatrix(); G.viewCam.updateProjectionMatrix();
  const s = r.getDrawingBufferSize(new THREE.Vector2()); G.pipeline.resize(s.x, s.y);
}
G.resize = resize;

// One rifle shot: sentries first, then the building.
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surf: '' };
function shoot(origin, dir, muzzle, dmg = 100) {
  const w = G.world.raycast(origin, dir, 300), far = w ? w.distance : 300;
  const e = G.enemies ? G.enemies.raycast(origin, dir, far) : null;
  const end = e ? e.point : w ? w.point : origin.clone().addScaledVector(dir, 300);
  G.fx.tracer(muzzle, end);
  if (e) { e.dmg = dmg; G.fx.impact(e.point, e.normal, 'drone', dir, dmg >= 100 ? 1.4 : 0.8); const killed = e.enemy.hit(e, dir); G.hud.hitMarker(killed); return true; }
  if (w) G.fx.impact(w.point, w.normal, w.surf, dir, dmg >= 100 ? 1 : 0.6);
  G.enemies && G.enemies.heard(origin);
  return false;
}

function start() {
  if (G.state === 'play') return;
  G.audio && G.audio.resume();
  G.input.lock();
  if (G.state === 'menu') { G.hud.menu(null); G.state = 'play'; G.mission && G.mission.begin(); }
}
function pause() { if (G.state !== 'play') return; G.state = 'pause'; G.hud.menu('pause'); G.audio && G.audio.setPaused(true); }
function resume() { if (G.state !== 'pause') return; G.input.lock(); G.state = 'play'; G.hud.menu(null); G.audio && G.audio.setPaused(false); }
function restart(checkpoint) {
  G.player.reset(checkpoint && G.mission ? G.mission.checkpoint() : null); G.weapon.reset(); G.hud.menu(null);
  G.mission && (checkpoint ? G.mission.retry() : G.mission.reset()); G.state = 'play'; G.input.lock(); G.audio && G.audio.setPaused(false);
  if (!checkpoint && G.mission) G.mission.begin();
}
G.start = start; G.restart = restart;
G.end = (stats) => { G.state = 'end'; document.exitPointerLock(); $('end-stats').textContent = stats; G.hud.menu('end'); };

function bindUI() {
  $('menu-title').addEventListener('click', start);
  $('btn-resume').addEventListener('click', resume);
  $('btn-restart').addEventListener('click', () => restart(false));
  $('btn-retry').addEventListener('click', () => restart(true));
  $('btn-again').addEventListener('click', () => restart(false));
  G.input.onLock = (locked) => { if (!locked && G.state === 'play') pause(); };
  $('view').addEventListener('click', () => { if (G.state === 'play' && !G.input.locked) G.input.lock(); });
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && G.state === 'pause' && !G.input.locked) { /* Esc already released the pointer; a second press resumes */ } if (e.code === 'F3') { G.debug = !G.debug; if (!G.debug) G.hud.stats(''); } });
  const sens = $('set-sens'), vol = $('set-vol');
  sens.value = G.input.sens; $('out-sens').textContent = (+sens.value).toFixed(2);
  sens.addEventListener('input', () => { G.input.sens = +sens.value; $('out-sens').textContent = (+sens.value).toFixed(2); store.set('sens', +sens.value); });
  vol.value = store.get('vol', 0.8); $('out-vol').textContent = Math.round(vol.value * 100);
  vol.addEventListener('input', () => { $('out-vol').textContent = Math.round(vol.value * 100); store.set('vol', +vol.value); G.audio && G.audio.setVolume(+vol.value); });
  const seg = $('set-quality'); const mark = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.q === G.quality)); mark();
  seg.addEventListener('click', (e) => { const q = e.target.dataset.q; if (!q) return; G.quality = q; store.set('quality', q); mark(); G.dynScale = 1; G.pipeline.setQuality && G.pipeline.setQuality(q); resize(); });
}

// Dynamic resolution: if frames run long (a warm, fanless laptop slows down), render fewer pixels; give them back when there is room.
// Judged over 1.5 s windows, so a single long frame changes nothing. Scaling back up is tried after a calm spell and backs off if it fails.
let winN = 0, winSlow = 0, winT = 0, holdT = 0, calmT = 0, upWait = 10000, lastUp = false;
function adapt(ms) {
  if (G.state !== 'play' || params.has('nodyn') || params.has('scale')) { winN = winSlow = winT = 0; return; }
  winN++; winT += ms; if (ms > 20) winSlow++; holdT -= ms;
  if (winT < 1500) return;
  const frac = winSlow / winN, d = G.dynScale || 1; winN = winSlow = winT = 0;
  if (frac > 0.3 && holdT <= 0 && d > 0.62) { G.dynScale = Math.max(0.62, d - 0.08); holdT = 3000; calmT = 0; if (lastUp) upWait = Math.min(120000, upWait * 2); lastUp = false; resize(); }
  else if (frac < 0.04) { calmT += 1500; if (calmT > upWait && d < 1 && holdT <= 0) { G.dynScale = Math.min(1, d + 0.06); holdT = 3000; calmT = 0; lastUp = true; resize(); } }
  else calmT = 0;
}

let fpsAcc = 0, fpsN = 0, fpsShown = 0;
function update(dt, rawMs) {
  G.time += dt; G.renderer.info.reset();
  const playing = G.state === 'play';
  if (G.state === 'capture') G.capture.update(dt, rawMs);
  else if (playing || G.state === 'dead' || G.state === 'menu' || G.state === 'end') { G.bot && G.bot.update(dt); G.player.update(dt, G.input); }
  if (G.state !== 'pause') {
    G.viewRoot.position.copy(G.camera.position); G.viewRoot.quaternion.copy(G.camera.quaternion); G.viewRoot.updateMatrixWorld(true);
    G.viewCam.position.copy(G.camera.position); G.viewCam.quaternion.copy(G.camera.quaternion); G.viewCam.updateMatrixWorld(true);
    G.weapon.update(dt, G.input);
    G.mission && G.mission.update(dt);
    G.enemies && G.enemies.update(dt);
    G.world.update(dt); G.fx.update(dt);
    G.audio && G.audio.update(dt);
  }
  G.hud.update(dt);
  if (G.state === 'menu' && G.mission) G.mission.menuCamera(dt);
  fpsAcc += rawMs; fpsN++;
  if (fpsAcc > 500) { fpsShown = 1000 * fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; G.fps = fpsShown;
    if (G.debug || params.has('debug')) { const i = G.info || { calls: 0, tris: 0 }, p = G.player.pos; G.hud.stats(`${fpsShown.toFixed(0)} fps  ${i.calls} calls  ${(i.tris / 1000).toFixed(0)}k tris\n${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  ${G.world.zoneAt(p)}  ${G.quality} x${(G.dynScale || 1).toFixed(2)}`); } }
}

boot().catch((e) => { console.error(e); $('load-msg').textContent = 'Could not start: ' + e.message; });
