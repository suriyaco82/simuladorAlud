// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Llanura (motor de inundación): depresiones del terreno, infiltración continua con saturación del suelo, caudales
// que entran por el borde, caminos con terraplén y alcantarillas (OSM o GeoJSON) y uso del suelo (CN, Manning).
// Backend: flood.py, roads.py, landcover.py; tablas por defecto en /api/plain/defaults.
import {ic} from './icons.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const fmtVol = v => v == null ? '—' : v >= 1e6 ? fmt(v / 1e6, 2) + ' M m³' : fmt(v, 0) + ' m³';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ROAD_COLORS = {autopista: '#ff4d6d', primaria: '#ff8c42', secundaria: '#ffd166', terciaria: '#e9e3c9', vecinal: '#c8b6a6', huella: '#a39171', ferrocarril: '#b388eb'};
const DEPRESSIONS = {
  carve: 'Abrir salida a los pozos (montaña; como antes)',
  keep: 'Conservar bajos y lagunas (llanura)',
  shallow: 'Rellenar solo pozos chicos (artefactos del DEM)',
};

// hidrograma de forma gamma: Q(t) = Qb + (Qp − Qb)·[(t/tp)·e^(1 − t/tp)]^m
export function gammaHydrograph(qb, qp, tp, dur, m = 3.7, n = 48) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = dur * k / n, r = t / Math.max(tp, 1e-3);
    out.push([+t.toFixed(3), +(qb + (qp - qb) * Math.pow(r * Math.exp(1 - r), m)).toFixed(2)]);
  }
  return out;
}

// GeoJSON → listas de líneas y de anillos exteriores, con sus propiedades
function flattenGeo(gj) {
  const lines = [], polys = [];
  const geom = (g, props) => {
    if (!g) return;
    if (g.type === 'LineString') lines.push({coords: g.coordinates, props});
    else if (g.type === 'MultiLineString') g.coordinates.forEach(c => lines.push({coords: c, props}));
    else if (g.type === 'Polygon') polys.push({coords: g.coordinates[0], props});
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(c => polys.push({coords: c[0], props}));
    else if (g.type === 'GeometryCollection') g.geometries.forEach(x => geom(x, props));
  };
  if (gj.type === 'FeatureCollection') gj.features.forEach(f => geom(f.geometry, f.properties || {}));
  else if (gj.type === 'Feature') geom(gj.geometry, gj.properties || {});
  else geom(gj, {});
  const bad = [...lines, ...polys].some(f => f.coords.some(([lo, la]) => !(Math.abs(lo) <= 180 && Math.abs(la) <= 90)));
  if (bad) throw new Error('coordenadas fuera de rango: el archivo tiene que estar en WGS84 (lon/lat)');
  return {lines, polys};
}
const r6 = c => c.map(([lo, la]) => [+lo.toFixed(6), +la.toFixed(6)]);
// valor de una propiedad buscando varios nombres posibles
const prop = (p, keys) => { for (const k of keys) for (const kk of Object.keys(p)) if (kk.toLowerCase() === k && p[kk] != null && p[kk] !== '') return p[kk]; return null; };

export class PlainPanel {
  constructor({api, map, sec, body, status, getBBox, startDraw, onPreset, onChange, onPick}) {
    Object.assign(this, {api, map, sec, body, status, getBBox, startDraw, onPreset, onChange, onPick});
    this.layer = L.layerGroup();
    this.resLayer = L.layerGroup();
    this.v = this.empty();
    this.pick = null;  // {kind: 'inflow' | 'culvert', k, pts}
    this.luCls = 'cultivo';
    this.defs = null;
    this.body.innerHTML = `<div class="hint">${ic('refresh', 16, 'spin')} Cargando tablas…</div>`;
    fetch(api + '/api/plain/defaults').then(r => r.json()).then(d => { this.defs = d; this.render(); })
      .catch(e => { this.body.innerHTML = `<div class="warn">No se pudieron leer las tablas del backend: ${esc(e.message)}</div>`; });
  }

  empty() {
    return {
      flood: {depressions: 'carve', pit_depth_m: 0.5, rain_outside: false, dt_max: 10},
      infiltration: {method: 'scs', texture: 'franco', initial_saturation: 0.5, evaporation_mm_day: 0},
      inflows: [],
      roads: {items: [], classes: {}, culverts: []},
      landuse: {worldcover: false, polygons: [], classes: {}},
    };
  }

  get capturesMapClicks() { return !!this.pick; }
  // sin cuencas delineadas: en llanura se llueve sobre toda la zona
  get skipBasins() { return !!this.v.flood.rain_outside; }

