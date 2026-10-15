// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Informes profesionales (un análisis) y comparaciones entre varios escenarios.
// Todo se arma en el navegador: mapas sobre imágenes satelitales (teselas Esri, con CORS), gráficos SVG y tablas.
// El documento es HTML autocontenido (imágenes embebidas): se ve en el visor, se imprime a PDF o se descarga.
import {RAMPS, DAMAGE_COLORS, DAMAGE_NAMES, LEVEL_COLORS, CRITICALITY_COLORS, SERIES, hexRGB} from './palette.js';
import {buildingImpact, buildingHeight} from './exposure.js';
import {FLOW} from './basins.js';
import {HELP} from './help.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const fmtVol = v => v == null ? '—' : v >= 1e6 ? fmt(v / 1e6, 2) + ' hm³' : fmt(v, 0) + ' m³';
const fmtArea = a => a == null ? '—' : a >= 1e6 ? fmt(a / 1e6, 2) + ' km²' : fmt(a / 1e4, 2) + ' ha';
const fmtT = s => s == null || !isFinite(s) ? '—' : s < 120 ? fmt(s, 0) + ' s' : s < 7200 ? fmt(s / 60, 1) + ' min' : fmt(s / 3600, 2) + ' h';
const fmtDate = ts => new Date(ts * 1000).toLocaleString('es-AR', {dateStyle: 'long', timeStyle: 'short'});
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ENGINE = {mpm: 'MPM 3D — medio continuo con presión de poros y erosión', particles: 'Partículas independientes (exploratorio)',
  flood: 'Inundación 2D por lluvia en cuencas, con transporte de sedimento'};
const ENGINE_SHORT = {mpm: 'MPM 3D', particles: 'Partículas', flood: 'Inundación por lluvia'};

// ═════════════════════════════════════════════════════════════ Mapas (canvas)
const TILES = {imagery: ['World_Imagery', 19, 'Imágenes © Esri, Maxar, Earthstar Geographics'],
  topo: ['World_Topo_Map', 19, '© Esri, HERE, Garmin, USGS'], gray: ['Canvas/World_Light_Gray_Base', 16, '© Esri, HERE, Garmin']};
