// Heads-up display and menus. Kept small on purpose: a dot, the rounds left, one objective line.
import * as THREE from 'three';
const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3();

export class HUD {
  constructor(G) {
    this.G = G; this.el = { dot: $('dot'), hit: $('hit'), ammo: $('ammo'), obj: $('obj'), hint: $('hint'), prompt: $('prompt'), mark: $('mark'), hurt: $('hurt'), dir: $('dir'), fade: $('fade'), stats: $('stats'), radio: $('radio'), boss: $('boss'), warn: [...document.querySelectorAll('.ui__warn')] };
    this.warns = []; this.radioT = 0; this.radioText = ''; this.radioN = 0; this.bossV = null;
    this.rounds = []; this.ammoN = -1; this.hitT = 1; this.dirT = 1; this.dirYaw = 0; this.markPos = null; this.hintT = 0; this.objT = 0;
    this.menus = { title: $('menu-title'), pause: $('menu-pause'), dead: $('menu-dead'), end: $('menu-end') };
  }
  menu(name) { for (const k in this.menus) this.menus[k].classList.toggle('is-open', k === name); }
  setAmmo(n, max, kind) {
    if (this.rounds.length !== max || this.kind !== kind) { this.kind = kind; this.el.ammo.textContent = ''; this.rounds = []; this.ammoN = -1; for (let i = 0; i < max; i++) { const d = document.createElement('div'); d.className = 'ui__round' + (kind === 'pistol' ? ' ui__round--small' : ''); this.el.ammo.appendChild(d); this.rounds.push(d); } }
    if (n !== this.ammoN) { this.ammoN = n; this.rounds.forEach((d, i) => d.classList.toggle('is-spent', i >= n)); }
  }
  hitMarker(kill) { this.hitT = 0; this.el.hit.classList.toggle('is-kill', !!kill); }
  hurt(from, player) { if (from) { this.dirT = 0; this.dirFrom = from.clone(); } }
  objective(text) { const o = this.el.obj; if (!text) { o.style.opacity = 0; return; } o.lastElementChild.textContent = text; o.style.opacity = 1; this.objT = 7; }
  hint(html, secs = 6) { this.el.hint.innerHTML = html; this.el.hint.style.opacity = html ? 1 : 0; this.hintT = secs; }
  prompt(text) { if (this.promptText === text) return; this.promptText = text; this.el.prompt.innerHTML = text || ''; this.el.prompt.style.opacity = text ? 1 : 0; }
  mark(pos, label) { this.markPos = pos ? pos.clone() : null; this.el.mark.firstElementChild.textContent = label || ''; if (!pos) this.el.mark.style.opacity = 0; }
  // an opponent with a clear line is charging a shot: pos = its eye, charge 0..1
  warn(pos, charge) { if (this.warns.length < this.el.warn.length) this.warns.push({ pos, charge }); }
  // a line from the voice on the radio, typed on
  radio(text, secs = 6) { const r = this.el.radio; this.radioText = text || ''; this.radioN = 0; this.radioT = text ? secs : 0; r.lastElementChild.textContent = ''; r.style.opacity = text ? 1 : 0; }
  // the bar at the top: the lifter's strength, or (kind 'prime') the pumps coming up to pressure
  boss(frac, label = 'Lifter', kind = '') { const b = this.el.boss; if (frac === this.bossV) return; this.bossV = frac; b.style.opacity = frac == null ? 0 : 1; if (frac == null) return;
    if (this.bossL !== label) { this.bossL = label; b.firstElementChild.textContent = label; b.className = 'ui__boss' + (kind ? ' is-' + kind : ''); } b.lastElementChild.firstElementChild.style.transform = `scaleX(${frac})`; }
  fade(opacity, ms = 1200) { this.el.fade.style.transitionDuration = ms + 'ms'; this.el.fade.style.opacity = opacity; }
  stats(text) { this.el.stats.style.display = text ? 'block' : 'none'; this.el.stats.textContent = text || ''; }
  update(dt) {
    const G = this.G, pl = G.player, e = this.el;
    e.dot.style.opacity = G.state === 'play' && pl.aimT < 0.5 && pl.sprintT < 0.5 && !G.weapon.busyReload ? 0.85 : 0;
    e.ammo.style.opacity = G.state === 'play' || G.state === 'pause' ? 0.9 : 0;
    this.hitT += dt; e.hit.style.opacity = Math.max(0, 1 - this.hitT / 0.22); e.hit.style.transform = `scale(${1 + Math.min(1, this.hitT / 0.1) * 0.25})`;
    const hp = pl.health / 100; e.hurt.style.opacity = Math.min(1, (1 - hp) * 1.25 + Math.max(0, 0.5 - pl.hurtT * 2));
    this.dirT += dt;
    if (this.dirT < 1.4 && this.dirFrom) { const a = Math.atan2(this.dirFrom.x - pl.pos.x, -(this.dirFrom.z - pl.pos.z)) + pl.yaw; e.dir.style.opacity = Math.max(0, 1 - this.dirT / 1.4); e.dir.style.transform = `rotate(${a}rad)`; } else e.dir.style.opacity = 0;
    if (this.hintT > 0) { this.hintT -= dt; if (this.hintT <= 0) e.hint.style.opacity = 0; }
    if (this.objT > 0) { this.objT -= dt; if (this.objT <= 0) e.obj.style.opacity = 0.5; }
    if (this.markPos && G.state === 'play') {
      _v.copy(this.markPos).project(G.camera);
      const behind = _v.z > 1; let x = _v.x, y = _v.y; if (behind) { x = -x; y = -1; }
      x = Math.max(-0.92, Math.min(0.92, x)); y = Math.max(-0.88, Math.min(0.88, y));
      e.mark.style.left = (x * 0.5 + 0.5) * 100 + '%'; e.mark.style.top = (-y * 0.5 + 0.5) * 100 + '%';
      const d = this.markPos.distanceTo(pl.eye), dy = this.markPos.y - pl.eye.y;
      e.mark.style.opacity = d < 1.7 ? 0 : 0.9; e.mark.firstElementChild.textContent = (dy > 1.6 ? '\u25B2 ' : dy < -1.6 ? '\u25BC ' : '') + Math.round(d) + ' m' + (dy > 1.6 ? ' up' : dy < -1.6 ? ' down' : '');
    } else e.mark.style.opacity = 0;
    if (this.radioT > 0) { const r = e.radio; if (this.radioN < this.radioText.length) { this.radioN = Math.min(this.radioText.length, this.radioN + dt * 46); r.lastElementChild.textContent = this.radioText.slice(0, Math.floor(this.radioN)); }
      this.radioT -= dt; if (this.radioT <= 0) r.style.opacity = 0; }
    for (let i = 0; i < e.warn.length; i++) { const w = this.warns[i], el = e.warn[i];
      if (!w || G.state !== 'play') { el.style.opacity = 0; continue; }
      const a = Math.atan2(w.pos.x - pl.pos.x, -(w.pos.z - pl.pos.z)) + pl.yaw, c = Math.min(1, w.charge);
      el.style.opacity = 0.25 + 0.75 * c * (c > 0.72 ? 0.55 + 0.45 * Math.sin(performance.now() * 0.03) : 1); el.style.transform = `rotate(${a}rad) scale(${1.25 - 0.25 * c})`; }
    this.warns.length = 0;
  }
}
