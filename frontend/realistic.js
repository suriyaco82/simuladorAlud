// Vista realista: terreno con imagen satelital, superficie del flujo reconstruida desde las partículas,
// clastos 3D que ruedan (instancing) y polvo en frentes rápidos. El aspecto depende del material.
import * as THREE from 'three';

export const STYLES = {
  rock: {name: 'Avalancha de roca', surface: '#a39d93', rough: .95, bump: 1.0, clastEvery: 1, clastR: .6,
    clasts: ['#8d8a86', '#6e6a66', '#a39f99', '#7b7064', '#5d5953', '#9a8f80'], dust: true, wet: 0},
  soil: {name: 'Deslizamiento de suelo', surface: '#94704b', rough: .92, bump: .8, clastEvery: 3, clastR: .42,
    clasts: ['#6b4f35', '#7d6146', '#5a4330', '#8a8174', '#6f6a62'], dust: true, wet: .15},
  debris: {name: 'Flujo de detritos', surface: '#735a40', rough: .42, bump: .55, clastEvery: 4, clastR: .5,
    clasts: ['#6f6a64', '#595450', '#7e7468', '#4f4a45', '#8a8580'], dust: false, wet: .6},
  glof: {name: 'Crecida (agua + hielo o sedimento)', surface: '#dfe8ec', rough: .35, bump: .5, clastEvery: 2, clastR: .55,
    clasts: ['#eef5f8', '#d6e8ee', '#bfd8e1', '#a9c9d4'], dust: false, wet: .9},
  mud: {name: 'Flujo de barro', surface: '#86684a', rough: .22, bump: .25, clastEvery: 12, clastR: .32,
    clasts: ['#6a6159', '#574d44', '#7a6f63'], dust: false, wet: .9},
};
const SEDIMENT = ['#a08c6c', '#8f7d60', '#b39f80', '#978567'];
const WATER = new THREE.Color('#6f9aa0');  // agua glaciar turbia (harina de roca)
const HYPER = new THREE.Color('#a2804f');  // flujo hiperconcentrado (Cv ≈ 0,2)
const MUD = new THREE.Color('#6e5238');    // flujo de detritos (Cv ≥ 0,4)

export function autoStyle(mat, hasWater) {
  if (hasWater) return 'glof';
  const Sr = mat?.saturation ?? .5, eta = mat?.viscosity_pa_s ?? 0;
  if (Sr >= .85 && eta >= 1000) return 'mud';
  if (Sr >= .8) return 'debris';
  if (Sr < .3) return 'rock';
  return 'soil';
}

const hash = i => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

function noiseTexture() {
  // textura granular procedural (clastos + matriz fina), en escala de grises
  const N = 512, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, N, N);
  for (let k = 0; k < 9000; k++) {
    const r = Math.pow(Math.random(), 3) * 9 + 0.6, v = 90 + Math.random() * 130;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath();
    const x = Math.random() * N, y = Math.random() * N;
    g.ellipse(x, y, r, r * (0.6 + Math.random() * 0.6), Math.random() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function rockGeometry() {
  const g = new THREE.DodecahedronGeometry(1, 1);
  const p = g.attributes.position, seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, 0.72 + Math.random() * 0.45);
    const f = seen.get(key);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f * 0.8);
  }
  g.computeVertexNormals();
  return g;
}

function dustTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function skyTexture() {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#5f86ad'); gr.addColorStop(0.55, '#a9c0d3'); gr.addColorStop(1, '#d9e1e4');
  g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Imagen satelital (Esri World Imagery) sobre el dominio: mosaico de teselas + UV por vértice.
export async function satelliteTexture(d) {
  const latMid = (d.south + d.north) / 2;
  const mpp = Math.max(d.Lx, d.Ly) / 3072;
  let z = Math.max(1, Math.min(18, Math.floor(Math.log2(156543.03 * Math.cos(latMid * Math.PI / 180) / mpp))));
  const tx = lon => (lon + 180) / 360 * 2 ** z;
  const ty = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
  let x0, x1, y0, y1;
  for (;;) {
    x0 = Math.floor(tx(d.west)); x1 = Math.floor(tx(d.east)); y0 = Math.floor(ty(d.north)); y1 = Math.floor(ty(d.south));
    if ((x1 - x0 + 1) * 256 <= 4096 && (y1 - y0 + 1) * 256 <= 4096) break;
    z--;
  }
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#6b6457'; g.fillRect(0, 0, W, H);
  const jobs = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    jobs.push(new Promise(res => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => { g.drawImage(im, (x - x0) * 256, (y - y0) * 256); res(); };
      im.onerror = () => res();
      im.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    }));
  }
  await Promise.all(jobs);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const uv = new Float32Array(d.nx * d.ny * 2);
  for (let j = 0; j < d.ny; j++) {
    const lat = d.south + j * d.dx / d.my, v = 1 - (ty(lat) - y0) * 256 / H;
    for (let i = 0; i < d.nx; i++) {
      const k = j * d.nx + i, lon = d.west + i * d.dx / d.mx;
      uv[k * 2] = (tx(lon) - x0) * 256 / W; uv[k * 2 + 1] = v;
    }
  }
  return {tex, uv, zoom: z};
}

export class Realistic {
  constructor(world) {
    this.group = new THREE.Group();
    this.group.visible = false;
    world.add(this.group);
    this.noise = noiseTexture();
    this.rockGeo = rockGeometry();
    this.dustTex = dustTexture();
    this.styleName = 'soil';
    this._q = new THREE.Quaternion(); this._q0 = new THREE.Quaternion(); this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3(); this._ax = new THREE.Vector3(); this._c = new THREE.Color(); this._w = new THREE.Color();
  }

  dispose() {
    for (const o of [this.surface, this.clasts, this.dust]) {
      if (!o) continue;
      this.group.remove(o); o.geometry.dispose(); o.material.dispose();
    }
    this.surface = this.clasts = this.dust = null;
  }

