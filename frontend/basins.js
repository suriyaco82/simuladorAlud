// Cuencas y tormenta (motor de inundación por lluvia): parámetros, delineación de cuencas y subcuencas sobre el DEM,
// red de drenaje e hidrología SCS de cada cuenca (backend: hydro.py, endpoint /api/basins).
import {ic} from './icons.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const fmtVol = v => v == null ? '—' : v >= 1e6 ? fmt(v / 1e6, 2) + ' M m³' : fmt(v, 0) + ' m³';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

export const FLOW = {
  agua: {name: 'Crecida', color: '#3fa9f5'},
  hiper: {name: 'Hiperconcentrado', color: '#ff9f1c'},
  detritos: {name: 'Alud (detritos)', color: '#d62828'},
};
const PATTERNS = {adelantado: 'Adelantado (pico al 30 %)', centrado: 'Centrado', atrasado: 'Atrasado', uniforme: 'Uniforme', bloques: 'Bloques alternos'};
const MODES = {edge: 'Salidas al borde de la zona', target: 'Cauces que entran a la zona urbana', outlets: 'Puntos marcados en el mapa'};
const COLS = ['#3fa9f5', '#ffd166', '#ef476f', '#06d6a0', '#c77dff', '#f4a261'];

// [grupo, clave, etiqueta, mín, máx, paso, defecto, ayuda]; defecto null = el del backend
const FIELDS = [
  ['storm', 'rain_mm', 'Lluvia total (mm)', 0, 400, 5, 60, 'Lluvia puntual de la tormenta. Se reduce según el área de la cuenca (una tormenta convectiva no cubre toda la cuenca).'],
  ['storm', 'duration_h', 'Duración (h)', 0.25, 48, 0.25, 3, 'Duración de la tormenta. Con la misma lluvia, menos horas = más intensidad = más escorrentía y caudales pico mayores.'],
  ['storm', 'cn', 'Número de curva CN', 30, 99, 1, 80, 'SCS-CN (humedad normal). Roca y suelo desnudo de sierras áridas: 80–90; pastizal: 60–75; bosque: 50–65. Se corrige por pendiente en cada celda.'],
  ['sim', 'sim_h', 'Tiempo simulado (h)', 0.25, 48, 0.25, 4, 'Duración de la simulación 2D, desde el inicio de la lluvia. Tiene que cubrir la tormenta más el tiempo de concentración de la cuenca.'],
  ['basins', 'subbasin_area_km2', 'Umbral de subcuenca (km²)', 0.1, 500, 0.5, 1, 'Se crea una subcuenca en cada confluencia de dos cauces mayores que este área.'],
  ['basins', 'stream_area_km2', 'Área mínima de cauce (km²)', 0.05, 50, 0.05, 0.5, 'Celdas con más área de aporte se dibujan como cauce.'],
  ['basins', 'min_basin_area_km2', 'Área mínima de cuenca (km²)', 0.1, 500, 0.5, 2, 'Cuencas principales más chicas se ignoran.'],
];
const ADV = [
  ['soil', 'soil_depth_m', 'Espesor de suelo (m)', 0.2, 10, 0.1, 1.2, 'Suelo de ladera que se desliza (SHALSTAB + talud infinito).'],
  ['soil', 'cohesion_kpa', "Cohesión c' (kPa)", 0, 50, 0.5, 6, 'Cohesión efectiva del suelo, incluye raíces.'],
  ['soil', 'friction_angle_deg', "Fricción φ' (°)", 20, 50, 0.5, 36, 'Ángulo de fricción efectivo del suelo de ladera.'],
  ['soil', 'transmissivity_m2_day', 'Transmisividad (m²/día)', 1, 300, 1, 30, 'Capacidad del suelo saturado de conducir agua ladera abajo.'],
  ['debris', 'channel_erodible_m', 'Lecho erosionable (m)', 0, 10, 0.1, 1, 'Espesor de sedimento suelto en el lecho de los cauces que la crecida puede incorporar.'],
  ['debris', 'grain_size_m', 'Diámetro medio del lecho (m)', 0.01, 1, 0.01, 0.1, 'Controla el caudal crítico de disparo de un flujo de detritos en el cauce (Gregoretti y Dalla Fontana 2008).'],
  ['debris', 'deposition_slope_deg', 'Pendiente de depósito (°)', 2, 20, 0.5, 10, 'Bajo esta pendiente el flujo de detritos se frena y deposita (abanico).'],
  ['flood', 'manning_channel', 'Manning cauce', 0.02, 0.15, 0.005, 0.045, 'Rugosidad de los cauces.'],
  ['flood', 'manning_hillslope', 'Manning ladera', 0.02, 0.3, 0.005, 0.06, 'Rugosidad de las laderas.'],
  ['flood', 'boulders', 'Bloques de roca', 0, 10000, 100, 1500, 'Trazadores: bloques en el lecho de los cauces empinados y en los deslizamientos.'],
  ['flood', 'trees_per_km', 'Árboles por km de cauce', 0, 500, 5, 40, 'Árboles de la ribera que la crecida puede arrancar y arrastrar.'],
];