const tileCache = new Map();
function tile(svc, z, x, y) {
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/${z}/${y}/${x}`;
  if (!tileCache.has(url)) tileCache.set(url, new Promise(res => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  }));
  return tileCache.get(url);
}
const merc = {
  x: (lon, z) => (lon + 180) / 360 * 256 * 2 ** z,
  y: (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * 2 ** z; },
  lon: (px, z) => px / (256 * 2 ** z) * 360 - 180,
  lat: (py, z) => 180 / Math.PI * Math.atan(Math.sinh(Math.PI - 2 * Math.PI * py / (256 * 2 ** z))),
};

// valor de un campo del dominio en (lon, lat), vecino más cercano; NaN fuera del dominio
export function sampler(d, F) {
  return (lon, lat) => {
    const i = Math.round((lon - d.west) * d.mx / d.dx), j = Math.round((lat - d.south) * d.my / d.dx);
    return i < 0 || j < 0 || i >= d.nx || j >= d.ny ? NaN : F[j * d.nx + i];
  };
}

// estilos de los campos de resultado
const FIELD = {
  intensity: {name: 'Intensidad del flujo', cats: [[1, 'baja'], [2, 'media'], [3, 'alta']], colors: LEVEL_COLORS, mask: v => v >= 1},
  max_depth: {name: 'Profundidad máxima del flujo', unit: 'm', ramp: 'depth', mask: v => v > 0.05},
  max_speed: {name: 'Velocidad máxima', unit: 'm/s', ramp: 'speed', mask: v => v > 0.1},
  max_pressure: {name: 'Presión dinámica máxima ρ·v²', unit: 'kPa', ramp: 'depth', mask: v => v > 0.1},
  arrival: {name: 'Tiempo de arribo del flujo', unit: 'min', ramp: 'arrival', mask: v => v >= 0, k: 1 / 60},
  deposit: {name: 'Espesor de depósito', unit: 'm', ramp: 'depth', mask: v => v > 0.05},
  net_change: {name: 'Cambio neto de la superficie (− erosión / + depósito)', unit: 'm', ramp: 'diverging', mask: v => Math.abs(v) > 0.05, diverging: true},
  max_cv: {name: 'Concentración de sedimento máxima Cv', unit: '', ramp: 'pore', mask: v => v > 0.01, fixed: [0, 0.6]},
  frequency: {name: 'Escenarios que alcanzan cada sitio', unit: '', ramp: 'arrival', mask: v => v >= 1},
};

function rampColor(stops, t) {
  const cs = stops.map(hexRGB), x = Math.max(0, Math.min(1, t)) * (cs.length - 1), k = Math.min(cs.length - 2, Math.floor(x)), f = x - k;
  return [0, 1, 2].map(c => cs[k][c] + (cs[k + 1][c] - cs[k][c]) * f);
}
// estilo listo para pintar: color(v) y la leyenda
export function fieldStyle(name, F, opts = {}) {
  const st = {...FIELD[name], ...opts};
  if (st.cats) {
    const cols = Object.fromEntries(st.cats.map(([v]) => [v, hexRGB(st.colors[v])]));
    return {...st, color: v => st.mask(v) ? cols[Math.round(v)] || null : null,
      legend: {title: st.name, items: st.cats.map(([v, l]) => ({color: st.colors[v], label: l}))}};
  }
  const k = st.k || 1;
  let lo = 0, hi = 1;
  if (st.fixed) [lo, hi] = st.fixed;
  else if (st.range) [lo, hi] = st.range;
  else {
    const vals = [];
    for (const v of F) if (st.mask(v)) vals.push(st.diverging ? Math.abs(v) : v);
    vals.sort((a, b) => a - b);
    hi = vals.length ? vals[Math.floor(vals.length * 0.99)] || vals[vals.length - 1] : 1;
    lo = st.diverging ? -hi : 0;
    if (name === 'arrival' && vals.length) lo = vals[0];
  }
  if (!(hi > lo)) hi = lo + 1;
  const stops = RAMPS[st.ramp];
  return {...st, lo, hi, color: v => st.mask(v) ? rampColor(stops, (v - lo) / (hi - lo)) : null,
    legend: {title: st.name + (st.unit ? ` (${st.unit})` : ''), stops, lo: lo * k, hi: hi * k}};
}

// extensión (lon/lat) de lo alcanzado por el flujo, con margen
export function footprint(meta, F, pad = 0.15) {
  const d = meta.domain;
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  if (F) for (let j = 0; j < d.ny; j++) for (let i = 0; i < d.nx; i++) if (F[j * d.nx + i] > 0.1) {
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
  }
  if (!isFinite(i0)) return {west: d.west, south: d.south, east: d.east, north: d.north};
  const e = {west: d.west + i0 * d.dx / d.mx, east: d.west + i1 * d.dx / d.mx, south: d.south + j0 * d.dx / d.my, north: d.south + j1 * d.dx / d.my};
  return padExtent(e, pad);
}
export function padExtent(e, pad, minDeg = 0.004) {
  const w = Math.max(e.east - e.west, minDeg), h = Math.max(e.north - e.south, minDeg), cx = (e.east + e.west) / 2, cy = (e.north + e.south) / 2;
  return {west: cx - w / 2 * (1 + 2 * pad), east: cx + w / 2 * (1 + 2 * pad), south: cy - h / 2 * (1 + 2 * pad), north: cy + h / 2 * (1 + 2 * pad)};
}
export const unionExtent = es => ({west: Math.min(...es.map(e => e.west)), east: Math.max(...es.map(e => e.east)),
  south: Math.min(...es.map(e => e.south)), north: Math.max(...es.map(e => e.north))});
function polysExtent(polys) {
  const e = {west: Infinity, east: -Infinity, south: Infinity, north: -Infinity};
  for (const rings of polys) for (const [lo, la] of rings[0]) {
    e.west = Math.min(e.west, lo); e.east = Math.max(e.east, lo); e.south = Math.min(e.south, la); e.north = Math.max(e.north, la);
  }
  return e;
}

// Mapa en imagen: teselas + capa de resultado + zonas + edificios + escala, norte, leyenda y atribución
export async function renderMap(o) {
  const W = o.width || 1400, base = TILES[o.basemap || 'imagery'];
  let {west, south, east, north} = o.extent;
  // relación de aspecto acotada (las figuras del informe no pueden ser tiras finas)
  const [amin, amax] = o.aspect || [0.55, 0.95];
  const wx = merc.x(east, 0) - merc.x(west, 0), hy = merc.y(south, 0) - merc.y(north, 0), asp = hy / wx;
  const cxm = (merc.x(east, 0) + merc.x(west, 0)) / 2, cym = (merc.y(south, 0) + merc.y(north, 0)) / 2;
  let w0 = wx, h0 = hy;
  if (asp < amin) h0 = wx * amin; else if (asp > amax) w0 = hy / amax;
  west = merc.lon(cxm - w0 / 2, 0); east = merc.lon(cxm + w0 / 2, 0);
  north = merc.lat(cym - h0 / 2, 0); south = merc.lat(cym + h0 / 2, 0);
  const H = Math.round(W * h0 / w0);
  const zt = Math.max(1, Math.min(base[1], Math.round(Math.log2(W / w0))));
  const s = W / (w0 * 2 ** zt);
  const px0 = merc.x(west, zt), py0 = merc.y(north, zt);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#d8d4cc'; g.fillRect(0, 0, W, H);
  const tx0 = Math.floor(px0 / 256), tx1 = Math.floor((px0 + W / s) / 256), ty0 = Math.floor(py0 / 256), ty1 = Math.floor((py0 + H / s) / 256);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++)
    jobs.push(tile(base[0], zt, tx, ty).then(im => { if (im) g.drawImage(im, (tx * 256 - px0) * s, (ty * 256 - py0) * s, 256 * s + 0.5, 256 * s + 0.5); }));
  await Promise.all(jobs);
  if (o.dim) { g.fillStyle = `rgba(255,255,255,${o.dim})`; g.fillRect(0, 0, W, H); }
  const P = (lon, lat) => [(merc.x(lon, zt) - px0) * s, (merc.y(lat, zt) - py0) * s];

  // capa de resultado, muestreada por píxel
  for (const ov of o.overlays || []) {
    const oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    const oct = oc.getContext('2d'), img = oct.createImageData(W, H);
    const lons = new Float64Array(W);
    for (let x = 0; x < W; x++) lons[x] = merc.lon(px0 + (x + 0.5) / s, zt);
    for (let y = 0; y < H; y++) {
      const lat = merc.lat(py0 + (y + 0.5) / s, zt);
      for (let x = 0; x < W; x++) {
        const c = ov.colorAt(lons[x], lat);
        if (!c) continue;
        const k = (y * W + x) * 4;
        img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
      }
    }
    oct.putImageData(img, 0, 0);
    g.globalAlpha = ov.alpha ?? 0.78; g.drawImage(oc, 0, 0); g.globalAlpha = 1;
  }
  // contornos (zona de cálculo, zona urbana)
  for (const r of o.rects || []) {
    const [x0, y0] = P(r.extent.west, r.extent.north), [x1, y1] = P(r.extent.east, r.extent.south);
    g.strokeStyle = r.color || '#fff'; g.lineWidth = r.width || 3; g.setLineDash(r.dash || []);
    g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.setLineDash([]);
  }
  for (const pl of o.outlines || []) {
    g.beginPath();
    pl.ring.forEach(([lo, la], k) => { const [x, y] = P(lo, la); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.closePath(); g.strokeStyle = pl.color || '#3fd0e0'; g.lineWidth = pl.width || 2.5; g.setLineDash(pl.dash || [8, 5]); g.stroke(); g.setLineDash([]);
  }
  // zonas de afectación
  if (o.zones) {
    for (const z of [...o.zones].sort((a, b) => a.level - b.level)) {
      g.beginPath();
      for (const rings of z.polygons) for (const ring of rings) {
        ring.forEach(([lo, la], k) => { const [x, y] = P(lo, la); k ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.closePath();
      }
      if (o.zoneFill !== false) { g.fillStyle = LEVEL_COLORS[z.level] + '55'; g.fill('evenodd'); }
      g.strokeStyle = z.criticality === 'Crítica' ? CRITICALITY_COLORS['Crítica'] : LEVEL_COLORS[z.level];
      g.lineWidth = z.criticality === 'Crítica' ? 3.5 : 2; g.stroke();
    }
  }
  // edificios
  for (const b of o.buildings || []) {
    const [x, y] = P(b.lon, b.lat);
    if (x < -5 || y < -5 || x > W + 5 || y > H + 5) continue;
    g.beginPath(); g.arc(x, y, b.r || 3.2, 0, Math.PI * 2);
    g.fillStyle = b.color; g.fill(); g.lineWidth = 0.8; g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke();
  }
  // etiquetas de zonas
  if (o.zones && o.zoneLabels !== false) {
    g.font = '600 15px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const z of o.zones) {
      if (o.zoneLabels === 'important' && !(z.criticality === 'Crítica' || z.criticality === 'Alta' || z.buildings_affected)) continue;
      const [x, y] = P(z.center[0], z.center[1]);
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const w = g.measureText(z.code).width + 10;
      g.fillStyle = 'rgba(255,255,255,.92)'; g.fillRect(x - w / 2, y - 10, w, 20);
      g.strokeStyle = CRITICALITY_COLORS[z.criticality]; g.lineWidth = 2; g.strokeRect(x - w / 2, y - 10, w, 20);
      g.fillStyle = '#111'; g.fillText(z.code, x, y + 1);
    }
  }
  for (const m of o.markers || []) {
    const [x, y] = P(m.lon, m.lat);
    g.font = '600 14px Helvetica, Arial, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fillStyle = m.color || '#007ac2'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    if (m.label) { const w = g.measureText(m.label).width + 8; g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(x + 9, y - 10, w, 20); g.fillStyle = '#111'; g.fillText(m.label, x + 13, y + 1); }
  }
  decorate(g, W, H, {mpp: 156543.03 * Math.cos((north + south) / 2 * Math.PI / 180) / 2 ** zt / s, legend: o.legend, title: o.title, attribution: base[2]});
  return cv.toDataURL('image/jpeg', 0.86);
}

function decorate(g, W, H, {mpp, legend, title, attribution}) {
  g.textBaseline = 'alphabetic';
  // escala gráfica
  const target = W * 0.2 * mpp, e = 10 ** Math.floor(Math.log10(target)), m = target / e;
  const len = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e, px = len / mpp, x0 = 22, y0 = H - 26;
  g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(x0 - 10, y0 - 30, px + 64, 46);
  g.fillStyle = '#111'; g.fillRect(x0, y0, px / 2, 7); g.strokeStyle = '#111'; g.lineWidth = 1.2; g.strokeRect(x0, y0, px, 7);
  g.font = '13px Helvetica, Arial, sans-serif'; g.textAlign = 'center';
  g.fillText('0', x0, y0 - 6); g.fillText(len >= 1000 ? `${fmt(len / 1000, 1)} km` : `${fmt(len, 0)} m`, x0 + px, y0 - 6);
  // norte
  const nx = W - 34, ny = 50;
  g.fillStyle = 'rgba(255,255,255,.88)'; g.beginPath(); g.arc(nx, ny - 6, 24, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111'; g.beginPath(); g.moveTo(nx, ny - 26); g.lineTo(nx + 9, ny + 2); g.lineTo(nx, ny - 5); g.lineTo(nx - 9, ny + 2); g.closePath(); g.fill();
  g.font = '700 13px Helvetica, Arial, sans-serif'; g.fillText('N', nx, ny + 14);
  if (title) {
    g.font = '600 17px Helvetica, Arial, sans-serif'; g.textAlign = 'left';
    const w = g.measureText(title).width + 20;
    g.fillStyle = 'rgba(255,255,255,.92)'; g.fillRect(12, 12, w, 30); g.fillStyle = '#111'; g.fillText(title, 22, 33);
  }
  if (legend) drawLegend(g, W, H, legend);
  g.font = '11px Helvetica, Arial, sans-serif'; g.textAlign = 'right';
  const aw = g.measureText(attribution).width + 10;
  g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(W - aw - 4, H - 17, aw + 4, 17); g.fillStyle = '#333'; g.fillText(attribution, W - 8, H - 5);
}
function drawLegend(g, W, H, L) {
  const pad = 12, lw = 270;
  g.font = '600 13px Helvetica, Arial, sans-serif'; g.textAlign = 'left';
  const titleLines = wrap(g, L.title, lw - 2 * pad);
  let h = pad + titleLines.length * 17;
  if (L.stops) h += 46; else h += L.items.length * 21 + 4;
  const x = W - lw - 14, y = H - h - 26;
  g.fillStyle = 'rgba(255,255,255,.92)'; g.fillRect(x, y, lw, h);
  g.strokeStyle = 'rgba(0,0,0,.2)'; g.lineWidth = 1; g.strokeRect(x, y, lw, h);
  g.fillStyle = '#111';
  titleLines.forEach((t, k) => g.fillText(t, x + pad, y + pad + 12 + k * 17));
  let yy = y + pad + titleLines.length * 17 + 4;
  if (L.stops) {
    const gr = g.createLinearGradient(x + pad, 0, x + lw - pad, 0);
    L.stops.forEach((c, k) => gr.addColorStop(k / (L.stops.length - 1), c));
    g.fillStyle = gr; g.fillRect(x + pad, yy, lw - 2 * pad, 14);
    g.fillStyle = '#222'; g.font = '12px Helvetica, Arial, sans-serif';
    const d = Math.abs(L.hi) < 10 ? 2 : 0;
    g.textAlign = 'left'; g.fillText(fmt(L.lo, d), x + pad, yy + 30);
    g.textAlign = 'center'; g.fillText(fmt((L.lo + L.hi) / 2, d), x + lw / 2, yy + 30);
    g.textAlign = 'right'; g.fillText(fmt(L.hi, d) + (L.plus === false ? '' : '+'), x + lw - pad, yy + 30);
  } else {
    g.font = '13px Helvetica, Arial, sans-serif';
    for (const it of L.items) {
      g.fillStyle = it.color; g.fillRect(x + pad, yy, 16, 14); g.strokeStyle = 'rgba(0,0,0,.35)'; g.strokeRect(x + pad, yy, 16, 14);
      g.fillStyle = '#111'; g.fillText(it.label, x + pad + 24, yy + 12); yy += 21;
    }
  }
}
function wrap(g, text, w) {
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    const t = line ? line + ' ' + word : word;
    if (g.measureText(t).width > w && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

// ═════════════════════════════════════════════════════════════ Gráficos (SVG)
const AX = '#9a9a9a', GRID = '#e6e6e6', TXT = '#333';
function niceMax(v) {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v)), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
const ticks = (max, n = 4) => Array.from({length: n + 1}, (_, k) => max * k / n);
const tfmt = v => Math.abs(v) >= 1e6 ? fmt(v / 1e6, 1) + ' M' : Math.abs(v) >= 1e4 ? fmt(v / 1e3, 0) + ' k' : fmt(v, v < 10 ? 2 : 0);

// barras horizontales: rows [{label, value, color, text}]
export function hbars({rows, width = 680, labelW = 190, unit = '', fmtv = v => fmt(v, 1)}) {
  const bh = 22, gap = 8, top = 8, H = top + rows.length * (bh + gap) + 24, max = niceMax(Math.max(...rows.map(r => r.value || 0)));
  const x = v => labelW + (width - labelW - 70) * v / max;
  let s = `<svg class="chart" viewBox="0 0 ${width} ${H}" width="${width}">`;
  for (const t of ticks(max)) s += `<line x1="${x(t)}" y1="${top - 4}" x2="${x(t)}" y2="${H - 22}" stroke="${GRID}"/><text x="${x(t)}" y="${H - 8}" text-anchor="middle" class="tk">${tfmt(t)}</text>`;
  rows.forEach((r, k) => {
    const y = top + k * (bh + gap);
    s += `<text x="${labelW - 8}" y="${y + bh / 2 + 4}" text-anchor="end" class="lb">${esc(r.label)}</text>` +
      `<rect x="${labelW}" y="${y}" width="${Math.max(0, x(r.value || 0) - labelW)}" height="${bh}" fill="${r.color}"/>` +
      `<text x="${x(r.value || 0) + 6}" y="${y + bh / 2 + 4}" class="vl">${r.text ?? fmtv(r.value)}</text>`;
  });
  return s + `<text x="${width - 4}" y="${H - 8}" text-anchor="end" class="tk">${unit}</text></svg>`;
}
// barras horizontales apiladas: rows [{label, values[]}], cats [{name, color}]
export function stackedH({rows, cats, width = 680, labelW = 190, unit = ''}) {
  const bh = 24, gap = 10, top = 8, H = top + rows.length * (bh + gap) + 24;
  const max = niceMax(Math.max(1, ...rows.map(r => r.values.reduce((a, b) => a + b, 0))));
  const x = v => labelW + (width - labelW - 60) * v / max;
  let s = `<svg class="chart" viewBox="0 0 ${width} ${H}" width="${width}">`;
  for (const t of ticks(max)) s += `<line x1="${x(t)}" y1="${top - 4}" x2="${x(t)}" y2="${H - 22}" stroke="${GRID}"/><text x="${x(t)}" y="${H - 8}" text-anchor="middle" class="tk">${tfmt(t)}</text>`;
  rows.forEach((r, k) => {
    const y = top + k * (bh + gap);
    let acc = 0;
    s += `<text x="${labelW - 8}" y="${y + bh / 2 + 4}" text-anchor="end" class="lb">${esc(r.label)}</text>`;
    r.values.forEach((v, c) => {
      if (!v) return;
      const w = x(acc + v) - x(acc);
      s += `<rect x="${x(acc)}" y="${y}" width="${w}" height="${bh}" fill="${cats[c].color}"><title>${esc(cats[c].name)}: ${fmt(v, 1)}</title></rect>`;
      if (w > 26) s += `<text x="${x(acc) + w / 2}" y="${y + bh / 2 + 4}" text-anchor="middle" class="in" fill="${dark(cats[c].color) ? '#fff' : '#111'}">${fmt(v, 0)}</text>`;
      acc += v;
    });
    s += `<text x="${x(acc) + 6}" y="${y + bh / 2 + 4}" class="vl">${fmt(acc, 0)}</text>`;
  });
  return s + `<text x="${width - 4}" y="${H - 8}" text-anchor="end" class="tk">${unit}</text></svg>` + legend(cats);
}
const dark = hex => { const [r, g, b] = hexRGB(hex); return r * 0.299 + g * 0.587 + b * 0.114 < 140; };
// barras verticales agrupadas: cats [etiquetas del eje x], series [{name, color, values}]
export function vgroups({cats, series, width = 680, height = 280, unit = '', valueLabels = series.length <= 4 && cats.length <= 12}) {
  const L = 54, B = 46, T = 12, R = 10, pw = width - L - R, ph = height - T - B;
  const max = niceMax(Math.max(...series.flatMap(s => s.values.map(v => v || 0))));
  const gw = pw / cats.length, bw = Math.min(46, gw * 0.8 / series.length);
  let s = `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}">`;
  for (const t of ticks(max)) { const y = T + ph - ph * t / max; s += `<line x1="${L}" y1="${y}" x2="${width - R}" y2="${y}" stroke="${GRID}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="tk">${tfmt(t)}</text>`; }
  cats.forEach((c, i) => {
    const x0 = L + gw * i + (gw - bw * series.length) / 2;
    series.forEach((se, k) => {
      const v = se.values[i] || 0, h = ph * v / max;
      s += `<rect x="${x0 + k * bw}" y="${T + ph - h}" width="${bw - 2}" height="${h}" fill="${se.color}"><title>${esc(se.name)} · ${esc(c)}: ${fmt(v, 2)}</title></rect>`;
      if (valueLabels && v) s += `<text x="${x0 + k * bw + bw / 2 - 1}" y="${T + ph - h - 4}" text-anchor="middle" class="tk">${tfmt(v)}</text>`;
    });
    s += `<text x="${L + gw * i + gw / 2}" y="${height - B + 18}" text-anchor="middle" class="lb">${esc(c)}</text>`;
  });
  s += `<line x1="${L}" y1="${T + ph}" x2="${width - R}" y2="${T + ph}" stroke="${AX}"/>`;
  s += `<text x="12" y="${T + ph / 2}" transform="rotate(-90 12 ${T + ph / 2})" text-anchor="middle" class="tk">${esc(unit)}</text></svg>`;
  return s + (series.length > 1 ? legend(series) : '');
}
// líneas: series [{name, color, pts: [[x, y]], dash}]
export function lines({series, width = 680, height = 280, xlab = '', ylab = '', xfmt = tfmt}) {
  const L = 58, B = 42, T = 12, R = 14, pw = width - L - R, ph = height - T - B;
  const xs = series.flatMap(s => s.pts.map(p => p[0])), ys = series.flatMap(s => s.pts.map(p => p[1]));
  const xmax = Math.max(1e-9, ...xs), ymax = niceMax(Math.max(...ys, 0));
  const X = v => L + pw * v / xmax, Y = v => T + ph - ph * v / ymax;
  let s = `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}">`;
  for (const t of ticks(ymax)) s += `<line x1="${L}" y1="${Y(t)}" x2="${width - R}" y2="${Y(t)}" stroke="${GRID}"/><text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end" class="tk">${tfmt(t)}</text>`;
  for (const t of ticks(xmax, 5)) s += `<text x="${X(t)}" y="${T + ph + 16}" text-anchor="middle" class="tk">${xfmt(t)}</text>`;
  s += `<line x1="${L}" y1="${T + ph}" x2="${width - R}" y2="${T + ph}" stroke="${AX}"/><line x1="${L}" y1="${T}" x2="${L}" y2="${T + ph}" stroke="${AX}"/>`;
  for (const se of series) {
    if (!se.pts.length) continue;
    s += `<polyline fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''} points="${se.pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ')}"/>`;
  }
  s += `<text x="${L + pw / 2}" y="${height - 6}" text-anchor="middle" class="tk">${esc(xlab)}</text>` +
    `<text x="14" y="${T + ph / 2}" transform="rotate(-90 14 ${T + ph / 2})" text-anchor="middle" class="tk">${esc(ylab)}</text></svg>`;
  return s + (series.length > 1 ? legend(series.filter(x => !x.hideLegend)) : '');
}
const legend = items => `<div class="lgd">${items.map(i => `<span><i style="background:${i.color}"></i>${esc(i.name)}</span>`).join('')}</div>`;

