// Render pipeline: HDR scene with MSAA -> light shafts and haze -> bloom -> eye adaptation -> film response and grade.
import * as THREE from 'three';

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
const STEPS = { low: 14, medium: 26, high: 32 };

const VOL = (steps) => `
precision highp float; precision highp sampler2DShadow;
uniform sampler2D tDepth; uniform sampler2DShadow tShadow; uniform sampler2D tNoise;
uniform mat4 uShadowM; uniform mat4 uInvVP; uniform vec3 uCam; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmbIn; uniform vec3 uAmbOut;
uniform float uTime; uniform float uDensity; uniform float uFrame; uniform float uShadowOn;
varying vec2 vUv;
float ign( vec2 p ){ return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
float hg( float c, float g ){ float g2 = g * g; return ( 1.0 - g2 ) / ( 12.566 * pow( 1.0 + g2 - 2.0 * g * c, 1.5 ) ); }
float outdoors( vec3 p ){ return max( max( smoothstep( 44.2, 45.2, p.x ), smoothstep( -15.8, -15.2, p.z ) ), smoothstep( 11.3, 11.8, p.y ) ); }
void main(){
  float depth = texture2D( tDepth, vUv ).r;
  vec4 wp = uInvVP * vec4( vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 ); wp /= wp.w;
  vec3 ray = wp.xyz - uCam; float dist = length( ray ); ray /= dist;
  float maxD = min( dist, 85.0 ), dt = maxD / float( ${steps} );
  float t = dt * ign( gl_FragCoord.xy + uFrame * 5.588 );
  float c = dot( ray, uSunDir ); float ph = 0.6 * hg( c, 0.7 ) + 0.4 * hg( c, 0.05 );
  vec3 L = vec3( 0.0 ); float T = 1.0;
  for ( int i = 0; i < ${steps}; i++ ) {
    vec3 p = uCam + ray * t;
    float o = outdoors( p );
    float n = texture2D( tNoise, p.xz * 0.031 + vec2( uTime * 0.004, p.y * 0.043 - uTime * 0.002 ) ).r;
    float s = uDensity * ( 0.5 + n ) * ( 1.0 + 0.7 * o ) + uDensity * 7.0 * o * smoothstep( 1.0, -7.0, p.y ) * ( 0.4 + 1.2 * n );
    vec4 sc = uShadowM * vec4( p, 1.0 );
    float lit = uShadowOn > 0.5 ? texture( tShadow, vec3( sc.xy, sc.z - 0.0005 ) ) : 1.0;
    vec3 Li = uSunCol * lit * ph + mix( uAmbIn, uAmbOut, o );
    float a = 1.0 - exp( - s * dt );
    L += T * a * Li; T *= 1.0 - a; t += dt;
  }
  gl_FragColor = vec4( L, T );
}`;

// Short-range ambient occlusion from the depth buffer: the darkening where things meet that a 2 cm lightmap texel is too coarse to hold.
const AO = `
precision highp float;
uniform sampler2D tDepth; uniform vec2 uNF; uniform vec2 uProj; uniform float uRadius; varying vec2 vUv;
float lin( float d ){ return uNF.x * uNF.y / ( uNF.y - d * ( uNF.y - uNF.x ) ); }
vec3 vpos( vec2 uv ){ float z = lin( texture2D( tDepth, uv ).r ); return vec3( ( uv * 2.0 - 1.0 ) * uProj * z, -z ); }
float ign( vec2 p ){ return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
void main(){
  float d = texture2D( tDepth, vUv ).r; if ( d < 0.0205 || d > 0.99999 ) { gl_FragColor = vec4( 1.0 ); return; }      // the rifle and the sky take no occlusion
  vec3 P = vpos( vUv ); vec3 N = normalize( cross( dFdx( P ), dFdy( P ) ) );
  float a = ign( gl_FragCoord.xy ) * 6.2831853; vec3 rv = vec3( cos( a ), sin( a ), 0.0 ); vec3 T = normalize( rv - N * dot( rv, N ) ); vec3 B = cross( N, T );
  float occ = 0.0; float R = uRadius * clamp( -P.z * 0.35, 0.35, 1.0 );
  for ( int i = 0; i < 10; i++ ) {
    float fi = float( i ); float r = ( fi + 0.5 ) / 10.0; float th = fi * 2.399963; float h = sqrt( 1.0 - r * 0.85 );
    vec3 k = vec3( cos( th ) * r, sin( th ) * r, h * 0.6 + 0.08 ) * mix( 0.25, 1.0, r * r );
    vec3 S = P + ( T * k.x + B * k.y + N * k.z ) * R;
    vec2 uv = ( S.xy / ( -S.z * uProj ) ) * 0.5 + 0.5; float sz = -lin( texture2D( tDepth, uv ).r );
    float range = smoothstep( 0.0, 1.0, R / max( abs( P.z - sz ), 1e-4 ) );
    occ += step( S.z + 0.025, sz ) * range;
  }
  gl_FragColor = vec4( pow( 1.0 - occ / 10.0, 1.6 ) );
}`;

