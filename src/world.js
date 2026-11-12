// The station: lightmapped geometry, sky, sun, glass, lamps, light probes, and queries against the static world.
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { Materials, MATS, HDR_GLSL } from './materials.js';
import { damp, clamp } from './physics.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const METAL = new Set(['metal_yellow', 'metal_green', 'metal_blue', 'metal_rust', 'metal_dark', 'steel', 'shutter', 'corr', 'frame']);
const _ray = new THREE.Raycaster(); _ray.firstHitOnly = true;
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3(), _c = new THREE.Color();
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// Cube-map face texel directions as three.js lays them out (px, nx, py, ny, pz, nz).
function faceDir(f, u, v, out) {
  switch (f) { case 0: return out.set(1, -v, -u); case 1: return out.set(-1, -v, u); case 2: return out.set(u, 1, v); case 3: return out.set(u, -1, -v); case 4: return out.set(u, -v, 1); default: return out.set(-u, -v, -1); }
}

export class World {
  constructor(G) {
    this.G = G; this.group = new THREE.Group(); G.scene.add(this.group);
    this.solid = [];
    this.sunDir = new THREE.Vector3().fromArray(G.level.ent.sun.dir).normalize();
    this.sunColor = new THREE.Color().fromArray(G.level.ent.sun.color);
    this.materials = new Materials(G);
    this.zones = {}; this.playerAmb = Array.from({ length: 6 }, () => new THREE.Vector3(0.3, 0.3, 0.3));
    this.dyn = []; this.power = 0; this.powerTarget = 0; this.time = 0; this.lampGlow = []; this.flicker = 0; this.rebakeQ = null; this.zoneName = 'adit';
    this.alarm = 0;
  }