// ═════════════════════════════════════════════════════════════ Piezas del documento
const CSS = `
@page{size:A4;margin:14mm 13mm 16mm}
*{box-sizing:border-box}
body{margin:0;background:#e9ecef;color:#1d1d1d;font:10.5pt/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif}
.doc{max-width:210mm;margin:0 auto;background:#fff;padding:14mm 13mm;box-shadow:0 2px 18px rgba(0,0,0,.15)}
.tb{position:sticky;top:0;z-index:5;display:flex;gap:8px;justify-content:center;padding:10px;background:#1f2a33}
.tb button{font:600 13px Helvetica,Arial,sans-serif;padding:8px 16px;border:0;border-radius:3px;background:#007ac2;color:#fff;cursor:pointer}
.tb button.sec{background:#fff;color:#1f2a33}
h1{font-size:25pt;line-height:1.15;margin:0 0 6px;color:#0b2e4a}
h2{font-size:15pt;margin:26px 0 10px;padding-bottom:5px;border-bottom:2.5px solid #007ac2;color:#0b2e4a;break-after:avoid}
h3{font-size:11.5pt;margin:18px 0 6px;color:#0b2e4a;break-after:avoid}
p{margin:6px 0 10px;text-align:justify}
.cover{min-height:255mm;display:flex;flex-direction:column;break-after:page}
.cover .band{background:linear-gradient(120deg,#0b2e4a,#007ac2);color:#fff;padding:22px 24px;margin:-14mm -13mm 18px}
.cover .band small{opacity:.85;letter-spacing:.12em;text-transform:uppercase;font-size:9pt}
.cover .band h1{color:#fff;margin-top:10px}
.cover .band .sub{font-size:13pt;opacity:.95}
.cover table.meta{margin-top:auto}
.cover .disclaimer{margin-top:14px;font-size:8.5pt;color:#555;border-left:3px solid #edd317;padding:6px 10px;background:#fffbe6}
table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:9.2pt;break-inside:auto}
table.wide{font-size:8.2pt}
table.wide td,table.wide th{padding:3px 4px}
th{background:#0b2e4a;color:#fff;font-weight:600;text-align:left;padding:5px 7px;vertical-align:bottom}
td{padding:4px 7px;border-bottom:1px solid #e2e2e2;vertical-align:top}
tr{break-inside:avoid}
tbody tr:nth-child(even) td{background:#f6f8fa}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.n{white-space:nowrap}
table.meta td:first-child{color:#555;width:38%}
table.kv td:first-child{color:#444;width:52%}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0 14px}
.kpi{border:1px solid #dfe3e8;border-top:4px solid #007ac2;padding:8px 10px;break-inside:avoid}
.kpi b{display:block;font-size:15.5pt;color:#0b2e4a;line-height:1.2}
.kpi span{font-size:8.3pt;color:#555}
.kpi.red{border-top-color:#d62828}.kpi.dark{border-top-color:#6b0a0a}.kpi.org{border-top-color:#ff9f1c}
figure{margin:10px 0 16px;break-inside:avoid}
figure img{width:100%;display:block;border:1px solid #ccc}
figcaption{font-size:8.8pt;color:#444;margin-top:5px}
figcaption b{color:#0b2e4a}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid2 figure{margin:4px 0 8px}
svg.chart{max-width:100%;height:auto;font-family:Helvetica,Arial,sans-serif}
svg.chart .tk{font-size:10px;fill:#555}
svg.chart .lb{font-size:11px;fill:#222}
svg.chart .vl{font-size:11px;fill:#111;font-weight:600}
svg.chart .in{font-size:10px;font-weight:600}
.lgd{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:9pt;color:#333;margin:4px 0 0}
.lgd i{display:inline-block;width:11px;height:11px;margin-right:5px;vertical-align:-1px;border:1px solid rgba(0,0,0,.25)}
.chip{display:inline-block;padding:1px 7px;border-radius:9px;font-size:8.3pt;font-weight:600;white-space:nowrap}
.note{font-size:8.6pt;color:#555}
.callout{border-left:4px solid #007ac2;background:#f1f7fb;padding:8px 12px;margin:10px 0;break-inside:avoid}
.warn{border-left:4px solid #edd317;background:#fffbe6;padding:6px 10px;margin:5px 0;font-size:9pt}
.pb{break-before:page}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.best{color:#1e7d32;font-weight:700}.worst{color:#b3261e;font-weight:700}
footer{margin-top:24px;padding-top:8px;border-top:1px solid #ddd;font-size:8.2pt;color:#777;display:flex;justify-content:space-between}
@media print{body{background:#fff}.doc{box-shadow:none;padding:0;max-width:none}.tb{display:none}.cover .band{margin:0 0 18px}}
`;
const chip = (text, bg) => `<span class="chip" style="background:${bg};color:${dark(bg) ? '#fff' : '#1b1b1b'}">${esc(text)}</span>`;
const dmgChip = g => chip(DAMAGE_NAMES[g], DAMAGE_COLORS[g]);
const critChip = c => chip(c, CRITICALITY_COLORS[c]);
const fig = (src, caption, n) => `<figure><img src="${src}" alt=""><figcaption><b>Figura ${n}.</b> ${caption}</figcaption></figure>`;
const kv = rows => `<table class="kv"><tbody>${rows.filter(Boolean).map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table>`;
const kpi = (value, label, cls = '') => `<div class="kpi ${cls}"><b>${value}</b><span>${label}</span></div>`;

