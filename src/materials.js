// Materials: scanned PBR textures plus the shader additions that make them sit in baked light.
import * as THREE from 'three';

// game material -> Poly Haven texture set and tuning
export const MATS = {
  floor:        { tex: 'concrete_floor_worn_001', wet: 0.64, macro: 0.16, rough: 1.0, color: 0xeef2f7 },
  floor_ext:    { tex: 'hangar_concrete_floor', wet: 0.66, macro: 0.14 },
  conc_a:       { tex: 'concrete_wall_008', macro: 0.13, stain: 0.5, color: 0xe9eef5, paint: true },      // tinted a touch cool: the scan is beige, the station should be grey
  conc_b:       { tex: 'concrete_layers_02', macro: 0.11, stain: 0.35, color: 0xe9eef5, paint: true },
  conc_c:       { tex: 'concrete_wall_006', macro: 0.12, stain: 0.2, color: 0xeef2f6 },
  conc_dirty:   { tex: 'concrete_wall_006', macro: 0.13, stain: 0.8, color: 0xb9b2a6 },
  precast:      { tex: 'concrete_slab_wall', macro: 0.1, stain: 0.3 },
  paint_conc:   { tex: 'painted_concrete', macro: 0.08, stain: 0.3, color: 0xb4b8b0 },
  rock:         { tex: 'rock_face_03', macro: 0.1 },
  metal_yellow: { tex: 'blue_metal_plate', macro: 0.06, recolor: [2.5, 1.62, 0.2] },     // signal yellow: the painted-steel scan, repainted
  deck:         { tex: 'metal_plate', macro: 0.05 },
  metal_green:  { tex: 'green_metal_rust', macro: 0.06 },
  metal_blue:   { tex: 'blue_metal_plate', macro: 0.05, recolor: [0.5, 1.5, 3.0] },     // pump motors: machine blue (yellow read as wooden barrels in the orange sun)
  metal_rust:   { tex: 'rusty_metal_04', macro: 0.05 },
  metal_dark:   { tex: 'blue_metal_plate', macro: 0.05, recolor: [0.36, 0.37, 0.39] },   // plain dark painted steel
  steel:        { tex: 'rusty_metal_sheet', macro: 0.05 },
  shutter:      { tex: 'painted_metal_shutter', macro: 0.06 },
  corr:         { tex: 'corrugated_iron_02', macro: 0.05 },
  frame:        { tex: 'blue_metal_plate', macro: 0.0, recolor: [0.2, 0.2, 0.21] },
  grate:        { tex: 'metal_grate_rusty', macro: 0.04, color: 0x8c8782 },
  glove:        { tex: 'fabric_leather_02' },
  pipe_blue:    { tex: 'blue_metal_plate', macro: 0.05, recolor: [0.45, 1.6, 3.6] },      // water mains
  pipe_red:     { tex: 'blue_metal_plate', macro: 0.05, recolor: [2.7, 0.42, 0.3] },      // fire main
};

function noiseTexture(size = 256) {
  // three independent tiling value-noise fields, each a few octaves
  const data = new Uint8Array(size * size * 4);
  for (let ch = 0; ch < 3; ch++) {
    const acc = new Float32Array(size * size); let amp = 1, tot = 0;
    for (let cells = 4; cells <= 64; cells *= 2) {
      const lat = new Float32Array(cells * cells); for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const fx = x / size * cells, fy = y / size * cells, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = lat[(y0 % cells) * cells + x0 % cells], b = lat[(y0 % cells) * cells + (x0 + 1) % cells], c = lat[((y0 + 1) % cells) * cells + x0 % cells], d = lat[((y0 + 1) % cells) * cells + (x0 + 1) % cells];
        acc[y * size + x] += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * amp;
      }
      tot += amp; amp *= 0.55;
    }
    let mn = 1e9, mx = -1e9; for (const v of acc) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    for (let i = 0; i < acc.length; i++) data[i * 4 + ch] = Math.round((acc[i] - mn) / (mx - mn) * 255);
  }
  for (let i = 0; i < size * size; i++) data[i * 4 + 3] = Math.random() * 255;
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

