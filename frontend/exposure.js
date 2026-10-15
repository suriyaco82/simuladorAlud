// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Exposición: zonas urbanas y edificios (mapa + 3D), panel de impacto y ejemplos precargados.
import * as THREE from 'three';
import {DAMAGE_COLORS, DAMAGE_NAMES} from './palette.js';

export const INTENSITY_COLORS = {0: '#d9d4c7', 1: '#ffe066', 2: '#ff9f1c', 3: '#d62828'};
const NAMES = {1: 'baja', 2: 'media', 3: 'alta'};
const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const ha = m2 => fmt(m2 / 1e4, 1) + ' ha';
const fmtT = s => s == null ? '—' : s < 120 ? fmt(s, 0) + ' s' : fmt(s / 60, 1) + ' min';

export async function listExamples() {
  const r = await fetch('examples/index.json');
  return r.ok ? r.json() : [];
}
export async function fetchExample(file) {
  const r = await fetch('examples/' + file);
  if (!r.ok) throw new Error('No se pudo leer el ejemplo ' + file);
  return r.json();
}

// Edificios como objetos {id, lon, lat, area, levels, height, hsrc, use, structure, notes, src}.
// Los ejemplos originales los guardan como [lon, lat, área, pisos] (OpenStreetMap).
export function normBuildings(ex) {
  const raw = ex.buildings || (ex.params.exposure_points || []).map(q => [q[0], q[1], 60, null]);
  return raw.map((b, i) => Array.isArray(b)
    ? {id: 'b' + (i + 1), lon: b[0], lat: b[1], area: b[2], levels: b[3] ?? null, height: null, src: 'OSM'}
    : {...b, id: b.id || 'b' + (i + 1)});
}
// altura usada para el impacto: medida (campo o GBA) o estimada por pisos (3 m c/u); null = sin dato
export const buildingHeight = b => b.height > 0 ? b.height : b.levels > 0 ? b.levels * 3 : null;

// lo que le pasa al edificio i según el resultado (exposure.points del backend)
export function buildingImpact(pts, i) {
  if (!pts || i >= pts.intensity.length) return null;
  const pick = k => pts[k] ? pts[k][i] : null;
  return {intensity: pts.intensity[i], damage: pick('damage') ?? pts.intensity[i], depth: pick('depth_m'), speed: pick('speed_m_s'),
    pressure: pick('pressure_kPa'), arrival: pts.arrival_s[i] >= 0 ? pts.arrival_s[i] : null};
}
export const damageChip = g => `<span class="dmg" style="background:${DAMAGE_COLORS[g]};color:${g >= 3 ? '#fff' : '#1b1b1b'}">${DAMAGE_NAMES[g]}</span>`;

export function buildingHTML(b, r) {
  const h = buildingHeight(b);
  const rows = [
    ['Altura', h ? `${fmt(h, 1)} m${b.height > 0 ? '' : ' (estimada por pisos)'}` : 'sin dato'],
    ['Superficie', b.area ? `${fmt(b.area, 0)} m²` : '—'],
    b.use ? ['Uso', b.use] : null, b.structure ? ['Estructura', b.structure] : null,
    ['Fuente', b.src || '—'],
  ].filter(Boolean);
  if (r) rows.unshift(
    ['Intensidad', ['sin afectación', 'baja', 'media', 'alta'][r.intensity] || '—'],
    ['Profundidad máx.', r.depth != null ? fmt(r.depth, 2) + ' m' : '—'],
    ['Velocidad máx.', r.speed != null ? fmt(r.speed, 1) + ' m/s' : '—'],
    ['Presión dinámica', r.pressure != null ? fmt(r.pressure, 0) + ' kPa' : '—'],
    ['Llegada del flujo', r.arrival != null ? fmtT(r.arrival) : 'no llega']);
  return `<div class="pop"><div class="pop-h"><b>Edificio ${b.id}</b>${r ? damageChip(r.damage) : ''}</div>` +
    `<table>${rows.map(([a, v]) => `<tr><td>${a}</td><td>${v}</td></tr>`).join('')}</table>` +
    (b.notes ? `<p class="hint">${b.notes}</p>` : '') + `<div class="hint">${fmt(b.lat, 5)}, ${fmt(b.lon, 5)}</div></div>`;
}

export class Exposure {
  constructor(map, world) {
    this.map = map;
    this.world = world;
    this.layer = L.layerGroup().addTo(map);
    // los edificios van sobre las zonas de afectación para poder tocarlos
    if (!map.getPane('buildingsPane')) map.createPane('buildingsPane').style.zIndex = 450;
    this.renderer = L.canvas({padding: 0.3, pane: 'buildingsPane'});
    this.example = null;
    this.markers = [];
    this.mesh = null;
    this.result = null;
  }