export function shell(title, body, meta) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `<div class="tb" id="tb" hidden><button onclick="print()">Imprimir / guardar PDF</button></div>` +
    `<div class="doc">${body}<footer><span>${esc(meta)}</span><span>Suriyaco MassFlow 3D · Alfredo Toledo · SuriyacoValley · La Rioja, Argentina · AGPL-3.0 · generado el ${new Date().toLocaleString('es-AR')}</span></footer></div>` +
    `<script>if(window.top===window)document.getElementById('tb').hidden=false</script></body></html>`;
}

// ═════════════════════════════════════════════════════════════ Datos de un análisis
const damageOf = (pts, i) => (pts.damage ? pts.damage[i] : pts.intensity[i]) || 0;
function affectedBuildings(A) {
  const pts = A.meta.exposure && A.meta.exposure.points;
  if (!pts) return [];
  const B = A.buildings || [];
  const out = [];
  for (let i = 0; i < pts.intensity.length; i++) {
    const r = buildingImpact(pts, i);
    if (!r || !(r.damage > 0)) continue;
    out.push({i, b: B[i] || {id: '#' + (i + 1)}, r});
  }
  return out.sort((a, b) => b.r.damage - a.r.damage || (a.r.arrival ?? 1e12) - (b.r.arrival ?? 1e12));
}
function damageCounts(A) {
  const pts = A.meta.exposure && A.meta.exposure.points;
  const c = [0, 0, 0, 0, 0];
  if (pts) for (let i = 0; i < pts.intensity.length; i++) c[damageOf(pts, i)]++;
  return c;
}
const urbanRings = A => ((A.params && A.params.exposure) || []).filter(z => (z.polygon || []).length >= 3).map(z => ({ring: z.polygon}));

function narrative(A) {
  const m = A.meta, s = m.summary, imp = m.impact, pts = m.exposure && m.exposure.points, dc = damageCounts(A);
  const Z = imp ? imp.zones : [], nc = Z.filter(z => z.criticality === 'Crítica').length, nh = Z.filter(z => z.criticality === 'Alta').length;
  let t = '';
  if (m.engine === 'flood') {
    const st = m.flood.storm, tt = m.flood.totals;
    t += `El escenario simula una tormenta de <b>${fmt(st.rain_mm, 0)} mm en ${fmt(st.duration_h, 2)} h</b> (intensidad pico ${fmt(st.peak_intensity_mm_h, 0)} mm/h) sobre las cuencas seleccionadas. ` +
      `Escurren ${fmtVol(tt.runoff_m3)} (coeficiente de escorrentía ${fmt(tt.runoff_coeff, 2)}) y el área inundada con más de 0,1 m de tirante alcanza <b>${fmt(tt.flooded_area_km2, 2)} km²</b>, ` +
      `con profundidades de hasta ${fmt(s.max_depth_m, 1)} m, velocidades de hasta ${fmt(s.max_speed_m_s, 1)} m/s y una concentración de sedimento máxima Cv = ${fmt(s.max_cv, 2)}${s.max_cv >= 0.4 ? ' (flujo de detritos)' : s.max_cv >= 0.2 ? ' (flujo hiperconcentrado)' : ''}. `;
  } else {
    t += `El escenario moviliza <b>${fmtVol(m.release.volume_m3)}</b>${s.eroded_volume_m3 > 0 ? ` y erosiona otros ${fmtVol(s.eroded_volume_m3)} a lo largo del recorrido` : ''}. ` +
      `El flujo alcanza <b>${fmt(s.runout_m, 0)} m</b> desde el área de desprendimiento, cubre ${fmtArea(s.affected_area_m2)} y llega a velocidades de <b>${fmt(s.max_speed_m_s, 1)} m/s</b> (${fmt(s.max_speed_km_h, 0)} km/h) con espesores de hasta ${fmt(s.max_depth_m, 1)} m. `;
  }
  if (Z.length) t += `Se delimitaron <b>${Z.length} zonas de afectación</b>, de las cuales ${nc} son de criticidad crítica y ${nh} de criticidad alta. `;
  if (pts) {
    t += `De los ${fmt(pts.total, 0)} edificios relevados, <b>${fmt(pts.affected, 0)}</b> (${fmt(pts.affected / Math.max(1, pts.total) * 100, 0)} %) son alcanzados por el flujo: ` +
      `${fmt(dc[4], 0)} con destrucción probable, ${fmt(dc[3], 0)} con daño grave, ${fmt(dc[2], 0)} con daño moderado y ${fmt(dc[1], 0)} con daño leve.` +
      (pts.first_arrival_s != null ? ` El primer edificio es alcanzado a los <b>${fmtT(pts.first_arrival_s)}</b> del inicio del evento.` : '');
  }
  return t;
}

function paramRows(A) {
  const m = A.meta, p = A.params || {}, mat = m.material || {}, v = m.solver || {}, d = m.domain;
  const rows = [
    ['Motor de cálculo', ENGINE[m.engine] || m.engine],
    ['Modelo', esc(m.model)],
    ['Modelo digital de elevación', esc(m.dem_source || m.dataset)],
    ['Zona de cálculo', `${fmt(d.Lx / 1000, 2)} × ${fmt(d.Ly / 1000, 2)} km · ${fmt(d.nx, 0)} × ${fmt(d.ny, 0)} celdas de ${fmt(d.dx, 1)} m`],
    ['Extensión (O, S, E, N)', `${fmt(d.west, 4)}, ${fmt(d.south, 4)}, ${fmt(d.east, 4)}, ${fmt(d.north, 4)}`],
  ];
  if (m.engine === 'flood') {
    const st = m.flood.storm, tt = m.flood.totals, ps = p.storm || {};
    rows.push(['Lluvia de diseño', `${fmt(st.rain_mm, 0)} mm en ${fmt(st.duration_h, 2)} h · hietograma ${esc(st.pattern)}`],
      ['Intensidad pico', `${fmt(st.peak_intensity_mm_h, 0)} mm/h`],
      ['Número de curva CN · humedad antecedente', `${fmt(st.cn, 0)} · AMC ${esc(st.amc)}`],
      ['Lluvia areal (con reducción)', `${fmt(tt.rain_mm, 1)} mm (× ${fmt(tt.areal_reduction, 2)})`],
      ['Volumen llovido / escurrido', `${fmtVol(tt.rain_m3)} / ${fmtVol(tt.runoff_m3)}`],
      ['Deslizamientos de ladera', tt.landslide_cells ? `${fmt(tt.landslide_cells, 0)} celdas · ${fmtVol(tt.landslide_m3)}` : 'ninguno'],
      ['Erosionado / depositado', `${fmtVol(tt.eroded_m3)} / ${fmtVol(tt.deposited_m3)}`],
      ps.ia_ratio ? ['Abstracción inicial Ia/S', fmt(ps.ia_ratio, 2)] : null);
  } else {
    const r = m.release;
    rows.push(['Volumen liberado', fmtVol(r.volume_m3) + (r.water_volume_m3 ? ` + ${fmtVol(r.water_volume_m3)} de agua` : '')],
      r.area_m2 ? ['Área · espesor medio / máx.', `${fmtArea(r.area_m2)} · ${fmt(r.mean_thickness_m, 1)} / ${fmt(r.max_thickness_m, 1)} m`] : null,
      ...(m.bodies || []).map(b => [`Masa «${esc(b.name)}»`, `${esc(b.material)} · ${fmtVol(b.volume_m3)}`]),
      ['Densidad de la mezcla', `${fmt(mat.rho_mixture, 0)} kg/m³ (sólidos ${fmt(mat.density_solid, 0)} kg/m³, porosidad ${fmt(mat.porosity, 2)})`],
      ['Fricción interna φ · basal δ', `${fmt(mat.friction_angle_deg, 1)}° · ${fmt(mat.basal_friction_deg, 1)}°`],
      ['Viscosidad · saturación', `${fmt(mat.viscosity_pa_s, 0)} Pa·s · ${fmt(mat.saturation, 2)}`],
      ['Espesor erosionable', `${fmt(mat.erodible_depth_m, 1)} m`],
      p.turbulence_xi ? ['Turbulencia Voellmy ξ', `${fmt(p.turbulence_xi, 0)} m/s²`] : null);
  }
  rows.push(['Tiempo simulado · de cómputo', `${fmtT(v.t_end)} · ${fmtT(m.summary.wall_time_s)}`],
    ['Dispositivo de cálculo', esc(v.device || '—')]);
  return rows;
}

function zonesTable(Z, limit = 40) {
  if (!Z.length) return '<p class="note">El flujo no generó zonas de afectación.</p>';
  const rows = Z.slice(0, limit).map(z => {
    const dc = z.damage_counts || {};
    return `<tr><td><b>${z.code}</b></td><td>${critChip(z.criticality)}</td><td><span class="sw" style="background:${LEVEL_COLORS[z.level]}"></span>${z.level_name}</td>` +
      `<td class="n">${fmt(z.area_m2 / 1e4, 2)}</td><td class="n">${fmt(z.max_depth_m, 1)}</td><td class="n">${fmt(z.max_speed_m_s, 1)}</td><td class="n">${fmt(z.max_pressure_kPa, 0)}</td>` +
      `<td class="n">${fmtT(z.first_arrival_s)}</td><td class="n">${z.buildings_affected || '—'}</td>` +
      `<td class="n">${[4, 3, 2, 1].map(g => dc[DAMAGE_NAMES[g]] || 0).join(' / ')}</td></tr>`;
  }).join('');
  return `<table class="wide"><thead><tr><th>Zona</th><th>Criticidad</th><th>Intensidad</th><th class="n">Área (ha)</th><th class="n">h máx. (m)</th><th class="n">v máx. (m/s)</th>` +
    `<th class="n">P máx. (kPa)</th><th class="n">1.er arribo</th><th class="n">Edificios</th><th class="n">D / G / M / L</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="note">D / G / M / L: edificios con destrucción probable, daño grave, moderado y leve.${Z.length > limit ? ` Se listan las ${limit} zonas más comprometidas de ${Z.length}.` : ''}</p>`;
}