export class BasinsPanel {
  constructor({api, map, sec, body, getParams, status, onChange, isDrawing, hasUrbanZone, startDraw}) {
    Object.assign(this, {api, map, sec, body, getParams, status, onChange, isDrawing, hasUrbanZone, startDraw});
    this.layer = L.layerGroup().addTo(map);
    this.cellRenderer = L.canvas({padding: 0.3});
    this.v = {storm: {pattern: 'adelantado', amc: 'II'}, basins: {mode: 'edge', outlets: []}, soil: {}, debris: {}, flood: {landslides: true}, sim: {}};
    for (const [g, k, , , , , def] of FIELDS) if (g !== 'basins' || k !== 'mode') this.v[g][k] = def;
    this.picking = false;
    this.data = null;      // última delineación (/api/basins)
    this.dataKey = null;   // parámetros con los que se delineó (para detectar cambios)
    this.selected = new Set();  // ids de las cuencas principales a simular
    this.seq = 0;
    this.render();
  }

  get capturesMapClicks() { return this.picking; }

  // las cuencas solo se ven en el modo cuencas (en movimiento de masa estorban y capturan clics)
  setVisible(on) {
    for (const l of [this.layer, this.pins]) if (l) { if (on) l.addTo(this.map); else l.remove(); }
    if (!on) this.setPicking(false);
  }

  // zona urbana dibujada en el panel ([[lon, lat], ...]) o null
  get urbanZone() { const z = this.v.basins.target_polygon; return z && z.length >= 3 ? z : null; }

  // lo que define la delineación: si cambia después de delinear, las cuencas dibujadas ya no valen
  keyOf(p) {
    const b = {...(p.basins || {})};
    delete b.selected;
    return JSON.stringify([p.dataset, p.bbox, p.dx, b, p.flood && p.flood.max_cells, p.lakes, p.burn_channels, p.dams]);
  }
  get stale() { return !!this.data && this.keyOf(this.getParams()) !== this.dataKey; }

  // antes de simular: hay cuencas delineadas, vigentes y al menos una elegida (null = todo bien)
  checkReady() {
    if (!this.data) return 'Primero delineá las cuencas (botón «Delinear cuencas» en el panel Cuencas y tormenta): la simulación usa las cuencas que elijas.';
    if (this.stale) return 'Cambiaste la zona, el dx o las opciones de cuencas después de delinear: volvé a delinear antes de simular.';
    if (!this.selected.size) return 'Elegí al menos una cuenca para simular (casillas de la tabla o clic en el mapa).';
    return null;
  }

  // valores de un escenario cargado (ejemplo)
  load(p) {
    for (const g of ['storm', 'soil', 'debris', 'flood', 'basins']) if (p[g]) Object.assign(this.v[g], p[g]);
    if (!this.v.basins.outlets) this.v.basins.outlets = [];
    if (p.engine === 'flood' && p.duration_s) this.v.sim.sim_h = Math.round(p.duration_s / 360) / 10;
    this.clearMap();
    this.render();
  }