const PARS_V = `
varying vec3 vWPos; varying vec3 vWNrm;
#ifdef LS_LIGHTMAP
  attribute vec2 lsUv; varying vec2 vLsUv;
#endif
#ifdef LS_VERT
  attribute vec3 lsColA; attribute vec3 lsColB; varying vec3 vLsA; varying vec3 vLsB;
#endif
`;
const MAIN_V = `
#ifdef USE_INSTANCING
  vWPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz; vWNrm = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );
#else
  vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz; vWNrm = normalize( mat3( modelMatrix ) * objectNormal );
#endif
#ifdef LS_LIGHTMAP
  vLsUv = lsUv;
#endif
#ifdef LS_VERT
  vLsA = lsColA; vLsB = lsColB;
#endif
`;
export const HDR_GLSL = `
uniform vec2 lsHdr;
vec3 lsEncode( vec3 c ) { if ( lsHdr.x < 0.5 ) return c; c = max( c, 0.0 ) * lsHdr.y; return c / ( 1.0 + max( c.r, max( c.g, c.b ) ) ); }
`;
const PARS_F = `
varying vec3 vWPos; varying vec3 vWNrm;
uniform sampler2D lsNoise; uniform float lsPower; uniform vec3 lsTune;   // macro, wet threshold, stain
#ifdef LS_RECOLOR
  uniform vec3 lsTint;
#endif
#ifdef LS_PAINT
  uniform vec3 lsPaint; uniform vec3 lsPaintH;    // colour; floor level, height of the painted band, strength
#endif
${HDR_GLSL}
#ifdef LS_LIGHTMAP
  varying vec2 vLsUv; uniform sampler2D lsDay; uniform sampler2D lsLamps; uniform vec2 lsRange;
#endif
#ifdef LS_AMBCUBE
  uniform vec3 lsAmb[6];
#endif
#ifdef LS_VERT
  varying vec3 vLsA; varying vec3 vLsB; uniform vec2 lsRange;
#endif
#ifdef LS_BOXPROJ
  uniform vec3 lsBoxMin; uniform vec3 lsBoxMax; uniform vec3 lsProbePos;
#endif
#ifdef USE_ENVMAP
vec3 lsIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
  vec3 r = reflect( - viewDir, normal );
  r = normalize( mix( r, normal, pow4( roughness ) ) );
  r = transformDirectionByInverseViewMatrix( r, viewMatrix );
  #ifdef LS_BOXPROJ
    vec3 a = ( lsBoxMax - vWPos ) / r, b = ( lsBoxMin - vWPos ) / r; vec3 m = max( a, b );
    float t = min( min( m.x, m.y ), m.z );
    r = normalize( mix( vWPos + r * t - lsProbePos, r, roughness * roughness ) );
  #endif
  return textureLod( envMap, envMapRotation * r, roughnessToMip( roughness ) ).rgb * envMapIntensity;
}
#endif
`;
const AFTER_MAP = `
float lsPuddle = 0.0; float lsDamp = 0.0; float lsSunMask = 1.0;
#ifdef LS_LIGHTMAP
  lsSunMask = smoothstep( 0.04, 0.4, texture2D( lsDay, vLsUv ).a );
#endif
#ifdef LS_RECOLOR
  diffuseColor.rgb = vec3( dot( diffuseColor.rgb, vec3( 0.34, 0.5, 0.16 ) ) ) * lsTint;
#endif
{
  vec3 an = abs( vWNrm );
  vec2 mp = an.y > 0.6 ? vWPos.xz : ( an.x > 0.6 ? vWPos.zy : vWPos.xy );
  vec3 n1 = texture2D( lsNoise, mp * 0.047 ).rgb; vec3 n2 = texture2D( lsNoise, mp * 0.0117 + 0.37 ).rgb;
  float macro = n1.r * 0.55 + n2.g * 0.45;
  diffuseColor.rgb *= mix( 1.0 - lsTune.x, 1.0 + lsTune.x, macro );
  diffuseColor.rgb *= mix( vec3( 1.035, 1.0, 0.955 ), vec3( 0.965, 1.0, 1.045 ), n2.b );
  #ifdef LS_PAINT
    if ( an.y < 0.5 && lsPaintH.z > 0.0 ) {      // a painted band along the foot of the wall, chipped and scuffed, with a pale line above it
      // which room the wall faces decides its colour (a wall between two rooms is one part with two faces)
      vec3 q = vWPos + vWNrm * 0.2; vec3 pc = vec3( 0.07, 0.3, 0.36 ); vec3 ph = vec3( 0.0, 1.2, 1.0 );                                                   // gallery and tunnel: teal
      if ( q.y < -0.7 ) { pc = vec3( 0.42, 0.3, 0.05 ); ph = vec3( -4.4, 0.9, 1.0 ); }                                                                      // pipe gallery: ochre
      else if ( q.x > 44.0 || ( q.z > -16.6 && q.x > 4.6 ) ) ph.z = 0.0;                                                                                                       // outside: bare
      else if ( q.x < 13.8 && q.y > 4.0 ) { pc = vec3( 0.14, 0.24, 0.42 ); ph = vec3( 4.2, 1.05, 1.0 ); }                                                     // control room: blue
      else if ( q.x > 13.8 && q.z < -22.3 ) { pc = vec3( 0.08, 0.3, 0.17 ); ph = vec3( 0.0, 1.5, 1.0 ); if ( vWPos.z > -45.95 && vWPos.z < -44.3 && vWPos.x > 16.4 && vWPos.x < 29.8 ) ph.z = 0.0; }      // not on the staircase that stands against that wall                                                     // pump hall: green
      float h = vWPos.y - ph.x + ( n1.b - 0.5 ) * 0.035; float top = ph.y;
      float chips = smoothstep( 0.74, 0.8, texture2D( lsNoise, mp * 0.9 ).g * 0.6 + n1.r * 0.4 ) + smoothstep( 0.3, 0.0, h ) * smoothstep( 0.55, 0.75, texture2D( lsNoise, mp * 0.37 ).r );
      float band = smoothstep( top + 0.012, top - 0.012, h ) * step( -0.05, h ) * ( 1.0 - clamp( chips, 0.0, 1.0 ) ) * ph.z;
      float lum = dot( diffuseColor.rgb, vec3( 0.333 ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, pc * ( 0.55 + 1.1 * lum ), band );
      float line = smoothstep( 0.03, 0.02, abs( h - top - 0.05 ) ) * ph.z * ( 1.0 - clamp( chips, 0.0, 1.0 ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.82, 0.8, 0.7 ) * ( 0.6 + lum ), line * 0.85 );
    }
  #endif
  #ifdef LS_STAIN
    if ( an.y < 0.5 ) {      // streaks where water has run down walls
      float st = texture2D( lsNoise, vec2( mp.x * 0.33, mp.y * 0.021 ) ).r * 0.7 + texture2D( lsNoise, vec2( mp.x * 1.3, mp.y * 0.05 ) ).g * 0.3;
      float band = texture2D( lsNoise, vec2( mp.x * 0.05, 0.5 ) ).b;
      float k = smoothstep( 0.52, 0.74, st ) * smoothstep( 0.3, 0.7, band ) * lsTune.z;
      diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.62, 0.6, 0.56 ), k );
      float low = smoothstep( 1.1, 0.0, vWPos.y - floor( ( vWPos.y + 0.05 ) / 4.2 ) * 4.2 ) * n1.b;   // grime near the floor line
      diffuseColor.rgb *= 1.0 - 0.3 * low * lsTune.z;
    }
  #endif
  #ifdef LS_WET
    if ( vWNrm.y > 0.6 ) {
      float lum = dot( diffuseColor.rgb, vec3( 0.333 ) );
      float pn = n1.g * 0.6 + n2.r * 0.4 + ( 0.3 - lum ) * 0.12;
      lsDamp = smoothstep( lsTune.y - 0.3, lsTune.y - 0.02, pn );
      lsPuddle = smoothstep( lsTune.y - 0.01, lsTune.y + 0.055, pn );
      diffuseColor.rgb *= mix( 1.0, 0.5, lsDamp * 0.75 );
    }
  #endif
}
`;
const AFTER_ROUGH = `
#ifdef LS_WET
  roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.5, lsDamp );
  roughnessFactor = mix( roughnessFactor, 0.06, lsPuddle );
#endif
`;
const AFTER_NORMAL = `
#ifdef LS_WET
  normal = normalize( mix( normal, lsGeoN, lsPuddle * 0.97 ) );
#endif
`;
const LIGHTS_MAPS = `
#if defined( RE_IndirectDiffuse )
  #ifdef LS_LIGHTMAP
    vec3 lmA = texture2D( lsDay, vLsUv ).rgb; vec3 lmB = texture2D( lsLamps, vLsUv ).rgb;
    lmB *= lmB; if ( vWPos.y < -0.7 ) lmB = mix( vec3( dot( lmB, vec3( 0.3, 0.5, 0.2 ) ) ) * vec3( 1.25, 1.1, 0.9 ), lmB, 0.3 );      // the pipe gallery's lamps are warm white, not deep amber, so paint and pipes keep their colour
    vec3 lsD = lmA * lmA * lsRange.x; lsD *= mix( vec3( 0.84, 0.98, 1.2 ), vec3( 1.0 ), smoothstep( 0.03, 0.5, dot( lsD, vec3( 0.3, 0.5, 0.2 ) ) ) );    // deep shade leans cool
    irradiance += ( lsD + lmB * lsRange.y * lsPower ) * PI;
  #endif
  #ifdef LS_VERT
    vec3 lsV = vLsA * vLsA * lsRange.x; lsV *= mix( vec3( 0.84, 0.98, 1.2 ), vec3( 1.0 ), smoothstep( 0.03, 0.5, dot( lsV, vec3( 0.3, 0.5, 0.2 ) ) ) );
    vec3 lsW = vLsB * vLsB; if ( vWPos.y < -0.7 ) lsW = mix( vec3( dot( lsW, vec3( 0.3, 0.5, 0.2 ) ) ) * vec3( 1.25, 1.1, 0.9 ), lsW, 0.3 );
    irradiance += ( lsV + lsW * lsRange.y * lsPower ) * PI;
  #endif
  #ifdef LS_AMBCUBE
    { vec3 wn = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix ); vec3 q = wn * wn;
      irradiance += q.x * ( wn.x > 0.0 ? lsAmb[0] : lsAmb[1] ) + q.y * ( wn.y > 0.0 ? lsAmb[2] : lsAmb[3] ) + q.z * ( wn.z > 0.0 ? lsAmb[4] : lsAmb[5] ); }
  #endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance += lsIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
#endif
`;