function buildingsTable(list, limit = 600) {
  if (!list.length) return '<p class="note">Ningún edificio relevado es alcanzado por el flujo.</p>';
  const hasH = list.some(o => buildingHeight(o.b)), hasUse = list.some(o => o.b.use);
  const rows = list.slice(0, limit).map(({b, r}, k) => `<tr><td class="n">${k + 1}</td><td>${esc(b.id)}</td><td>${dmgChip(r.damage)}</td>` +
    `<td>${['—', 'baja', 'media', 'alta'][r.intensity]}</td><td class="n">${fmt(r.depth, 2)}</td><td class="n">${fmt(r.speed, 1)}</td><td class="n">${fmt(r.pressure, 0)}</td>` +
    `<td class="n">${fmtT(r.arrival)}</td>${hasH ? `<td class="n">${buildingHeight(b) ? fmt(buildingHeight(b), 1) : '—'}</td>` : ''}${hasUse ? `<td>${esc(b.use || '')}</td>` : ''}` +
    `<td>${b.lat != null ? `${(+b.lat).toFixed(5)}, ${(+b.lon).toFixed(5)}` : '—'}</td></tr>`).join('');
  return `<table class="wide"><thead><tr><th class="n">N.º</th><th>Edificio</th><th>Grado de daño</th><th>Intensidad</th><th class="n">h máx. (m)</th><th class="n">v (m/s)</th>` +
    `<th class="n">P (kPa)</th><th class="n">Llegada</th>${hasH ? '<th class="n">Altura (m)</th>' : ''}${hasUse ? '<th>Uso</th>' : ''}<th>Lat, lon</th></tr></thead><tbody>${rows}</tbody></table>` +
    (list.length > limit ? `<p class="note">Se listan los ${limit} edificios más afectados de ${list.length}.</p>` : '');
}

function hydroCharts(G, engine) {
  if (!G || !G.length) return '';
  const hrs = Math.max(...G.map(g => g.t[g.t.length - 1] || 0)) > 7200, k = hrs ? 3600 : 60;
  const series = [];
  G.slice(0, 6).forEach((g, i) => {
    series.push({name: g.name, color: SERIES[i % SERIES.length], pts: g.t.map((t, j) => [t / k, g.Q[j]])});
    if (g.Q_scs) series.push({name: g.name + ' (SCS)', color: SERIES[i % SERIES.length], dash: '5 4', width: 1.3, hideLegend: true, pts: g.t.map((t, j) => [t / k, g.Q_scs[j]])});
  });
  const rows = G.map(g => {
    const iq = g.Q.indexOf(Math.max(...g.Q)), arr = g.t.find((t, i) => g.h[i] > 0.5);
    return `<tr><td>${esc(g.name)}</td><td class="n">${fmt(g.Q[iq], 0)}</td><td class="n">${fmtT(g.t[iq])}</td><td class="n">${fmtT(arr)}</td>` +
      `<td class="n">${fmt(Math.max(...g.h), 2)}</td><td class="n">${fmt(Math.max(...g.v), 1)}</td>${g.Q_scs ? `<td class="n">${fmt(Math.max(...g.Q_scs), 0)}</td>` : '<td class="n">—</td>'}</tr>`;
  }).join('');
  return lines({series, xlab: hrs ? 'tiempo (h)' : 'tiempo (min)', ylab: 'caudal (m³/s)'}) +
    `<table><thead><tr><th>Estación</th><th class="n">Q pico (m³/s)</th><th class="n">Hora del pico</th><th class="n">Llegada (h > 0,5 m)</th><th class="n">h máx. (m)</th><th class="n">v máx. (m/s)</th><th class="n">Q pico SCS</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="note">Q = Σ h·v·ancho a través de la sección. Tiempos desde el inicio ${engine === 'flood' ? 'de la lluvia; en punteado, el hidrograma SCS agregado' : 'del evento'}.</p>`;
}

// curva de edificios alcanzados en el tiempo
function arrivalCurve(A) {
  const pts = A.meta.exposure && A.meta.exposure.points;
  if (!pts) return null;
  const ta = pts.arrival_s.filter(t => t >= 0).sort((a, b) => a - b);
  if (ta.length < 2) return null;
  const tmax = ta[ta.length - 1], k = tmax > 7200 ? 3600 : 60;
  return {k, pts: [[0, 0], ...ta.map((t, i) => [t / k, i + 1])]};
}

const METHOD = {
  flood: 'La lluvia se transforma en escorrentía con el método SCS-CN y se propaga en 2D con las ecuaciones de aguas someras (aproximación inercial local); en los cauces empinados la crecida incorpora sedimento hasta el equilibrio de Takahashi y deposita en los abanicos; los deslizamientos de ladera se evalúan con SHALSTAB.',
  mpm: 'La masa se resuelve como medio continuo con el método del punto material (MPM), con fricción de Drucker-Prager, presión de poros que reduce la fricción efectiva y erosión del lecho según McDougall y Hungr.',
  particles: 'Cada partícula sigue su trayectoria sobre el terreno con fricción basal, sin interacción entre partículas: es un motor de previsualización y sus resultados son solo indicativos del recorrido posible.',
};

