// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Desencadenante por lluvia: panel con la lluvia acumulada y el suelo de la zona de búsqueda,
// y vista previa en el mapa de lo que se desprende (modelo del backend: talud infinito + SHALSTAB).
import {ic} from './icons.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

// [clave, etiqueta, mín, máx, paso, valor por defecto, ayuda]; los de lluvia van con deslizador
const RAIN = [
  ['rain_mm', 'Lluvia acumulada (mm)', 0, 600, 5, 150, 'Lluvia total del período. Lo que satura el suelo es la lluvia acumulada repartida en los días del período (mm/día).'],
  ['days', 'Días del período', 1, 15, 1, 3, 'Duración del episodio de lluvia. Con la misma lluvia total, menos días = más intensidad diaria = más saturación.'],
  ['melt_mm', 'Deshielo (mm de agua)', 0, 300, 5, 0, 'Agua de fusión de nieve en el mismo período (lluvia sobre nieve). Se suma a la lluvia.'],
];
const SOIL = [
  ['infiltration', 'Infiltración (0–1)', 0.05, 1, 0.05, 0.7, 'Fracción de la lluvia que entra al suelo; el resto escurre en superficie.'],
  ['soil_depth_m', 'Espesor del suelo (m)', 0.5, 30, 0.5, 6, 'Espesor vertical de till, morena o coluvio sobre la superficie de rotura. Es el espesor que se desprende.'],
  ['cohesion_kpa', "Cohesión c' (kPa)", 0, 100, 1, 5, 'Cohesión efectiva (incluye raíces). Till consolidado: 5–20 kPa; coluvio suelto: 0–5 kPa.'],
  ['friction_angle_deg', "Fricción φ' (°)", 20, 50, 0.5, 35, 'Ángulo de fricción efectivo del suelo. Till y morenas: 36–42°.'],
  ['transmissivity_m2_day', 'Transmisividad (m²/día)', 1, 300, 1, 20, 'Capacidad del suelo saturado de conducir agua ladera abajo. Más baja = se satura antes.'],
  ['initial_saturation', 'Saturación previa (0–1)', 0, 1, 0.05, 0.3, 'Humedad del suelo antes del episodio. Afecta el peso del suelo.'],
  ['max_slope_deg', 'Pendiente máx. con suelo (°)', 25, 90, 1, 50, 'Por encima de esta pendiente se asume roca desnuda (no hay suelo que se deslice).'],
  ['channel_area_m2', 'Área de cauce (m²)', 1000, 200000, 1000, 20000, 'Celdas con más área de aporte son cauces (agua superficial sobre roca), no ladera.'],
];

export class RainPanel {
  constructor({api, map, sec, body, getExample, getParams, onZone, startDraw, status}) {
    Object.assign(this, {api, map, sec, body, getExample, getParams, onZone, startDraw, status});
    this.layer = L.layerGroup().addTo(map);
    this.renderer = L.canvas({padding: 0.3});
    this.timer = null;
    this.seq = 0;
  }

  // índice del primer cuerpo con desencadenante por lluvia
  get target() {
    const ex = this.getExample();
    const B = ex && ex.params.bodies;
    if (!B) return null;
    const k = B.findIndex(b => b.rain && b.kind !== 'water');
    return k < 0 ? null : {k, b: B[k], ex};
  }