const COMPOSE = `
precision highp float;
uniform sampler2D tScene; uniform sampler2D tDepth; uniform sampler2D tVol; uniform sampler2D tAO; uniform float uAO; uniform vec2 uVolRes; uniform float uPre; uniform vec2 uNF;
varying vec2 vUv;
float lin( float d ){ return uNF.x * uNF.y / ( uNF.y - d * ( uNF.y - uNF.x ) ); }
void main(){
  vec3 c = texture2D( tScene, vUv ).rgb; c = c / max( 1.0 - max( c.r, max( c.g, c.b ) ), 1e-4 ) / uPre; c = min( c, vec3( 14.0 ) );
  float z = lin( texture2D( tDepth, vUv ).r );
  // depth-aware upsample of the half-resolution haze: favour the taps that sit at this pixel's depth
  vec2 px = vUv * uVolRes - 0.5; vec2 f = fract( px ); vec2 base = ( floor( px ) + 0.5 ) / uVolRes; vec2 st = 1.0 / uVolRes;
  vec4 acc = vec4( 0.0 ); float wsum = 0.0; float ao = 0.0;
  for ( int j = 0; j < 2; j++ ) for ( int i = 0; i < 2; i++ ) {
    vec2 uv = base + vec2( float( i ), float( j ) ) * st; float zz = lin( texture2D( tDepth, uv ).r );
    float w = ( i == 0 ? 1.0 - f.x : f.x ) * ( j == 0 ? 1.0 - f.y : f.y ) / ( 0.02 + abs( zz - z ) / z ) + 1e-5;
    acc += texture2D( tVol, uv ) * w; ao += texture2D( tAO, uv ).r * w; wsum += w;
  }
  acc /= wsum; ao = mix( 1.0, ao / wsum, uAO );
  gl_FragColor = vec4( c * ao * acc.a + acc.rgb, 1.0 );
}`;

const VBLUR = `
precision highp float; uniform sampler2D tVol; uniform sampler2D tDepth; uniform vec2 uDir; uniform vec2 uNF; varying vec2 vUv;
float lin( float d ){ return uNF.x * uNF.y / ( uNF.y - d * ( uNF.y - uNF.x ) ); }
void main(){ float z = lin( texture2D( tDepth, vUv ).r ); vec4 acc = vec4( 0.0 ); float ws = 0.0;
  for ( int i = -2; i <= 2; i++ ) { vec2 uv = vUv + uDir * float( i ); float zz = lin( texture2D( tDepth, uv ).r );
    float w = exp( - float( i * i ) / 3.0 ) / ( 0.03 + abs( zz - z ) / z ); acc += texture2D( tVol, uv ) * w; ws += w; }
  gl_FragColor = acc / ws; }`;