// ═════════════════════════════════════════════════════════════ Informe de un análisis
export async function buildReport(A, progress = () => {}) {
  const m = A.meta, d = m.domain, Z = (m.impact && m.impact.zones) || [], pts = m.exposure && m.exposure.points;
  const E = A.entry || {name: m.scenario_name || 'Análisis', project: '', created: Date.now() / 1000};
  const F = {};
  for (const k of ['intensity', 'max_depth', 'max_speed', 'max_pressure', 'arrival', 'deposit', 'net_change', 'max_cv']) F[k] = await A.field(k);
  const ext = footprint(m, F.max_depth), sample = k => sampler(d, F[k]);
  const affected = affectedBuildings(A), dc = damageCounts(A);
  const B = A.buildings || [];
  const bDots = (size = 3.2) => B.map((b, i) => ({lon: b.lon, lat: b.lat, r: size, color: DAMAGE_COLORS[pts ? damageOf(pts, i) : 0]}));
  const urban = urbanRings(A);
  let nfig = 0;
  const F_ = (src, cap) => fig(src, cap, ++nfig);
  const mapOf = async (name, title, extra = {}, width = 1000) => {
    if (!F[name]) return '';
    const st = fieldStyle(name, F[name], name === 'arrival' && m.summary && (A.meta.solver.t_end || 0) < 600 ? {k: 1, unit: 's'} : {});
    const smp = sample(name);
    progress(`Mapa: ${st.name}…`);
    return renderMap({extent: ext, width, overlays: [{colorAt: (lo, la) => st.color(smp(lo, la))}], outlines: urban, legend: st.legend, title, ...extra});
  };

  progress('Mapa de ubicación…');
  const locExt = padExtent({west: d.west, east: d.east, south: d.south, north: d.north}, 1.6, 0.05);
  const imgLoc = await renderMap({extent: locExt, basemap: 'topo', width: 1200, aspect: [0.55, 0.75],
    rects: [{extent: {west: d.west, east: d.east, south: d.south, north: d.north}, color: '#d62828', width: 3}],
    markers: [{lon: (d.west + d.east) / 2, lat: (d.south + d.north) / 2, label: 'Zona de cálculo', color: '#d62828'}]});

  const imgIntensity = await mapOf('intensity', 'Intensidad del flujo y zonas de afectación', {zones: Z, zoneFill: false, zoneLabels: 'important', buildings: bDots(2.6)}, 1400);
  const imgDepth = await mapOf('max_depth', 'Profundidad máxima');
  const imgSpeed = await mapOf('max_speed', 'Velocidad máxima');
  const imgPress = await mapOf('max_pressure', 'Presión dinámica máxima');
  const imgArr = await mapOf('arrival', 'Tiempo de arribo');
  const imgDep = m.engine === 'flood' && F.max_cv ? await mapOf('max_cv', 'Concentración de sedimento', {}, 1400) : await mapOf('net_change', 'Erosión y depósito', {}, 1400);
  progress('Mapa de zonas…');
  const imgZones = Z.length ? await renderMap({extent: ext, zones: Z, zoneLabels: true, outlines: urban, buildings: bDots(3), title: 'Zonas de afectación y edificios',
    legend: {title: 'Grado de daño de los edificios', items: [4, 3, 2, 1].map(g => ({color: DAMAGE_COLORS[g], label: DAMAGE_NAMES[g]}))}}) : '';
  // acercamientos a las zonas más comprometidas
  const close = [];
  for (const z of Z.filter(z => z.criticality === 'Crítica' || z.buildings_affected).slice(0, 4)) {
    progress(`Detalle de la zona ${z.code}…`);
    close.push({z, img: await renderMap({extent: padExtent(polysExtent(z.polygons), 0.25, 0.003), width: 1000, aspect: [0.6, 0.9], zones: [z], zoneLabels: false,
      buildings: bDots(5), title: `Zona ${z.code} · ${z.criticality}`})});
  }

  // ── documento
  const s = m.summary, nc = Z.filter(z => z.criticality === 'Crítica').length;
  let h = `<section class="cover"><div class="band"><small>Informe técnico de simulación</small><h1>${esc(E.name)}</h1>` +
    `<div class="sub">${esc(E.project || 'Sin proyecto')}${m.scenario_name && m.scenario_name !== E.name ? ' · ' + esc(m.scenario_name) : ''}</div></div>` +
    F_(imgLoc, `Ubicación de la zona de cálculo (rectángulo rojo). Centro: ${fmt((d.south + d.north) / 2, 4)}°, ${fmt((d.west + d.east) / 2, 4)}°.`) +
    `<table class="meta"><tbody>` +
    `<tr><td>Proyecto</td><td>${esc(E.project || '—')}</td></tr><tr><td>Análisis</td><td>${esc(E.name)}</td></tr>` +
    `<tr><td>Tipo de evento / motor</td><td>${ENGINE[m.engine] || esc(m.engine)}</td></tr>` +
    `<tr><td>Fecha del cálculo</td><td>${fmtDate(E.created)}</td></tr>` +
    `<tr><td>Identificador</td><td>${esc(A.id || '—')}</td></tr>` +
    (E.notes ? `<tr><td>Notas</td><td>${esc(E.notes)}</td></tr>` : '') +
    `<tr><td>Elaborado por</td><td>&nbsp;</td></tr></tbody></table>` +
    `<div class="disclaimer">${esc(m.warning || 'Escenario exploratorio sin calibrar.')} Los resultados dependen de los datos de entrada y de los supuestos del modelo; deben ser revisados por especialistas antes de usarse para decisiones.</div></section>`;

  h += `<h2>1. Resumen ejecutivo</h2><div class="kpis">` +
    (m.engine === 'flood' ? kpi(fmt(m.flood.totals.flooded_area_km2, 2) + ' km²', 'Área inundada (h > 0,1 m)') : kpi(fmtArea(s.affected_area_m2), 'Área afectada por el flujo')) +
    kpi(fmt(s.max_depth_m, 1) + ' m', 'Profundidad máxima') + kpi(fmt(s.max_speed_m_s, 1) + ' m/s', 'Velocidad máxima') +
    (m.engine === 'flood' ? kpi(fmtVol(m.flood.totals.runoff_m3), 'Volumen escurrido') : kpi(fmt(s.runout_m, 0) + ' m', 'Alcance (runout)')) +
    kpi(Z.length, 'Zonas de afectación') + kpi(nc, 'Zonas críticas', 'dark') +
    (pts ? kpi(`${fmt(pts.affected, 0)} / ${fmt(pts.total, 0)}`, 'Edificios alcanzados / relevados', 'red') + kpi(fmt(dc[4] + dc[3], 0), 'Con daño grave o destrucción probable', 'dark')
      : kpi(fmtVol(s.deposit_volume_m3), 'Volumen depositado') + kpi(fmtT(Z.length ? Math.min(...Z.map(z => z.first_arrival_s ?? Infinity)) : null), 'Primer arribo a una zona')) +
    `</div><p>${narrative(A)}</p>`;
  if (m.warnings && m.warnings.length) h += m.warnings.map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join('');

  h += `<h2>2. Escenario y parámetros</h2>${kv(paramRows(A))}`;
  if (m.engine === 'flood' && m.flood.basins && m.flood.basins.length) {
    const mains = m.flood.basins.filter(b => b.is_main);
    h += `<h3>Cuencas simuladas</h3><table><thead><tr><th>Cuenca</th><th class="n">Área (km²)</th><th class="n">Melton</th><th class="n">Q pico SCS (m³/s)</th><th class="n">Pico (h)</th><th>Tipo de flujo esperado</th></tr></thead><tbody>` +
      mains.map(b => `<tr><td>${esc(b.code || '')} ${esc(b.name)}</td><td class="n">${fmt(b.area_km2, 2)}</td><td class="n">${fmt(b.melton, 2)}</td><td class="n">${fmt(b.q_peak, 0)}</td><td class="n">${fmt(b.t_peak_h, 2)}</td>` +
        `<td>${b.flow && FLOW[b.flow] ? chip(FLOW[b.flow].name, FLOW[b.flow].color) : '—'}</td></tr>`).join('') + `</tbody></table>`;
    const hy = m.flood.hyetograph;
    if (hy && hy.mm) h += `<h3>Hietograma de diseño</h3>` + vgroups({cats: hy.mm.map((_, i) => i % Math.ceil(hy.mm.length / 12) === 0 ? fmt(i * hy.dt_h * 60, 0) : ''),
      series: [{name: 'Lluvia', color: '#3f8fd2', values: hy.mm}], unit: 'mm por intervalo', height: 220}) + `<p class="note">Eje horizontal: minutos desde el inicio de la tormenta.</p>`;
  }

  h += `<h2 class="pb">3. Mapas de resultados</h2>` +
    `<p>Los mapas muestran las envolventes (máximos alcanzados en cualquier instante del evento) sobre imagen satelital. ${urban.length ? 'La línea discontinua celeste marca la zona urbana analizada.' : ''}</p>` +
    (imgIntensity ? F_(imgIntensity, `Intensidad del flujo (alta, media, baja) con el contorno de las zonas de afectación y los edificios coloreados según el grado de daño estimado.`) : '') +
    `<div class="grid2">` + [[imgDepth, 'Profundidad máxima del flujo.'], [imgSpeed, 'Velocidad máxima.'], [imgPress, 'Presión dinámica máxima (ρ·v²), indicador del empuje sobre estructuras.'],
    [imgArr, 'Tiempo de arribo del flujo desde el inicio del evento.']].filter(x => x[0]).map(([i, c]) => F_(i, c)).join('') + `</div>` +
    (imgDep ? F_(imgDep, m.engine === 'flood' ? 'Concentración volumétrica de sedimento máxima (Cv): < 0,2 crecida de agua, 0,2–0,4 hiperconcentrado, > 0,4 flujo de detritos.' : 'Cambio neto de la superficie: en azul la erosión del lecho, en rojo el material depositado.') : '');
  if (A.snapshot3D) h += F_(A.snapshot3D, 'Vista tridimensional del escenario (exageración vertical según la vista del simulador).');

  h += `<h2 class="pb">4. Zonas de afectación</h2>` +
    `<p>Las zonas resultan de agrupar las áreas contiguas de igual intensidad. Su criticidad combina la intensidad con el daño de los edificios que contienen: ` +
    `<b>crítica</b> (intensidad alta con edificios con daño grave o destrucción), <b>alta</b> (intensidad alta, o media con edificios), <b>media</b> (intensidad media, o baja con edificios) y <b>baja</b> (el resto).</p>` +
    (imgZones ? F_(imgZones, 'Zonas de afectación numeradas por criticidad, y edificios según el grado de daño estimado.') : '');
  if (m.impact && m.impact.area_by_level_m2) {
    const a = m.impact.area_by_level_m2;
    h += `<h3>Superficie por intensidad</h3>` + hbars({rows: [3, 2, 1].map(L => ({label: 'Intensidad ' + ['', 'baja', 'media', 'alta'][L], value: (a[['', 'baja', 'media', 'alta'][L]] || 0) / 1e4, color: LEVEL_COLORS[L]})), unit: 'ha', fmtv: v => fmt(v, 2) + ' ha'});
  }
  h += `<h3>Listado de zonas</h3>` + zonesTable(Z);
  if (close.length) {
    h += `<h3>Detalle de las zonas más comprometidas</h3><div class="grid2">` + close.map(({z, img}) => F_(img,
      `Zona ${z.code} (${z.criticality.toLowerCase()}, intensidad ${z.level_name}): ${fmtArea(z.area_m2)}, h máx. ${fmt(z.max_depth_m, 1)} m, v máx. ${fmt(z.max_speed_m_s, 1)} m/s, ${z.buildings_affected || 0} edificios afectados.`)).join('') + `</div>`;
  }

  if (pts) {
    h += `<h2 class="pb">5. Exposición: edificios afectados</h2>` +
      `<p>Para cada edificio se toma el flujo máximo en su ubicación. El grado de daño es orientativo: <b>leve</b> con intensidad baja, <b>moderado</b> con intensidad media, <b>grave</b> con intensidad alta y ` +
      `<b>destrucción probable</b> con intensidad alta y presión dinámica de 35 kPa o más (umbral de colapso de mampostería, Jakob et al. 2012), o cuando el flujo supera la altura del edificio.</p>` +
      `<div class="kpis">${[4, 3, 2, 1].map(g => kpi(fmt(dc[g], 0), DAMAGE_NAMES[g], g === 4 ? 'dark' : g === 3 ? 'red' : g === 2 ? 'org' : '')).join('')}</div>` +
      `<h3>Edificios por grado de daño</h3>` + hbars({rows: [4, 3, 2, 1].map(g => ({label: DAMAGE_NAMES[g], value: dc[g], color: DAMAGE_COLORS[g]})), fmtv: v => fmt(v, 0)});
    const ac = arrivalCurve(A);
    if (ac) h += `<h3>Edificios alcanzados en el tiempo</h3>` + lines({series: [{name: 'Edificios alcanzados', color: '#d62828', pts: ac.pts}], xlab: ac.k === 3600 ? 'tiempo desde el inicio (h)' : 'tiempo desde el inicio (min)', ylab: 'edificios alcanzados (acumulado)'}) +
      `<p class="note">Tiempo disponible para la evacuación: el primer edificio es alcanzado a los ${fmtT(pts.first_arrival_s)}; la mitad de los afectados, antes de ${fmtT(ac.pts[Math.ceil(ac.pts.length / 2)][0] * ac.k)}.</p>`;
    if (pts.with_height) h += kv([['Edificios con altura conocida', `${fmt(pts.with_height, 0)} de ${fmt(pts.total, 0)}`], ['Flujo ≥ mitad de la altura', fmt(pts.half_height, 0)], ['Flujo ≥ altura del edificio', fmt(pts.overtopped, 0)]]);
    h += `<h3>Listado de edificios afectados</h3>` + buildingsTable(affected);
  }
  const zonesEx = (m.exposure && m.exposure.zones) || [];
  if (zonesEx.length) {
    h += `<h3>Zonas urbanas analizadas</h3><table><thead><tr><th>Zona</th><th class="n">Superficie</th><th class="n">Afectada</th><th class="n">Alta / media / baja (ha)</th><th class="n">1.er arribo</th><th class="n">h p50 / p90 (m)</th><th class="n">Depósito</th></tr></thead><tbody>` +
      zonesEx.map(z => `<tr><td>${esc(z.name)}</td><td class="n">${fmtArea(z.area_m2)}</td><td class="n">${fmtArea(z.affected_area_m2)} (${fmt(z.affected_fraction * 100, 0)} %)</td>` +
        `<td class="n">${['alta', 'media', 'baja'].map(k => fmt(z.area_by_intensity_m2[k] / 1e4, 2)).join(' / ')}</td><td class="n">${fmtT(z.first_arrival_s)}</td>` +
        `<td class="n">${z.depth_p50_p90_m ? z.depth_p50_p90_m.map(v => fmt(v, 2)).join(' / ') : '—'}</td><td class="n">${fmtVol(z.deposit_volume_m3)}</td></tr>`).join('') + `</tbody></table>`;
  }
  if (m.gauges && m.gauges.length) h += `<h2 class="pb">${pts ? 6 : 5}. Hidrogramas en estaciones virtuales</h2>` + hydroCharts(m.gauges, m.engine);

  h += `<h2>Metodología, criterios y limitaciones</h2>` +
    `<p><b>Modelo.</b> ${esc(m.model)}. ${METHOD[m.engine] || ''}</p>` +
    (m.impact ? `<p><b>Intensidad.</b> ${esc(m.impact.criteria.intensity)}.</p><p><b>Grado de daño.</b> ${esc(m.impact.criteria.damage)}.</p><p><b>Criticidad de las zonas.</b> ${esc(m.impact.criteria.criticality)}.</p>` : '') +
    (m.terrain_notes && m.terrain_notes.length ? `<p><b>Acondicionamiento del terreno.</b> ${m.terrain_notes.map(esc).join(' · ')}.</p>` : '') +
    `<div class="callout"><b>Limitaciones.</b> ${esc(m.warning || '')} La resolución del DEM (${fmt(d.dx, 0)} m) no representa calles, muros ni obras menores; los edificios se tratan como puntos y no desvían el flujo. ` +
    `El grado de daño es un indicador orientativo basado en la intensidad local y no reemplaza una evaluación estructural. Para usos de planificación, calibrar con eventos históricos y validar en campo.</div>`;

  return shell(`Informe · ${E.name}`, h, `${E.project ? E.project + ' · ' : ''}${E.name}`);
}