  build(result, cap) {
    this.dispose();
    const d = result.meta.domain, rel = result.meta.release;
    this.S = result.S;
    // inundación: la lámina viene de la grilla y los cauces son angostos, se usa resolución completa si es posible
    this.flood = !!result.flood;
    const s = d.nx * d.ny > (this.flood ? 500000 : 90000) ? 2 : 1;
    const gnx = Math.floor((d.nx - 1) / s) + 1, gny = Math.floor((d.ny - 1) / s) + 1, gn = gnx * gny;
    Object.assign(this, {s, gnx, gny, gn, cs: d.dx * s, nxT: d.nx});
    this.bedIdx = new Int32Array(gn);
    const pos = new Float32Array(gn * 3), uv = new Float32Array(gn * 2);
    for (let j = 0; j < gny; j++) for (let i = 0; i < gnx; i++) {
      const k = j * gnx + i;
      this.bedIdx[k] = (j * s) * d.nx + i * s;
      pos[k * 3] = i * this.cs; pos[k * 3 + 1] = j * this.cs;
      uv[k * 2] = i * this.cs / 40; uv[k * 2 + 1] = j * this.cs / 40;
    }
    const idx = new Uint32Array((gnx - 1) * (gny - 1) * 6);
    let q = 0;
    for (let j = 0; j < gny - 1; j++) for (let i = 0; i < gnx - 1; i++) {
      const a = j * gnx + i, b = a + 1, c = a + gnx, e = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = e; idx[q++] = c;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(gn * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(gn * 3), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.surface = new THREE.Mesh(g, new THREE.MeshStandardMaterial({vertexColors: true, map: this.noise, bumpMap: this.noise, metalness: 0}));
    this.surface.receiveShadow = true;
    this.surface.frustumCulled = false;
    this.group.add(this.surface);
    this.cnt = new Float32Array(gn); this.lamS = new Float32Array(gn); this.ent = new Float32Array(gn); this.tmp = new Float32Array(gn);
    this.wat = new Float32Array(gn);
    this.hz = new Float32Array(gn);

    // volumen representado por cada partícula visible y tamaño efectivo
    const shown = Math.max(1, result.frames[0].count);
    this.vdisp = (rel.volume_m3 + (rel.water_volume_m3 || 0)) / shown;
    this.spacing = (rel.spacing_m || d.dx / 3) * Math.cbrt(Math.max(1, rel.particles / shown));

    this.cap = cap;
    const maxClasts = Math.min(cap, 14000);
    this.clasts = new THREE.InstancedMesh(this.rockGeo, new THREE.MeshStandardMaterial({roughness: .88, metalness: 0, flatShading: true}), maxClasts);
    this.clasts.castShadow = true; this.clasts.receiveShadow = true;
    this.clasts.frustumCulled = false;
    this.clasts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.clasts);
    this.maxClasts = maxClasts;
    this.p0 = new Float32Array(cap * 2).fill(NaN);
    this.lastFlag = new Uint8Array(cap).fill(254);
    this.rnd = new Float32Array(cap * 6);
    for (let i = 0; i < cap; i++) for (let k = 0; k < 6; k++) this.rnd[i * 6 + k] = hash(i * 7 + k * 131);

    const maxDust = 8000;
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxDust * 3), 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({color: 0xbfae93, map: this.dustTex, transparent: true, opacity: .2, depthWrite: false, sizeAttenuation: true}));
    this.dust.frustumCulled = false;
    this.maxDust = maxDust;
    this.group.add(this.dust);
    this.setStyle(this.styleName);
  }

  setStyle(name) {
    this.styleName = STYLES[name] ? name : 'soil';
    const st = STYLES[this.styleName];
    this.style = st;
    if (!this.surface) return;
    this.surfaceColor = new THREE.Color(st.surface);
    this.sediment = new THREE.Color(SEDIMENT[0]);
    const m = this.surface.material;
    m.roughness = st.rough;
    m.bumpScale = st.bump * 3;
    m.needsUpdate = true;
    this.clastEvery = Math.max(st.clastEvery, Math.ceil(this.cap / this.maxClasts));
    this.lastFlag.fill(254);
    this.dust.visible = st.dust;
    this.dust.material.size = this.spacing * 5 * this.S;
  }

  // st: pos (xyz, m), spd, lam, flg (255 = inactiva), n, exag, bed (posiciones del terreno)
  update({pos, spd, lam, flg, n, exag, bed}) {
    if (!this.surface) return;
    const {gnx, gny, gn, cs, cnt, lamS, ent, tmp, hz, wat} = this;
    cnt.fill(0); lamS.fill(0); ent.fill(0); wat.fill(0);
    for (let i = 0; i < n; i++) {
      if (flg[i] === 255) continue;
      const fx = Math.min(gnx - 1.001, Math.max(0, pos[i * 3] / cs)), fy = Math.min(gny - 1.001, Math.max(0, pos[i * 3 + 1] / cs));
      const i0 = fx | 0, j0 = fy | 0, tx = fx - i0, ty = fy - j0, k = j0 * gnx + i0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty, l = lam[i], e = flg[i] === 1 ? 1 : 0, wa = flg[i] === 2 ? 1 : 0;
      wat[k] += w00 * wa; wat[k + 1] += w10 * wa; wat[k + gnx] += w01 * wa; wat[k + gnx + 1] += w11 * wa;
      cnt[k] += w00; cnt[k + 1] += w10; cnt[k + gnx] += w01; cnt[k + gnx + 1] += w11;
      lamS[k] += w00 * l; lamS[k + 1] += w10 * l; lamS[k + gnx] += w01 * l; lamS[k + gnx + 1] += w11 * l;
      ent[k] += w00 * e; ent[k + 1] += w10 * e; ent[k + gnx] += w01 * e; ent[k + gnx + 1] += w11 * e;
    }
    for (const A of [cnt, lamS, ent, wat]) this.blur(A, tmp);

    const P = this.surface.geometry.attributes.position.array, C = this.surface.geometry.attributes.color.array;
    const area = cs * cs, st = this.style, base = this.surfaceColor, sed = this.sediment, c = this._c;
    let sw = 0, sx = 0, sy = 0, sz = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < gn; k++) {
      const tb = bed[this.bedIdx[k] * 3 + 2], h = cnt[k] * this.vdisp / area;
      const on = h > 0.3;
      if (on) {
        const x = (k % gnx) * cs, y = Math.floor(k / gnx) * cs;
        sw += h; sx += h * x; sy += h * y; sz += h * (tb + h);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      hz[k] = on ? tb + h : -1e9;
      P[k * 3 + 2] = on ? tb + h : tb - 4;
      if (!on) continue;
      const fe = cnt[k] > 1e-6 ? ent[k] / cnt[k] : 0, wet = st.wet * Math.min(1, (cnt[k] > 1e-6 ? lamS[k] / cnt[k] : 0) / 0.6);
      const fw = cnt[k] > 1e-6 ? wat[k] / cnt[k] : 0;
      c.copy(base).lerp(sed, Math.min(1, fe * 0.9)).multiplyScalar(1 - 0.22 * wet);
      // agua: color glaciar, más turbio (marrón) cuanto más sedimento lleva
      if (fw > 0) c.lerp(this._w.copy(WATER).lerp(base, Math.min(1, (1 - fw) * 1.5)), fw);
      const edge = Math.min(1, h / 3);  // bordes delgados más claros (material disperso)
      C[k * 3] = c.r * (1.15 - .15 * edge); C[k * 3 + 1] = c.g * (1.15 - .15 * edge); C[k * 3 + 2] = c.b * (1.15 - .15 * edge);
    }
    // centroide ponderado por espesor y extensión del flujo (para la cámara que sigue al flujo)
    this.stats = sw > 0 ? {x: sx / sw, y: sy / sw, z: sz / sw, ext: Math.max(x1 - x0, y1 - y0, cs * 4)} : null;
    const g = this.surface.geometry;
    this.heightfieldNormals(P, g.attributes.normal.array);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.normal.needsUpdate = true;

    this.updateClasts(pos, spd, flg, n, exag);
    if (st.dust) this.updateDust(pos, spd, flg, n);
  }

  // motor de inundación: lámina de agua/barro desde el tirante h y la concentración Cv de la grilla completa;
  // bloques y troncos con su tamaño real (bandera 4 bloque, 3 tronco; los árboles en pie no se dibujan)
  updateGrid({h, cv, pos, lam, flg, n, exag, bed}) {
    if (!this.surface) return;
    const {gn, gnx, cs, hz} = this, P = this.surface.geometry.attributes.position.array, C = this.surface.geometry.attributes.color.array;
    const c = this._c, mud = MUD, hyper = HYPER;
    let sw = 0, sx = 0, sy = 0, sz = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < gn; k++) {
      const idx = this.bedIdx[k], tb = bed[idx * 3 + 2], hh = h[idx], on = hh > 0.05;
      hz[k] = on ? tb + hh : -1e9;
      // la lámina se levanta un poco sobre el lecho para no quedar tapada por el terreno de la malla fina
      P[k * 3 + 2] = on ? tb + hh + 0.25 : tb - 4;
      if (!on) continue;
      const x = (k % gnx) * cs, y = Math.floor(k / gnx) * cs;
      sw += hh; sx += hh * x; sy += hh * y; sz += hh * (tb + hh);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const f = cv[idx];
      if (f < 0.2) c.copy(WATER).lerp(hyper, f / 0.2); else c.copy(hyper).lerp(mud, Math.min(1, (f - 0.2) / 0.2));
      const dk = 1 - 0.3 * Math.min(1, hh / 3);  // más oscuro cuanto más profundo
      C[k * 3] = c.r * dk; C[k * 3 + 1] = c.g * dk; C[k * 3 + 2] = c.b * dk;
    }
    this.stats = sw > 0 ? {x: sx / sw, y: sy / sw, z: sz / sw, ext: Math.max(x1 - x0, y1 - y0, cs * 4)} : null;
    const g = this.surface.geometry, m = this.surface.material;
    if (m.roughness !== 0.3) { m.roughness = 0.3; m.bumpScale = 0.6; m.needsUpdate = true; }
    this.heightfieldNormals(P, g.attributes.normal.array);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.normal.needsUpdate = true;
    this.dust.visible = false;
    this.updateTracers(pos, lam, flg, n, exag);
  }

  updateTracers(pos, lam, flg, n, exag) {
    const inst = this.clasts, m = this._m, q = this._q, q0 = this._q0, ax = this._ax, sc = this._s, rnd = this.rnd, st = this.style;
    let used = 0;
    for (let i = 0; i < n && used < this.maxClasts; i++) {
      const f = flg[i];
      if ((f !== 3 && f !== 4) || isNaN(pos[i * 3])) continue;
      const slot = used++, x = pos[i * 3], y = pos[i * 3 + 1];
      if (isNaN(this.p0[i * 2])) { this.p0[i * 2] = x; this.p0[i * 2 + 1] = y; }
      const dxm = x - this.p0[i * 2], dym = y - this.p0[i * 2 + 1], L = Math.hypot(dxm, dym);
      if (f === 4) {
        const r = lam[i] * 2;  // λ = d/4 → radio d/2
        q0.setFromAxisAngle(ax.set(rnd[i * 6 + 1] - .5, rnd[i * 6 + 2] - .5, rnd[i * 6 + 3] - .5).normalize(), rnd[i * 6 + 4] * 6.283);
        if (L > 1e-3) q.setFromAxisAngle(ax.set(-dym / L, dxm / L, 0), L / Math.max(r, 0.1) * 0.6).multiply(q0); else q.copy(q0);
        sc.set(r * (0.8 + 0.5 * rnd[i * 6 + 5]), r * (0.8 + 0.4 * rnd[i * 6 + 2]), r * (0.6 + 0.4 * rnd[i * 6 + 3]));
      } else {
        const len = lam[i] * 12;  // λ = largo/12
        q.setFromAxisAngle(ax.set(0, 0, 1), rnd[i * 6 + 4] * 6.283);
        sc.set(len / 2, 0.25, 0.25);
      }
      m.compose(ax.set(0, 0, 0), q, sc);
      m.elements[2] /= exag; m.elements[6] /= exag; m.elements[10] /= exag;
      m.setPosition(x, y, pos[i * 3 + 2]);
      inst.setMatrixAt(slot, m);
      // el slot de cada trazador cambia entre cuadros (árboles que pasan a troncos): el color se asigna siempre
      inst.setColorAt(slot, this._c.set(f === 3 ? '#6b4a2b' : st.clasts[Math.floor(rnd[i * 6 + 4] * st.clasts.length) % st.clasts.length]));
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.lastFlag.fill(254);
    inst.count = used;
    inst.instanceMatrix.needsUpdate = true;
  }

  // normales por diferencias centrales (malla regular): mucho más barato que computeVertexNormals
  heightfieldNormals(P, N) {
    const {gnx, gny, cs} = this, inv = 1 / (2 * cs);
    for (let j = 0; j < gny; j++) {
      const jm = j > 0 ? j - 1 : j, jp = j < gny - 1 ? j + 1 : j;
      for (let i = 0; i < gnx; i++) {
        const im = i > 0 ? i - 1 : i, ip = i < gnx - 1 ? i + 1 : i, k = j * gnx + i;
        const nx = -(P[(j * gnx + ip) * 3 + 2] - P[(j * gnx + im) * 3 + 2]) * inv * (2 / (ip - im || 1));
        const ny = -(P[(jp * gnx + i) * 3 + 2] - P[(jm * gnx + i) * 3 + 2]) * inv * (2 / (jp - jm || 1));
        const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        N[k * 3] = nx * l; N[k * 3 + 1] = ny * l; N[k * 3 + 2] = l;
      }
    }
  }

  blur(A, T) {
    const {gnx, gny} = this;
    for (let j = 0; j < gny; j++) for (let i = 0; i < gnx; i++) {
      const k = j * gnx + i, l = i > 0 ? A[k - 1] : A[k], r = i < gnx - 1 ? A[k + 1] : A[k];
      T[k] = 0.25 * l + 0.5 * A[k] + 0.25 * r;
    }
    for (let j = 0; j < gny; j++) for (let i = 0; i < gnx; i++) {
      const k = j * gnx + i, u = j > 0 ? T[k - gnx] : T[k], dn = j < gny - 1 ? T[k + gnx] : T[k];
      A[k] = 0.25 * u + 0.5 * T[k] + 0.25 * dn;
    }
  }

  surfaceAt(x, y) {
    const {gnx, gny, cs, hz} = this;
    const i = Math.min(gnx - 1, Math.max(0, Math.round(x / cs))), j = Math.min(gny - 1, Math.max(0, Math.round(y / cs)));
    return hz[j * gnx + i];
  }

  updateClasts(pos, spd, flg, n, exag) {
    const inst = this.clasts, every = this.clastEvery, st = this.style, R = this.spacing * st.clastR;
    const m = this._m, q = this._q, q0 = this._q0, ax = this._ax, sc = this._s, rnd = this.rnd;
    let used = 0;
    for (let i = 0; i < n && used < this.maxClasts; i += every) {
      const slot = used++;
      if (flg[i] === 255 || flg[i] === 2 || isNaN(pos[i * 3])) { m.makeScale(0, 0, 0); inst.setMatrixAt(slot, m); continue; }
      const x = pos[i * 3], y = pos[i * 3 + 1];
      if (isNaN(this.p0[i * 2])) { this.p0[i * 2] = x; this.p0[i * 2 + 1] = y; }
      const r = R * (0.45 + 0.9 * rnd[i * 6] ** 1.6);
      const dxm = x - this.p0[i * 2], dym = y - this.p0[i * 2 + 1], L = Math.hypot(dxm, dym);
      // orientación base aleatoria + rodadura en la dirección del desplazamiento
      q0.setFromAxisAngle(ax.set(rnd[i * 6 + 1] - .5, rnd[i * 6 + 2] - .5, rnd[i * 6 + 3] - .5).normalize(), rnd[i * 6 + 4] * 6.283);
      if (L > 1e-3) q.setFromAxisAngle(ax.set(-dym / L, dxm / L, 0), L / r * 0.6).multiply(q0); else q.copy(q0);
      sc.set(r * (0.8 + 0.5 * rnd[i * 6 + 5]), r * (0.8 + 0.4 * rnd[i * 6 + 2]), r * (0.6 + 0.4 * rnd[i * 6 + 3]));
      m.compose(ax.set(0, 0, 0), q, sc);
      const surf = this.surfaceAt(x, y);
      const z = Math.max(pos[i * 3 + 2] + r * 0.4, surf > -1e8 ? surf - r * (st.wet > .5 ? 0.45 : 0.15) : -1e9);
      // cancelar la exageración vertical del grupo para que los bloques no se estiren
      m.elements[2] /= exag; m.elements[6] /= exag; m.elements[10] /= exag;
      m.setPosition(x, y, z);
      inst.setMatrixAt(slot, m);
      if (this.lastFlag[i] !== flg[i]) {
        this.lastFlag[i] = flg[i];
        const pal = flg[i] === 1 ? SEDIMENT : st.clasts;
        inst.setColorAt(slot, this._c.set(pal[Math.floor(rnd[i * 6 + 4] * pal.length) % pal.length]));
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      }
    }
    inst.count = used;
    inst.instanceMatrix.needsUpdate = true;
  }

  updateDust(pos, spd, flg, n) {
    const P = this.dust.geometry.attributes.position.array;
    let k = 0;
    for (let i = 0; i < n && k < this.maxDust; i += 2) {
      if (flg[i] === 255 || flg[i] === 2 || spd[i] < 10 || isNaN(pos[i * 3])) continue;
      const h1 = hash(i * 3.1), h2 = hash(i * 5.7), lift = 3 + spd[i] * 0.35 * (0.3 + h1);
      P[k * 3] = pos[i * 3] + (h1 - .5) * this.spacing * 3;
      P[k * 3 + 1] = pos[i * 3 + 1] + (h2 - .5) * this.spacing * 3;
      P[k * 3 + 2] = pos[i * 3 + 2] + lift;
      k++;
    }
    this.dust.geometry.setDrawRange(0, k);
    this.dust.geometry.attributes.position.needsUpdate = true;
  }
}