const DOWN = `
precision highp float; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst; varying vec2 vUv;
vec3 s( vec2 o ){ return texture2D( tSrc, vUv + o * uTexel ).rgb; }
float kw( vec3 c ){ return 1.0 / ( 1.0 + dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ); }
void main(){
  vec3 a = s( vec2( -2, 2 ) ), b = s( vec2( 0, 2 ) ), c = s( vec2( 2, 2 ) ), d = s( vec2( -2, 0 ) ), e = s( vec2( 0, 0 ) ), f = s( vec2( 2, 0 ) ), g = s( vec2( -2, -2 ) ), h = s( vec2( 0, -2 ) ), i = s( vec2( 2, -2 ) );
  vec3 j = s( vec2( -1, 1 ) ), k = s( vec2( 1, 1 ) ), l = s( vec2( -1, -1 ) ), m = s( vec2( 1, -1 ) );
  vec3 o;
  if ( uFirst > 0.5 ) { // weight each group by its inverse brightness so single hot pixels do not flicker
    vec3 g0 = ( a + b + d + e ) * 0.25, g1 = ( b + c + e + f ) * 0.25, g2 = ( d + e + g + h ) * 0.25, g3 = ( e + f + h + i ) * 0.25, g4 = ( j + k + l + m ) * 0.25;
    float w0 = kw( g0 ) * 0.125, w1 = kw( g1 ) * 0.125, w2 = kw( g2 ) * 0.125, w3 = kw( g3 ) * 0.125, w4 = kw( g4 ) * 0.5;
    o = ( g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 ) / ( w0 + w1 + w2 + w3 + w4 );
  } else o = e * 0.125 + ( a + c + g + i ) * 0.03125 + ( b + d + f + h ) * 0.0625 + ( j + k + l + m ) * 0.125;
  gl_FragColor = vec4( max( o, 0.0 ), 1.0 );
}`;
const UP = `
precision highp float; uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 uTexel; uniform float uMix; varying vec2 vUv;
void main(){ vec3 c = vec3( 0.0 ); vec2 t = uTexel;
  c += texture2D( tSrc, vUv + vec2( -t.x, t.y ) ).rgb + texture2D( tSrc, vUv + vec2( t.x, t.y ) ).rgb + texture2D( tSrc, vUv + vec2( -t.x, -t.y ) ).rgb + texture2D( tSrc, vUv + vec2( t.x, -t.y ) ).rgb;
  c += 2.0 * ( texture2D( tSrc, vUv + vec2( 0.0, t.y ) ).rgb + texture2D( tSrc, vUv + vec2( 0.0, -t.y ) ).rgb + texture2D( tSrc, vUv + vec2( t.x, 0.0 ) ).rgb + texture2D( tSrc, vUv + vec2( -t.x, 0.0 ) ).rgb );
  c += 4.0 * texture2D( tSrc, vUv ).rgb; c /= 16.0;
  gl_FragColor = vec4( mix( texture2D( tBase, vUv ).rgb, c, uMix ), 1.0 ); }`;
const LUM = `
precision highp float; uniform sampler2D tSrc; uniform sampler2D tPrev; uniform float uDt; uniform float uReset; varying vec2 vUv;
void main(){ float acc = 0.0, ws = 0.0;
  for ( int j = 0; j < 5; j++ ) for ( int i = 0; i < 7; i++ ) { vec2 uv = ( vec2( float( i ), float( j ) ) + 0.5 ) / vec2( 7.0, 5.0 ); vec2 q = uv - 0.5; float w = 1.0 - 0.7 * dot( q, q ) * 2.0;
    acc += log( dot( texture2D( tSrc, uv ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) + 0.004 ) * w; ws += w; }
  float cur = exp( acc / ws ), prev = texture2D( tPrev, vec2( 0.5 ) ).r;
  float rate = cur > prev ? 2.6 : 1.3; float o = uReset > 0.5 ? cur : prev + ( cur - prev ) * ( 1.0 - exp( - uDt * rate ) );
  gl_FragColor = vec4( clamp( o, 0.002, 60.0 ) ); }`;
