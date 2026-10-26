// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Inundación urbana (motor de inundación): calles pavimentadas bajo el cordón, barrios, red pluvial (si existe) y red
// cloacal que colapsan con la lluvia intensa; informe de barrios y calles afectadas.
// Backend: urbanflood.py; tablas por defecto en /api/plain/defaults (clave urban); datos de OSM en /api/urban/osm.
import {ic} from './icons.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const fmtVol = v => v == null ? '—' : v >= 1e6 ? fmt(v / 1e6, 2) + ' M m³' : fmt(v, 0) + ' m³';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const STREET_COLORS = {avenida: '#ff8c42', colectora: '#ffd166', calle: '#e9e3c9', pasaje: '#a39171'};
const HAZARD_COLORS = ['#7f8c8d', '#ffe08a', '#ffb347', '#ff7f50', '#e63946', '#9d0208', '#4a0006'];
const SEVERITY = {'Alta': '#d62828', 'Media': '#f77f00', 'Baja': '#fcbf49', 'Sin afectación': '#8ecae6'};
const r6 = c => c.map(([lo, la]) => [+lo.toFixed(6), +la.toFixed(6)]);
const prop = (p, keys) => { for (const k of keys) for (const kk of Object.keys(p)) if (kk.toLowerCase() === k && p[kk] != null && p[kk] !== '') return p[kk]; return null; };
const truthy = x => x === true || ['si', 'sí', 'yes', 'true', '1', 's'].includes(String(x).toLowerCase());
const csv = rows => 'data:text/csv;charset=utf-8,' + encodeURIComponent('﻿' + rows.map(r => r.map(x => {
  const s = x == null ? '' : String(x);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(';')).join('\n'));

function flattenGeo(gj) {
  const lines = [], polys = [], points = [];
  const geom = (g, props) => {
    if (!g) return;
    if (g.type === 'LineString') lines.push({coords: g.coordinates, props});
    else if (g.type === 'MultiLineString') g.coordinates.forEach(c => lines.push({coords: c, props}));
    else if (g.type === 'Polygon') polys.push({coords: g.coordinates[0], props});
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(c => polys.push({coords: c[0], props}));
    else if (g.type === 'Point') points.push({coords: [g.coordinates], props});
    else if (g.type === 'GeometryCollection') g.geometries.forEach(x => geom(x, props));
  };
  if (gj.type === 'FeatureCollection') gj.features.forEach(f => geom(f.geometry, f.properties || {}));
  else if (gj.type === 'Feature') geom(gj.geometry, gj.properties || {});
  else geom(gj, {});
  if ([...lines, ...polys, ...points].some(f => f.coords.some(([lo, la]) => !(Math.abs(lo) <= 180 && Math.abs(la) <= 90))))
    throw new Error('coordenadas fuera de rango: el archivo tiene que estar en WGS84 (lon/lat)');
  return {lines, polys, points};
}

export class UrbanPanel {
  constructor({api, map, body, status, getBBox, startDraw, onPreset, onPick, onToggle}) {
    Object.assign(this, {api, map, body, status, getBBox, startDraw, onPreset, onPick, onToggle});
    this.layer = L.layerGroup();
    this.resLayer = L.layerGroup();
    this.v = this.empty();
    this.pick = null;
    this.defs = null;
    this.visible = false;
    this.body.innerHTML = `<div class="hint">${ic('refresh', 16, 'spin')} Cargando tablas…</div>`;
    fetch(api + '/api/plain/defaults').then(r => r.json()).then(d => { this.defs = d.urban; this.render(); })
      .catch(e => { this.body.innerHTML = `<div class="warn">No se pudieron leer las tablas del backend: ${esc(e.message)}</div>`; });
  }

  empty() {
    return {enabled: false, curb_m: 0.15, assume_paved: true, streets: [], barrios: [], canals: [], burnCanals: true, drains: [],
      classes: {}, surface: {}, storm: {enabled: false, design_mm_h: 20, storage_mm: 5, inlet_m_per_100m: 3, direct_fraction: 0, outlet: null},
      sewer: {enabled: true, capacity_mm_h: 0.5, storage_mm: 1.5, rdii_fraction: 0.03, manhole_spacing_m: 100, lid_area_m2: 0.02, ingress_depth_m: 0.05}};
  }

  get enabled() { return this.v.enabled; }
  setEnabled(on) {
    this.v.enabled = !!on;
    this.render();
    this.onToggle && this.onToggle(this.v.enabled);
  }
  get capturesMapClicks() { return !!this.pick; }

  setVisible(on) {
    this.visible = on;
    for (const l of [this.layer, this.resLayer]) if (on) l.addTo(this.map); else l.remove();
    if (!on) this.setPick(null);
  }

  params() {
    const v = this.v;
    if (!v.enabled) return {};
    const clean = o => Object.fromEntries(Object.entries(o).filter(([, x]) => x != null && x !== '' && !(typeof x === 'number' && !isFinite(x))));
    return {urban: {
      streets: v.streets, barrios: v.barrios.map(b => clean({name: b.name, polygon: b.polygon, point: b.point, storm_drain: b.storm_drain, design_mm_h: b.design_mm_h})),
      canals: v.burnCanals ? v.canals.map(c => ({name: c.name, line: c.line, depth_m: c.depth_m ?? 1.5, width_m: c.width_m ?? 4})) : [],
      classes: v.classes, surface: v.surface, curb_m: v.curb_m, assume_paved: v.assume_paved,
      storm: clean(v.storm), sewer: clean(v.sewer),
    }};
  }

  load(p) {
    this.v = this.empty();
    const u = p.urban;
    if (u) {
      const v = this.v;
      v.enabled = true;
      for (const k of ['streets', 'barrios', 'canals']) if (u[k]) v[k] = JSON.parse(JSON.stringify(u[k]));
      for (const k of ['classes', 'surface']) if (u[k]) v[k] = {...u[k]};
      for (const k of ['curb_m', 'assume_paved']) if (u[k] != null) v[k] = u[k];
      if (u.storm) Object.assign(v.storm, Object.fromEntries(Object.entries(u.storm).filter(([, x]) => x != null)));
      if (u.sewer) Object.assign(v.sewer, Object.fromEntries(Object.entries(u.sewer).filter(([, x]) => x != null)));
    }
    this.resLayer.clearLayers();
    if (this.defs) this.render();
    this.onToggle && this.onToggle(this.v.enabled);
  }

  // ── panel
  num(obj, key, label, opts = {}) {
    const v = obj === 'root' ? this.v[key] : this.v[obj][key];
    return `<label title="${esc(opts.help || '')}">${label}<input type="number" data-up="${obj}.${key}" value="${v ?? ''}"${opts.min != null ? ` min="${opts.min}"` : ''}` +
      `${opts.max != null ? ` max="${opts.max}"` : ''} step="${opts.step || 'any'}"></label>`;
  }
  chk(obj, key, label, help = '') {
    const v = obj === 'root' ? this.v[key] : this.v[obj][key];
    return `<label class="check" title="${esc(help)}"><input type="checkbox" data-up="${obj}.${key}"${v ? ' checked' : ''}> ${label}</label>`;
  }

  render() {
    if (!this.defs) return;
    const v = this.v, D = this.defs;
    let h = `<p class="hint">Lluvia intensa sobre una ciudad: el agua de techos y patios baja a las calles pavimentadas y corre por ellas; ` +
      `las bocas de tormenta captan hasta que la red pluvial (si existe) se llena, y la cloaca, que recibe conexiones clandestinas y agua por las tapas, ` +
      `desborda por las bocas de registro más bajas. El resultado indica los <b>barrios</b> y las <b>calles</b> afectadas.</p>` +
      `<label class="check"><input type="checkbox" id="upOn"${v.enabled ? ' checked' : ''}> <b>Simular inundación urbana</b></label>`;
    if (!v.enabled) { this.body.innerHTML = h; this.bind(); this.draw(); return; }
    h += `<button class="tool" id="upPreset">${ic('urban-model')}Aplicar preset urbano</button>`;

    // calles
    const counts = {}, pv = {si: 0, no: 0, nd: 0};
    v.streets.forEach(s => { counts[s.cls] = (counts[s.cls] || 0) + 1; pv[s.paved === true ? 'si' : s.paved === false ? 'no' : 'nd']++; });
    h += `<b class="sub">Calles, barrios y desagües</b>` +
      `<div class="row"><button class="tool" id="upOsm">${ic('download')}Cargar de OSM</button>` +
      `<label class="file-btn" data-ic="upload" style="flex:1;margin:6px 0">${ic('upload')}GeoJSON<input type="file" id="upGeo" accept=".geojson,.json"></label></div>` +
      `<div class="hint">GeoJSON: líneas = calles (propiedades <code>nombre</code>, <code>clase</code> avenida/colectora/calle/pasaje, <code>pavimentada</code> sí/no) y ` +
      `polígonos o puntos = barrios (<code>nombre</code>, <code>pluvial</code> sí/no).</div>`;
    if (v.streets.length) {
      h += `<table class="basins"><tr><th></th><th>Calles</th><th>n</th><th>Ancho m</th></tr>` +
        Object.entries(D.streets).filter(([k]) => counts[k]).map(([k, c]) => {
          const o = v.classes[k] || {}, inc = o.include ?? c.include;
          return `<tr><td><input type="checkbox" data-sc="${k}" data-sk="include"${inc ? ' checked' : ''}></td>` +
            `<td><span class="sw" style="background:${STREET_COLORS[k]};margin-left:0"></span>${esc(c.name)}</td><td>${counts[k]}</td>` +
            `<td><input type="number" data-sc="${k}" data-sk="width_m" value="${o.width_m ?? c.width_m}" min="2" max="80" step="1" style="width:60px"></td></tr>`;
        }).join('') + `</table>` +
        `<div class="hint">${v.streets.length} tramos: ${pv.si} pavimentados, ${pv.no} de tierra, ${pv.nd} sin dato.</div>` +
        this.chk('root', 'assume_paved', 'Calles sin dato de superficie: pavimentadas');
    } else h += `<div class="hint">Sin calles cargadas: el agua corre sobre el DEM y las bocas se reparten en todo el barrio.</div>`;
    h += `<div class="grid2">${this.num('root', 'curb_m', 'Altura del cordón (m)', {min: 0, max: 0.5, step: 0.01, help: 'La calzada pavimentada queda esta altura por debajo de las manzanas: el agua se encauza por las calles y, al superarla, sube a veredas y viviendas.'})}</div>`;

    // barrios
    h += `<b class="sub">Barrios</b><div class="hint">Cada barrio es un sector de drenaje con su propia red. Los barrios con solo un punto (OSM) toman el área más cercana.</div>`;
    if (v.barrios.length) {
      h += `<div style="max-height:220px;overflow:auto"><table class="basins"><tr><th>Barrio</th><th title="Tiene red pluvial">Pluvial</th><th title="Capacidad de la red pluvial (mm/h)">mm/h</th><th></th></tr>` +
        v.barrios.map((b, k) => {
          const on = b.storm_drain ?? v.storm.enabled;
          return `<tr><td><input type="text" data-bn="${k}" value="${esc(b.name)}" style="width:100%">${b.polygon ? '' : '<span class="hint"> (punto)</span>'}</td>` +
            `<td><input type="checkbox" data-bs="${k}"${on ? ' checked' : ''}></td>` +
            `<td><input type="number" data-bd="${k}" value="${b.design_mm_h ?? ''}" placeholder="${fmt(v.storm.design_mm_h, 0)}" min="1" max="300" step="1" style="width:52px"${on ? '' : ' disabled'}></td>` +
            `<td><button class="tool" data-bx="${k}" style="width:auto;padding:2px 6px" title="Quitar">${ic('trash')}</button></td></tr>`;
        }).join('') + `</table></div>`;
    }
    h += `<div class="row"><input type="text" id="upBName" placeholder="Nombre del barrio" style="flex:1">` +
      `<button class="tool" id="upBDraw" style="width:auto">${ic('polygon')}Dibujar</button></div>` +
      `<div class="hint">${v.barrios.length} barrios${v.barrios.length ? ` · <a href="#" id="upBClr">quitar todos</a>` : ''} · ${v.drains.length} bocas/registros de OSM · ${v.canals.length} canales</div>` +
      (v.canals.length ? this.chk('root', 'burnCanals', 'Grabar los canales a cielo abierto en el DEM (1,5 m × 4 m)') : '');

    // red pluvial
    const S = v.storm;
    h += `<b class="sub">Red pluvial (desagües pluviales)</b>` +
      this.chk('storm', 'enabled', 'La ciudad tiene red pluvial (valor general; por barrio en la tabla)', 'Muchas ciudades no tienen desagües pluviales: el agua escurre solo por las calles.') +
      `<div class="grid2">` +
      this.num('storm', 'design_mm_h', 'Capacidad (mm/h)', {min: 1, max: 300, step: 1, help: 'Caudal que conduce la red, expresado como lluvia sobre el barrio. Redes diseñadas para 2–5 años de recurrencia: 15–40 mm/h.'}) +
      this.num('storm', 'storage_mm', 'Volumen de conductos (mm)', {min: 0, max: 100, step: 0.5}) +
      this.num('storm', 'inlet_m_per_100m', 'Bocas (m de reja c/100 m)', {min: 0, max: 50, step: 0.5, help: 'Captación como vertedero Q = 1,66·L·h^1,5.'}) +
      this.num('storm', 'direct_fraction', 'Techos conectados (0–1)', {min: 0, max: 1, step: 0.05, help: 'Fracción de la lluvia que entra directo a la red; si la red se llena, sale por los puntos bajos.'}) +
      `</div><div class="row"><button class="tool${this.pick === 'outlet' ? ' active' : ''}" id="upOutlet">${ic('pin')}Descarga de la red</button>` +
      (S.outlet ? `<button class="tool" id="upOutletClr" style="width:auto" title="Quitar">${ic('trash')}</button>` : '') + `</div>` +
      `<div class="hint">${S.outlet ? `Descarga en ${S.outlet[1].toFixed(5)}, ${S.outlet[0].toFixed(5)} (el agua vuelve a la superficie ahí: canal o río)` : 'Sin descarga marcada: la red descarga fuera de la zona.'}</div>`;

    // red cloacal
    h += `<b class="sub">Red cloacal</b>` +
      this.chk('sewer', 'enabled', 'Simular la red cloacal (colapso y desbordes)') +
      (v.sewer.enabled ? `<div class="grid2">` +
        this.num('sewer', 'capacity_mm_h', 'Capacidad libre (mm/h)', {min: 0, max: 50, step: 0.1, help: 'Lo que la cloaca puede llevar además del líquido cloacal: 1 mm/h ≈ 2,8 l/s por hectárea.'}) +
        this.num('sewer', 'storage_mm', 'Volumen (mm)', {min: 0, max: 50, step: 0.1}) +
        this.num('sewer', 'rdii_fraction', 'Conexiones pluviales (0–0,5)', {min: 0, max: 0.5, step: 0.01, help: 'Fracción de la lluvia que entra a la cloaca por conexiones clandestinas de techos y patios.'}) +
        this.num('sewer', 'manhole_spacing_m', 'Bocas de registro cada (m)', {min: 10, max: 1000, step: 10}) +
        this.num('sewer', 'lid_area_m2', 'Entrada por tapa (m²)', {min: 0, max: 1, step: 0.005}) +
        this.num('sewer', 'ingress_depth_m', 'Tirante de entrada (m)', {min: 0, max: 1, step: 0.01}) + `</div>` : '');

    // superficies
    h += `<details class="rain-soil"><summary>Superficies (CN, Manning, factor de Ks)</summary><table class="basins"><tr><th>Superficie</th><th>CN</th><th>n</th><th>×Ks</th></tr>` +
      Object.entries(D.surface).map(([k, c]) => {
        const o = v.surface[k] || {};
        const inp = (a, st) => `<input type="number" data-sf="${k}" data-sa="${a}" value="${o[a] ?? c[a]}" step="${st}" style="width:56px">`;
        return `<tr><td>${esc(c.name)}</td><td>${inp('cn', 1)}</td><td>${inp('manning', 0.005)}</td><td>${inp('ks_factor', 0.05)}</td></tr>`;
      }).join('') + `</table></details>`;
    this.body.innerHTML = h;
    this.bind();
    this.draw();
  }

  bind() {
    const B = this.body, V = this.v, q = s => B.querySelector(s);
    q('#upOn').onchange = e => this.setEnabled(e.target.checked);
    if (!V.enabled) return;
    B.querySelectorAll('[data-up]').forEach(el => el.addEventListener('change', () => {
      const [g, k] = el.dataset.up.split('.'), o = g === 'root' ? V : V[g];
      o[k] = el.type === 'checkbox' ? el.checked : el.value === '' ? null : +el.value;
      if (el.type === 'checkbox' || k === 'design_mm_h') this.render();
    }));
    q('#upPreset').onclick = () => { this.onPreset && this.onPreset(); };
    q('#upOsm').onclick = () => this.loadOSM();
    q('#upGeo').onchange = e => this.loadGeo(e.target);
    B.querySelectorAll('[data-sc]').forEach(el => el.onchange = () => {
      const o = V.classes[el.dataset.sc] = V.classes[el.dataset.sc] || {};
      o[el.dataset.sk] = el.type === 'checkbox' ? el.checked : +el.value;
      this.draw();
    });
    B.querySelectorAll('[data-bn]').forEach(el => el.onchange = () => { V.barrios[+el.dataset.bn].name = el.value; this.draw(); });
    B.querySelectorAll('[data-bs]').forEach(el => el.onchange = () => { V.barrios[+el.dataset.bs].storm_drain = el.checked; this.render(); });
    B.querySelectorAll('[data-bd]').forEach(el => el.onchange = () => { V.barrios[+el.dataset.bd].design_mm_h = el.value === '' ? null : +el.value; });
    B.querySelectorAll('[data-bx]').forEach(el => el.onclick = () => { V.barrios.splice(+el.dataset.bx, 1); this.render(); });
    const bc = q('#upBClr');
    if (bc) bc.onclick = e => { e.preventDefault(); V.barrios = []; this.render(); };
    q('#upBDraw').onclick = () => {
      const name = q('#upBName').value.trim() || `Barrio ${V.barrios.length + 1}`;
      this.startDraw(pts => { V.barrios.push({name, polygon: pts.map(ll => [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]), storm_drain: null}); this.render(); });
    };
    q('#upOutlet').onclick = () => this.setPick(this.pick === 'outlet' ? null : 'outlet');
    const oc = q('#upOutletClr');
    if (oc) oc.onclick = () => { V.storm.outlet = null; this.render(); };
    B.querySelectorAll('[data-sf]').forEach(el => el.onchange = () => {
      const o = V.surface[el.dataset.sf] = V.surface[el.dataset.sf] || {};
      o[el.dataset.sa] = +el.value;
    });
  }

  setPick(p) {
    this.pick = p;
    this.map.getContainer().classList.toggle('drawing', !!p);
    this.onPick && this.onPick(!!p);
    if (p === 'outlet') this.status('Descarga de la red pluvial: clic en el canal o río donde vuelca. Esc cancela.');
    const b = this.body.querySelector('#upOutlet');
    if (b) b.classList.toggle('active', p === 'outlet');
  }

  onMapClick(ll) {
    if (this.pick !== 'outlet') return;
    this.v.storm.outlet = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)];
    this.setPick(null);
    this.render();
  }

  // ── datos
  async loadOSM() {
    const b = this.getBBox(), btn = this.body.querySelector('#upOsm');
    btn.disabled = true; btn.innerHTML = ic('refresh', 16, 'spin') + 'Descargando…';
    try {
      const r = await fetch(this.api + '/api/urban/osm', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)});
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail));
      const V = this.v;
      V.streets = j.streets;
      V.barrios = [...V.barrios.filter(x => !x.source), ...j.barrios.map(x => ({...x, storm_drain: null}))];
      V.drains = j.drains;
      V.canals = j.canals;
      this.render();
      const c = j.counts;
      this.status(`OpenStreetMap: ${c.streets} tramos de calles (${c.paved} pavimentados, ${c.unpaved} de tierra), ${c.barrios} barrios, ` +
        `${c.drains} bocas o registros y ${c.canals} canales. Indicá en la tabla qué barrios tienen red pluvial.`);
    } catch (e) {
      this.status('No se pudieron descargar las calles: ' + e.message, true);
      btn.disabled = false; btn.innerHTML = ic('download') + 'Cargar de OSM';
    }
  }

  async loadGeo(input) {
    const f = input.files[0]; input.value = '';
    if (!f) return;
    try {
      const {lines, polys, points} = flattenGeo(JSON.parse(await f.text()));
      if (!lines.length && !polys.length && !points.length) throw new Error('no tiene geometrías');
      const cls = Object.keys(this.defs.streets);
      const streets = lines.filter(l => l.coords.length >= 2).map((l, i) => {
        let c = String(prop(l.props, ['clase', 'cls', 'categoria', 'tipo', 'highway']) || 'calle').toLowerCase();
        if (!cls.includes(c)) c = {primary: 'avenida', secondary: 'avenida', trunk: 'avenida', tertiary: 'colectora', service: 'pasaje', residential: 'calle'}[c] || 'calle';
        const p = prop(l.props, ['pavimentada', 'paved', 'pavimento', 'surface', 'superficie']);
        const paved = p == null ? null : /asphalt|asfalto|hormig|concrete|paved|adoquin/i.test(String(p)) || truthy(p);
        return {id: 'g' + i, cls: c, name: String(prop(l.props, ['nombre', 'name', 'calle']) || ''), paved, line: r6(l.coords)};
      });
      const storm = p => { const x = prop(p.props, ['pluvial', 'storm_drain', 'desague_pluvial']); return x == null ? null : truthy(x); };
      const barrios = [
        ...polys.filter(p => p.coords.length >= 4).map(p => ({name: String(prop(p.props, ['nombre', 'name', 'barrio']) || 'Barrio'), polygon: r6(p.coords.slice(0, -1)), storm_drain: storm(p)})),
        ...points.map(p => ({name: String(prop(p.props, ['nombre', 'name', 'barrio']) || 'Barrio'), point: r6(p.coords)[0], storm_drain: storm(p)})),
      ];
      this.v.streets = [...this.v.streets, ...streets];
      this.v.barrios = [...this.v.barrios, ...barrios];
      this.render();
      this.status(`${esc(f.name)}: ${streets.length} calles y ${barrios.length} barrios agregados.`);
    } catch (e) { this.status('GeoJSON inválido: ' + e.message, true); }
  }

  // ── mapa
  draw() {
    this.layer.clearLayers();
    if (!this.defs || !this.v.enabled) return;
    const ll = c => c.map(([lo, la]) => [la, lo]), V = this.v, sc = this.defs.streets;
    for (const b of V.barrios) {
      const on = b.storm_drain ?? V.storm.enabled;
      if (b.polygon) L.polygon(ll(b.polygon), {color: on ? '#3fa9f5' : '#adb5bd', weight: 1.5, dashArray: '4 3', fillOpacity: .05, interactive: true})
        .bindTooltip(`${esc(b.name)}${on ? ' · con red pluvial' : ' · sin red pluvial'}`, {sticky: true}).addTo(this.layer);
      else if (b.point) L.circleMarker([b.point[1], b.point[0]], {radius: 5, color: '#fff', weight: 1, fillColor: on ? '#3fa9f5' : '#adb5bd', fillOpacity: 1})
        .bindTooltip(esc(b.name), {permanent: false}).addTo(this.layer);
    }
    for (const s of V.streets) {
      const o = V.classes[s.cls] || {}, inc = o.include ?? (sc[s.cls] || {}).include;
      L.polyline(ll(s.line), {color: STREET_COLORS[s.cls] || '#ccc', weight: s.cls === 'avenida' ? 3 : 1.5, opacity: inc ? .85 : .2,
        dashArray: s.paved === false ? '3 3' : null, interactive: false}).addTo(this.layer);
    }
    for (const c of V.canals) L.polyline(ll(c.line), {color: '#0096c7', weight: 3, opacity: .8}).bindTooltip(esc(c.name), {sticky: true}).addTo(this.layer);
    for (const d of V.drains) L.circleMarker([d.point[1], d.point[0]], {radius: 2.5, weight: 0, fillColor: d.kind === 'cloacal' ? '#8d6e63' : '#00b4d8', fillOpacity: .9, interactive: false}).addTo(this.layer);
    if (V.storm.outlet) L.circleMarker([V.storm.outlet[1], V.storm.outlet[0]], {radius: 7, color: '#fff', weight: 2, fillColor: '#0077b6', fillOpacity: 1})
      .bindTooltip('Descarga de la red pluvial').addTo(this.layer);
  }

  showResult(meta) {
    this.resLayer.clearLayers();
    const U = meta.urban;
    if (!U) return;
    const ll = c => c.map(([lo, la]) => [la, lo]), hz = U.hazard;
    for (const b of U.barrios) {
      for (const ring of b.polygon || []) {
        if (!ring || ring.length < 3) continue;
        L.polygon(ll(ring), {color: SEVERITY[b.severity], weight: 2, fillColor: SEVERITY[b.severity], fillOpacity: b.severity === 'Sin afectación' ? .04 : .18})
          .bindTooltip(`<b>${esc(b.name)}</b> · afectación ${b.severity.toLowerCase()}<br>${fmt(b.flooded_ha, 2)} ha anegadas (${fmt(b.flooded_pct, 1)} %) · h máx. ${fmt(b.max_depth_m, 2)} m<br>` +
            `${b.streets_affected} calles afectadas${b.sewer.overflow_m3 ? ` · desborde cloacal ${fmtVol(b.sewer.overflow_m3)}` : ''}` +
            (b.storm.exists ? `<br>Red pluvial: ${b.storm.collapse_h != null ? `colapsa a las ${fmt(b.storm.collapse_h, 2)} h` : 'no colapsa'}` : '<br>Sin red pluvial'), {sticky: true}).addTo(this.resLayer);
      }
    }
    for (const s of U.segments) {
      L.polyline(ll(s.line), {color: HAZARD_COLORS[s.hazard], weight: 5, opacity: .95})
        .bindTooltip(`<b>${esc(s.name)}</b><br>h máx. ${fmt(s.max_depth_m, 2)} m · ${esc((hz.find(x => x.k === s.hazard) || {}).name || '')}`, {sticky: true}).addTo(this.resLayer);
    }
    const vmax = Math.max(1, ...U.overflows.map(o => o.volume_m3));
    for (const o of U.overflows) {
      L.circleMarker([o.point[1], o.point[0]], {radius: 3 + 7 * Math.sqrt(o.volume_m3 / vmax), color: '#fff', weight: 1,
        fillColor: o.kind === 'cloacal' ? '#6d4c41' : '#0077b6', fillOpacity: .95})
        .bindTooltip(`${o.kind === 'cloacal' ? 'Desborde cloacal' : 'Sobrecarga de la red pluvial'} · ${esc(o.barrio)}<br>${fmtVol(o.volume_m3)}`).addTo(this.resLayer);
    }
  }

  resultHTML(meta) {
    const U = meta.urban;
    if (!U) return '';
    const T = U.totals, hz = k => (U.hazard.find(x => x.k === k) || {}).name || '—';
    let h = `<div class="zone"><div class="zname">Resumen</div><table>` +
      `<tr><td>Zona urbana anegada (h &gt; 0,10 m)</td><td><b>${fmt(T.flooded_ha, 2)} ha</b> de ${fmt(T.area_ha, 0)} ha</td></tr>` +
      `<tr><td>Barrios afectados</td><td><b>${T.barrios_affected}</b> de ${U.barrios.length}</td></tr>` +
      `<tr><td>Calles afectadas</td><td><b>${T.streets_affected}</b> · ${fmt(T.streets_cordon_km, 2)} km sobre el cordón · ${fmt(T.streets_autos_km, 2)} km intransitables para autos</td></tr>` +
      (T.storm_sectors ? `<tr><td>Red pluvial</td><td>captó ${fmtVol(T.storm_captured_m3)} · colapsó en ${T.storm_collapsed} de ${T.storm_sectors} barrios${T.storm_surcharge_m3 ? ` · sobrecarga ${fmtVol(T.storm_surcharge_m3)}` : ''}</td></tr>`
        : `<tr><td>Red pluvial</td><td>no hay: el agua escurre solo por las calles</td></tr>`) +
      `<tr><td>Red cloacal</td><td>recibió ${fmtVol(T.sewer_inflow_m3)} de lluvia · colapsó en ${T.sewer_collapsed} barrios · desbordó <b>${fmtVol(T.sewer_overflow_m3)}</b></td></tr>` +
      (T.sewage_ha ? `<tr><td>Agua mezclada con líquido cloacal</td><td><b>${fmt(T.sewage_ha, 2)} ha</b> (riesgo sanitario)</td></tr>` : '') +
      `</table></div>`;

    const bRows = U.barrios.filter(b => b.severity !== 'Sin afectación');
    h += `<div class="zone"><div class="zname">Barrios afectados</div>` + (bRows.length ? `<div style="max-height:320px;overflow:auto"><table class="basins">` +
      `<tr><th>Barrio</th><th>Afect.</th><th>Anegado ha (%)</th><th>h máx. m</th><th>Calles</th><th title="Hora de colapso de la red pluvial">Pluvial</th><th title="Desborde cloacal">Cloaca</th>${bRows.some(b => b.buildings) ? '<th>Edif.</th>' : ''}</tr>` +
      bRows.map(b => `<tr><td><span class="sw" style="background:${SEVERITY[b.severity]};margin-left:0"></span>${esc(b.name)}</td><td>${b.severity}</td>` +
        `<td><b>${fmt(b.flooded_ha, 2)}</b> (${fmt(b.flooded_pct, 0)} %)</td><td>${fmt(b.max_depth_m, 2)}</td><td>${b.streets_affected}</td>` +
        `<td>${b.storm.exists ? (b.storm.collapse_h != null ? `colapsa ${fmt(b.storm.collapse_h, 1)} h` : 'no colapsa') : 'no hay'}</td>` +
        `<td>${b.sewer.exists ? (b.sewer.overflow_m3 ? fmtVol(b.sewer.overflow_m3) : 'sin desborde') : '—'}</td>` +
        (bRows.some(x => x.buildings) ? `<td>${b.buildings_wet} / ${b.buildings}</td>` : '') + `</tr>`).join('') +
      `</table></div>` + bRows.map(b => b.streets.length ? `<details><summary>${esc(b.name)}: calles afectadas</summary><div class="hint">${b.streets.map(esc).join(' · ')}` +
        `${b.streets_affected > b.streets.length ? ` y ${b.streets_affected - b.streets.length} más` : ''}</div></details>` : '').join('')
      : `<div class="hint">Ningún barrio con agua sobre 0,10 m.</div>`) + `</div>`;

    h += `<div class="zone"><div class="zname">Calles afectadas</div>` + (U.streets.length ? `<div style="max-height:320px;overflow:auto"><table class="basins">` +
      `<tr><th>Calle</th><th>Barrios</th><th>&gt; cordón km</th><th>&gt; 0,3 km</th><th>h máx. m</th><th>Peligro</th><th>Desde</th></tr>` +
      U.streets.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.barrios.join(', ') || '—')}</td><td><b>${fmt(s.cordon_km, 2)}</b></td><td>${fmt(s.autos_km, 2)}</td>` +
        `<td>${fmt(s.max_depth_m, 2)}</td><td title="${esc(hz(s.hazard))}"><span class="sw" style="background:${HAZARD_COLORS[s.hazard]};margin-left:0"></span>H${s.hazard}</td>` +
        `<td>${s.first_s != null ? fmt(s.first_s / 3600, 1) + ' h' : '—'}</td></tr>`).join('') + `</table></div>`
      : `<div class="hint">Ninguna calle con agua sobre el cordón.</div>`) + `</div>`;

    const cb = csv([['Barrio', 'Afectación', 'Superficie ha', 'Anegado ha', 'Anegado %', 'h > 0,3 m ha', 'h máx m', 'Peligro', 'Duración media h', 'Primer anegamiento h',
      'Calles afectadas', 'km de calle afectados', 'Red pluvial', 'Colapso pluvial h', 'Desborde cloacal m3', 'Colapso cloacal h', 'Agua cloacal ha', 'Edificios afectados', 'Edificios', 'Calles'],
      ...U.barrios.map(b => [b.name, b.severity, b.area_ha, b.flooded_ha, b.flooded_pct, b.deep_ha, b.max_depth_m, 'H' + b.hazard, b.mean_wet_h, b.first_h, b.streets_affected, b.streets_km,
        b.storm.exists ? 'sí' : 'no', b.storm.collapse_h, b.sewer.overflow_m3, b.sewer.collapse_h, b.sewage_ha, b.buildings_wet, b.buildings, b.streets.join(', ')])]);
    const cs = csv([['Calle', 'Categoría', 'Barrios', 'Largo km', 'Pavimentada km', 'Sobre el cordón km', 'Intransitable autos km', 'Intransitable todo vehículo km', 'h máx m', 'v máx m/s', 'Peligro', 'Primer anegamiento h'],
      ...U.streets.map(s => [s.name, s.cls, s.barrios.join(', '), s.km, s.paved_km, s.cordon_km, s.autos_km, s.todos_km, s.max_depth_m, s.max_speed_m_s, hz(s.hazard), s.first_s != null ? +(s.first_s / 3600).toFixed(2) : ''])]);
    h += `<div class="row"><a class="tool" download="barrios_afectados.csv" href="${cb}">${ic('download')}Barrios (CSV)</a>` +
      `<a class="tool" download="calles_afectadas.csv" href="${cs}">${ic('download')}Calles (CSV)</a></div>` +
      `<div class="hint">En el mapa: barrios por afectación, tramos de calle con agua sobre el cordón por peligrosidad (H1–H6) y puntos de desborde ` +
      `(marrón: cloacal; azul: red pluvial). ${esc(U.criteria)}</div>`;
    return `<div class="impact"><b>Inundación urbana: barrios y calles afectadas</b>${h}</div>`;
  }
}