// ═════════════════════════════════════════════════════════════ Comparación de varios escenarios
const KPI_ROWS = [
  ['Tipo de evento', A => ENGINE_SHORT[A.meta.engine] || A.meta.engine],
  ['Lluvia de diseño', A => A.meta.flood ? `${fmt(A.meta.flood.storm.rain_mm, 0)} mm / ${fmt(A.meta.flood.storm.duration_h, 2)} h` : null],
  ['Volumen movilizado / escurrido', A => A.meta.flood ? A.meta.flood.totals.runoff_m3 : A.meta.release.volume_m3, 'vol', 'low'],
  ['Área afectada', A => A.meta.summary.affected_area_m2, 'area', 'low'],
  ['Alcance (runout)', A => A.meta.engine === 'flood' ? null : A.meta.summary.runout_m, 'm', 'low'],
  ['Profundidad máxima', A => A.meta.summary.max_depth_m, 'h', 'low'],
  ['Velocidad máxima', A => A.meta.summary.max_speed_m_s, 'v', 'low'],
  ['Volumen depositado', A => A.meta.summary.deposit_volume_m3, 'vol', 'low'],
  ['Área de intensidad alta', A => lv(A, 'alta'), 'area', 'low'],
  ['Área de intensidad media', A => lv(A, 'media'), 'area', 'low'],
  ['Área de intensidad baja', A => lv(A, 'baja'), 'area', 'low'],
  ['Zonas de afectación', A => A.meta.impact ? A.meta.impact.zones.length : null, 'n', 'low'],
  ['Zonas críticas', A => A.meta.impact ? A.meta.impact.zones.filter(z => z.criticality === 'Crítica').length : null, 'n', 'low'],
  ['Edificios alcanzados', A => pts(A) ? pts(A).affected : null, 'n', 'low'],
  ['Destrucción probable', A => pts(A) ? damageCounts(A)[4] : null, 'n', 'low'],
  ['Daño grave', A => pts(A) ? damageCounts(A)[3] : null, 'n', 'low'],
  ['Daño moderado', A => pts(A) ? damageCounts(A)[2] : null, 'n', 'low'],
  ['Daño leve', A => pts(A) ? damageCounts(A)[1] : null, 'n', 'low'],
  ['Primer edificio alcanzado', A => pts(A) ? pts(A).first_arrival_s : null, 't', 'high'],
  ['Resolución de la grilla', A => A.meta.domain.dx, 'm'],
  ['Tiempo de cómputo', A => A.meta.summary.wall_time_s, 't'],
];
const pts = A => A.meta.exposure && A.meta.exposure.points;
const lv = (A, k) => A.meta.impact && A.meta.impact.area_by_level_m2 ? A.meta.impact.area_by_level_m2[k] : null;
const kfmt = (v, u) => v == null ? '—' : typeof v === 'string' ? esc(v) : u === 'vol' ? fmtVol(v) : u === 'area' ? fmtArea(v) : u === 'm' ? fmt(v, 0) + ' m'
  : u === 'h' ? fmt(v, 2) + ' m' : u === 'v' ? fmt(v, 1) + ' m/s' : u === 't' ? fmtT(v) : fmt(v, 0);

// parámetros que cambian entre escenarios
const SKIP = new Set(['exposure_points', 'exposure_heights', 'project', 'analysis_name', 'analysis_notes', 'ui', 'release_polygon', 'scenario_name', 'max_frames', 'display_particles', 'random_seed']);
function flatten(o, pre = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    if (SKIP.has(k)) continue;
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = v.length && typeof v[0] === 'object' ? `${v.length} elemento${v.length === 1 ? '' : 's'} (${JSON.stringify(v).length > 80 ? 'geometría' : esc(JSON.stringify(v))})` : JSON.stringify(v);
    else out[key] = v;
  }
  return out;
}
const pname = k => { const last = k.split('.').pop(); return HELP[last] ? `${esc(HELP[last].t)} <span class="note">(${esc(k)})</span>` : esc(k); };