const FINAL = `
precision highp float;
uniform sampler2D tHdr; uniform sampler2D tBloom; uniform sampler2D tLum; uniform vec2 uTexel; uniform float uTime; uniform float uBloom; uniform float uKey; uniform vec2 uExpRange; uniform float uSharp; uniform float uFixedExp; uniform float uDamage;
varying vec2 vUv;
vec3 agxCurve( vec3 x ){ vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 agx( vec3 c ){
  const mat3 toRec2020 = mat3( 0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956 );
  const mat3 fromRec2020 = mat3( 1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187 );
  const mat3 inset = mat3( 0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859 );
  const mat3 outset = mat3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 );
  c = inset * ( toRec2020 * c ); c = max( c, 1e-10 ); c = ( log2( c ) + 12.47393 ) / 16.5;
  c = agxCurve( clamp( c, 0.0, 1.0 ) ); c = outset * c; c = pow( max( vec3( 0.0 ), c ), vec3( 2.2 ) );
  return clamp( fromRec2020 * c, 0.0, 1.0 );
}
float hash( vec2 p ){ vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
void main(){
  vec3 c = texture2D( tHdr, vUv ).rgb;
  // light sharpening to offset the internal render scale, limited so bright edges do not ring
  vec3 n = texture2D( tHdr, vUv + vec2( 0.0, uTexel.y ) ).rgb, s = texture2D( tHdr, vUv - vec2( 0.0, uTexel.y ) ).rgb, e = texture2D( tHdr, vUv + vec2( uTexel.x, 0.0 ) ).rgb, w = texture2D( tHdr, vUv - vec2( uTexel.x, 0.0 ) ).rgb;
  vec3 mn = min( c, min( min( n, s ), min( e, w ) ) ), mx = max( c, max( max( n, s ), max( e, w ) ) );
  c = clamp( c + ( c - ( n + s + e + w ) * 0.25 ) * uSharp, mn, mx );
  c = mix( c, texture2D( tBloom, vUv ).rgb, uBloom );
  float lum = texture2D( tLum, vec2( 0.5 ) ).r;
  float ex = uFixedExp > 0.0 ? uFixedExp : clamp( uKey / lum, uExpRange.x, uExpRange.y );
  c *= ex * vec3( 0.965, 1.0, 1.05 );      // white balance set a little cool, so the sun reads warm against it
  c = agx( c );
  // the look: a touch more contrast and colour than the neutral curve, cool shadows, warm highlights
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, 1.42 );                // vivid, on purpose: the first cut was all beige
  c = pow( max( c, 0.0 ), vec3( 1.14 ) ) * 1.07;
  c += vec3( -0.014, 0.002, 0.02 ) * ( 1.0 - smoothstep( 0.0, 0.45, l ) ) + vec3( 0.016, 0.004, -0.016 ) * smoothstep( 0.55, 1.0, l );
  c = mix( c, vec3( l ) * vec3( 1.0, 0.86, 0.82 ), uDamage * 0.45 );
  vec2 q = vUv - 0.5; float v = dot( q, q ); c *= mix( 1.0, 0.74, smoothstep( 0.12, 0.62, v ) );
  c = pow( clamp( c, 0.0, 1.0 ), vec3( 1.0 / 2.2 ) );
  float g = hash( gl_FragCoord.xy + fract( uTime ) * 311.7 ) - 0.5; c += g * ( 0.03 * ( 1.0 - l * 0.6 ) ) ;
  gl_FragColor = vec4( c, 1.0 );
}`;

