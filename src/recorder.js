// Clip recorder: V starts and stops a recording of the game picture and the game's own sound, saved as a video file.
// The picture is copied to a 720p canvas each frame so the file stays small enough to share; the HUD is not in it, only a crosshair dot.
const W = 1280, MAX_SECS = 180;
export class Recorder {
  constructor(G) {
    this.G = G; this.on = false; this.t0 = 0; this.el = document.getElementById('rec'); this.cv = document.createElement('canvas'); this.g = this.cv.getContext('2d', { alpha: false });
    this.ok = !!(window.MediaRecorder && this.cv.captureStream);
    addEventListener('keydown', (e) => { if (e.code === 'KeyV' && !e.repeat && (G.state === 'play' || this.on)) this.toggle(); });
  }
  toggle() { if (this.on) this.stop(); else this.start(); }
  start() {
    const G = this.G, src = G.renderer.domElement; if (!this.ok || this.on) return false;
    this.cv.width = W; this.cv.height = Math.round(W * src.height / src.width / 2) * 2;
    const stream = this.cv.captureStream(60), A = G.audio;
    if (A && A.ready) { this.dest = this.dest || A.ctx.createMediaStreamDestination(); A.out.connect(this.dest); for (const t of this.dest.stream.getAudioTracks()) stream.addTrack(t); }
    const type = ['video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4', 'video/webm;codecs="vp9,opus"', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    this.ext = type.startsWith('video/mp4') ? 'mp4' : 'webm'; this.chunks = [];
    this.mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4e6, audioBitsPerSecond: 160000 });
    this.mr.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.mr.onstop = () => this.save(type);
    this.mr.start(1000); this.on = true; this.t0 = performance.now(); this.el.style.display = 'block'; G.hud.hint('Recording. <kbd>V</kbd> stops and saves the clip', 4); return true;
  }
  stop() { if (!this.on) return; this.on = false; this.el.style.display = 'none'; try { this.mr.stop(); } catch (e) { console.error('recorder:', e); } if (this.dest) { try { this.G.audio.out.disconnect(this.dest); } catch (e) { /* already apart */ } } }
  save(type) {
    const blob = new Blob(this.chunks, { type: type.split(';')[0] }), d = new Date(), p = (n) => String(n).padStart(2, '0');
    this.name = `low-sun-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${this.ext}`; this.size = blob.size; this.chunks = [];
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = this.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    this.G.hud.hint(`Clip saved to your Downloads: ${this.name} (${Math.max(1, Math.round(blob.size / 1e6))} MB)`, 7);
  }
  // called once a frame, after the picture is drawn
  frame() {
    if (!this.on) return; const G = this.G, g = this.g, cv = this.cv, secs = (performance.now() - this.t0) / 1000;
    g.drawImage(G.renderer.domElement, 0, 0, cv.width, cv.height);
    if (G.state === 'play' && G.hud.el.dot.style.opacity > 0.1) { g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.arc(cv.width / 2, cv.height / 2, 2.6, 0, 6.3); g.fill(); g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(cv.width / 2, cv.height / 2, 1.6, 0, 6.3); g.fill(); }
    const s = Math.floor(secs); if (s !== this.shown) { this.shown = s; this.el.lastElementChild.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    if (secs > MAX_SECS) this.stop();
  }
}