  refresh() {
    const t = this.target;
    this.sec.hidden = !t;
    this.layer.clearLayers();
    if (!t) return;
    const r = t.b.rain;
    const field = ([k, lab, mn, mx, st, def, help], slider) => {
      const v = r[k] ?? def;
      return `<label title="${esc(help)}">${lab}${slider ? ` <output data-out="${k}">${fmt(v, 2)}</output>` : ''}` +
        (slider ? `<input type="range" data-rain="${k}" min="${mn}" max="${mx}" step="${st}" value="${v}">` : '') +
        `<input type="number" data-rain="${k}" min="${mn}" max="${mx}" step="${st}" value="${v}"${slider ? ' class="rain-num"' : ''}></label>`;
    };
    this.body.innerHTML =
      `<p class="hint">El polígono <b>${esc(t.b.name)}</b> es la zona de búsqueda: el volumen no es fijo, lo calcula la lluvia. ` +
      `Fallan las celdas de la ladera con factor de seguridad &lt; 1 (talud infinito + SHALSTAB, Montgomery y Dietrich 1994).</p>` +
      RAIN.map(f => field(f, true)).join('') +
      `<details class="rain-soil"><summary>Suelo de la ladera</summary><div class="grid2">${SOIL.map(f => field(f, false)).join('')}</div></details>` +
      `<div class="row"><button class="tool" id="rainDraw">${ic('polygon')}Dibujar zona</button><button class="tool" id="rainZoom">${ic('zoom-to-object')}Ver zona</button></div>` +
      `<button class="tool" id="rainPreview">${ic('refresh')}Calcular volumen</button>` +
      `<div class="rain-res" id="rainRes"></div>`;
    this.body.querySelectorAll('[data-rain]').forEach(el => el.addEventListener('input', () => {
      const k = el.dataset.rain, v = +el.value;
      if (el.value === '' || !isFinite(v)) return;
      r[k] = v;
      this.body.querySelectorAll(`[data-rain="${k}"]`).forEach(o => { if (o !== el) o.value = v; });
      const out = this.body.querySelector(`[data-out="${k}"]`);
      if (out) out.value = fmt(v, 2);
      this.schedule();
    }));
    this.body.querySelector('#rainPreview').onclick = () => this.preview();
    this.body.querySelector('#rainZoom').onclick = () => this.map.fitBounds(L.polygon(t.b.polygon.map(([lo, la]) => [la, lo])).getBounds(), {padding: [30, 30]});
    this.body.querySelector('#rainDraw').onclick = () => this.startDraw(pts => {
      t.b.polygon = pts.map(ll => [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]);
      this.onZone();
      this.preview();
    });
    this.preview();
  }

  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.preview(), 700); }

  async preview() {
    const t = this.target;
    if (!t) return;
    const res = this.body.querySelector('#rainRes'), my = ++this.seq;
    res.innerHTML = `${ic('refresh', 16, 'spin')} Calculando qué se desprende…`;
    try {
      const r = await fetch(this.api + '/api/trigger/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(this.getParams())});
      const j = await r.json();
      if (my !== this.seq) return;  // llegó una respuesta más nueva
      if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail));
      const b = j.bodies.find(x => x.index === t.k) || j.bodies[0];
      this.draw(b);
      const i = b.info, ok = b.cells.length > 0;
      res.className = 'rain-res ' + (ok ? 'fail' : 'stable');
      res.innerHTML = `<b>${ok ? ic('exclamation-mark-triangle') + 'Se desprende' : ic('check-circle') + 'Ladera estable'}</b>` +
        `<table>` +
        (ok ? `<tr><td>Volumen</td><td><b>${fmt(i.volume_m3 / 1e6, 2)} M m³</b></td></tr>` +
          `<tr><td>Área que falla</td><td>${fmt(i.failed_area_m2 / 1e4, 1)} ha (${i.clusters} deslizamiento${i.clusters === 1 ? '' : 's'})</td></tr>` +
          `<tr><td>Saturación media</td><td>${fmt(i.saturated_fraction_mean * 100, 0)} % del espesor</td></tr>` +
          `<tr><td>Densidad / λ inicial</td><td>${fmt(i.density, 0)} kg/m³ · ${fmt(i.pore_ratio_initial, 2)}</td></tr>` : '') +
        `<tr><td>Recarga efectiva</td><td>${fmt(i.recharge_mm_day, 1)} mm/día</td></tr>` +
        `<tr><td>FS mínimo / mediana</td><td>${fmt(i.fs_min, 2)} / ${fmt(i.fs_median, 2)}</td></tr>` +
        (i.critical_rain_min_mm != null ? `<tr><td>Lluvia crítica (mín · p10 · p50)</td><td>${fmt(i.critical_rain_min_mm, 0)} · ${fmt(i.critical_rain_p10_mm, 0)} · ${fmt(i.critical_rain_p50_mm, 0)} mm</td></tr>` : '') +
        `</table><div class="hint">${esc(i.message)} Lluvia crítica: la que, en ${fmt(i.days, 0)} días, lleva cada celda a FS = 1. ` +
        `En rojo, lo que se desprende; en amarillo, ladera al límite (FS &lt; 1,2). DEM ${esc(j.dem_source)}, celdas de ${fmt(b.dx, 0)} m.</div>`;
    } catch (e) {
      if (my !== this.seq) return;
      res.className = 'rain-res';
      res.textContent = 'No se pudo calcular: ' + e.message;
    }
  }

  draw(b) {
    this.layer.clearLayers();
    const t = this.target;
    if (t) L.polygon(t.b.polygon.map(([lo, la]) => [la, lo]), {color: '#a83bd6', weight: 2, dashArray: '6 4', fill: false, interactive: false})
      .bindTooltip('Zona de búsqueda del deslizamiento', {sticky: true}).addTo(this.layer);
    const half = b.dx / 2, lat0 = b.cells[0] ? b.cells[0][1] : (b.marginal[0] || [0, 0])[1];
    const hy = half / 110540, hx = half / (111320 * Math.cos(lat0 * Math.PI / 180));
    const cell = ([lo, la], color, op) => L.rectangle([[la - hy, lo - hx], [la + hy, lo + hx]],
      {renderer: this.renderer, stroke: false, fillColor: color, fillOpacity: op, interactive: false}).addTo(this.layer);
    b.marginal.forEach(c => cell(c, '#edd317', 0.45));
    b.cells.forEach(c => cell(c, '#d83020', 0.75));
  }

  clear() { this.layer.clearLayers(); this.sec.hidden = true; }
}