export class Pipeline {
  constructor(G) {
    this.G = G; const r = G.renderer;
    r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace; r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; r.shadowMap.autoUpdate = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.quad = new THREE.Mesh(g, null); this.quad.frustumCulled = false; this.qscene = new THREE.Scene(); this.qscene.add(this.quad);
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.mats = {
      ao: mk(AO, { tDepth: { value: null }, uNF: { value: new THREE.Vector2(0.03, 600) }, uProj: { value: new THREE.Vector2(1, 1) }, uRadius: { value: 0.55 } }),
      compose: mk(COMPOSE, { tScene: { value: null }, tDepth: { value: null }, tVol: { value: null }, tAO: { value: null }, uAO: { value: 0.85 }, uVolRes: { value: new THREE.Vector2() }, uPre: { value: 0.25 }, uNF: { value: new THREE.Vector2(0.03, 600) } }),
      vblur: mk(VBLUR, { tVol: { value: null }, tDepth: { value: null }, uDir: { value: new THREE.Vector2() }, uNF: { value: new THREE.Vector2(0.03, 600) } }),
      down: mk(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } }),
      up: mk(UP, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.5 } }),
      lum: mk(LUM, { tSrc: { value: null }, tPrev: { value: null }, uDt: { value: 0.016 }, uReset: { value: 1 } }),
      final: mk(FINAL, { tHdr: { value: null }, tBloom: { value: null }, tLum: { value: null }, uTexel: { value: new THREE.Vector2() }, uTime: { value: 0 }, uBloom: { value: 0.055 }, uKey: { value: 0.098 }, uExpRange: { value: new THREE.Vector2(0.22, 4.6) }, uSharp: { value: 0.35 }, uFixedExp: { value: 0 }, uDamage: { value: 0 } }),
    };
    this.volUniforms = { tDepth: { value: null }, tShadow: { value: null }, tNoise: { value: null }, uShadowM: { value: new THREE.Matrix4() }, uInvVP: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() },
      uAmbIn: { value: new THREE.Color(0.02, 0.02, 0.025) }, uAmbOut: { value: new THREE.Color(0.3, 0.34, 0.42) }, uTime: { value: 0 }, uDensity: { value: 0.0055 }, uFrame: { value: 0 }, uShadowOn: { value: 0 } };
    this.frame = 0; this.width = this.height = 1; this.lumI = 0; this.reset = 3; this.shadowHold = 0;
    this.lum = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }));
    this.setQuality(G.quality);
    const fx = G.params.get('exp'); if (fx) this.mats.final.uniforms.uFixedExp.value = +fx;
  }
  setQuality(q) {
    this.q = q; this.mats.vol = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: VOL(STEPS[q] || 20), uniforms: this.volUniforms, depthTest: false, depthWrite: false });
    if (this.G.world?.sun) { const s = this.G.QUALITY[q].shadow; const sh = this.G.world.sun.shadow; if (sh.mapSize.x !== s) { sh.mapSize.set(s, s); sh.map?.dispose(); sh.map = null; this.shadowHold = 0; } }
  }
  resize(w, h) {
    const G = this.G, q = G.QUALITY[this.q] || G.QUALITY.medium, sc = +(G.params.get('scale') || q.scale) * (G.dynScale || 1);
    const iw = Math.max(64, Math.round(w * sc / 2) * 2), ih = Math.max(64, Math.round(h * sc / 2) * 2);
    this.width = w; this.height = h; if (iw === this.iw && ih === this.ih) return; const first = !this.scene; this.iw = iw; this.ih = ih;
    const hf = THREE.HalfFloatType, lin = THREE.LinearFilter;
    for (const k of ['scene', 'vol', 'hdr']) this[k]?.dispose(); (this.bloom || []).forEach((t) => t.dispose());
    this.scene = new THREE.WebGLRenderTarget(iw, ih, { type: hf, samples: G.params.has('nomsaa') ? 0 : 4, minFilter: lin, magFilter: lin });
    this.scene.depthTexture = new THREE.DepthTexture(iw, ih, THREE.FloatType); this.scene.depthTexture.minFilter = this.scene.depthTexture.magFilter = THREE.NearestFilter;
    this.vol = new THREE.WebGLRenderTarget(iw / 2, ih / 2, { type: hf, depthBuffer: false, minFilter: lin, magFilter: lin });
    this.vol2?.dispose(); this.vol2 = new THREE.WebGLRenderTarget(iw / 2, ih / 2, { type: hf, depthBuffer: false, minFilter: lin, magFilter: lin });
    this.aoA?.dispose(); this.aoB?.dispose(); this.aoA = new THREE.WebGLRenderTarget(iw / 2, ih / 2, { depthBuffer: false, minFilter: lin, magFilter: lin }); this.aoB = new THREE.WebGLRenderTarget(iw / 2, ih / 2, { depthBuffer: false, minFilter: lin, magFilter: lin });
    this.hdr = new THREE.WebGLRenderTarget(iw, ih, { type: hf, depthBuffer: false, minFilter: lin, magFilter: lin });
    this.bloom = []; let bw = iw >> 1, bh = ih >> 1;
    for (let i = 0; i < 6 && bw > 8 && bh > 8; i++) { this.bloom.push(new THREE.WebGLRenderTarget(bw, bh, { type: hf, depthBuffer: false, minFilter: lin, magFilter: lin })); bw >>= 1; bh >>= 1; }
    this.bloomUp?.forEach((t) => t.dispose());
    this.bloomUp = this.bloom.slice(0, -1).map((t) => new THREE.WebGLRenderTarget(t.width, t.height, { type: hf, depthBuffer: false, minFilter: lin, magFilter: lin }));
    if (first) this.reset = 3;       // a change of render scale must not make the exposure jump
  }
  pass(mat, target) { const r = this.G.renderer; this.quad.material = mat; r.setRenderTarget(target); r.render(this.qscene, this.cam); }

  render(dt) {
    const G = this.G, r = G.renderer, W = G.world, cam = G.camera, M = this.mats; this.frame++;
    if (!this.scene) return;
    // shadows only need redrawing when something that casts one is moving
    // the building's shadows are drawn once; only the roller door ever changes them
    const doorMoving = W.doorsMoving && W.doorsMoving();
    if (this.shadowHold < 4 || doorMoving || this.wasMoving) { r.shadowMap.needsUpdate = true; this.shadowHold++; }
    this.wasMoving = doorMoving;
    r.setRenderTarget(this.scene); r.setClearColor(0x000000, 1); r.clear();
    r.render(G.scene, cam);
    // the rifle is drawn into the nearest sliver of the depth range, so it never clips into walls and the world's depth survives for the haze pass
    if (G.showWeapon) { const gl = r.getContext(); r.autoClear = false; gl.depthRange(0, 0.02); r.render(G.scene, G.viewCam); gl.depthRange(0, 1); r.autoClear = true; }
    // haze and shafts at half resolution
    const u = this.volUniforms, sun = W.sun;
    u.tDepth.value = this.scene.depthTexture; u.tNoise.value = W.materials.shared.lsNoise.value; u.uInvVP.value.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse); u.uCam.value.copy(cam.position);
    u.uSunDir.value.copy(W.sunDir); u.uSunCol.value.copy(W.sunColor).multiplyScalar(W.sunStrength); u.uTime.value = G.time; u.uFrame.value = this.frame % 16;
    if (sun.shadow.map) { u.tShadow.value = sun.shadow.map.depthTexture; u.uShadowM.value.copy(sun.shadow.matrix); u.uShadowOn.value = 1; }
    W.ambientAt(cam.position, u.uAmbIn.value); u.uAmbIn.value.multiplyScalar(0.09); u.uAmbIn.value.b *= 1.25; u.uAmbIn.value.r *= 0.85;      // a thin, cool veil; the warm light in the air comes from the sun shafts
    this.pass(M.vol, this.vol);
    const vb = M.vblur.uniforms; vb.tDepth.value = this.scene.depthTexture; vb.uNF.value.set(cam.near, cam.far);
    vb.tVol.value = this.vol.texture; vb.uDir.value.set(1 / this.vol.width, 0); this.pass(M.vblur, this.vol2);
    vb.tVol.value = this.vol2.texture; vb.uDir.value.set(0, 1 / this.vol.height); this.pass(M.vblur, this.vol);
    if (!G.params.has('noao')) { const a = M.ao.uniforms, th = Math.tan(cam.fov * Math.PI / 360); a.tDepth.value = this.scene.depthTexture; a.uNF.value.set(cam.near, cam.far); a.uProj.value.set(th * cam.aspect, th); this.pass(M.ao, this.aoA);
      vb.tVol.value = this.aoA.texture; vb.uDir.value.set(1 / this.vol.width, 0); this.pass(M.vblur, this.aoB); vb.tVol.value = this.aoB.texture; vb.uDir.value.set(0, 1 / this.vol.height); this.pass(M.vblur, this.aoA); }
    const c = M.compose.uniforms; c.tScene.value = this.scene.texture; c.tDepth.value = this.scene.depthTexture; c.tVol.value = this.vol.texture; c.tAO.value = this.aoA.texture; c.uAO.value = G.params.has('noao') ? 0 : 0.85; c.uVolRes.value.set(this.vol.width, this.vol.height); c.uPre.value = W.materials.shared.lsHdr.value.y; c.uNF.value.set(cam.near, cam.far);
    this.pass(M.compose, this.hdr);
    // bloom: walk down, then back up
    let src = this.hdr;
    for (let i = 0; i < this.bloom.length; i++) { const d = M.down.uniforms; d.tSrc.value = src.texture; d.uTexel.value.set(1 / src.width, 1 / src.height); d.uFirst.value = i === 0 ? 1 : 0; this.pass(M.down, this.bloom[i]); src = this.bloom[i]; }
    for (let i = this.bloom.length - 2; i >= 0; i--) { const p = M.up.uniforms; p.tSrc.value = src.texture; p.tBase.value = this.bloom[i].texture; p.uTexel.value.set(1 / src.width, 1 / src.height); p.uMix.value = 0.62; this.pass(M.up, this.bloomUp[i]); src = this.bloomUp[i]; }
    // eye adaptation from the smallest level
    const l = M.lum.uniforms, a = this.lum[this.lumI], b = this.lum[1 - this.lumI]; l.tSrc.value = this.bloom[this.bloom.length - 1].texture; l.tPrev.value = a.texture; l.uDt.value = dt; l.uReset.value = this.reset > 0 ? 1 : 0; if (this.reset > 0) this.reset--;
    this.pass(M.lum, b); this.lumI = 1 - this.lumI;
    const f = M.final.uniforms; f.tHdr.value = this.hdr.texture; f.tBloom.value = src.texture; f.tLum.value = b.texture; f.uTexel.value.set(1 / this.iw, 1 / this.ih); f.uTime.value = G.time;
    f.uDamage.value = G.player ? Math.max(0, 1 - G.player.health / 100) : 0;
    const key = W.zoneName === 'ext' ? 0.25 : 0.098; f.uKey.value += (key - f.uKey.value) * Math.min(1, dt * 1.2);       // outdoors is exposed brighter: the eye never fully adapts to open sky
    this.pass(M.final, null);
  }
}