export class Materials {
  constructor(G) {
    this.G = G;
    this.shared = { lsNoise: { value: noiseTexture() }, lsPower: { value: 0 }, lsHdr: { value: new THREE.Vector2(1, 0.25) }, lsRange: { value: new THREE.Vector2(6, 6) } };
    this.cache = {}; this.tex = {}; this.all = []; this.manifest = {};
  }
  texPaths(name) {
    if (name.startsWith('P:')) { const m = this.manifest[name.slice(2)] || {}; return ['diff', 'nor', 'arm'].map((k) => (m[k] ? `./assets/tex/p/${m[k]}.ktx2` : null)); }
    const base = './assets/tex/m/' + (MATS[name] || MATS.conc_a).tex;
    return [base + '_diff.ktx2', base + '_nor.ktx2', base + '_arm.ktx2'];
  }
  async preload(paths, progress) {
    let n = 0; const an = this.G.QUALITY[this.G.quality].aniso;
    paths = paths.filter(Boolean);
    await Promise.all(paths.map(async (p) => {
      if (!(p in this.tex)) { try { const t = await this.G.ktx2.loadAsync(p); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = an; t.needsUpdate = true; this.tex[p] = t; } catch (e) { this.tex[p] = null; this.missing.push(p); } }
      progress && progress(++n / paths.length);
    }));
  }
  missing = [];
  set(name, opts) {
    const [pd, pn, pa] = this.texPaths(name), arm = this.tex[pa] || null;
    const m = new THREE.MeshStandardMaterial({ color: opts.color ?? 0xffffff, roughness: opts.rough ?? (arm ? 1 : 0.7), metalness: arm ? 1 : 0 });
    m.map = this.tex[pd] || null; m.normalMap = this.tex[pn] || null;
    if (arm) { m.aoMap = arm; m.roughnessMap = arm; m.metalnessMap = arm; }
    return m;
  }
  // Add the game's lighting model to a standard material.
  patch(m, f) {
    const u = m.userData.u = { lsTune: { value: new THREE.Vector3(f.macro ?? 0, f.wet ?? 9, f.stain ?? 0) } };
    if (f.lightmap) { u.lsDay = { value: f.lightmap.day }; u.lsLamps = { value: f.lightmap.lamps }; }
    if (f.amb) u.lsAmb = { value: f.amb };
    if (f.recolor) u.lsTint = { value: new THREE.Vector3().fromArray(f.recolor) };
    if (f.paint) { u.lsPaint = { value: new THREE.Vector3().fromArray(f.paint.color) }; u.lsPaintH = { value: new THREE.Vector3(f.paint.base, f.paint.height, 1) }; }
    if (f.box) { u.lsBoxMin = { value: f.box.min }; u.lsBoxMax = { value: f.box.max }; u.lsProbePos = { value: f.box.pos }; }
    const defs = [f.lightmap && 'LS_LIGHTMAP', f.vert && 'LS_VERT', f.amb && 'LS_AMBCUBE', f.box && 'LS_BOXPROJ', f.wet && 'LS_WET', f.stain && 'LS_STAIN', f.recolor && 'LS_RECOLOR', f.paint && 'LS_PAINT'].filter(Boolean);
    m.customProgramCacheKey = () => 'ls:' + defs.join(',');
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.shared, u);
      const D = defs.map((d) => `#define ${d}\n`).join('');
      sh.vertexShader = D + sh.vertexShader.replace('void main() {', PARS_V + 'void main() {').replace('#include <fog_vertex>', '#include <fog_vertex>\n' + MAIN_V);
      sh.fragmentShader = D + sh.fragmentShader.replace('void main() {', PARS_F + 'void main() {')
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + AFTER_MAP)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + AFTER_ROUGH)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nvec3 lsGeoN = normal;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + AFTER_NORMAL)
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= lsSunMask;'))
        .replace('#include <lights_fragment_maps>', LIGHTS_MAPS)
        .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = lsEncode( gl_FragColor.rgb );');
      m.userData.shader = sh;
    };
    this.all.push(m); return m;
  }
  // A static, lightmapped material for one zone.
  staticMat(name, zone) {
    const key = name + '@' + zone.name; if (this.cache[key]) return this.cache[key];
    let m, f;
    if (name.startsWith('P:')) { m = this.set(name, {}); f = { macro: 0.03, vert: true }; }
    else { const d = MATS[name] || MATS.conc_a; m = this.set(name, d); f = { macro: d.macro, wet: d.wet, stain: d.stain, recolor: d.recolor, paint: d.paint && zone.paint }; }
    if (!f.vert) f.lightmap = zone.lightmap; f.box = zone.box; m.envMap = zone.env; m.envMapIntensity = 1;
    this.patch(m, f); m.userData.zone = zone.name; this.cache[key] = m; return m;
  }
  setEnv(zoneName, env) { for (const m of this.all) if (m.userData.zone === zoneName) { if (!m.envMap) m.needsUpdate = true; m.envMap = env; } }
}