  setVisible(on) {
    for (const l of [this.layer, this.resLayer]) if (on) l.addTo(this.map); else l.remove();
    if (!on) this.setPick(null);
  }

  // ── parámetros para /api/simulate y /api/basins
  params() {
    const v = this.v, clean = o => Object.fromEntries(Object.entries(o).filter(([, x]) => x != null && x !== '' && !(typeof x === 'number' && !isFinite(x))));
    const out = {flood: clean(v.flood)};
    if (out.flood.depressions !== 'shallow') delete out.flood.pit_depth_m;
    if (v.infiltration.method === 'green_ampt' || v.infiltration.evaporation_mm_day > 0) out.infiltration = clean(v.infiltration);
    const inf = v.inflows.filter(q => q.section && q.section.length === 2 && q.hydrograph.length >= 2);
    if (inf.length) out.inflows = inf.map(q => ({name: q.name, section: q.section, hydrograph: q.hydrograph}));
    if (v.roads.items.length || v.roads.culverts.length) out.roads = {items: v.roads.items, classes: v.roads.classes, culverts: v.roads.culverts};
    if (v.landuse.worldcover || v.landuse.polygons.length) out.landuse = {worldcover: v.landuse.worldcover, polygons: v.landuse.polygons, classes: v.landuse.classes};
    return out;
  }

  load(p) {
    this.v = this.empty();
    const fl = p.flood || {};
    for (const k of ['depressions', 'pit_depth_m', 'rain_outside', 'dt_max']) if (fl[k] != null) this.v.flood[k] = fl[k];
    if (p.infiltration) Object.assign(this.v.infiltration, p.infiltration);
    if (p.inflows) this.v.inflows = JSON.parse(JSON.stringify(p.inflows)).map(q => ({...q, gen: q.gen || {}}));
    if (p.roads) Object.assign(this.v.roads, {items: p.roads.items || [], classes: p.roads.classes || {}, culverts: p.roads.culverts || []});
    if (p.landuse) Object.assign(this.v.landuse, {worldcover: !!p.landuse.worldcover, polygons: p.landuse.polygons || [], classes: p.landuse.classes || {}});
    this.resLayer.clearLayers();
    if (this.defs) this.render();
  }

  // ── preset de llanura
  applyPreset() {
    const v = this.v;
    Object.assign(v.flood, {depressions: 'keep', rain_outside: true, dt_max: 20});
    Object.assign(v.infiltration, {method: 'green_ampt', texture: v.infiltration.texture && v.infiltration.texture !== 'franco' ? v.infiltration.texture : 'franco_limoso',
      initial_saturation: 0.7, water_table_m: v.infiltration.water_table_m ?? 1.5, evaporation_mm_day: 4});
    this.onPreset && this.onPreset();
    this.render();
    this.status('Preset de llanura aplicado: bajos conservados, lluvia en toda la zona, infiltración Green-Ampt con napa, sin procesos de montaña. Revisá la tormenta (lluvia de varios días) y cargá caminos y caudales de entrada.');
  }