  // parámetros para /api/simulate y /api/basins
  params() {
    const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
    const b = clean(this.v.basins);
    if (b.mode !== 'outlets' || !b.outlets.length) delete b.outlets;
    if (b.mode !== 'target') { delete b.target_polygon; delete b.target_name; }
    delete b.selected;
    if (this.data) b.selected = this.data.basins.filter(x => x.is_main && this.selected.has(x.id)).map(x => x.outlet_lonlat);
    return {storm: clean(this.v.storm), soil: clean(this.v.soil), debris: clean(this.v.debris), flood: clean(this.v.flood), basins: b,
      duration_s: Math.round(this.v.sim.sim_h * 3600)};
  }

  field([g, k, lab, mn, mx, st, , help]) {
    const v = this.v[g][k] ?? '';
    return `<label title="${esc(help)}">${lab}<input type="number" data-bg="${g}" data-bk="${k}" min="${mn}" max="${mx}" step="${st}" value="${v}"></label>`;
  }

  render() {
    const V = this.v, sel = (g, k, opts) => `<select data-bg="${g}" data-bk="${k}">${Object.entries(opts).map(([a, b]) =>
      `<option value="${a}"${V[g][k] === a ? ' selected' : ''}>${b}</option>`).join('')}</select>`;
    const F = k => this.field(FIELDS.find(f => f[1] === k));
    this.body.innerHTML =
      `<p class="hint">1) Delineá las cuencas sobre el DEM. 2) Elegí cuáles simular. 3) Simulá: la lluvia cae sobre esas cuencas y escurre ` +
      `por el terreno hasta sus salidas y aguas abajo. En los cauces empinados la crecida erosiona el lecho y puede volverse un flujo de ` +
      `detritos (alud); los deslizamientos de ladera suman material.</p>` +
      `<b class="sub">Tormenta</b><div class="grid2">${F('rain_mm')}${F('duration_h')}` +
      `<label>Hietograma${sel('storm', 'pattern', PATTERNS)}</label>` +
      `<label title="Humedad del suelo antes de la tormenta">Humedad previa${sel('storm', 'amc', {I: 'I · seca', II: 'II · normal', III: 'III · húmeda'})}</label>` +
      `${F('cn')}${F('sim_h')}</div>` +
      `<label class="check"><input type="checkbox" data-bg="storm" data-bk="areal_reduction"${V.storm.areal_reduction !== false ? ' checked' : ''}> Reducción areal de la lluvia</label>` +
      `<b class="sub">Cuencas</b><label>Salidas de las cuencas${sel('basins', 'mode', MODES)}</label>` +
      `<div id="bsOutlets"${V.basins.mode === 'outlets' ? '' : ' hidden'}>` +
      `<div class="row"><button class="tool${this.picking ? ' active' : ''}" id="bsPick">${ic('pin')}Marcar salidas</button>` +
      `<button class="tool" id="bsClearOut">${ic('trash')}Borrar</button></div>` +
      `<div class="hint">${V.basins.outlets.length ? V.basins.outlets.map((o, i) => `${i + 1}. ${esc(o.name)}`).join(' · ') : 'Clic en el mapa sobre el cauce; la salida se lleva al cauce más cercano (300 m).'}</div></div>` +
      `<div id="bsTarget"${V.basins.mode === 'target' ? '' : ' hidden'}>` +
      `<div class="row"><button class="tool" id="bsDrawUrban">${ic('polygon')}Dibujar zona urbana</button>` +
      `<button class="tool" id="bsClearUrban"${this.urbanZone ? '' : ' disabled'}>${ic('trash')}Borrar</button></div>` +
      `<div class="hint">${this.urbanZone ? `Zona urbana dibujada (${this.urbanZone.length} vértices): se delinean las cuencas cuyos cauces entran a ella.`
        : this.hasUrbanZone && this.hasUrbanZone() ? 'Se usa la zona urbana del ejemplo cargado. Podés dibujar otra.'
        : 'Dibujá el polígono de la zona urbana: se delinean las cuencas cuyos cauces entran a ella.'}</div></div>` +
      `<div class="grid2">${F('subbasin_area_km2')}${F('stream_area_km2')}${F('min_basin_area_km2')}</div>` +
      `<details class="rain-soil"><summary>Suelo, lecho y rugosidad</summary><div class="grid2">${ADV.map(f => this.field(f)).join('')}</div>` +
      `<label class="check"><input type="checkbox" data-bg="flood" data-bk="landslides"${V.flood.landslides !== false ? ' checked' : ''}> Deslizamientos de ladera por la lluvia</label></details>` +
      `<div class="row"><button class="tool" id="bsRun">${ic('refresh')}Delinear cuencas</button>` +
      `<button class="tool" id="bsClear">${ic('x')}Quitar del mapa</button></div>` +
      `<div id="bsRes" class="basins-res">${this.data ? this.tableHTML(this.data) : ''}</div>`;
    this.body.querySelectorAll('[data-bg]').forEach(el => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
      const g = el.dataset.bg, k = el.dataset.bk;
      if (el.type === 'checkbox') V[g][k] = el.checked;
      else if (el.tagName === 'SELECT') V[g][k] = el.value;
      else { if (el.value === '' || !isFinite(+el.value)) return; V[g][k] = +el.value; }
      if (k === 'mode') {
        this.body.querySelector('#bsOutlets').hidden = el.value !== 'outlets';
        this.body.querySelector('#bsTarget').hidden = el.value !== 'target';
        if (el.value !== 'outlets') this.setPicking(false);
        this.drawOutletPins();
      }
      if (k === 'duration_h' && V.sim.sim_h < V.storm.duration_h + 0.5) {
        V.sim.sim_h = V.storm.duration_h + 1;
        this.body.querySelector('[data-bk="sim_h"]').value = V.sim.sim_h;
      }
      this.onChange && this.onChange();
    }));
    this.body.querySelector('#bsRun').onclick = () => this.delineate();
    this.body.querySelector('#bsClear').onclick = () => { this.data = null; this.dataKey = null; this.selected.clear(); this.clearMap(); this.body.querySelector('#bsRes').innerHTML = ''; };
    this.body.querySelector('#bsPick').onclick = () => this.setPicking(!this.picking);
    this.body.querySelector('#bsDrawUrban').onclick = () => { this.setPicking(false); this.startDraw(pts => {
      V.basins.target_polygon = pts.map(ll => [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]);
      V.basins.target_name = 'la zona urbana';
      this.render();
      this.status('Zona urbana dibujada. Ahora «Delinear cuencas».');
    }); };
    this.body.querySelector('#bsClearUrban').onclick = () => { delete V.basins.target_polygon; delete V.basins.target_name; this.render(); };
    this.body.querySelector('#bsClearOut').onclick = () => { V.basins.outlets = []; this.drawOutletPins(); this.render(); };
    this.bindTable();
    this.drawOutletPins();
  }

  setPicking(on) {
    this.picking = on;
    this.map.getContainer().classList.toggle('drawing', on);
    const b = this.body.querySelector('#bsPick');
    if (b) b.classList.toggle('active', on);
    if (on) this.status('Clic en el mapa sobre un cauce para marcar la salida de una cuenca. Esc o "Marcar salidas" para terminar.');
  }

  addOutlet(ll) {
    const o = this.v.basins.outlets;
    o.push({lon: +ll.lng.toFixed(6), lat: +ll.lat.toFixed(6), name: `Salida ${o.length + 1}`});
    this.render();
    this.setPicking(true);
  }

  drawOutletPins() {
    if (this.pins) this.pins.remove();
    this.pins = L.layerGroup();
    if (!this.sec.hidden) this.pins.addTo(this.map);
    const uz = this.urbanZone;
    if (uz && this.v.basins.mode === 'target') L.polygon(uz.map(([lo, la]) => [la, lo]), {color: '#3fd0e0', weight: 2, fillOpacity: .08, interactive: false})
      .addTo(this.pins);
    if (this.v.basins.mode !== 'outlets') return;
    this.v.basins.outlets.forEach((o, i) => L.circleMarker([o.lat, o.lon], {radius: 6, color: '#fff', weight: 2, fillColor: '#ff4d6d', fillOpacity: 1})
      .bindTooltip(`${i + 1}. ${esc(o.name)}`).addTo(this.pins));
  }

  clearMap() { this.layer.clearLayers(); }

  async delineate() {
    const res = this.body.querySelector('#bsRes'), my = ++this.seq;
    res.innerHTML = `${ic('refresh', 16, 'spin')} Analizando el terreno y la tormenta…`;
    try {
      const prm = this.getParams();
      if (prm.dataset === 'SYNTHETIC') res.innerHTML = `<div class="warn">⚠ El DEM SYNTHETIC es un relieve inventado: las cuencas no corresponden al lugar. Usá AWS_TERRAIN o COP30.</div>` + res.innerHTML;
      const r = await fetch(this.api + '/api/basins', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(prm)});
      const j = await r.json();
      if (my !== this.seq) return;
      if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail.map(d => `${d.loc.slice(-1)[0]}: ${d.msg}`).join('; '));
      const keep = this.data ? new Set(this.data.basins.filter(x => x.is_main && this.selected.has(x.id)).map(x => x.outlet_lonlat.join())) : null;
      this.data = j;
      this.dataKey = this.keyOf(this.getParams());
      // conservar la elección anterior si las salidas siguen siendo las mismas; si no, todas
      const mains = j.basins.filter(x => x.is_main);
      const again = keep && mains.filter(x => keep.has(x.outlet_lonlat.join()));
      this.selected = new Set((again && again.length ? again : mains).map(x => x.id));
      this.draw(j);
      res.innerHTML = this.tableHTML(j);
      this.bindTable();
    } catch (e) {
      if (my !== this.seq) return;
      res.textContent = 'No se pudieron delinear las cuencas: ' + e.message;
    }
  }

  // ── mapa
  draw(j, fit = true) {
    this.clearMap();
    const ring = r => r.map(([lo, la]) => [la, lo]);
    const poly = P => P.map(p => p.map(ring));
    const flowOf = b => (b.storm && b.storm.flow) || b.propensity;
    for (const b of j.basins.filter(b => !b.is_main)) {
      L.polygon(poly(b.polygon), {color: '#e8f1f5', weight: 1, opacity: .7, dashArray: '3 3', fill: false, interactive: false}).addTo(this.layer);
    }
    this.mainLayers = {};
    for (const b of j.basins.filter(b => b.is_main)) {
      const pl = L.polygon(poly(b.main_polygon || b.polygon), this.mainStyle(b))
        .bindTooltip(this.tipHTML(b) + (j.result ? '' : '<br><i>Clic: elegir / quitar para la simulación</i>'), {sticky: true}).addTo(this.layer);
      if (!j.result) pl.on('click', () => { if (!this.isDrawing || !this.isDrawing()) this.toggle(b.id); });
      this.mainLayers[b.id] = pl;
    }
    for (const s of j.streams) {
      L.polyline(s.coords.map(([lo, la]) => [la, lo]), {color: '#4fc3f7', weight: Math.min(6, 0.6 + 0.7 * s.order), opacity: .85, interactive: false}).addTo(this.layer);
    }
    const h = j.hydrology;
    if (h) {
      const half = h.cell_m / 2, lat0 = j.basins.length ? j.basins[0].outlet_lonlat[1] : 0;
      const hy = half / 110540, hx = half / (111320 * Math.cos(lat0 * Math.PI / 180));
      const cell = ([lo, la], color, op) => L.rectangle([[la - hy, lo - hx], [la + hy, lo + hx]],
        {renderer: this.cellRenderer, stroke: false, fillColor: color, fillOpacity: op, interactive: false}).addTo(this.layer);
      (h.debris_path_cells || []).forEach(c => cell(c, '#ff7b39', .55));
      (h.debris_trigger_cells || []).forEach(c => cell(c, '#d62828', .8));
      (h.landslide_cells || []).forEach(c => cell(c, '#a83bd6', .8));
    }
    for (const b of j.basins) {
      const [lo, la] = b.outlet_lonlat;
      L.circleMarker([la, lo], {radius: b.is_main ? 6 : 3.5, color: '#fff', weight: 1.5, fillColor: FLOW[flowOf(b)].color, fillOpacity: 1})
        .bindTooltip(this.tipHTML(b)).addTo(this.layer);
    }
    const mains = j.basins.filter(b => b.is_main);
    if (fit && mains.length) {
      const bounds = L.latLngBounds(mains.flatMap(b => (b.main_polygon || b.polygon).flatMap(p => ring(p[0]))));
      if (bounds.isValid()) this.map.fitBounds(bounds, {padding: [20, 20]});
    }
  }

  mainStyle(b) {
    const on = !this.data || this.data.result || this.selected.has(b.id), c = on ? FLOW[(b.storm && b.storm.flow) || b.propensity].color : '#9aa3ab';
    return {color: c, weight: on ? 2.5 : 1.5, dashArray: on ? null : '6 4', fillColor: c, fillOpacity: on ? .12 : .03};
  }

  toggle(id) {
    if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
    const b = this.data.basins.find(x => x.id === id);
    if (this.mainLayers[id]) this.mainLayers[id].setStyle(this.mainStyle(b));
    this.body.querySelectorAll(`input[data-sel="${id}"]`).forEach(el => { el.checked = this.selected.has(id); });
    const n = this.body.querySelector('#bsSelN');
    if (n) n.textContent = this.selInfo();
  }

  selInfo() {
    const m = this.data.basins.filter(x => x.is_main && this.selected.has(x.id));
    return `${m.length} cuenca${m.length === 1 ? '' : 's'} elegida${m.length === 1 ? '' : 's'} · ${fmt(m.reduce((a, b) => a + b.area_up_km2, 0), 1)} km² con lluvia`;
  }

  // resultado de una simulación: las cuencas que se usaron (solo lectura)
  showResult(geo) {
    if (!geo) return;
    this.setPicking(false);
    this.draw({...geo, result: true}, false);
  }

  // cuencas, subcuencas, cauces y salidas digitalizados, en GeoJSON (EPSG:4326)
  geojson() {
    const j = this.data, F = [];
    const props = b => {
      const s = b.storm || {};
      return {tipo: b.is_main ? 'cuenca' : 'subcuenca', id: b.id, codigo: b.code, nombre: b.name, drena_a: b.down || null,
        cuenca_principal: b.main, simulada: this.selected.has(b.main), area_propia_km2: b.area_km2, area_aporte_km2: b.area_up_km2,
        cota_salida_m: b.z_outlet, cota_max_m: b.z_max_up, desnivel_m: b.relief_up_m, pendiente_media_deg: b.slope_mean_deg,
        largo_cauce_km: b.length_up_km, pendiente_cauce: b.channel_slope_up, melton: b.melton, tc_kirpich_h: b.tc_up_h,
        tc_temez_h: b.tc_temez_up_h, propension: b.propensity, q_pico_scs_m3s: s.q_peak, t_pico_h: s.t_peak_h,
        tipo_flujo: s.flow, toca_borde: b.touches_border};
    };
    for (const b of j.basins) {
      F.push({type: 'Feature', properties: props(b), geometry: {type: 'MultiPolygon', coordinates: b.polygon}});
      if (b.is_main && b.main_polygon) F.push({type: 'Feature', properties: {...props(b), tipo: 'cuenca_completa'}, geometry: {type: 'MultiPolygon', coordinates: b.main_polygon}});
      F.push({type: 'Feature', properties: {tipo: 'salida', id: b.id, codigo: b.code, nombre: b.name, area_aporte_km2: b.area_up_km2}, geometry: {type: 'Point', coordinates: b.outlet_lonlat}});
    }
    for (const s of j.streams) F.push({type: 'Feature', properties: {tipo: 'cauce', orden_strahler: s.order, area_km2: s.area_km2}, geometry: {type: 'LineString', coordinates: s.coords}});
    return {type: 'FeatureCollection', name: 'cuencas', features: F};
  }

  download() {
    const blob = new Blob([JSON.stringify(this.geojson())], {type: 'application/geo+json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'cuencas_subcuencas.geojson'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  tipHTML(b) {
    const s = b.storm, f = FLOW[(s && s.flow) || b.propensity];
    return `<b>${esc(b.name)}</b> (${b.code})<br>Área ${fmt(b.area_up_km2, 2)} km²${b.is_main ? '' : ` · propia ${fmt(b.area_km2, 2)} km²`}` +
      `<br>Melton ${fmt(b.melton, 2)} · Tc ${fmt(b.tc_up_h * 60, 0)} min` +
      (s ? `<br>Q pico ${fmt(s.q_peak, 1)} m³/s a las ${fmt(s.t_peak_h, 2)} h<br>Llega como: <b style="color:${f.color}">${f.name}</b>` +
        (s.flow_formation !== s.flow ? ` (se forma como ${FLOW[s.flow_formation].name.toLowerCase()})` : '') : `<br>Propensión: ${f.name}`);
  }

  // ── tabla e hidrogramas
  tableHTML(j) {
    const mains = j.basins.filter(b => b.is_main), h = j.hydrology;
    const subs = id => j.basins.filter(b => !b.is_main && b.main === id);
    const badge = k => `<span class="flow-badge" style="background:${FLOW[k].color}">${FLOW[k].name}</span>`;
    const row = b => {
      const s = b.storm || {};
      const chk = b.is_main ? `<input type="checkbox" data-sel="${b.id}"${this.selected.has(b.id) ? ' checked' : ''} title="Simular esta cuenca"> ` : '<span class="indent"></span>';
      return `<tr data-bid="${b.id}"><td>${chk}${b.is_main ? '<b>' : ''}${b.code} ${esc(b.name)}${b.is_main ? '</b>' : ''}</td><td>${fmt(b.area_up_km2, 1)}</td>` +
        `<td>${fmt(b.melton, 2)}</td><td>${fmt(s.q_peak, 0)}</td><td>${badge(s.flow || b.propensity)}</td></tr>`;
    };
    let html = (j.warnings || []).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
    html += `<div class="sel-info"><b id="bsSelN">${this.selInfo()}</b><span class="hint">La simulación llueve solo sobre las cuencas elegidas; ` +
      `el agua sigue aguas abajo de sus salidas. Elegí con las casillas o con clic en el mapa.</span></div>` +
      `<div class="row"><button class="tool" id="bsAll">${ic('check-square')}Todas</button><button class="tool" id="bsNone">${ic('square')}Ninguna</button>` +
      `<button class="tool" id="bsGeo">${ic('download')}GeoJSON</button></div>`;
    html += `<table class="basins"><tr><th>Cuenca</th><th>km²</th><th>Melton</th><th>Q<sub>p</sub> m³/s</th><th>Llega como</th></tr>` +
      mains.map(b => row(b) + subs(b.id).map(row).join('')).join('') + '</table>';
    if (h) {
      html += this.hydrographSVG(j, mains);
      const tot = k => mains.reduce((a, b) => a + ((b.storm || {})[k] || 0), 0);
      html += `<table>` +
        `<tr><td>Intensidad pico</td><td>${fmt(h.storm.peak_intensity_mm_h, 0)} mm/h</td></tr>` +
        `<tr><td>Escorrentía (cuencas principales)</td><td>${fmtVol(tot('v_water_m3'))}</td></tr>` +
        `<tr><td>Deslizamientos de ladera</td><td>${fmtVol(j.basins.reduce((a, b) => a + ((b.storm || {}).landslide_m3 || 0), 0))}</td></tr>` +
        `<tr><td>Lluvia crítica de deslizamiento (p10 · p50)</td><td>${h.critical_rain_p10_mm != null ? `${fmt(h.critical_rain_p10_mm, 0)} · ${fmt(h.critical_rain_p50_mm, 0)} mm` : '—'}</td></tr>` +
        `</table><div class="hint">Mapa: ${legendSw('#d62828')}disparo de alud en el cauce (Gregoretti) · ${legendSw('#ff7b39')}recorrido del alud · ` +
        `${legendSw('#a83bd6')}deslizamientos de ladera. Hidrología: SCS-CN + hidrograma unitario SCS + Muskingum entre subcuencas; ` +
        `tipo de flujo por la concentración de equilibrio de Takahashi y el número de Melton. DEM ${esc(j.dem_source)}, celdas de ${fmt(j.dx, 0)} m.</div>`;
    }
    return html;
  }

  hydrographSVG(j, mains) {
    const h = j.hydrology, t = h.t_h, W = 290, H = 130, pad = 30, top = 30;
    const sel = mains.slice(0, COLS.length).filter(b => b.storm && b.storm.hydrograph);
    if (!sel.length || !t.length) return '';
    const tMax = t[t.length - 1] || 1, qMax = Math.max(1, ...sel.map(b => b.storm.q_peak));
    const px = x => pad + (W - pad - 6) * x / tMax, py = q => H - 16 - (H - 16 - top) * q / qMax;
    const rain = h.hyetograph.mm, iMax = Math.max(...rain) / h.hyetograph.dt_h;
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="hydro">`;
    rain.forEach((mm, k) => {
      const x0 = px(k * h.hyetograph.dt_h), x1 = px((k + 1) * h.hyetograph.dt_h), hh = (top - 8) * (mm / h.hyetograph.dt_h) / iMax;
      svg += `<rect x="${x0.toFixed(1)}" y="4" width="${Math.max(0.5, x1 - x0 - 0.3).toFixed(1)}" height="${hh.toFixed(1)}" fill="#5aa9e6" opacity=".55"/>`;
    });
    svg += `<text x="${W - 4}" y="12" text-anchor="end">${fmt(iMax, 0)} mm/h</text>` +
      `<line x1="${pad}" y1="${H - 16}" x2="${W - 4}" y2="${H - 16}" stroke="#3a5566"/><line x1="${pad}" y1="${top}" x2="${pad}" y2="${H - 16}" stroke="#3a5566"/>` +
      `<text x="${pad - 3}" y="${top + 6}" text-anchor="end">${fmt(qMax, 0)}</text><text x="${pad - 3}" y="${H - 16}" text-anchor="end">0</text>` +
      `<text x="${W - 4}" y="${H - 3}" text-anchor="end">${fmt(tMax, 1)} h</text><text x="${pad}" y="${H - 3}">0</text>`;
    sel.forEach((b, k) => {
      const Q = b.storm.hydrograph;
      svg += `<polyline fill="none" stroke="${COLS[k]}" stroke-width="1.6" points="${Q.map((q, i) => `${px(t[i]).toFixed(1)},${py(q).toFixed(1)}`).join(' ')}"/>`;
    });
    svg += '</svg>';
    return `<div class="zone"><div class="zname">Hidrogramas SCS en las salidas (m³/s)</div>${svg}` +
      `<div class="hint">${sel.map((b, k) => `${legendSw(COLS[k])}${esc(b.name)}`).join(' · ')}</div></div>`;
  }

  bindTable() {
    this.body.querySelectorAll('input[data-sel]').forEach(el => {
      el.onclick = e => e.stopPropagation();
      el.onchange = () => { if (el.checked !== this.selected.has(+el.dataset.sel)) this.toggle(+el.dataset.sel); };
    });
    const btn = (id, fn) => { const b = this.body.querySelector(id); if (b) b.onclick = fn; };
    const mains = () => this.data.basins.filter(x => x.is_main);
    btn('#bsAll', () => mains().forEach(b => { if (!this.selected.has(b.id)) this.toggle(b.id); }));
    btn('#bsNone', () => mains().forEach(b => { if (this.selected.has(b.id)) this.toggle(b.id); }));
    btn('#bsGeo', () => this.download());
    this.body.querySelectorAll('tr[data-bid]').forEach(tr => tr.onclick = () => {
      const b = this.data && this.data.basins.find(x => x.id === +tr.dataset.bid);
      if (!b) return;
      const P = (b.is_main && b.main_polygon) || b.polygon;
      const bounds = L.latLngBounds(P.flatMap(p => p[0].map(([lo, la]) => [la, lo])));
      if (bounds.isValid()) this.map.fitBounds(bounds, {padding: [30, 30]});
    });
  }
}

const legendSw = c => `<span class="sw" style="background:${c};margin-left:0"></span>`;

// resumen de cuencas de un resultado del motor de inundación (result.json → flood.basins)
export function floodBasinsHTML(fl) {
  if (!fl || !fl.basins || !fl.basins.length) return '';
  const mains = fl.basins.filter(b => b.is_main);
  const badge = k => k ? `<span class="flow-badge" style="background:${FLOW[k].color}">${FLOW[k].name}</span>` : '—';
  return `<div class="zone"><div class="zname">Cuencas (hidrología SCS)</div><table class="basins">` +
    `<tr><th>Cuenca</th><th>km²</th><th>Q<sub>p</sub> m³/s</th><th>Llega como</th></tr>` +
    mains.map(b => `<tr><td>${b.code} ${esc(b.name)}</td><td>${fmt(b.area_km2, 1)}</td><td>${fmt(b.q_peak, 0)}</td><td>${badge(b.flow)}</td></tr>`).join('') +
    `</table></div>`;
}