  get active() { return !!this.example; }

  // edificios sin ejemplo cargado (p. ej. GlobalBuildingAtlas en una zona libre): se agregan al escenario actual
  setBuildings(list) {
    const ex = this.example || {id: '_libre', title: '', params: {}, free: true};
    ex.buildings = list;
    delete ex.params.exposure_points;
    this.set(ex);
  }

  set(example) {
    this.clear();
    this.example = example;
    const p = example.params;
    for (const z of p.exposure || []) {
      L.polygon(z.polygon.map(([lo, la]) => [la, lo]), {color: '#3fd0e0', weight: 2, fillOpacity: 0.06, interactive: false})
        .bindTooltip(z.name, {sticky: true}).addTo(this.layer);
    }
    // elementos del escenario en cascada
    for (const bd of p.bodies || []) {
      const water = bd.kind === 'water';
      L.polygon(bd.polygon.map(([lo, la]) => [la, lo]), {color: water ? '#3fa9f5' : '#e8f4f8', weight: 2, dashArray: water ? null : '5 4', fillOpacity: water ? 0.12 : 0.25, interactive: false})
        .bindTooltip(bd.name, {sticky: true}).addTo(this.layer);
    }
    for (const dm of p.dams || []) {
      L.polyline(dm.line.map(([lo, la]) => [la, lo]), {color: '#f2f2f2', weight: 6, opacity: .95, interactive: false})
        .bindTooltip(`${dm.name}: coronamiento ${dm.crest_m} m`, {sticky: true}).addTo(this.layer);
      for (const sp of dm.spillways || []) {
        // tramo del vertedero sobre el eje del muro
        const pts = dm.line, seg = [];
        for (let k = 0; k < pts.length - 1; k++) seg.push(Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]));
        const tot = seg.reduce((a, b) => a + b, 0), at = f => { let d = f * tot, k = 0; while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; } const u = seg[k] ? d / seg[k] : 0; return [pts[k][1] + (pts[k + 1][1] - pts[k][1]) * u, pts[k][0] + (pts[k + 1][0] - pts[k][0]) * u]; };
        L.polyline([at(sp.from_frac), at((sp.from_frac + sp.to_frac) / 2), at(sp.to_frac)], {color: '#3fa9f5', weight: 6, interactive: false})
          .bindTooltip(`Vertedero: cresta ${sp.crest_m} m`, {sticky: true}).addTo(this.layer);
      }
    }
    if (p.breach) L.polyline(p.breach.line.map(([lo, la]) => [la, lo]), {color: '#ff8a3d', weight: 5, opacity: .85, interactive: false})
      .bindTooltip(p.breach.target_m != null ? `Rotura del muro hasta ${p.breach.target_m} m, desde t = ${p.breach.start_s} s en ${Math.round(p.breach.duration_s)} s`
        : `Brecha: ${p.breach.depth_m} m, desde t = ${p.breach.start_s} s durante ${Math.round(p.breach.duration_s / 60)} min`, {sticky: true}).addTo(this.layer);
    for (const g of p.gauges || []) {
      L.polyline(g.section.map(([lo, la]) => [la, lo]), {color: '#ffffff', weight: 3, interactive: false}).addTo(this.layer);
      const [lo, la] = g.section[1];
      L.marker([la, lo], {icon: L.divIcon({className: 'gauge-label', html: '▮ ' + g.name.split(' (')[0].replace('Río Fitz Roy, ', ''), iconSize: null})}).addTo(this.layer);
    }
    const b = example.buildings = normBuildings(example);
    this.buildings = b;
    this.markers = b.map(({lon: lo, lat: la}, i) => L.circleMarker([la, lo], {renderer: this.renderer, radius: 2.2, weight: 0, fillOpacity: .9, fillColor: INTENSITY_COLORS[0], bubblingMouseEvents: false})
      .on('click', () => this.openBuilding(i)).addTo(this.layer));
  }

  openBuilding(i, zoom = false) {
    const b = this.buildings && this.buildings[i];
    if (!b) return;
    if (zoom) this.map.setView([b.lat, b.lon], Math.max(this.map.getZoom(), 17));
    L.popup({maxWidth: 320, className: 'bld-popup'}).setLatLng([b.lat, b.lon])
      .setContent(buildingHTML(b, buildingImpact(this.result && this.result.points, i))).openOn(this.map);
  }

  clear() {
    this.layer.clearLayers();
    this.markers = [];
    this.example = null;
    this.buildings = null;
    this.result = null;
    this.disposeMesh();
  }

  // parámetros del ejemplo que no están en el formulario (cuerpos, lago, brecha, cauces, aforos, exposición…)
  params() {
    if (!this.example) return {};
    const p = this.example.params, out = {};
    const formManaged = new Set(['bbox', 'release_polygon', 'source_lon', 'source_lat', 'pore_ratio_initial', 'dem_fallback', 'exposure_points', 'exposure_heights']);
    for (const [k, v] of Object.entries(p)) {
      if (formManaged.has(k) || document.querySelector(`[data-param="${k}"]`)) continue;
      out[k] = v;
    }
    // los edificios (editados o de GBA) definen los puntos expuestos, en el mismo orden que los marcadores
    if (this.buildings && this.buildings.length) {
      out.exposure_points = this.buildings.map(b => [b.lon, b.lat]);
      out.exposure_heights = this.buildings.map(buildingHeight);
    }
    return out;
  }

  get bodies() { return (this.example && this.example.params.bodies) || null; }

  // ── resultados
  applyResult(meta) {
    const ex = meta.exposure;
    this.result = ex && ex.points ? ex : null;
    // los marcadores del mapa se pintan con el tiempo (update3D), no con el estado final
    this.markerState = new Int8Array(this.markers.length).fill(-1);
    this.shown = -2;
    return this.panelHTML(meta);
  }

  gaugesHTML(meta) {
    const G = meta.gauges || [];
    if (!G.length) return '';
    const W = 290, H = 110, pad = 26;
    const tMax = Math.max(...G.map(g => g.t[g.t.length - 1] || 1));
    const qMax = Math.max(1, ...G.flatMap(g => g.Q.concat(g.Q_scs || [])));
    const hrs = tMax > 7200, ft = t => hrs ? `${fmt(t / 3600, 2)} h` : `${fmt(t / 60, 1)} min`;
    const cols = ['#3fa9f5', '#ffd166', '#ef476f'];
    const px = t => pad + (W - pad - 6) * t / tMax, py = q => H - 16 - (H - 26) * q / qMax;
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="hydro"><line x1="${pad}" y1="${H - 16}" x2="${W - 4}" y2="${H - 16}" stroke="#3a5566"/>` +
      `<line x1="${pad}" y1="6" x2="${pad}" y2="${H - 16}" stroke="#3a5566"/>` +
      `<text x="${pad - 3}" y="12" text-anchor="end">${qMax >= 1000 ? fmt(qMax / 1000, 1) + 'k' : fmt(qMax, 0)}</text><text x="${pad - 3}" y="${H - 16}" text-anchor="end">0</text>` +
      `<text x="${W - 4}" y="${H - 3}" text-anchor="end">${hrs ? fmt(tMax / 3600, 1) + ' h' : fmt(tMax / 60, 0) + ' min'}</text><text x="${pad}" y="${H - 3}">0</text>`;
    G.forEach((g, k) => {
      if (g.Q_scs) svg += `<polyline fill="none" stroke="${cols[k % 3]}" stroke-width="1" stroke-dasharray="3 2" opacity=".8" points="${g.t.map((t, i) => `${px(t).toFixed(1)},${py(g.Q_scs[i]).toFixed(1)}`).join(' ')}"/>`;
      svg += `<polyline fill="none" stroke="${cols[k % 3]}" stroke-width="1.6" points="${g.t.map((t, i) => `${px(t).toFixed(1)},${py(g.Q[i]).toFixed(1)}`).join(' ')}"/>`;
    });
    svg += '</svg>';
    let rows = '';
    G.forEach((g, k) => {
      const iq = g.Q.indexOf(Math.max(...g.Q)), arr = g.t.find((t, i) => g.h[i] > 0.5);
      rows += `<tr><td><span class="sw" style="background:${cols[k % 3]};margin-left:0"></span>${g.name}</td><td>${fmt(g.Q[iq], 0)} m³/s · ${ft(g.t[iq])}</td></tr>` +
        (g.Q_scs ? `<tr><td class="sub">pico SCS (punteado)</td><td>${fmt(Math.max(...g.Q_scs), 0)} m³/s</td></tr>` : '') +
        `<tr><td class="sub">llegada (h > 0,5 m) · h máx. · v máx.${g.cv ? ' · Cv máx.' : ''}</td><td>${arr != null ? ft(arr) : '—'} · ${fmt(Math.max(...g.h), 1)} m · ${fmt(Math.max(...g.v), 1)} m/s${g.cv ? ' · ' + fmt(Math.max(...g.cv), 2) : ''}</td></tr>`;
    });
    return `<div class="zone"><div class="zname">Hidrogramas (estaciones virtuales)</div>${svg}<table><tr><td></td><td><b>Caudal pico · tiempo</b></td></tr>${rows}</table>` +
      `<div class="hint">Q = Σ h·v·ancho a través de la sección. ${meta.engine === 'flood'
        ? 'Tiempos desde el inicio de la lluvia. Punteado: hidrograma SCS (método agregado) en la misma salida, para comparar con el 2D.'
        : 'Tiempos desde el inicio del colapso.'}</div></div>`;
  }

  panelHTML(meta) {
    const ex = meta.exposure;
    const gauges = this.gaugesHTML(meta);
    if (!ex || (!ex.zones.length && !ex.points)) return gauges ? `<div class="impact"><b>Resultados del escenario</b>${gauges}</div>` : '';
    let h = `<div class="impact"><b>Impacto${meta.scenario_name ? ' · ' + meta.scenario_name : ''}</b>` + gauges;
    for (const z of ex.zones) {
      const pct = fmt(z.affected_fraction * 100, 0);
      h += `<div class="zone"><div class="zname">${z.name}</div>` +
        `<div class="bar">${[3, 2, 1].map(k => { const a = z.area_by_intensity_m2[NAMES[k]]; return a > 0 ? `<i style="width:${a / z.area_m2 * 100}%;background:${INTENSITY_COLORS[k]}" title="${NAMES[k]}: ${ha(a)}"></i>` : ''; }).join('')}</div>` +
        `<table>` +
        `<tr><td>Superficie afectada</td><td>${ha(z.affected_area_m2)} (${pct}% de ${ha(z.area_m2)})</td></tr>` +
        `<tr><td>Intensidad alta / media / baja</td><td>${ha(z.area_by_intensity_m2.alta)} / ${ha(z.area_by_intensity_m2.media)} / ${ha(z.area_by_intensity_m2.baja)}</td></tr>` +
        `<tr><td>Primer arribo</td><td>${z.first_arrival_s != null ? fmtT(z.first_arrival_s) : 'no llega'}</td></tr>` +
        (z.depth_p50_p90_m ? `<tr><td>Profundidad p50 / p90 / máx.</td><td>${fmt(z.depth_p50_p90_m[0])} / ${fmt(z.depth_p50_p90_m[1])} / ${fmt(z.max_depth_m)} m</td></tr>` +
          `<tr><td>Velocidad p50 / p90</td><td>${fmt(z.speed_p50_p90_m_s[0])} / ${fmt(z.speed_p50_p90_m_s[1])} m/s</td></tr>` +
          `<tr><td>Presión dinámica p50 / p90</td><td>${fmt(z.pressure_p50_p90_kPa[0], 0)} / ${fmt(z.pressure_p50_p90_kPa[1], 0)} kPa</td></tr>` : '') +
        `<tr><td>Material depositado en la zona</td><td>${fmt(z.deposit_volume_m3 / 1e3, 0)} mil m³</td></tr>` +
        `</table></div>`;
    }
    if (ex.points) {
      const p = ex.points, c = p.counts;
      const ta = p.arrival_s.filter(t => t >= 0).sort((a, b) => a - b), med = ta.length ? ta[Math.floor(ta.length / 2)] : null;
      const srcs = [...new Set((this.buildings || []).map(b => (b.src || '').split(':')[0]).filter(Boolean))].join(' + ');
      h += `<div class="zone"><div class="zname">Edificios${srcs ? ' (' + srcs + ')' : ''}</div><table>` +
        `<tr><td>Alcanzados</td><td><b>${fmt(p.affected, 0)}</b> de ${fmt(p.total, 0)} (${fmt(p.affected / p.total * 100, 0)}%)</td></tr>` +
        `<tr><td><span class="sw" style="background:${INTENSITY_COLORS[3]};margin-left:0"></span>Intensidad alta</td><td>${fmt(c.alta, 0)}</td></tr>` +
        `<tr><td><span class="sw" style="background:${INTENSITY_COLORS[2]};margin-left:0"></span>Intensidad media</td><td>${fmt(c.media, 0)}</td></tr>` +
        `<tr><td><span class="sw" style="background:${INTENSITY_COLORS[1]};margin-left:0"></span>Intensidad baja</td><td>${fmt(c.baja, 0)}</td></tr>` +
        (p.damage_counts ? `<tr><td colspan="2" class="sub" style="padding-left:0;padding-top:6px">Grado de daño estimado</td></tr>` +
          [4, 3, 2, 1].map(g => `<tr><td><span class="sw" style="background:${DAMAGE_COLORS[g]};margin-left:0"></span>${DAMAGE_NAMES[g]}</td><td>${fmt(p.damage_counts[DAMAGE_NAMES[g]], 0)}</td></tr>`).join('') : '') +
        `<tr><td>Primer edificio alcanzado</td><td>${fmtT(p.first_arrival_s)}</td></tr>` +
        `<tr><td>50% de los alcanzados, antes de</td><td>${fmtT(med)}</td></tr>` +
        (p.with_height ? `<tr><td>Flujo ≥ mitad de la altura</td><td>${fmt(p.half_height, 0)}</td></tr>` +
          `<tr><td>Flujo ≥ altura del edificio</td><td><b>${fmt(p.overtopped, 0)}</b></td></tr>` +
          `<tr><td class="sub">con altura conocida (campo, GBA o pisos)</td><td>${fmt(p.with_height, 0)} de ${fmt(p.total, 0)}</td></tr>` : '') +
        `</table></div>`;
    }
    h += meta.engine === 'flood'
      ? `<div class="hint">Intensidad en cada edificio, según el flujo que lo alcanza. Crecida de agua (Cv &lt; 0,2): alta si h &gt; 2 m o h·v &gt; 2 m²/s; media si h &gt; 0,5 m o h·v &gt; 0,5 m²/s; baja con h &gt; 0,1 m. Barro y detritos (Cv ≥ 0,2), según Hürlimann et al. (2008): alta si h ≥ 1 m y v ≥ 1 m/s; media, una de las dos; baja, el resto. Los tiempos se cuentan desde el inicio de la lluvia.</div></div>`
      : `<div class="hint">Intensidad para flujos de detritos (Hürlimann et al., 2008): alta h ≥ 1 m y v ≥ 1 m/s; media, una de las dos; baja, el resto. Presión dinámica ≈ ρ·v². Los tiempos se cuentan desde el inicio del desprendimiento.</div></div>`;
    return h;
  }

  // ── edificios 3D
  disposeMesh() {
    if (this.mesh) { this.world.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh = null; }
  }

  build3D(result, bedAt) {
    this.disposeMesh();
    if (!this.buildings || !this.buildings.length) return;
    const d = result.meta.domain, n = this.buildings.length;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({roughness: .8, metalness: 0}), n);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    const hDef = (this.example && this.example.building_defaults && this.example.building_defaults.height_m) || 6;
    this.inst = this.buildings.map(b => {
      const x = (b.lon - d.west) * d.mx, y = (b.lat - d.south) * d.my;
      const s = Math.min(40, Math.max(4, Math.sqrt(b.area || 60)));
      return {x, y, s, h: buildingHeight(b) || hDef, z: bedAt(x, y), inside: x >= 0 && y >= 0 && x <= d.Lx && y <= d.Ly};
    });
    this.world.add(this.mesh);
    this.shown = -2;
  }

  layout3D(exag) {
    if (!this.mesh) return;
    const m = new THREE.Matrix4();
    this.inst.forEach((b, i) => {
      // la altura del edificio no se exagera: se compensa la escala vertical del grupo
      m.makeScale(b.inside ? b.s : 0, b.inside ? b.s : 0, b.inside ? b.h / exag : 0);
      m.setPosition(b.x, b.y, b.z);
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // colores en el tiempo: un edificio toma el color de su intensidad cuando el flujo lo alcanza
  update3D(t) {
    const pts = this.result && this.result.points, c = new THREE.Color();
    const key = pts ? Math.floor(t * 2) : -1;
    if (key === this.shown) return;
    this.shown = key;
    const n = this.inst ? this.inst.length : this.markers.length;
    const sameMarkers = pts && this.markers.length === pts.intensity.length;
    for (let i = 0; i < n; i++) {
      const hit = pts && pts.arrival_s[i] >= 0 && pts.arrival_s[i] <= t ? pts.intensity[i] : 0;
      if (this.mesh) this.mesh.setColorAt(i, c.set(INTENSITY_COLORS[hit]));
      if (sameMarkers && this.markerState[i] !== hit) {
        this.markerState[i] = hit;
        this.markers[i].setStyle({fillColor: INTENSITY_COLORS[hit], radius: hit ? 3 : 2.2});
      }
    }
    if (this.mesh) this.mesh.instanceColor.needsUpdate = true;
  }
}