  // ── panel
  num(path, label, opts = {}) {
    const [g, k] = path.split('.'), v = this.v[g][k];
    return `<label title="${esc(opts.help || '')}">${label}<input type="number" data-pp="${path}" value="${v ?? ''}"${opts.min != null ? ` min="${opts.min}"` : ''}` +
      `${opts.max != null ? ` max="${opts.max}"` : ''} step="${opts.step || 'any'}"${opts.ph ? ` placeholder="${esc(opts.ph)}"` : ''}></label>`;
  }
  sel(path, label, options, help = '') {
    const [g, k] = path.split('.'), v = this.v[g][k];
    return `<label title="${esc(help)}">${label}<select data-pp="${path}">${Object.entries(options).map(([a, b]) => `<option value="${a}"${v === a ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select></label>`;
  }
  chk(path, label, help = '') {
    const [g, k] = path.split('.');
    return `<label class="check" title="${esc(help)}"><input type="checkbox" data-pp="${path}"${this.v[g][k] ? ' checked' : ''}> ${label}</label>`;
  }

  render() {
    if (!this.defs) return;
    const v = this.v, D = this.defs, inf = v.infiltration, tex = D.textures[inf.texture] || D.textures.franco;
    const ga = inf.method === 'green_ampt';
    let h = `<p class="hint">Para campos y caminos que se anegan por desborde de ríos y por saturación del suelo. ` +
      `<b>Preset llanura</b> configura todo de una vez; los procesos de montaña (aludes, deslizamientos, bloques) quedan apagados.</p>` +
      `<button class="tool" id="ppPreset">${ic('layers')}Aplicar preset llanura</button>`;

    h += `<b class="sub">Terreno</b>` +
      this.sel('flood.depressions', 'Depresiones del DEM', DEPRESSIONS, 'En llanura, los bajos y lagunas sin salida son los que se inundan: conservarlos evita que el modelo los drene con cortes artificiales.') +
      (v.flood.depressions === 'shallow' ? this.num('flood.pit_depth_m', 'Profundidad máx. a rellenar (m)', {min: 0.05, max: 20, step: 0.05}) : '') +
      this.chk('flood.rain_outside', 'Llover en toda la zona (no hace falta delinear cuencas)', 'En terreno plano las cuencas están mal definidas: la lluvia cae sobre toda la zona de cálculo.') +
      `<div class="grid2">${this.num('flood.dt_max', 'Paso máx. (s)', {min: 1, max: 60, step: 1, help: 'Paso de tiempo máximo. Más alto acelera simulaciones de varios días (el CFL lo limita igual).'})}</div>`;

    h += `<b class="sub">Infiltración y saturación del suelo</b>` +
      this.sel('infiltration.method', 'Método', {scs: 'SCS-CN sobre la lluvia (como antes)', green_ampt: 'Green-Ampt continuo (llanura)'},
        'Green-Ampt infiltra también el agua estancada o desbordada, hasta que el suelo se satura hasta la napa.');
    if (ga) {
      h += this.sel('infiltration.texture', 'Textura del suelo', Object.fromEntries(Object.entries(D.textures).map(([k, t]) => [k, t.name])), 'Rawls, Brakensiek y Miller (1983)') +
        `<div class="grid2">` +
        this.num('infiltration.ks_mm_h', 'Ks (mm/h)', {min: 0.01, max: 500, ph: fmt(tex.ks_mm_h, 1), help: 'Conductividad saturada; vacío = la de la textura'}) +
        this.num('infiltration.suction_mm', 'Succión ψ (mm)', {min: 1, max: 2000, ph: fmt(tex.suction_mm, 0)}) +
        this.num('infiltration.porosity', 'Porosidad efectiva', {min: 0.05, max: 0.7, step: 0.01, ph: fmt(tex.porosity, 3)}) +
        this.num('infiltration.initial_saturation', 'Saturación inicial (0–1)', {min: 0, max: 1, step: 0.05, help: 'Humedad del suelo antes del evento: tras semanas de lluvia, 0,7–0,9.'}) +
        this.num('infiltration.water_table_m', 'Napa freática (m)', {min: 0.05, max: 50, step: 0.1, ph: 'sin límite', help: 'Profundidad de la napa: el suelo se satura cuando lo infiltrado llena los poros hasta ella.'}) +
        this.num('infiltration.evaporation_mm_day', 'Evaporación (mm/día)', {min: 0, max: 20, step: 0.5}) + `</div>`;
      const th = inf.porosity || tex.porosity, se = inf.initial_saturation ?? 0.5;
      if (inf.water_table_m) h += `<div class="hint">El suelo admite ≈ <b>${fmt(th * (1 - se) * inf.water_table_m * 1000, 0)} mm</b> antes de saturarse hasta la napa.</div>`;
    } else {
      h += `<div class="grid2">${this.num('infiltration.evaporation_mm_day', 'Evaporación (mm/día)', {min: 0, max: 20, step: 0.5})}</div>`;
    }

    // entradas de caudal
    h += `<b class="sub">Caudales que entran por el borde</b><div class="hint">Crecida de un río que viene de aguas arriba de la zona. Marcá una sección a través del cauce (dos clics) y cargá el hidrograma.</div>`;
    v.inflows.forEach((q, k) => {
      const g = q.gen || {}, peak = q.hydrograph.length ? Math.max(...q.hydrograph.map(r => r[1])) : null;
      h += `<div class="zone"><div class="row"><input type="text" data-inf="${k}" data-ik="name" value="${esc(q.name)}" style="flex:1">` +
        `<button class="tool${this.pick && this.pick.kind === 'inflow' && this.pick.k === k ? ' active' : ''}" data-inf-pick="${k}" style="width:auto">${ic('line')}Sección</button>` +
        `<button class="tool" data-inf-del="${k}" style="width:auto" title="Quitar">${ic('trash')}</button></div>` +
        `<div class="hint">${q.section ? 'Sección marcada' : '<span style="color:#f4b64c">Falta marcar la sección</span>'} · ${q.hydrograph.length} puntos · pico ${fmt(peak, 0)} m³/s</div>` +
        `<div class="grid2"><label>Q base (m³/s)<input type="number" data-gen="${k}" data-gk="qb" value="${g.qb ?? 10}" min="0"></label>` +
        `<label>Q pico (m³/s)<input type="number" data-gen="${k}" data-gk="qp" value="${g.qp ?? 200}" min="0"></label>` +
        `<label>Hora del pico (h)<input type="number" data-gen="${k}" data-gk="tp" value="${g.tp ?? 12}" min="0.1" step="0.5"></label>` +
        `<label>Duración (h)<input type="number" data-gen="${k}" data-gk="dur" value="${g.dur ?? 48}" min="0.5" step="1"></label></div>` +
        `<button class="tool" data-gen-run="${k}">${ic('graph-time-series')}Generar hidrograma</button>` +
        `<label>Hidrograma (h ; m³/s por línea; se puede pegar de una planilla)<textarea data-inf-hy="${k}" rows="4">${q.hydrograph.map(r => `${r[0]} ; ${r[1]}`).join('\n')}</textarea></label></div>`;
    });
    h += `<button class="tool" id="ppAddInf">${ic('plus')}Agregar entrada de caudal</button>`;

    // caminos
    const R = v.roads, rc = {...D.roads};
    const counts = {};
    R.items.forEach(r => { counts[r.cls] = (counts[r.cls] || 0) + 1; });
    h += `<b class="sub">Caminos, vías y alcantarillas</b><div class="hint">Los terraplenes (0,5–2 m) frenan o desvían el agua y el DEM no los ve: se levantan sobre el terreno según su categoría. Las alcantarillas comunican ambos lados.</div>` +
      `<div class="row"><button class="tool" id="ppOsm">${ic('download')}Cargar de OSM</button>` +
      `<label class="file-btn" data-ic="upload" style="flex:1;margin:6px 0">${ic('upload')}GeoJSON<input type="file" id="ppRoadsGeo" accept=".geojson,.json"></label></div>`;
    if (R.items.length) {
      h += `<table class="basins"><tr><th></th><th>Categoría</th><th>n</th><th>Terraplén m</th><th>Ancho m</th></tr>` +
        Object.entries(rc).filter(([k]) => counts[k]).map(([k, c]) => {
          const o = R.classes[k] || {}, inc = o.include ?? c.include;
          return `<tr><td><input type="checkbox" data-rc="${k}" data-rk="include"${inc ? ' checked' : ''}></td>` +
            `<td><span class="sw" style="background:${ROAD_COLORS[k]};margin-left:0"></span>${esc(c.name)}</td><td>${counts[k]}</td>` +
            `<td><input type="number" data-rc="${k}" data-rk="embankment_m" value="${o.embankment_m ?? c.embankment_m}" min="0" max="10" step="0.1" style="width:60px"></td>` +
            `<td><input type="number" data-rc="${k}" data-rk="width_m" value="${o.width_m ?? c.width_m}" min="1" max="100" step="1" style="width:60px"></td></tr>`;
        }).join('') + `</table>`;
    }
    h += `<div class="hint">${R.items.length ? `${R.items.length} tramos (${R.items.filter(r => r.bridge).length} puentes, sin terraplén)` : 'Sin caminos cargados'} · ${R.culverts.length} alcantarillas</div>` +
      `<div class="row"><button class="tool${this.pick && this.pick.kind === 'culvert' ? ' active' : ''}" id="ppCulv">${ic('pin')}Agregar alcantarilla</button>` +
      `<button class="tool" id="ppRoadsClr">${ic('trash')}Quitar todo</button></div>` +
      (R.culverts.length ? `<div class="grid2"><label>Diámetro de las alcantarillas (m)<input type="number" id="ppCulvD" value="${R.culverts[R.culverts.length - 1].diameter_m}" min="0.2" max="10" step="0.1"></label></div>` : '');

    // uso del suelo
    const LU = v.landuse;
    h += `<b class="sub">Uso del suelo</b><div class="hint">Define CN, rugosidad de Manning e infiltración por celda. Los polígonos tienen prioridad sobre WorldCover.</div>` +
      this.chk('landuse.worldcover', 'ESA WorldCover 10 m (automático, sin clave)') +
      `<div class="row"><label class="file-btn" data-ic="upload" style="flex:1;margin:6px 0">${ic('upload')}Polígonos GeoJSON<input type="file" id="ppLuGeo" accept=".geojson,.json"></label></div>` +
      `<div class="row"><select id="ppLuCls" style="flex:1">${Object.entries(D.landuse).map(([k, c]) => `<option value="${k}"${k === this.luCls ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` +
      `<button class="tool" id="ppLuDraw" style="width:auto">${ic('polygon')}Dibujar</button></div>` +
      `<div class="hint">${LU.polygons.length} polígonos${LU.polygons.length ? ` <a href="#" id="ppLuClr">quitar</a>` : ''}. GeoJSON: propiedad <code>clase</code> (cultivo, pastura, monte, arbustal, desnudo, urbano, agua, humedal).</div>` +
      `<details class="rain-soil"><summary>Valores por clase (CN, Manning, factor de Ks)</summary><table class="basins"><tr><th>Clase</th><th>CN</th><th>n</th><th>×Ks</th></tr>` +
      Object.entries(D.landuse).map(([k, c]) => {
        const o = LU.classes[k] || {};
        const inp = (a, st) => `<input type="number" data-lc="${k}" data-lk="${a}" value="${o[a] ?? c[a]}" step="${st}" style="width:56px">`;
        return `<tr><td><span class="sw" style="background:${c.color};margin-left:0"></span>${esc(c.name)}</td><td>${inp('cn', 1)}</td><td>${inp('manning', 0.005)}</td><td>${inp('ks_factor', 0.05)}</td></tr>`;
      }).join('') + `</table></details>`;
    this.body.innerHTML = h;
    this.bind();
    this.draw();
  }

  bind() {
    const B = this.body, V = this.v, q = s => B.querySelector(s);
    B.querySelectorAll('[data-pp]').forEach(el => el.addEventListener('change', () => {
      const [g, k] = el.dataset.pp.split('.');
      if (el.type === 'checkbox') V[g][k] = el.checked;
      else if (el.tagName === 'SELECT') V[g][k] = el.value;
      else V[g][k] = el.value === '' ? null : +el.value;
      if (['method', 'texture', 'depressions', 'water_table_m', 'initial_saturation', 'porosity'].includes(k)) this.render();
      this.onChange && this.onChange();
    }));
    q('#ppPreset').onclick = () => this.applyPreset();
    // entradas de caudal
    q('#ppAddInf').onclick = () => {
      V.inflows.push({name: `Entrada ${V.inflows.length + 1}`, section: null, hydrograph: gammaHydrograph(10, 200, 12, 48), gen: {qb: 10, qp: 200, tp: 12, dur: 48}});
      this.render();
      this.setPick({kind: 'inflow', k: V.inflows.length - 1, pts: []});
    };
    B.querySelectorAll('[data-inf]').forEach(el => el.onchange = () => { V.inflows[+el.dataset.inf][el.dataset.ik] = el.value; });
    B.querySelectorAll('[data-inf-pick]').forEach(el => el.onclick = () => {
      const k = +el.dataset.infPick;
      this.setPick(this.pick && this.pick.kind === 'inflow' && this.pick.k === k ? null : {kind: 'inflow', k, pts: []});
    });
    B.querySelectorAll('[data-inf-del]').forEach(el => el.onclick = () => { V.inflows.splice(+el.dataset.infDel, 1); this.setPick(null); this.render(); });
    B.querySelectorAll('[data-gen]').forEach(el => el.onchange = () => { const qq = V.inflows[+el.dataset.gen]; qq.gen = {...qq.gen, [el.dataset.gk]: +el.value}; });
    B.querySelectorAll('[data-gen-run]').forEach(el => el.onclick = () => {
      const k = +el.dataset.genRun, qq = V.inflows[k], g = {qb: 10, qp: 200, tp: 12, dur: 48, ...qq.gen};
      if (!(g.dur > 0 && g.tp > 0 && g.qp >= g.qb)) { this.status('Hidrograma: el pico tiene que ser ≥ el caudal base y la duración y la hora del pico, positivas.', true); return; }
      qq.hydrograph = gammaHydrograph(g.qb, g.qp, g.tp, g.dur);
      this.render();
    });
    B.querySelectorAll('[data-inf-hy]').forEach(el => el.onchange = () => {
      const rows = el.value.split(/\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(/[;\t]|\s+|,(?=\s)/).filter(Boolean).map(x => +x.replace(',', '.')));
      const ok = rows.filter(r => r.length >= 2 && isFinite(r[0]) && isFinite(r[1]) && r[1] >= 0);
      if (ok.length < 2) { this.status('Hidrograma: hacen falta al menos dos filas «horas ; m³/s».', true); return; }
      V.inflows[+el.dataset.infHy].hydrograph = ok.map(r => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
      this.render();
    });
    // caminos
    q('#ppOsm').onclick = () => this.loadOSM();
    q('#ppRoadsGeo').onchange = e => this.loadRoadsGeo(e.target);
    B.querySelectorAll('[data-rc]').forEach(el => el.onchange = () => {
      const k = el.dataset.rc, o = V.roads.classes[k] = V.roads.classes[k] || {};
      o[el.dataset.rk] = el.type === 'checkbox' ? el.checked : +el.value;
      this.draw();
    });
    q('#ppCulv').onclick = () => this.setPick(this.pick && this.pick.kind === 'culvert' ? null : {kind: 'culvert'});
    q('#ppRoadsClr').onclick = () => { V.roads = {items: [], classes: {}, culverts: []}; this.setPick(null); this.render(); };
    const cd = q('#ppCulvD');
    if (cd) cd.onchange = () => { V.roads.culverts.forEach(c => { if (c.user) c.diameter_m = +cd.value; }); };
    // uso del suelo
    q('#ppLuGeo').onchange = e => this.loadLanduseGeo(e.target);
    q('#ppLuCls').onchange = e => { this.luCls = e.target.value; };
    q('#ppLuDraw').onclick = () => this.startDraw(pts => {
      V.landuse.polygons.push({name: this.defs.landuse[this.luCls].name, cls: this.luCls, polygon: pts.map(ll => [+ll.lng.toFixed(6), +ll.lat.toFixed(6)])});
      this.render();
    });
    const lc = q('#ppLuClr');
    if (lc) lc.onclick = e => { e.preventDefault(); V.landuse.polygons = []; this.render(); };
    B.querySelectorAll('[data-lc]').forEach(el => el.onchange = () => {
      const k = el.dataset.lc, o = V.landuse.classes[k] = V.landuse.classes[k] || {};
      o[el.dataset.lk] = +el.value;
    });
  }

  // ── clics en el mapa
  setPick(p) {
    this.pick = p;
    this.map.getContainer().classList.toggle('drawing', !!p);
    this.onPick && this.onPick(!!p);
    if (this.preview) { this.preview.remove(); this.preview = null; }
    if (p && p.kind === 'inflow') this.status(`Entrada de caudal: clic en una margen del cauce y luego en la otra (la sección tiene que cruzar todo el cauce). Esc cancela.`);
    if (p && p.kind === 'culvert') this.status('Alcantarilla: clic sobre el camino, donde el agua lo cruza por debajo. Esc termina.');
    if (this.defs) {
      this.body.querySelectorAll('[data-inf-pick]').forEach(el => el.classList.toggle('active', !!p && p.kind === 'inflow' && p.k === +el.dataset.infPick));
      const c = this.body.querySelector('#ppCulv');
      if (c) c.classList.toggle('active', !!p && p.kind === 'culvert');
    }
  }

  onMapClick(ll) {
    const p = this.pick;
    if (!p) return;
    const pt = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)];
    if (p.kind === 'culvert') {
      const d = this.v.roads.culverts.length ? this.v.roads.culverts[this.v.roads.culverts.length - 1].diameter_m : 1.0;
      this.v.roads.culverts.push({point: pt, diameter_m: d, count: 1, name: `Alcantarilla ${this.v.roads.culverts.length + 1}`, user: true});
      this.render();
      this.setPick({kind: 'culvert'});
      return;
    }
    p.pts.push(pt);
    if (p.pts.length === 1) {
      this.preview = L.circleMarker([ll.lat, ll.lng], {radius: 4, color: '#3fa9f5'}).addTo(this.map);
      return;
    }
    this.v.inflows[p.k].section = p.pts.slice(0, 2);
    this.setPick(null);
    this.render();
    this.status('Sección de entrada marcada. Revisá el hidrograma.');
  }

  // ── caminos
  async loadOSM() {
    const b = this.getBBox(), btn = this.body.querySelector('#ppOsm');
    btn.disabled = true; btn.innerHTML = ic('refresh', 16, 'spin') + 'Descargando…';
    try {
      const r = await fetch(this.api + '/api/roads/osm', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)});
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail));
      this.v.roads.items = j.roads;
      this.v.roads.culverts = [...this.v.roads.culverts.filter(c => c.user), ...j.culverts];
      this.render();
      this.status(`OpenStreetMap: ${j.roads.length} tramos de caminos y vías, ${j.culverts.length} alcantarillas. Revisá la altura de terraplén de cada categoría.`);
    } catch (e) {
      this.status('No se pudieron descargar los caminos: ' + e.message, true);
      btn.disabled = false; btn.innerHTML = ic('download') + 'Cargar de OSM';
    }
  }

  async loadRoadsGeo(input) {
    const f = input.files[0]; input.value = '';
    if (!f) return;
    try {
      const {lines} = flattenGeo(JSON.parse(await f.text()));
      if (!lines.length) throw new Error('no tiene líneas');
      const cls = Object.keys(this.defs.roads);
      const items = lines.filter(l => l.coords.length >= 2).map((l, i) => {
        let c = String(prop(l.props, ['clase', 'cls', 'categoria', 'tipo', 'highway']) || 'vecinal').toLowerCase();
        if (!cls.includes(c)) c = {motorway: 'autopista', trunk: 'autopista', primary: 'primaria', secondary: 'secundaria', tertiary: 'terciaria', track: 'huella', rail: 'ferrocarril'}[c] || 'vecinal';
        return {id: 'g' + i, cls: c, name: String(prop(l.props, ['nombre', 'name', 'ref']) || ''), bridge: !!prop(l.props, ['puente', 'bridge']), line: r6(l.coords)};
      });
      this.v.roads.items = [...this.v.roads.items, ...items];
      this.render();
      this.status(`${items.length} caminos agregados desde ${esc(f.name)}.`);
    } catch (e) { this.status('GeoJSON de caminos inválido: ' + e.message, true); }
  }

  async loadLanduseGeo(input) {
    const f = input.files[0]; input.value = '';
    if (!f) return;
    try {
      const {polys} = flattenGeo(JSON.parse(await f.text()));
      if (!polys.length) throw new Error('no tiene polígonos');
      const L_ = this.defs.landuse, keys = Object.keys(L_);
      let unk = 0;
      const items = polys.filter(p => p.coords.length >= 4).map(p => {
        const raw = String(prop(p.props, ['clase', 'cls', 'uso', 'cobertura', 'class']) || '').toLowerCase();
        let c = keys.find(k => raw === k || raw.includes(k) || L_[k].name.toLowerCase().includes(raw) && raw.length > 2);
        if (!c) { c = this.luCls; unk++; }
        return {name: String(prop(p.props, ['nombre', 'name']) || L_[c].name), cls: c, polygon: r6(p.coords.slice(0, -1))};
      });
      this.v.landuse.polygons = [...this.v.landuse.polygons, ...items];
      this.render();
      this.status(`${items.length} polígonos de uso del suelo agregados${unk ? ` (${unk} sin clase reconocida: se les asignó «${L_[this.luCls].name}»)` : ''}.`);
    } catch (e) { this.status('GeoJSON de uso del suelo inválido: ' + e.message, true); }
  }

  // ── mapa
  draw() {
    this.layer.clearLayers();
    if (!this.defs) return;
    const ll = c => c.map(([lo, la]) => [la, lo]), V = this.v;
    for (const z of V.landuse.polygons) {
      const c = this.defs.landuse[z.cls];
      L.polygon(ll(z.polygon), {color: c.color, weight: 1, fillColor: c.color, fillOpacity: .18, interactive: false}).addTo(this.layer);
    }
    const rc = this.defs.roads;
    for (const r of V.roads.items) {
      const o = V.roads.classes[r.cls] || {}, inc = o.include ?? (rc[r.cls] || {}).include;
      L.polyline(ll(r.line), {color: ROAD_COLORS[r.cls] || '#ccc', weight: r.bridge ? 4 : r.cls === 'huella' ? 1.2 : 2, opacity: inc ? .9 : .25,
        dashArray: r.bridge ? '2 4' : null}).bindTooltip(`${esc((rc[r.cls] || {}).name || r.cls)}${r.name ? ' · ' + esc(r.name) : ''}${r.bridge ? ' · puente' : ''}`, {sticky: true}).addTo(this.layer);
    }
    for (const c of V.roads.culverts) {
      L.circleMarker([c.point[1], c.point[0]], {radius: 4, color: '#fff', weight: 1, fillColor: '#00b4d8', fillOpacity: 1})
        .bindTooltip(`${esc(c.name)} · Ø ${fmt(c.diameter_m, 2)} m`).addTo(this.layer);
    }
    for (const q of V.inflows) {
      if (!q.section) continue;
      L.polyline(ll(q.section), {color: '#3fa9f5', weight: 5, opacity: .9}).bindTooltip(`${esc(q.name)} · pico ${fmt(Math.max(...q.hydrograph.map(r => r[1])), 0)} m³/s`).addTo(this.layer);
    }
  }

  // ── resultados
  showResult(meta) {
    this.resLayer.clearLayers();
    const R = meta.roads;
    if (R && R.cuts) for (const c of R.cuts) {
      L.polyline(c.line.map(([lo, la]) => [la, lo]), {color: c.max_depth_m > 0.6 ? '#9d0208' : '#e85d04', weight: 6, opacity: .9})
        .bindTooltip(`Camino cortado${c.name ? ' · ' + esc(c.name) : ''}<br>${fmt(c.km, 2)} km · h máx. ${fmt(c.max_depth_m, 2)} m` +
          (c.first_cut_s != null ? `<br>desde las ${fmt(c.first_cut_s / 3600, 1)} h` : ''), {sticky: true}).addTo(this.resLayer);
    }
  }

  resultHTML(meta) {
    const f = meta.flood || {}, t = f.totals || {}, R = meta.roads, LU = meta.landuse;
    let h = '';
    if (t.infiltration_method === 'green_ampt' || t.inflow_m3 || t.evaporation_m3 || t.culvert_m3) {
      const gi = f.infiltration;
      h += `<div class="zone"><div class="zname">Balance de agua (llanura)</div><table>` +
        `<tr><td>Lluvia + entradas</td><td>${fmtVol(t.rain_m3)} + ${fmtVol(t.inflow_m3)}</td></tr>` +
        `<tr><td>Infiltrado${t.infiltration_method === 'green_ampt' ? ' (Green-Ampt)' : ''}</td><td>${fmtVol(t.infiltration_m3)}</td></tr>` +
        (t.evaporation_m3 ? `<tr><td>Evaporado</td><td>${fmtVol(t.evaporation_m3)}</td></tr>` : '') +
        `<tr><td>Salió / queda en superficie</td><td>${fmtVol(t.outflow_m3)} / ${fmtVol(t.stored_m3)}</td></tr>` +
        (t.culvert_m3 ? `<tr><td>Pasó por alcantarillas</td><td>${fmtVol(t.culvert_m3)}</td></tr>` : '') +
        (t.saturated_area_km2 != null ? `<tr><td>Suelo saturado hasta la napa</td><td>${fmt(t.saturated_area_km2, 2)} km²</td></tr>` : '') +
        `<tr><td>Anegado más de 24 h</td><td>${fmt(t.flooded_24h_km2, 2)} km²</td></tr>` +
        (gi ? `<tr><td class="sub">Suelo</td><td>${esc((this.defs && this.defs.textures[gi.texture] || {}).name || gi.texture)} · Ks ${fmt(gi.ks_mm_h, 1)} mm/h · Se₀ ${fmt(gi.initial_saturation, 2)}${gi.water_table_m ? ` · napa ${fmt(gi.water_table_m, 1)} m (${fmt(gi.storage_mm, 0)} mm)` : ''}</td></tr>` : '') +
        `</table>` + (f.inflows || []).map(q => `<div class="hint">Entrada «${esc(q.name)}»: pico ${fmt(q.q_peak, 0)} m³/s · ${fmtVol(q.volume_m3)}</div>`).join('') + `</div>`;
    }
    if (R && R.classes.length) {
      const T = R.totals;
      h += `<div class="zone"><div class="zname">Caminos anegados</div><table class="basins"><tr><th>Categoría</th><th>km</th><th>&gt; 0,15</th><th>&gt; 0,3</th><th>&gt; 0,6</th></tr>` +
        R.classes.map(c => `<tr><td><span class="sw" style="background:${ROAD_COLORS[c.cls]};margin-left:0"></span>${esc(c.name)}</td><td>${fmt(c.km, 1)}</td>` +
          `<td>${fmt(c.precaucion_km, 1)}</td><td><b>${fmt(c.livianos_km, 1)}</b></td><td>${fmt(c.todos_km, 1)}</td></tr>`).join('') +
        `<tr><td><b>Total</b></td><td><b>${fmt(T.km, 1)}</b></td><td>${fmt(T.precaucion_km, 1)}</td><td><b>${fmt(T.livianos_km, 1)}</b></td><td>${fmt(T.todos_km, 1)}</td></tr></table>` +
        `<div class="hint">km con agua sobre la calzada por encima de 0,15 m (precaución), 0,3 m (intransitable para autos) y 0,6 m (para todo vehículo); ` +
        `${fmt(T.over_24h_km, 1)} km anegados más de 24 h. En el mapa, los tramos cortados (&gt; 0,3 m). ${esc(R.criteria)}</div></div>`;
    }
    if (LU && LU.classes.length) {
      h += `<div class="zone"><div class="zname">Campos y uso del suelo anegados</div><table class="basins"><tr><th>Clase</th><th>ha</th><th>anegadas</th><th>&gt; 24 h</th><th>&gt; 72 h</th></tr>` +
        LU.classes.map(c => `<tr><td><span class="sw" style="background:${c.color};margin-left:0"></span>${esc(c.name)}</td><td>${fmt(c.area_ha, 0)}</td>` +
          `<td><b>${fmt(c.flooded_ha, 0)}</b> (${fmt(c.flooded_pct, 0)} %)</td><td>${fmt(c.over_24h_ha, 0)}</td><td>${fmt(c.over_72h_ha, 0)}</td></tr>`).join('') +
        `</table><div class="hint">${esc(LU.criteria)}.</div></div>`;
    }
    return h ? `<div class="impact"><b>Llanura: suelo, caminos y campos</b>${h}</div>` : '';
  }
}