export async function buildComparison(As, progress = () => {}) {
  const n = As.length, col = i => SERIES[i % SERIES.length];
  const label = (A, i) => `${String.fromCharCode(65 + i)} · ${A.entry.name}`;
  progress('Leyendo los campos de cada escenario…');
  for (const A of As) { A.F = {intensity: await A.field('intensity'), max_depth: await A.field('max_depth')}; A.ext = footprint(A.meta, A.F.max_depth, 0.08); }
  const ext = padExtent(unionExtent(As.map(A => A.ext)), 0.06);
  // escenarios en lugares distintos: cada mapa con su extensión y sin envolventes (no hay superposición que comparar)
  const diag = e => Math.hypot(e.east - e.west, e.north - e.south);
  const shared = diag(ext) <= 3 * Math.max(...As.map(A => diag(A.ext)));
  let nfig = 0;
  const F_ = (src, cap) => fig(src, cap, ++nfig);
  const projects = [...new Set(As.map(A => A.entry.project))];

  let h = `<section class="cover"><div class="band"><small>Informe comparativo de escenarios</small><h1>Comparación de ${n} escenarios</h1>` +
    `<div class="sub">${projects.map(esc).join(' · ')}</div></div>` +
    `<table><thead><tr><th>Escenario</th><th>Análisis</th><th>Proyecto</th><th>Tipo</th><th>Fecha</th></tr></thead><tbody>` +
    As.map((A, i) => `<tr><td><span class="sw" style="background:${col(i)}"></span><b>${String.fromCharCode(65 + i)}</b></td><td>${esc(A.entry.name)}</td><td>${esc(A.entry.project)}</td>` +
      `<td>${ENGINE_SHORT[A.meta.engine]}</td><td>${new Date(A.entry.created * 1000).toLocaleDateString('es-AR')}</td></tr>`).join('') + `</tbody></table>`;
  progress('Mapa de ubicación…');
  h += F_(await renderMap({extent: padExtent(ext, 1.2, 0.04), basemap: 'topo', width: 1200, aspect: [0.55, 0.75],
    rects: As.map((A, i) => ({extent: {west: A.meta.domain.west, east: A.meta.domain.east, south: A.meta.domain.south, north: A.meta.domain.north}, color: col(i), width: 3, dash: i ? [10, 6] : []}))}),
  'Zonas de cálculo de los escenarios comparados (un color por escenario).') +
    `<div class="disclaimer">Escenarios exploratorios sin calibrar. La comparación muestra sensibilidades relativas entre supuestos; no constituye una zonificación de riesgo.</div></section>`;

  // ── indicadores
  h += `<h2>1. Indicadores principales</h2><table><thead><tr><th>Indicador</th>${As.map((A, i) => `<th class="n"><span class="sw" style="background:${col(i)}"></span>${String.fromCharCode(65 + i)}</th>`).join('')}</tr></thead><tbody>`;
  for (const [name, f, u, better] of KPI_ROWS) {
    const vals = As.map(A => { try { return f(A); } catch { return null; } });
    if (vals.every(v => v == null)) continue;
    const nums = vals.filter(v => typeof v === 'number');
    const hi = Math.max(...nums), lo = Math.min(...nums), differ = nums.length > 1 && hi !== lo;
    h += `<tr><td>${name}</td>${vals.map(v => {
      let cls = '';
      if (differ && better && typeof v === 'number') cls = v === (better === 'low' ? hi : lo) ? 'worst' : v === (better === 'low' ? lo : hi) ? 'best' : '';
      return `<td class="n ${cls}">${kfmt(v, u)}</td>`;
    }).join('')}</tr>`;
  }
  h += `</tbody></table><p class="note">En rojo, el escenario más desfavorable de cada indicador; en verde, el más favorable.</p>` +
    `<p>${As.map((A, i) => `<b>${String.fromCharCode(65 + i)}</b> = ${esc(A.entry.name)}`).join(' · ')}</p>`;

  // ── gráficos
  h += `<h2>2. Gráficos comparativos</h2>`;
  if (As.some(pts)) {
    h += `<h3>Edificios por grado de daño</h3>` + stackedH({rows: As.map((A, i) => ({label: label(A, i).slice(0, 34), values: pts(A) ? [4, 3, 2, 1].map(g => damageCounts(A)[g]) : [0, 0, 0, 0]})),
      cats: [4, 3, 2, 1].map(g => ({name: DAMAGE_NAMES[g], color: DAMAGE_COLORS[g]})), labelW: 230, unit: 'edificios'});
  }
  if (As.some(A => A.meta.impact)) {
    h += `<h3>Superficie por intensidad</h3>` + vgroups({cats: ['Alta', 'Media', 'Baja'], series: As.map((A, i) => ({name: label(A, i), color: col(i),
      values: ['alta', 'media', 'baja'].map(k => (lv(A, k) || 0) / 1e4)})), unit: 'hectáreas'});
  }
  h += `<div class="grid2"><div><h3>Profundidad máxima</h3>${hbars({rows: As.map((A, i) => ({label: String.fromCharCode(65 + i), value: A.meta.summary.max_depth_m, color: col(i)})), width: 340, labelW: 40, unit: 'm', fmtv: v => fmt(v, 2) + ' m'})}</div>` +
    `<div><h3>Velocidad máxima</h3>${hbars({rows: As.map((A, i) => ({label: String.fromCharCode(65 + i), value: A.meta.summary.max_speed_m_s, color: col(i)})), width: 340, labelW: 40, unit: 'm/s', fmtv: v => fmt(v, 1) + ' m/s'})}</div></div>`;
  // edificios alcanzados en el tiempo
  const curves = As.map((A, i) => ({A, i, c: arrivalCurve(A)})).filter(o => o.c);
  if (curves.length) {
    const k = Math.max(...curves.map(o => o.c.k));
    h += `<h3>Edificios alcanzados en el tiempo</h3>` + lines({series: curves.map(({A, i, c}) => ({name: label(A, i), color: col(i), pts: c.pts.map(([t, y]) => [t * c.k / k, y])})),
      xlab: k === 3600 ? 'tiempo desde el inicio (h)' : 'tiempo desde el inicio (min)', ylab: 'edificios alcanzados'});
  }
  // hidrogramas de estaciones con el mismo nombre
  const gnames = [...new Set(As.flatMap(A => (A.meta.gauges || []).map(g => g.name)))].filter(nm => As.filter(A => (A.meta.gauges || []).some(g => g.name === nm)).length > 1).slice(0, 3);
  for (const nm of gnames) {
    const ser = As.map((A, i) => ({A, i, g: (A.meta.gauges || []).find(g => g.name === nm)})).filter(o => o.g);
    const hrs = Math.max(...ser.map(o => o.g.t[o.g.t.length - 1])) > 7200, k = hrs ? 3600 : 60;
    h += `<h3>Hidrograma · ${esc(nm)}</h3>` + lines({series: ser.map(({A, i, g}) => ({name: label(A, i), color: col(i), pts: g.t.map((t, j) => [t / k, g.Q[j]])})),
      xlab: hrs ? 'tiempo (h)' : 'tiempo (min)', ylab: 'caudal (m³/s)'});
  }

  // ── mapas
  h += `<h2 class="pb">3. Mapas comparativos</h2><p>${shared ? 'Todos los mapas usan la misma extensión para que las manchas sean comparables.'
    : 'Los escenarios están en zonas distintas: cada mapa muestra su propia extensión y no se calculan envolventes.'}</p><div class="grid2">`;
  const intSt = fieldStyle('intensity', null);
  for (const [i, A] of As.entries()) {
    progress(`Mapa del escenario ${String.fromCharCode(65 + i)}…`);
    const smp = sampler(A.meta.domain, A.F.intensity), B = A.buildings || [], P = pts(A);
    const img = await renderMap({extent: shared ? ext : A.ext, width: 1000, overlays: [{colorAt: (lo, la) => intSt.color(smp(lo, la))}],
      zones: (A.meta.impact && A.meta.impact.zones || []).filter(z => z.criticality === 'Crítica'), zoneFill: false, zoneLabels: false,
      buildings: B.map((b, k) => ({lon: b.lon, lat: b.lat, r: 2.4, color: DAMAGE_COLORS[P ? damageOf(P, k) : 0]})),
      title: label(A, i).slice(0, 48), legend: n <= 2 ? intSt.legend : null});
    h += F_(img, `Escenario ${String.fromCharCode(65 + i)}: intensidad del flujo, zonas críticas (contorno bordó) y edificios según el daño.`);
  }
  h += `</div>`;
  // envolventes
  if (shared) {
    progress('Envolventes de los escenarios…');
    const smps = As.map(A => sampler(A.meta.domain, A.F.intensity));
    const envSt = fieldStyle('intensity', null), freqStops = RAMPS.arrival;
    const imgEnv = await renderMap({extent: ext, overlays: [{colorAt: (lo, la) => { let mx = 0; for (const s of smps) { const v = s(lo, la); if (v > mx) mx = v; } return envSt.color(mx); }}],
      title: 'Envolvente: intensidad máxima entre escenarios', legend: envSt.legend});
    const imgFreq = await renderMap({extent: ext, overlays: [{colorAt: (lo, la) => { let c = 0; for (const s of smps) if (s(lo, la) >= 1) c++; return c ? rampColor(freqStops, n > 1 ? (c - 1) / (n - 1) : 1) : null; }}],
      title: 'Coincidencia entre escenarios', legend: {title: 'Escenarios que alcanzan el sitio', items: Array.from({length: n}, (_, k) => ({color: rgbHex(rampColor(freqStops, n > 1 ? k / (n - 1) : 1)), label: `${k + 1} de ${n}`}))}});
    h += F_(imgEnv, 'Envolvente de intensidad: en cada sitio, la máxima intensidad alcanzada en cualquiera de los escenarios.') +
      F_(imgFreq, 'Coincidencia: cantidad de escenarios en que el flujo alcanza cada sitio. Las áreas alcanzadas en todos los escenarios son las más robustas frente a la incertidumbre de los parámetros.');
  }

  // ── edificios en común
  const keyOf = b => `${(+b.lon).toFixed(5)},${(+b.lat).toFixed(5)}`;
  const withB = As.filter(A => pts(A) && A.buildings && A.buildings.length === pts(A).intensity.length);
  if (withB.length >= 2) {
    const all = new Map();
    withB.forEach(A => A.buildings.forEach((b, k) => {
      const key = keyOf(b);
      if (!all.has(key)) all.set(key, {b, g: new Map()});
      all.get(key).g.set(A, damageOf(pts(A), k));
    }));
    const rows = [...all.values()].filter(o => [...o.g.values()].some(g => g > 0));
    const inAll = rows.filter(o => withB.every(A => (o.g.get(A) || 0) > 0)).length;
    rows.sort((a, b) => Math.max(...b.g.values()) - Math.max(...a.g.values()) || [...b.g.values()].reduce((x, y) => x + y, 0) - [...a.g.values()].reduce((x, y) => x + y, 0));
    const short = ['—', 'L', 'M', 'G', 'D'];
    h += `<h2 class="pb">4. Edificios: coincidencias y diferencias</h2>` +
      `<div class="kpis">${kpi(fmt(rows.length, 0), 'Edificios afectados en al menos un escenario', 'red')}${kpi(fmt(inAll, 0), 'Afectados en todos los escenarios', 'dark')}` +
      `${kpi(fmt(rows.filter(o => Math.max(...o.g.values()) >= 3).length, 0), 'Con daño grave o destrucción en algún escenario', 'dark')}${kpi(fmt(rows.length - inAll, 0), 'Afectados solo en algunos', 'org')}</div>` +
      `<table><thead><tr><th>Edificio</th>${withB.map(A => `<th class="n">${String.fromCharCode(65 + As.indexOf(A))}</th>`).join('')}<th class="n">Lat, lon</th></tr></thead><tbody>` +
      rows.slice(0, 400).map(o => `<tr><td>${esc(o.b.id)}</td>${withB.map(A => { const g = o.g.get(A) || 0; return `<td class="n">${g ? chip(short[g], DAMAGE_COLORS[g]) : '—'}</td>`; }).join('')}` +
        `<td class="n">${fmt(o.b.lat, 5)}, ${fmt(o.b.lon, 5)}</td></tr>`).join('') + `</tbody></table>` +
      `<p class="note">L leve · M moderado · G grave · D destrucción probable.${rows.length > 400 ? ` Se listan los 400 más afectados de ${rows.length}.` : ''}` +
      (withB.length < n ? ` ${As.filter(A => !withB.includes(A)).map(A => String.fromCharCode(65 + As.indexOf(A))).join(', ')}: sin la ubicación de los edificios (análisis anterior o sin edificios), no entra en esta comparación.` : '') + `</p>`;
  }

  // ── zonas críticas de cada escenario
  h += `<h2>${withB.length >= 2 ? 5 : 4}. Zonas más comprometidas por escenario</h2>`;
  for (const [i, A] of As.entries()) {
    const Z = (A.meta.impact && A.meta.impact.zones) || [];
    h += `<h3><span class="sw" style="background:${col(i)}"></span>${esc(label(A, i))}</h3>` + zonesTable(Z, 6);
  }

  // ── diferencias de parámetros
  const flat = As.map(A => flatten(A.params || {}));
  const keys = [...new Set(flat.flatMap(f => Object.keys(f)))].filter(k => new Set(flat.map(f => JSON.stringify(f[k] ?? null))).size > 1).sort();
  h += `<h2>${withB.length >= 2 ? 6 : 5}. Parámetros que cambian entre escenarios</h2>`;
  if (As.some(A => !A.params)) h += `<p class="note">Algunos análisis importados de versiones anteriores no guardaron sus parámetros.</p>`;
  h += keys.length ? `<table><thead><tr><th>Parámetro</th>${As.map((A, i) => `<th class="n">${String.fromCharCode(65 + i)}</th>`).join('')}</tr></thead><tbody>` +
    keys.slice(0, 80).map(k => `<tr><td>${pname(k)}</td>${flat.map(f => `<td class="n">${f[k] == null ? '—' : esc(typeof f[k] === 'number' ? fmt(f[k], 4) : f[k])}</td>`).join('')}</tr>`).join('') + `</tbody></table>`
    : '<p>Los escenarios tienen los mismos parámetros guardados.</p>';

  return shell(`Comparación de ${n} escenarios`, h, projects.join(' · '));
}
const rgbHex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// ═════════════════════════════════════════════════════════════ Visor de documentos
export class DocViewer {
  constructor(host) {
    this.el = document.createElement('div');
    this.el.id = 'docview';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="dv-head"><b class="dv-title"></b><span class="dv-stage"></span>` +
      `<button class="secondary dv-print" disabled>Imprimir / PDF</button><button class="secondary dv-open" disabled>Abrir en pestaña</button>` +
      `<button class="secondary dv-dl" disabled>Descargar HTML</button><button class="dv-close">Cerrar</button></div>` +
      `<div class="dv-body"><div class="dv-wait"><span class="dv-spin"></span><span class="dv-msg">Preparando…</span></div><iframe title="Documento"></iframe></div>`;
    host.appendChild(this.el);
    this.frame = this.el.querySelector('iframe');
    this.el.querySelector('.dv-close').onclick = () => this.close();
    this.el.querySelector('.dv-print').onclick = () => this.frame.contentWindow.print();
    this.el.querySelector('.dv-open').onclick = () => window.open(URL.createObjectURL(new Blob([this.html], {type: 'text/html'})), '_blank');
    this.el.querySelector('.dv-dl').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([this.html], {type: 'text/html'}));
      a.download = this.file + '.html';
      a.click();
    };
  }

  async show(title, file, build) {
    this.token = {};
    const token = this.token;
    this.file = file.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '').trim().replace(/\s+/g, '_') || 'informe';
    this.el.hidden = false;
    this.el.querySelector('.dv-title').textContent = title;
    this.el.querySelectorAll('.dv-head button.secondary').forEach(b => b.disabled = true);
    this.el.querySelector('.dv-wait').hidden = false;
    this.frame.hidden = true;
    const msg = t => { if (this.token === token) this.el.querySelector('.dv-msg').textContent = t; };
    try {
      const html = await build(msg);
      if (this.token !== token) return;
      this.html = html;
      this.frame.srcdoc = html;
      this.frame.hidden = false;
      this.el.querySelector('.dv-wait').hidden = true;
      this.el.querySelectorAll('.dv-head button.secondary').forEach(b => b.disabled = false);
    } catch (e) {
      console.error(e);
      msg('No se pudo generar el documento: ' + e.message);
    }
  }

  close() { this.token = null; this.el.hidden = true; this.frame.srcdoc = ''; }
}