  async load(progress) {
    const G = this.G, M = this.materials;
    const [lm, sky, man] = await Promise.all(['./assets/lm/lm.json', './assets/sky/sky.json', './assets/tex/p/manifest.json'].map((u) => fetch(u).then((r) => r.json())));
    M.manifest = man;
    this.sky = sky; this.sunStrength = lm.sun; M.shared.lsRange.value.set(lm.range.day, lm.range.lamps * 0.95);     // the lamps are kept well under the daylight so the sun stays the brightest thing in every room
    const gltf = await G.gltf.loadAsync('./assets/level.glb'); progress(0.15);
    // lightmaps, one pair per atlas
    const tl = new THREE.TextureLoader(), atl = {}, ext = lm.format || 'png';
    const loadLm = async (name) => { const t = ext === 'ktx2' ? await G.ktx2.loadAsync(`./assets/lm/${name}.ktx2`) : await tl.loadAsync(`./assets/lm/${name}.png`);
      t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
    const names = [...new Set(Object.values(lm.atlas))];
    await Promise.all(names.map(async (a) => { atl[a] = { day: await loadLm(a + '_day'), lamps: await loadLm(a + '_lamps') }; }));
    progress(0.3);
    const PAINT = { gallery: { color: [0.07, 0.3, 0.36], base: 0, height: 1.2 }, hall: { color: [0.08, 0.3, 0.17], base: 0, height: 1.5 }, control: { color: [0.14, 0.24, 0.42], base: 4.2, height: 1.05 }, under: { color: [0.42, 0.3, 0.05], base: -4.4, height: 0.9 } };
    for (const k in G.level.ent.zones) { const z = G.level.ent.zones[k];
      this.zones[k] = { name: k, lightmap: atl[lm.atlas[k]], box: { min: new THREE.Vector3().fromArray(z.a), max: new THREE.Vector3().fromArray(z.b), pos: new THREE.Vector3().fromArray(z.probe) }, env: null, def: z, paint: PAINT[k] }; }
    // textures
    const meshes = []; gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const paths = new Set(); for (const o of meshes) for (const p of M.texPaths(o.material.name)) paths.add(p);
    for (const n of ['shutter', 'glove', 'steel', 'metal_dark', 'metal_yellow']) for (const p of M.texPaths(n)) paths.add(p);
    await M.preload([...paths], (f) => progress(0.3 + f * 0.5));
    for (const o of meshes) {
      const zone = this.zones[o.name.split('|')[0]] || this.zones.hall, mat = o.material.name;
      const ga = o.geometry.attributes; if (mat.startsWith('P:')) { o.geometry.setAttribute('lsColA', ga._lsa); o.geometry.setAttribute('lsColB', ga._lsb); } else o.geometry.setAttribute('lsUv', ga.uv1 || ga.uv);
      o.material = M.staticMat(mat, zone); o.castShadow = true; o.receiveShadow = true; o.matrixAutoUpdate = false;
      o.userData.surf = mat === 'grate' ? 'grate' : METAL.has(mat) || mat.startsWith('P:') ? 'metal' : 'concrete';
      o.geometry.computeBoundsTree(); this.solid.push(o);
    }
    this.group.add(gltf.scene); gltf.scene.updateMatrixWorld(true);
    this.buildSun(); this.buildSky(); this.buildGlass(); this.buildLamps(); this.buildDoor(); this.buildLive(); this.buildMotes(); this.buildDecals(); this.buildBeacons();
    progress(0.85);
    await this.captureProbes();
    progress(1);
  }

  buildSun() {
    const sun = new THREE.DirectionalLight(this.sunColor, this.sunStrength * 0.78); sun.layers.enableAll();    // a little under the bake's sun so lit concrete keeps its texture
    const c = new THREE.Vector3(30, 4, -23);
    sun.position.copy(c).addScaledVector(this.sunDir, 90); sun.target.position.copy(c);
    sun.castShadow = true; const s = this.G.QUALITY[this.G.quality].shadow; sun.shadow.mapSize.set(s, s);
    const view = new THREE.Matrix4().lookAt(sun.position, c, new THREE.Vector3(0, 1, 0)).invert();
    const box = new THREE.Box3();
    for (const x of [-1, 62]) for (const y of [-5.5, 12.5]) for (const z of [-47.5, 1.5]) box.expandByPoint(_v.set(x, y, z).sub(sun.position).applyMatrix4(view));
    const cam = sun.shadow.camera; cam.left = box.min.x; cam.right = box.max.x; cam.bottom = box.min.y; cam.top = box.max.y; cam.near = Math.max(0.5, -box.max.z - 2); cam.far = -box.min.z + 2; cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.03; sun.shadow.radius = 1.0;
    this.G.scene.add(sun, sun.target); this.sun = sun;
  }

  buildSky() {
    const s = this.sky, G = this.G;
    const mist = new THREE.Color().fromArray(s.horizon).multiplyScalar(0.9);
    const el = s.sunElevDeg * Math.PI / 180, az = Math.atan2(this.sunDir.z, this.sunDir.x);
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { tSky: { value: null }, tSkyB: { value: null }, uK: { value: s.k }, uVMax: { value: s.vMax }, uMist: { value: mist }, uSunFile: { value: new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)) },
        uSunCol: { value: new THREE.Color(1.0, 0.72, 0.4) }, uDisc: { value: 1 }, lsHdr: this.materials.shared.lsHdr },
      depthWrite: false, depthFunc: THREE.LessEqualDepth,
      vertexShader: `varying vec3 vDir; void main(){ gl_Position = vec4( position.xy, 1.0, 1.0 ); vec4 v = inverse( projectionMatrix ) * vec4( position.xy, 1.0, 1.0 ); vDir = transpose( mat3( viewMatrix ) ) * ( v.xyz / v.w ); }`,
      fragmentShader: `uniform sampler2D tSky; uniform sampler2D tSkyB; uniform float uK; uniform float uVMax; uniform vec3 uMist; uniform vec3 uSunFile; uniform vec3 uSunCol; uniform float uDisc; varying vec3 vDir; ${HDR_GLSL}
        void main(){ vec3 d = normalize( vDir ); float u = atan( d.z, d.x ) / 6.2831853 + 0.5; float v = 0.5 - asin( clamp( d.y, -1.0, 1.0 ) ) / 3.14159265;
          float vv = min( v / uVMax, 0.999 ); vec3 c = u < 0.5 ? textureLod( tSky, vec2( u * 2.0, vv ), 0.0 ).rgb : textureLod( tSkyB, vec2( u * 2.0 - 1.0, vv ), 0.0 ).rgb; c = c * c / uK;
          float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); c = max( mix( vec3( lum ), c, 1.6 ), 0.0 ) * mix( vec3( 1.0 ), vec3( 0.62, 0.86, 1.25 ), smoothstep( 0.06, 0.55, d.y ) );      // richer colour, deeper blue overhead
          float toSun = max( dot( normalize( d.xz ), normalize( uSunFile.xz ) ), 0.0 ); c += vec3( 1.0, 0.42, 0.16 ) * exp( -abs( d.y - 0.02 ) * 7.0 ) * ( 0.4 * toSun * toSun + 1.7 * pow( toSun, 6.0 ) );                              // the band of fire along the horizon under a low sun
          c = mix( c, uMist, smoothstep( -0.06, -0.15, d.y ) );           // the photographed reservoir and far ridges stay; only the near ground is lost in mist
          float cs = dot( d, uSunFile ); c += uSunCol * ( smoothstep( 0.99996, 0.999986, cs ) * 900.0 + pow( max( cs, 0.0 ), 900.0 ) * 20.0 + pow( max( cs, 0.0 ), 60.0 ) * 1.6 + pow( max( cs, 0.0 ), 8.0 ) * 0.25 ) * uDisc;
          gl_FragColor = vec4( lsEncode( c ), 1.0 ); }`,
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const m = new THREE.Mesh(g, this.skyMat); m.frustumCulled = false; m.renderOrder = 900; this.G.scene.add(m); this.skyMesh = m;
    this.mistColor = mist;
    const done = (key) => (t) => { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter; t.colorSpace = THREE.NoColorSpace; t.flipY = false; t.needsUpdate = true; this.skyMat.uniforms[key].value = t; };
    this.skyReady = Promise.all([G.ktx2.loadAsync('./assets/sky/sky_a.ktx2').then(done('tSky')), G.ktx2.loadAsync('./assets/sky/sky_b.ktx2').then(done('tSkyB'))]);
  }

  buildGlass() {
    const pos = [], uv = [], seed = [], idx = []; let n = 0;
    for (const p of this.G.level.parts) {
      if (p.t !== 'glass') continue;
      const q = p.axis === 'x' ? [[p.c, p.v[0], p.u[0]], [p.c, p.v[0], p.u[1]], [p.c, p.v[1], p.u[1]], [p.c, p.v[1], p.u[0]]] : [[p.u[0], p.v[0], p.c], [p.u[1], p.v[0], p.c], [p.u[1], p.v[1], p.c], [p.u[0], p.v[1], p.c]];
      for (const v of q) pos.push(...v); uv.push(0, 0, p.n[0], 0, p.n[0], p.n[1], 0, p.n[1]);
      for (let i = 0; i < 4; i++) seed.push(p.seed * 7.31 + 1.7, p.broken, p.zone === 'control' ? 1 : 0);
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 3)); g.setIndex(idx);
    this.glassMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { lsNoise: this.materials.shared.lsNoise, lsHdr: this.materials.shared.lsHdr, uSunDir: { value: this.sunDir }, uSunCol: { value: this.sunColor.clone().multiplyScalar(this.sunStrength) }, uAmb: { value: new THREE.Color(0.5, 0.6, 0.75) } },
      vertexShader: `attribute vec3 aSeed; varying vec2 vUv; varying vec3 vSeed; varying vec3 vW; void main(){ vUv = uv; vSeed = aSeed; vec4 w = modelMatrix * vec4( position, 1.0 ); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D lsNoise; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb; varying vec2 vUv; varying vec3 vSeed; varying vec3 vW; ${HDR_GLSL}
        float hash( vec2 p ){ return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
        void main(){ vec2 pane = floor( vUv ), f = fract( vUv ); float h = hash( pane + vSeed.x ); float edge = min( min( f.x, 1.0 - f.x ), min( f.y, 1.0 - f.y ) );
          vec3 n = texture2D( lsNoise, vUv * 0.23 + vSeed.x * 0.13 ).rgb; vec3 n2 = texture2D( lsNoise, vUv * 1.9 + h ).rgb;
          if ( h < vSeed.y && edge > 0.06 + n.r * 0.3 * ( 0.4 + f.y ) ) discard;                 // a broken pane keeps a few shards in its frame
          // dirt: runs that have dried down each pane, grime gathered in the corners and along the bottom bar, fine speckle
          float runs = texture2D( lsNoise, vec2( vUv.x * 0.9 + vSeed.x, vUv.y * 0.07 ) ).r; float speck = texture2D( lsNoise, vUv * 4.3 + h ).a;
          float grime = runs * 0.45 + n2.b * 0.2 + ( 1.0 - smoothstep( 0.0, 0.22, edge ) ) * 0.4 + pow( 1.0 - f.y, 3.0 ) * 0.3 + h * 0.18 + step( 0.93, speck ) * 0.25;
          vec3 view = normalize( vW - cameraPosition ); vec3 gn = normalize( cross( dFdx( vW ), dFdy( vW ) ) ); float fr = pow( 1.0 - abs( dot( view, gn ) ), 4.0 );
          float fwd = max( dot( view, uSunDir ), 0.0 ); float a; vec3 c;
          if ( vSeed.z > 0.5 ) { a = 0.05 + 0.12 * smoothstep( 0.55, 1.0, grime ) + fr * 0.5; c = vec3( 0.035, 0.04, 0.045 ) + fr * uAmb * 0.25; }      // the control room's clean partition glass
          else { a = mix( 0.22, 0.84, smoothstep( 0.32, 1.0, grime ) ); a = max( a, fr * 0.7 );
            c = uAmb * ( 0.22 + 0.4 * n2.r ) * ( 0.55 + 0.6 * runs ) + uSunCol * ( pow( fwd, 10.0 ) * 0.9 + pow( fwd, 90.0 ) * 6.0 ) * a + fr * uAmb * 0.3; }
          gl_FragColor = vec4( lsEncode( c ), a ); }` });
    const m = new THREE.Mesh(g, this.glassMat); m.renderOrder = 3; m.frustumCulled = false; this.group.add(m); this.glass = m;
  }

  buildLamps() {
    const G = this.G, hdr = this.materials.shared.lsHdr;
    this.lamps = [];
    const glowTex = this.glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.12, 'rgba(255,255,255,.42)'); r.addColorStop(0.4, 'rgba(255,255,255,.1)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
    for (const l of G.level.lamps) {
      const col = new THREE.Color().fromArray(l.color), u = { uCol: { value: col.clone() }, uI: { value: 0 }, lsHdr: hdr };
      const em = new THREE.ShaderMaterial({ uniforms: u, vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }', fragmentShader: `uniform vec3 uCol; uniform float uI; ${HDR_GLSL} void main(){ gl_FragColor = vec4( lsEncode( uCol * uI + 0.012 ), 1.0 ); }` });
      const grp = new THREE.Group(); grp.position.fromArray(l.pos); grp.rotation.y = l.ry || 0; let peak = 60, gs = 1.6;
      // the housings are scanned fixtures baked into the level; only the glowing part is drawn here
      if (l.kind === 'hang') { const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 10), em); bulb.scale.y = 0.75; grp.add(bulb); peak = 90; gs = 1.5; }
      else if (l.kind === 'tube') { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), em); t.rotation.z = Math.PI / 2; grp.add(t); peak = 11; gs = 0.7; u.uCol.value.setRGB(1.0, 0.84, 0.62); }
      else { const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), em); bulb.scale.set(1, 1.5, 0.8); grp.add(bulb); peak = 26; gs = 0.8; }
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { map: { value: glowTex }, uCol: { value: col.clone() }, uI: { value: 0 }, lsHdr: hdr },
        vertexShader: 'varying vec2 vUv; uniform float uS; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ); mv.xy += position.xy * ' + gs.toFixed(2) + '; gl_Position = projectionMatrix * mv; }',
        fragmentShader: `uniform sampler2D map; uniform vec3 uCol; uniform float uI; varying vec2 vUv; ${HDR_GLSL} void main(){ float a = texture2D( map, vUv ).a; gl_FragColor = vec4( lsEncode( uCol * uI * a ), 1.0 ); }` }));
       glow.renderOrder = 4; glow.frustumCulled = false; grp.add(glow);
      grp.traverse((o) => { o.castShadow = false; }); this.group.add(grp);
      this.lamps.push({ def: l, em: u, glow: glow.material.uniforms, peak, phase: Math.random() * 10, bad: !l.always && Math.random() < 0.18 });
    }
  }

  // Moving doors: the roller door to the terrace and two that the station's interlocks hold shut.
  buildDoor() {
    const E = this.G.level.ent, M = this.materials; this.doors = {};
    const make = (key, a, b, move, secs) => {
      const mat = M.set('shutter', {}), amb = Array.from({ length: 6 }, () => new THREE.Vector3(0.2, 0.2, 0.2)); M.patch(mat, { amb, macro: 0.05, recolor: key === 'roller' ? undefined : [0.95, 0.2, 0.14] });
      const sx = b[0] - a[0], sy = b[1] - a[1], sz = b[2] - a[2], g = new THREE.BoxGeometry(sx, sy, sz); const uvs = g.attributes.uv; for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * Math.max(sx, sz) / 2, uvs.getY(i) * sy / 2);
      const m = new THREE.Mesh(g, mat); m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); m.castShadow = true; m.receiveShadow = true; m.userData.surf = 'metal';
      this.group.add(m); g.computeBoundsTree(); this.solid.push(m);
      const d = { key, mesh: m, open: 0, target: 0, col: this.G.col.add({ t: 'box', a, b, surf: 'metal' }), a: a.slice(), b: b.slice(), home: m.position.clone(), move, secs }; this.doors[key] = d;
      this.dyn.push({ mat, amb, pos: m.position }); return d;
    };
    const r = E.door; this.door = make('roller', r.a, r.b, [0, r.lift, 0], 3.2);
    for (const k in E.doors || {}) make(k, E.doors[k].a, E.doors[k].b, E.doors[k].move, k === 'hall' ? 2.2 : 1.4);
  }
  placeDoor(d) { const k = d.open * d.open * (3 - 2 * d.open); d.mesh.position.set(d.home.x + d.move[0] * k, d.home.y + d.move[1] * k, d.home.z + d.move[2] * k); d.mesh.updateMatrixWorld();
    for (let i = 0; i < 3; i++) { d.col.a[i] = d.a[i] + d.move[i] * k; d.col.b[i] = d.b[i] + d.move[i] * k; } }

  // Console screens and the pulsing markers on things the player operates. All drawn live; none of it is baked.
  buildLive() {
    const hdr = this.materials.shared.lsHdr, E = this.G.level.ent; this.screens = []; this.beacons2 = [];
    const housing = new THREE.MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.5, metalness: 0.6 }); this.dressDynamic(housing);
    const cols = [[0.2, 1.0, 0.45], [1.0, 0.62, 0.15], [0.2, 1.0, 0.45], [0.3, 0.75, 1.0]];
    (E.console_screens || []).forEach((p, i) => {
      const u = { uCol: { value: new THREE.Color().fromArray(cols[i % 4]) }, uI: { value: 0 }, uT: { value: 0 }, uSeed: { value: i * 3.7 }, lsHdr: hdr };
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 0.5), housing); box.position.set(p[0] + 0.1, p[1] + 0.18, p[2]); box.castShadow = true;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.28), new THREE.ShaderMaterial({ uniforms: u, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
        fragmentShader: `uniform vec3 uCol; uniform float uI; uniform float uT; uniform float uSeed; varying vec2 vUv; ${HDR_GLSL}
          float h( vec2 p ){ return fract( sin( dot( p, vec2( 12.99, 78.23 ) ) + uSeed ) * 43758.5 ); }
          void main(){ vec2 g = vec2( floor( vUv.x * 22.0 ), floor( vUv.y * 11.0 ) ); float row = h( vec2( 0.0, g.y ) ); float txt = step( g.x / 22.0, 0.25 + 0.7 * row ) * step( 0.35, h( g + floor( uT * 0.6 + row * 4.0 ) * 0.01 ) ) * step( 0.15, fract( vUv.y * 11.0 ) );
            float bar = step( vUv.y, 0.16 ) * step( vUv.x, 0.3 + 0.6 * fract( uT * 0.11 + uSeed ) ); float scan = 0.82 + 0.18 * sin( vUv.y * 190.0 ); vec2 q = vUv - 0.5; float vig = 1.0 - dot( q, q ) * 1.6;
            gl_FragColor = vec4( lsEncode( uCol * ( 0.05 + 0.95 * max( txt, bar ) ) * scan * vig * uI + 0.004 ), 1.0 ); }` }));
      scr.rotation.y = -Math.PI / 2; scr.position.set(p[0] - 0.075, p[1] + 0.18, p[2]); this.group.add(box, scr); this.screens.push(u);
    });
  }
  // A pulsing light on something to be operated. Returns a handle with .on.
  addMarker(pos, color = 0xffb040) {
    const hdr = this.materials.shared.lsHdr, c = new THREE.Color(color), u = { map: { value: this.glowTex }, uCol: { value: c }, uI: { value: 0 }, lsHdr: hdr };
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, uniforms: u,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ); mv.xy += position.xy * 0.9; gl_Position = projectionMatrix * mv; }',
      fragmentShader: `uniform sampler2D map; uniform vec3 uCol; uniform float uI; varying vec2 vUv; ${HDR_GLSL} void main(){ float a = texture2D( map, vUv ).a; gl_FragColor = vec4( lsEncode( uCol * uI * a ), 1.0 ); }` }));
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.ShaderMaterial({ uniforms: u, vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }', fragmentShader: `uniform vec3 uCol; uniform float uI; ${HDR_GLSL} void main(){ gl_FragColor = vec4( lsEncode( uCol * ( uI * 6.0 + 0.03 ) ), 1.0 ); }` }));
    const g = new THREE.Group(); g.position.copy(pos); g.add(glow, lamp); glow.renderOrder = 9; glow.frustumCulled = false; this.group.add(g);
    const h = { on: false, u, k: 0, ph: Math.random() * 6, pos: pos.clone() }; this.beacons2.push(h); return h;
  }

  buildDecals() {
    const D = this.G.level.decals || []; if (!D.length) return;
    const S = 2048, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
    const rects = {}, texts = [...new Set(D.filter((d) => d.kind === 'stencil').map((d) => d.text))];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const worn = (x, y, w, h, n) => { g.globalCompositeOperation = 'source-over'; for (let i = 0; i < n * 5; i++) { g.fillStyle = `rgba(255,255,255,${rnd(0.3, 0.95)})`; const r = rnd(0.4, 2.2); g.beginPath(); g.ellipse(x + rnd(0, w), y + rnd(0, h), r * rnd(1, 3), r, rnd(0, 3), 0, 7); g.fill(); } };
    // stencilled lettering, one row each
    let y = 8; g.textBaseline = 'middle';
    for (const t of texts) { const h = 84; g.font = `700 ${h * 0.74}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; const w = Math.min(S - 16, g.measureText(t).width + 24);
      g.fillStyle = 'rgba(38,36,34,0.92)'; g.fillText(t, 20, y + h / 2 + 2, S - 40); worn(8, y, w, h, 60 + t.length * 5); rects['t:' + t] = [8, y, w, h]; y += h + 8; }
    // hazard tape
    { const h = 64, w = S - 16; g.save(); g.beginPath(); g.rect(8, y, w, h); g.clip(); g.fillStyle = 'rgb(214,160,40)'; g.fillRect(8, y, w, h); g.fillStyle = 'rgb(34,32,30)';
      for (let x = -h; x < w + h; x += h * 1.4) { g.beginPath(); g.moveTo(8 + x, y + h); g.lineTo(8 + x + h * 0.7, y + h); g.lineTo(8 + x + h * 1.7, y); g.lineTo(8 + x + h, y); g.fill(); } g.restore(); worn(8, y, w, h, 420); rects.hazard = [8, y, w, h]; y += h + 8; }
    // maker's plate
    { g.fillStyle = 'rgb(70,72,74)'; g.fillRect(8, y, 220, 130); g.fillStyle = 'rgb(190,186,170)'; g.font = '700 22px Arial'; g.fillText('HELVAR  TYPE VK 1250', 20, y + 26); g.font = '16px Arial';
      ['3~ MOT   6600 V   1.2 MW', '50 Hz   740 r/min   IP55', 'No. 4471 / 02      1987'].forEach((t, i) => g.fillText(t, 20, y + 58 + i * 24)); rects.plate = [8, y, 220, 130]; }
    // mimic board: the station drawn as a line diagram on a grey panel
    { const mx = 8, my = y + 150, mw = 840, mh = 300; g.fillStyle = 'rgb(128,132,128)'; g.fillRect(mx, my, mw, mh); g.strokeStyle = 'rgb(52,54,52)'; g.lineWidth = 5; g.strokeRect(mx + 4, my + 4, mw - 8, mh - 8);
      g.lineWidth = 6; g.beginPath(); g.moveTo(mx + 40, my + 150); g.lineTo(mx + 800, my + 150); for (let i = 0; i < 3; i++) { const px = mx + 220 + i * 200; g.moveTo(px, my + 150); g.lineTo(px, my + 70); g.moveTo(px, my + 150); g.lineTo(px, my + 235); } g.stroke();
      for (let i = 0; i < 3; i++) { const px = mx + 220 + i * 200; g.fillStyle = 'rgb(60,62,60)'; g.beginPath(); g.arc(px, my + 70, 26, 0, 7); g.fill(); g.fillStyle = i === 1 ? 'rgb(150,60,50)' : 'rgb(70,120,80)'; g.fillRect(px - 12, my + 222, 24, 24); g.fillStyle = 'rgb(40,42,40)'; g.font = '700 22px Arial'; g.fillText('P' + (i + 1), px + 34, my + 72); }
      g.font = '700 20px Arial'; g.fillStyle = 'rgb(40,42,40)'; g.fillText('RESERVOIR', mx + 30, my + 122); g.fillText('OUTFALL 2', mx + 660, my + 122); g.fillText('SKARN HEAD  No. 2 STATION  MIMIC', mx + 30, my + 36); rects.mimic = [mx, my, mw, mh]; }
    // stains: soft dark blotches;  leaks: streaks that have run down a wall
    const sx = 260, sy = y + 470; { const w = 560, h = 420; for (let i = 0; i < 46; i++) { const px = sx + w / 2 + rnd(-1, 1) * w * 0.3, py = sy + h / 2 + rnd(-1, 1) * h * 0.28, r = rnd(30, 120);
        const rg = g.createRadialGradient(px, py, 0, px, py, r); rg.addColorStop(0, `rgba(40,36,30,${rnd(0.05, 0.16)})`); rg.addColorStop(1, 'rgba(40,36,30,0)'); g.fillStyle = rg; g.fillRect(sx, sy, w, h); } rects.stain = [sx, sy, w, h]; }
    { const lx = 880, w = 420, h = 760; for (let i = 0; i < 70; i++) { const px = lx + w / 2 + rnd(-1, 1) * w * 0.4 * Math.random(), len = rnd(0.25, 1) * h * 0.92, wd = rnd(3, 26);
        const lg = g.createLinearGradient(0, sy, 0, sy + len); lg.addColorStop(0, `rgba(${rnd(30, 60) | 0},${rnd(30, 44) | 0},${rnd(20, 30) | 0},${rnd(0.1, 0.34)})`); lg.addColorStop(1, 'rgba(40,36,30,0)');
        g.fillStyle = lg; g.beginPath(); g.moveTo(px - wd, sy + 4); g.quadraticCurveTo(px + rnd(-8, 8), sy + len * 0.6, px + rnd(-4, 4), sy + len); g.quadraticCurveTo(px + rnd(-8, 8), sy + len * 0.6, px + wd, sy + 4); g.fill(); }
      const fade = g.createLinearGradient(lx, 0, lx + w, 0); fade.addColorStop(0, '#fff'); fade.addColorStop(0.12, 'rgba(255,255,255,0)'); fade.addColorStop(0.88, 'rgba(255,255,255,0)'); fade.addColorStop(1, '#fff'); g.fillStyle = fade; g.fillRect(lx, sy, w, h); rects.leak = [lx, sy, w, h]; }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true;
    const pos = [], uv = [], al = [], idx = []; let n = 0; const X = new THREE.Vector3(), Y = new THREE.Vector3(), N = new THREE.Vector3(), P = new THREE.Vector3();
    const FACE = { 'x+': [[1, 0, 0], [0, 0, -1], [0, 1, 0]], 'x-': [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], 'z+': [[0, 0, 1], [1, 0, 0], [0, 1, 0]], 'z-': [[0, 0, -1], [-1, 0, 0], [0, 1, 0]], 'y+': [[0, 1, 0], [1, 0, 0], [0, 0, -1]] };
    for (const d of D) {
      const r = rects[d.kind === 'stencil' ? 't:' + d.text : d.kind], f = FACE[d.face]; if (!r || !f) continue;
      N.fromArray(f[0]); X.fromArray(f[1]); Y.fromArray(f[2]); if (d.rot) { X.applyAxisAngle(N, d.rot); Y.applyAxisAngle(N, d.rot); }
      let w = d.w, h = d.h; if (d.kind === 'stencil') w = Math.min(d.w, h * r[2] / r[3]);     // keep lettering proportions
      const reps = d.kind === 'hazard' ? Math.max(1, d.w / (d.h * r[2] / r[3])) : 1;
      const u0 = r[0] / S, u1 = (r[0] + r[2] * Math.min(1, reps)) / S, v0 = 1 - (r[1] + r[3]) / S, v1 = 1 - r[1] / S;
      for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) { P.fromArray(d.pos).addScaledVector(X, a * w).addScaledVector(Y, b * h).addScaledVector(N, 0.003); pos.push(P.x, P.y, P.z); uv.push(a < 0 ? u0 : u1, b < 0 ? v0 : v1); al.push((d.a ?? 1) * (d.kind === 'stain' ? 0.5 : d.kind === 'leak' ? 0.6 : 1)); }
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setAttribute('aA', new THREE.Float32BufferAttribute(al, 1)); geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex } }, transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: 'attribute float aA; varying vec2 vUv; varying float vA; void main(){ vUv = uv; vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; varying float vA; void main(){ vec3 c = texture2D( map, vUv ).rgb; gl_FragColor = vec4( mix( vec3( 1.0 ), c, vA ), 1.0 ); }' });
    const m = new THREE.Mesh(geo, mat); m.renderOrder = 1; m.frustumCulled = false; this.group.add(m); this.decalMesh = m;
  }

  buildMotes() {
    const N = 2600, g = new THREE.BufferGeometry(), seed = new Float32Array(N * 4);
    for (let i = 0; i < N * 4; i++) seed[i] = Math.random();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.moteMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uBox: { value: new THREE.Vector3(18, 9, 18) }, uCam: { value: new THREE.Vector3() }, tShadow: { value: null }, uShadowM: { value: new THREE.Matrix4() }, uSunCol: { value: this.sunColor.clone().multiplyScalar(this.sunStrength) }, uSunDir: { value: this.sunDir },
        uAmb: { value: new THREE.Color(0.1, 0.1, 0.1) }, uPx: { value: 1 }, lsHdr: this.materials.shared.lsHdr },
      vertexShader: `attribute vec4 aSeed; uniform float uTime; uniform vec3 uBox; uniform vec3 uCam; uniform highp sampler2DShadow tShadow; uniform mat4 uShadowM; uniform vec3 uSunCol; uniform vec3 uSunDir; uniform vec3 uAmb; uniform float uPx; varying vec3 vCol;
        void main(){ vec3 drift = vec3( 0.03, -0.012, 0.022 ) * uTime + 0.12 * vec3( sin( uTime * 0.21 + aSeed.w * 40.0 ), sin( uTime * 0.17 + aSeed.x * 31.0 ), cos( uTime * 0.19 + aSeed.y * 23.0 ) );
          vec3 p = mod( aSeed.xyz * uBox + drift - uCam, uBox ) - 0.5 * uBox + uCam;
          vec4 sc = uShadowM * vec4( p, 1.0 ); float lit = texture( tShadow, vec3( sc.xy, sc.z - 0.0008 ) );
          vec4 mv = viewMatrix * vec4( p, 1.0 ); float d = -mv.z; vec3 view = normalize( p - cameraPosition ); float fwd = max( dot( view, uSunDir ), 0.0 );
          float tw = 0.55 + 0.45 * sin( uTime * ( 1.0 + aSeed.w * 2.5 ) + aSeed.x * 50.0 );
          float fade = smoothstep( 0.35, 1.2, d ) * smoothstep( 9.0, 5.0, d );
          vCol = ( uSunCol * lit * ( 0.035 + 0.5 * pow( fwd, 6.0 ) ) + uAmb * 0.02 ) * tw * fade * ( 1.0 - smoothstep( 44.0, 45.2, p.x ) );     // dust belongs indoors
          gl_Position = projectionMatrix * mv; gl_PointSize = clamp( uPx * ( 0.0045 + aSeed.w * 0.0055 ) / d, 1.0, 5.0 ); }`,
      fragmentShader: `varying vec3 vCol; ${HDR_GLSL} void main(){ vec2 q = gl_PointCoord - 0.5; float a = smoothstep( 0.5, 0.1, length( q ) ); gl_FragColor = vec4( lsEncode( vCol * a ), 1.0 ); }` });
    const p = new THREE.Points(g, this.moteMat); p.frustumCulled = false; p.renderOrder = 7; this.G.scene.add(p); this.motes = p;
  }

  // ------------------------------------------------------------------ probes
  // Reflection cubes per zone and a coarse lattice of ambient cubes for anything that moves. Both are captured once,
  // at load, for the station with its lamps off and with them on, so nothing has to be re-captured while playing.
  async captureProbes() {
    const G = this.G, r = G.renderer, sh = this.materials.shared;
    await this.skyReady;
    const hide = [this.motes, G.fx && G.fx.puffs.mesh, G.fx && G.fx.sparks.mesh].filter(Boolean); const vis = hide.map((o) => o.visible); hide.forEach((o) => (o.visible = false));
    const glows = []; this.group.traverse((o) => { if (o.renderOrder === 4) { glows.push(o); o.visible = false; } });
    sh.lsHdr.value.x = 0; this.skyMat.uniforms.uDisc.value = 0; r.shadowMap.needsUpdate = true;
    this.pmrem ||= new THREE.PMREMGenerator(r);
    const envPass = (state) => { for (const k in this.zones) { const z = this.zones[k], size = k === 'hall' || k === 'gallery' ? 512 : 256; if (!z) continue;
      z.cubeRT ||= new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
      z.cubeCam ||= new THREE.CubeCamera(0.1, 300, z.cubeRT); z.cubeCam.position.copy(z.box.pos); z.cubeCam.update(r, G.scene);
      z.envs ||= []; z.envs[state] && z.envs[state].dispose(); z.envs[state] = this.pmrem.fromCubemap(z.cubeRT.texture); this.materials.setEnv(k, z.envs[state].texture); z.env = z.envs[state].texture; } };
    const was = this.power;
    for (const state of [0, 1]) { this.lampLevels(state); sh.lsPower.value = state; envPass(state); if (state === 0) envPass(0); this.captureLattice(state); await new Promise((res) => setTimeout(res, 0)); }
    for (const k in this.zones) { this.zones[k].cubeRT.dispose(); this.zones[k].cubeRT = this.zones[k].cubeCam = null; }
    this.power = was; sh.lsPower.value = was; this.lampLevels(was); this.envState = -1; this.applyEnvState();
    sh.lsHdr.value.x = 1; this.skyMat.uniforms.uDisc.value = 1; hide.forEach((o, i) => (o.visible = vis[i])); glows.forEach((o) => (o.visible = true));
  }
  lampLevels(power) {
    for (const l of this.lamps) { let k = l.def.always ? 1 : power; if (l.bad && k > 0.5) k *= 0.75 + 0.25 * Math.sign(Math.sin(this.time * 13 + l.phase) + 0.93); l.em.uI.value = l.peak * k; l.glow.uI.value = l.peak * k * 0.005; }
  }
  // Reflections switch to the lamps-on set once the lamps are mostly up.
  applyEnvState() {
    const st = this.power > 0.5 ? 1 : 0; if (st === this.envState) return; this.envState = st;
    for (const k in this.zones) { const z = this.zones[k]; if (!z.envs) return; z.env = z.envs[st].texture; this.materials.setEnv(k, z.env); }
    this.setDynEnv(true);
  }

  captureLattice(state) {
    const G = this.G, r = G.renderer, S = 12;
    this.ambRT ||= new THREE.WebGLCubeRenderTarget(S, { type: THREE.FloatType, generateMipmaps: false });
    this.ambCam ||= new THREE.CubeCamera(0.08, 300, this.ambRT);
    if (!this.ambW) { // per-texel weights towards each of the six axes
      this.ambW = []; const d = new THREE.Vector3();
      for (let f = 0; f < 6; f++) { const w = new Float32Array(S * S * 6); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S * 2 - 1; faceDir(f, u, v, d); const l2 = d.lengthSq(), dw = 4 / (S * S) / (l2 * Math.sqrt(l2)); d.normalize();
        for (let a = 0; a < 6; a++) w[(y * S + x) * 6 + a] = Math.max(0, d.x * AXES[a][0] + d.y * AXES[a][1] + d.z * AXES[a][2]) * dw; } this.ambW.push(w); }
      this.ambBuf = new Float32Array(S * S * 4);
    }
    const spacing = { hall: [5, 4.4, 4.8], gallery: [4.4, 3, 6], adit: [4, 3, 3.8], control: [3.75, 3, 4.6], ext: [5.3, 4, 5.6], under: [4.6, 3, 3.2] };
    for (const k in this.zones) {
      const z = this.zones[k], a = z.box.min, b = z.box.max, sp = spacing[k], pad = 0.7;
      if (!z.lat) {
        const n = [0, 1, 2].map((i) => Math.max(1, Math.round((b.getComponent(i) - a.getComponent(i) - 2 * pad) / sp[i])) + 1);
        if (k === 'ext' || k === 'adit' || k === 'control' || k === 'under') n[1] = 1;
        z.lat = { n, o: [a.x + pad, (k === 'control' ? 4.2 : k === 'under' ? -4.4 : 0) + 1.3, a.z + pad], s: [0, 1, 2].map((i) => n[i] > 1 ? (b.getComponent(i) - a.getComponent(i) - 2 * pad) / (n[i] - 1) : 1), data: [null, null] };
        if (k === 'hall') z.lat.s[1] = 4.3; if (k === 'gallery') z.lat.s[1] = 2.6;
      }
      const L = z.lat, n = L.n, out = L.data[state] = new Float32Array(n[0] * n[1] * n[2] * 18);
      for (let iz = 0; iz < n[2]; iz++) for (let iy = 0; iy < n[1]; iy++) for (let ix = 0; ix < n[0]; ix++) {
        _v.set(L.o[0] + ix * L.s[0], L.o[1] + iy * L.s[1], L.o[2] + iz * L.s[2]);
        const idx = (iz * n[1] * n[0] + iy * n[0] + ix) * 18;
        // keep probes out of solid objects: nudge up if buried
        if (G.col.groundAt(_v.x, _v.z, 0.2, _v.y + 0.3)?.y > _v.y - 0.2) _v.y = G.col.groundAt(_v.x, _v.z, 0.2, _v.y + 6).y + 0.6;
        this.ambCam.position.copy(_v); this.ambCam.update(r, G.scene);
        for (let f = 0; f < 6; f++) { r.readRenderTargetPixels(this.ambRT, 0, 0, S, S, this.ambBuf, f); const w = this.ambW[f], buf = this.ambBuf;
          for (let t = 0; t < S * S; t++) { const cr = Math.min(buf[t * 4], 60), cg = Math.min(buf[t * 4 + 1], 60), cb = Math.min(buf[t * 4 + 2], 60);
            for (let ax = 0; ax < 6; ax++) { const ww = w[t * 6 + ax]; if (ww > 0) { out[idx + ax * 3] += cr * ww; out[idx + ax * 3 + 1] += cg * ww; out[idx + ax * 3 + 2] += cb * ww; } } } }
      }
    }
    r.setRenderTarget(null);
  }

  // Trilinear ambient cube at a point. out = array of 6 Vector3 (irradiance towards +x,-x,+y,-y,+z,-z).
  ambientCubeAt(pos, out) {
    const z = this.zones[this.zoneAt(pos)], L = z && z.lat; if (!L) return out;
    const f = [0, 1, 2].map((i) => clamp((pos.getComponent(i) - L.o[i]) / L.s[i], 0, L.n[i] - 1)), i0 = f.map(Math.floor), t = f.map((v, i) => v - i0[i]);
    for (let a = 0; a < 6; a++) out[a].set(0, 0, 0);
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1, w = (dx ? t[0] : 1 - t[0]) * (dy ? t[1] : 1 - t[1]) * (dz ? t[2] : 1 - t[2]); if (w < 1e-4) continue;
      const ix = Math.min(L.n[0] - 1, i0[0] + dx), iy = Math.min(L.n[1] - 1, i0[1] + dy), iz = Math.min(L.n[2] - 1, i0[2] + dz), idx = (iz * L.n[1] * L.n[0] + iy * L.n[0] + ix) * 18, d0 = L.data[0], d1 = L.data[1] || d0, p = this.power, w0 = w * (1 - p), w1 = w * p;
      for (let a = 0; a < 6; a++) { const j = idx + a * 3; out[a].x += d0[j] * w0 + d1[j] * w1; out[a].y += d0[j + 1] * w0 + d1[j + 1] * w1; out[a].z += d0[j + 2] * w0 + d1[j + 2] * w1; }
    }
    return out;
  }
  // Rough colour of a white, matte puff of dust at a point.
  ambientAt(pos, out) {
    const c = this._tmpCube ||= Array.from({ length: 6 }, () => new THREE.Vector3()); this.ambientCubeAt(pos, c);
    let r = 0, g = 0, b = 0; for (const v of c) { r += v.x; g += v.y; b += v.z; } const k = 1 / (6 * Math.PI);
    return out.setRGB(r * k, g * k, b * k);
  }

  // Give a moving object's material the game's lighting: its own ambient cube plus the reflections of the zone it is in.
  dressDynamic(material, amb, extra) {
    const a = Array.isArray(amb) ? amb : this.playerAmb;
    this.materials.patch(material, { amb: a, ...(extra || {}) }); material.envMapIntensity = 1; this.dynMats ||= []; this.dynMats.push(material); if (this.zones[this.zoneName]?.env) { material.envMap = this.zones[this.zoneName].env; }
    return material;
  }
  track(pos, amb) { const e = { pos, amb }; this.dyn.push(e); return e; }
  untrack(e) { const i = this.dyn.indexOf(e); if (i >= 0) this.dyn.splice(i, 1); }
  setDynEnv(force) {
    const env = this.zones[this.zoneName]?.env; if (!env || !this.dynMats) return;
    for (const m of this.dynMats) if (m.envMap !== env || force) { const had = !!m.envMap; m.envMap = env; if (!had) m.needsUpdate = true; }
  }

  raycast(origin, dir, far = 400) {
    _ray.set(origin, dir); _ray.far = far; _ray.near = 0;
    let best = null;
    for (const m of this.solid) { if (!m.visible) continue; const h = _ray.intersectObject(m, false); if (h.length && (!best || h[0].distance < best.distance)) best = h[0]; }
    if (!best) return null;
    _n.copy(best.face.normal).applyMatrix3(_m3.getNormalMatrix(best.object.matrixWorld)).normalize();
    if (_n.dot(dir) > 0) _n.negate();
    return { point: best.point, normal: _n.clone(), surf: best.object.userData.surf || 'concrete', distance: best.distance, object: best.object };
  }
  // How wet the floor is under a point (0 dry .. 1 standing water). Mirrors the floor shader so footsteps splash where puddles are drawn.
  wetAt(pos) {
    const t = this.materials.shared.lsNoise.value, d = t.image.data, S = t.image.width;
    const tap = (u, v, ch) => { const x = (u - Math.floor(u)) * S - 0.5, y = (v - Math.floor(v)) * S - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const g = (i, j) => d[((((y0 + j) % S) + S) % S * S + (((x0 + i) % S) + S) % S) * 4 + ch] / 255; return (g(0, 0) * (1 - fx) + g(1, 0) * fx) * (1 - fy) + (g(0, 1) * (1 - fx) + g(1, 1) * fx) * fy; };
    const pn = tap(pos.x * 0.047, pos.z * 0.047, 1) * 0.6 + tap(pos.x * 0.0117 + 0.37, pos.z * 0.0117 + 0.37, 0) * 0.4, th = pos.x > 44.5 ? 0.66 : 0.64;
    return clamp((pn - (th - 0.03)) / 0.05, 0, 1);
  }
  sunAt(pos) { return this.G.col.raycast(pos, this.sunDir, 120) === Infinity; }
  zoneAt(pos) {
    const z = this.G.level.ent.zones;
    for (const k in z) { const a = z[k].a, b = z[k].b; if (pos.x >= a[0] && pos.x <= b[0] && pos.y >= a[1] - 0.3 && pos.y <= b[1] && pos.z >= a[2] && pos.z <= b[2]) return k; }
    return pos.x > 44.5 ? 'ext' : pos.z > -15.5 ? 'adit' : 'gallery';
  }

  // Jump straight to a state (capture and checkpoints): no flicker, no door travel.
  async setState({ power, door, doors }) {
    if (power !== undefined) { this.power = this.powerTarget = power ? 1 : 0; this.flicker = 0; this.materials.shared.lsPower.value = this.power; }
    const set = (d, v) => { d.open = d.target = v ? 1 : 0; this.placeDoor(d); };
    if (door !== undefined) set(this.door, door);
    if (doors) for (const k in doors) if (this.doors[k]) set(this.doors[k], doors[k]);
    this.update(0); this.G.pipeline.shadowHold = 0;
  }
  // Red beacons that turn while the station is in alarm. One real light, three glowing domes.
  buildBeacons() {
    const hdr = this.materials.shared.lsHdr; this.beacons = [];
    for (const p of [[14.42, 6.4, -25.6], [29.0, 7.2, -45.82], [43.6, 4.95, -27.9]]) {
      const u = { uI: { value: 0 }, lsHdr: hdr };
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), new THREE.ShaderMaterial({ uniforms: u, vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }', fragmentShader: `uniform float uI; ${HDR_GLSL} void main(){ gl_FragColor = vec4( lsEncode( vec3( 1.0, 0.06, 0.03 ) * uI + vec3( 0.03, 0.004, 0.003 ) ), 1.0 ); }` }));
      m.position.fromArray(p); this.group.add(m); this.beacons.push({ u, ph: this.beacons.length * 2.1 });
    }
    this.alarmLight = new THREE.PointLight(0xff2a14, 0, 30, 1.6); this.alarmLight.position.set(29, 8.2, -34); this.alarmLight.layers.enableAll(); this.G.scene.add(this.alarmLight);
  }
  setAlarm(on) { this.alarmOn = !!on; }
  setPower(on) { this.powerTarget = on ? 1 : 0; if (on) { this.flicker = 2.4; } }
  openDoor(open = true, key = 'roller') { const d = this.doors[key]; if (d) d.target = open ? 1 : 0; }
  doorsMoving() { for (const k in this.doors) if (this.doors[k].open !== this.doors[k].target) return true; return false; }

  update(dt) {
    const G = this.G, sh = this.materials.shared; this.time += dt;
    // power: lamps strike with a flicker, then settle; probes are refreshed once the light is steady
    if (this.flicker > 0) { this.flicker -= dt; const t = 2.4 - this.flicker; this.power = t < 0.12 ? 0.55 : t < 0.3 ? 0.05 : t < 0.42 ? 0.7 : t < 0.7 ? 0.12 + 0.1 * Math.sin(t * 90) : Math.min(1, 0.35 + (t - 0.7) * 0.5);
      if (this.flicker <= 0) { this.power = 1; } }
    else this.power = damp(this.power, this.powerTarget, 3, dt);
    sh.lsPower.value = this.power; this.lampLevels(this.power); this.applyEnvState();
    this.alarm = damp(this.alarm, this.alarmOn ? 1 : 0, 3, dt);
    for (const b of this.beacons) { const s = Math.max(0, Math.sin(this.time * 4.2 + b.ph)); b.u.uI.value = this.alarm * s * s * 26; }
    this.alarmLight.intensity = this.alarm * (0.5 + 0.5 * Math.sin(this.time * 4.2)) * 26; this.alarmLight.position.x = 29 + Math.sin(this.time * 2.1) * 8;
    // door
    for (const k in this.doors) { const d = this.doors[k]; if (d.open !== d.target) { d.open = clamp(d.open + Math.sign(d.target - d.open) * dt / d.secs, 0, 1); this.placeDoor(d); G.audio && G.audio.door(d); } }
    for (const u of this.screens) { u.uI.value = this.power * 2.4; u.uT.value = this.time; }
    for (const b of this.beacons2) { b.k = damp(b.k, b.on ? 1 : 0, 6, dt); const near = THREE.MathUtils.smoothstep(b.pos.distanceTo(this.G.camera.position), 1.0, 4.5); b.u.uI.value = b.k * (0.7 + 0.5 * Math.sin(this.time * 5 + b.ph)) * 1.3 * (0.12 + 0.88 * near); }      // dims as you reach it, so it never blinds
    // ambient light on moving things
    const eye = G.camera.position; this.ambientCubeAt(eye, this.playerAmb);
    for (const e of this.dyn) this.ambientCubeAt(e.pos, e.amb);
    const zn = this.zoneAt(eye); if (zn !== this.zoneName) { this.zoneName = zn; this.setDynEnv(); }
    // dust and glass
    const mu = this.moteMat.uniforms; mu.uTime.value = this.time; mu.uCam.value.copy(eye); mu.uPx.value = G.pipeline.ih || 1000;
    if (this.sun.shadow.map) { mu.tShadow.value = this.sun.shadow.map.depthTexture; mu.uShadowM.value.copy(this.sun.shadow.matrix); }
    this.ambientAt(eye, _c); mu.uAmb.value.copy(_c); this.motes.visible = !!mu.tShadow.value;
  }
}
