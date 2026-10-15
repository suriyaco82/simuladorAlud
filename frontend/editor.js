// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Editor de escenarios: trae todos los datos de un ejemplo (parámetros, elementos en cascada y edificios),
// muestra cuáles faltan y permite cargar datos de campo, completar edificios con GlobalBuildingAtlas y guardar.
import {HELP} from './help.js';
import {normBuildings, buildingHeight} from './exposure.js';
import {ic} from './icons.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const metersPerDeg = lat => ({mx: 111320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)), my: 110540});

// ícono Calcite como nodo
const I = name => { const t = document.createElement('template'); t.innerHTML = ic(name); return t.content.firstChild; };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

// Nombres de los campos que no tienen ayuda en help.js
const LABELS = {
  name: 'Nombre', kind: 'Tipo', polygon: 'Polígono', line: 'Eje / línea', section: 'Sección transversal',
  release_mode: 'Masa definida por', thickness_m: 'Espesor medio (m)', volume_m3: 'Volumen (m³)', profile: 'Perfil de espesor',
  density: 'Densidad (kg/m³)', friction_angle_deg: 'Fricción interna φ (°)', basal_friction_deg: 'Fricción basal δ (°)',
  pore_ratio_initial: 'λ inicial (vacío = hidrostático)', turbulence_xi: 'Voellmy ξ (m/s²)', level_m: 'Nivel del agua (m s.n.m.)',
  width_m: 'Ancho (m)', depth_m: 'Profundidad (m)', start_s: 'Inicio (s)', duration_s: 'Duración (s)',
  target_m: 'Cota final del fondo (m s.n.m.)', crest_m: 'Cota de coronamiento (m s.n.m.)', spillways: 'Vertederos',
  rain: 'Desencadenante por lluvia',
  from_frac: 'Desde (fracción del eje 0–1)', to_frac: 'Hasta (fracción del eje 0–1)', erodible: 'Erosionable',
  west: 'Oeste', east: 'Este', south: 'Sur', north: 'Norte', source_lon: 'Punto de inicio · lon.', source_lat: 'Punto de inicio · lat.',
  water_bulk_modulus: 'Módulo volumétrico del agua (Pa)', water_viscosity_pa_s: 'Viscosidad del agua (Pa·s)',
  entrained_as: 'Material erosionado como', suspension_density: 'Densidad en suspensión (kg/m³)', max_frames: 'Cuadros guardados',
  max_particles: 'Máx. partículas', random_seed: 'Semilla aleatoria', damping: 'Amortiguamiento (motor partículas)',
  dt: 'Paso dt (motor partículas)', scenario_name: 'Nombre del escenario', release_polygon: 'Polígono de desprendimiento',
  engine: 'Motor', device: 'Dispositivo', dx: 'dx grilla (m)', ppc: 'Partículas/celda/eje', duration_s_sim: 'Duración (s)',
  display_particles: 'Partículas visibles',
};
const GROUPS = [
  ['Zona y terreno', ['dataset', 'dem_fallback']],
  ['Desprendimiento', ['release_mode', 'release_thickness_m', 'release_volume_m3', 'thickness_profile', 'release_radius_m', 'source_lon', 'source_lat']],
  ['Material', ['density_solid', 'porosity', 'friction_angle_deg', 'basal_friction_deg', 'viscosity_pa_s', 'young_modulus']],
  ['Agua y presión de poros', ['saturation', 'pore_ratio_initial', 'pore_diffusion_time_s', 'pore_generation', 'water_bulk_modulus', 'water_viscosity_pa_s', 'turbulence_xi']],
  ['Erosión y deposición', ['erodible_depth_m', 'entrainment_coeff', 'critical_velocity', 'entrained_as', 'suspension_density']],
  ['Solver', ['engine', 'device', 'dx', 'ppc', 'duration_s', 'max_frames', 'display_particles', 'max_particles', 'random_seed', 'damping', 'dt']],
  ['Otros', ['scenario_name']],
];
const LISTS = [
  ['bodies', 'Masas iniciales (hielo, roca, agua)', 'Body', 'polygon', false, 'masa inicial'],
  ['lakes', 'Lagos y embalses (nivel del agua)', 'Lake', 'polygon', false, 'lago o embalse'],
  ['dams', 'Diques y paredones', 'Dam', 'line', false, 'dique'],
  ['breach', 'Brecha', 'Breach', 'line', true, 'brecha'],
  ['burn_channels', 'Cauces grabados en el DEM', 'Channel', 'line', false, 'cauce'],
  ['erodible_zones', 'Zonas erosionables', 'ErodibleZone', 'polygon', false, 'zona erosionable'],
  ['gauges', 'Estaciones de aforo virtuales', 'Gauge', 'section', false, 'estación de aforo'],
  ['exposure', 'Zonas expuestas (urbanas)', 'ExposureZone', 'polygon', false, 'zona expuesta'],
];
const label = k => (HELP[k] && !k.startsWith('sec-') ? HELP[k].t : null) || LABELS[k] || k;

// ── esquema (OpenAPI del backend) normalizado
function normProp(p, defs) {
  let nullable = false;
  if (p.anyOf) { nullable = p.anyOf.some(a => a.type === 'null'); p = {...p.anyOf.find(a => a.type !== 'null'), title: p.title, description: p.description, default: p.default}; }
  const out = {nullable, default: p.default, description: p.description, min: p.minimum ?? p.exclusiveMinimum, max: p.maximum ?? p.exclusiveMaximum};
  if (p.$ref) return {...out, kind: 'object', ref: p.$ref.split('/').pop()};
  if (p.enum) return {...out, kind: 'enum', options: p.enum};
  if (p.type === 'array') {
    const it = p.items || {};
    if (it.$ref) return {...out, kind: 'list', ref: it.$ref.split('/').pop()};
    if (it.prefixItems || it.type === 'array') return {...out, kind: 'geom'};
    if (it.anyOf || it.type === 'number') return {...out, kind: 'numlist'};
    return {...out, kind: 'json'};
  }
  return {...out, kind: p.type === 'boolean' ? 'bool' : p.type === 'string' ? 'text' : p.type === 'integer' ? 'int' : 'number'};
}
function schemaOf(defs, name) {
  const s = defs[name], req = new Set(s.required || []);
  return Object.fromEntries(Object.entries(s.properties).map(([k, p]) => [k, {...normProp(p, defs), required: req.has(k)}]));
}

// ── geometría
function ringArea(c) {
  if (!c || c.length < 3) return 0;
  const {mx, my} = metersPerDeg(c[0][1]);
  let a = 0;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) a += c[j][0] * mx * c[i][1] * my - c[i][0] * mx * c[j][1] * my;
  return Math.abs(a / 2);
}
function lineLength(c) {
  if (!c || c.length < 2) return 0;
  const {mx, my} = metersPerDeg(c[0][1]);
  let L = 0;
  for (let i = 1; i < c.length; i++) L += Math.hypot((c[i][0] - c[i - 1][0]) * mx, (c[i][1] - c[i - 1][1]) * my);
  return L;
}
function inPoly(lon, lat, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
// índice de vecinos: celdas de ~cell metros
function spatialIndex(items, cell = 25) {
  const lat0 = items.length ? items[0].lat : 0, {mx, my} = metersPerDeg(lat0), m = new Map();
  const key = (lon, lat) => `${Math.floor(lon * mx / cell)},${Math.floor(lat * my / cell)}`;
  items.forEach((b, i) => { const k = key(b.lon, b.lat); (m.get(k) || m.set(k, []).get(k)).push(i); });
  return {
    nearest(lon, lat, maxD, skip) {
      const cx = Math.floor(lon * mx / cell), cy = Math.floor(lat * my / cell), r = Math.ceil(maxD / cell);
      let best = -1, bd = maxD;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (const i of m.get(`${cx + dx},${cy + dy}`) || []) {
        if (skip && skip.has(i)) continue;
        const d = Math.hypot((items[i].lon - lon) * mx, (items[i].lat - lat) * my);
        if (d <= bd) { bd = d; best = i; }
      }
      return best;
    },
  };
}

// ── CSV
function parseCSV(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : first.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return {sep, rows: rows.filter(r => r.some(x => x.trim()))};
}
const CSV_COLS = {
  id: ['id', 'codigo', 'código', 'cod'], lon: ['lon', 'lng', 'long', 'longitud', 'longitude', 'x'], lat: ['lat', 'latitud', 'latitude', 'y'],
  height: ['altura', 'height', 'height_m', 'altura_m', 'alto'], levels: ['pisos', 'niveles', 'levels', 'building:levels'],
  area: ['area', 'área', 'area_m2', 'superficie'], use: ['uso', 'use', 'destino', 'tipo'], structure: ['estructura', 'material', 'structure', 'construccion', 'construcción'],
  notes: ['notas', 'observaciones', 'obs', 'notes', 'comentario'], name: ['nombre', 'name', 'direccion', 'dirección'],
};
const NUM = new Set(['lon', 'lat', 'height', 'levels', 'area']);

export class ScenarioEditor {
  constructor({api, map, host, onApply, onSaved, status}) {
    Object.assign(this, {api, map, onApply, onSaved, status});
    this.root = h('div', {id: 'editor', hidden: true});
    host.appendChild(this.root);
    this.tab = 'general';
    this.picking = null;
    this.mini = false;       // minimizado: barra inferior, el mapa queda visible
    this.mapSelect = false;  // esperando un clic en el mapa para elegir un edificio
    this.selected = null;
    this.page = 0;
    this.filter = 'all';
    this.layer = L.layerGroup().addTo(map);
    map.on('click', e => this.mapClick(e));
    map.on('dblclick', e => { if (this.picking) { L.DomEvent.stop(e); this.finishPick(); } });
    document.addEventListener('keydown', e => {
      if (!this.picking || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === 'Enter') this.finishPick();
      if (e.key === 'Escape') this.cancelPick();
    });
  }

  get isOpen() { return !this.root.hidden; }
  // el mapa pertenece al editor mientras se dibuja o se eligen edificios
  get capturesMapClicks() { return this.isOpen && (!!this.picking || this.mapSelect); }

  async schema() {
    if (this.defs) return this.defs;
    // esquema del backend; si no responde, la copia local (schema.json) permite editar igual
    let j = null;
    try { const r = await fetch(this.api + '/openapi.json'); if (r.ok) j = await r.json(); } catch { /* backend caído */ }
    if (!j) { const r = await fetch('schema.json'); if (!r.ok) throw new Error('No se pudo leer el esquema de parámetros'); j = await r.json(); }
    this.defs = j.components.schemas;
    this.sim = schemaOf(this.defs, 'SimRequest');
    return this.defs;
  }

  async open(ex, orig) {
    await this.schema();
    this.orig = clone(orig || ex);
    this.d = clone(ex);
    this.d.params = this.d.params || {};
    this.d.buildings = normBuildings(this.d);
    this.d.building_defaults = this.d.building_defaults || {height_m: 6};
    this.d.field = this.d.field || {date: '', by: '', notes: ''};
    this.selected = null; this.page = 0; this.mini = false; this.mapSelect = false;
    this.root.hidden = false;
    this.render();
  }

  close() { this.cancelPick(); this.mapSelect = false; this.layer.clearLayers(); this.root.hidden = true; }

  // ───────────── estructura
  render() {
    const tabs = [['general', 'General'], ['params', 'Parámetros'], ['elements', 'Elementos del escenario'], ['buildings', 'Edificios'], ['missing', 'Datos faltantes']];
    const miss = this.missing().length;
    this.root.replaceChildren(...[
      h('div', {class: 'ed-head'},
        h('b', {}, I('pencil'), ' Editor del escenario'), h('span', {class: 'ed-title'}, this.d.title || ''),
        this.picking || this.mapSelect ? null : h('button', {class: 'tool ed-x', title: this.mini ? 'Volver al editor' : 'Minimizar para ver el mapa',
          onclick: () => { this.mini = !this.mini; this.render(); }}, I(this.mini ? 'chevron-up' : 'map'), this.mini ? 'Abrir editor' : 'Ver mapa'),
        h('button', {class: 'tool ed-x', title: 'Cerrar sin aplicar', onclick: () => this.close()}, I('x'), 'Cerrar')),
      h('div', {class: 'ed-tabs'}, tabs.map(([k, t]) => h('button', {class: 'tool' + (this.tab === k ? ' active' : ''), onclick: () => { this.tab = k; this.render(); }},
        t, k === 'missing' && miss ? h('span', {class: 'ed-badge'}, miss) : null))),
      h('div', {class: 'ed-body'}, this['tab_' + this.tab]()),
      h('div', {class: 'ed-foot'},
        h('button', {class: 'tool', onclick: () => this.apply(false), title: 'Carga estos datos en el formulario y en el mapa'}, I('check'), 'Aplicar'),
        h('button', {onclick: () => this.apply(true)}, I('play'), 'Aplicar y simular'),
        h('button', {class: 'tool', onclick: () => this.save()}, I('save'), 'Guardar como escenario'),
        h('button', {class: 'tool', onclick: () => this.download()}, I('download'), 'Descargar JSON'),
        h('label', {class: 'tool ed-file', title: 'Abrir un escenario .json'}, I('upload'), 'Abrir JSON', h('input', {type: 'file', accept: '.json,application/json', onchange: e => this.importJSON(e.target.files[0])}))),
      this.picking ? h('div', {class: 'ed-pick'}, this.picking.msg, ' ',
        h('button', {class: 'tool', onclick: () => this.finishPick()}, 'Terminar'), h('button', {class: 'tool', onclick: () => this.cancelPick()}, 'Cancelar')) : null,
      this.mapSelect ? h('div', {class: 'ed-pick'}, 'Hacé clic sobre un edificio en el mapa. ',
        h('button', {class: 'tool', onclick: () => { this.mapSelect = false; this.render(); }}, 'Cancelar')) : null,
    ].filter(Boolean));
    this.root.classList.toggle('mini', !!(this.mini || this.picking || this.mapSelect));
    this.drawMapLayer();
  }

  // ───────────── General
  tab_general() {
    const d = this.d, f = d.field;
    const inp = (obj, k, attrs = {}) => h('input', {value: obj[k] ?? '', ...attrs, oninput: e => { obj[k] = e.target.value; }});
    const area = (obj, k, rows, get = v => v, set = v => v) => h('textarea', {rows, oninput: e => { obj[k] = set(e.target.value); }}, get(obj[k] ?? ''));
    return h('div', {class: 'ed-grid1'},
      h('label', {}, 'Título', inp(d, 'title')),
      h('label', {}, 'Descripción', area(d, 'description', 4)),
      h('label', {}, 'Créditos científicos (uno por línea: autores, año, título, publicación y enlace)', area(d, 'credits', 3, v => (v || []).join('\n'), v => v.split('\n').map(s => s.trim()).filter(Boolean))),
      h('label', {}, 'Fuentes (una por línea)', area(d, 'sources', 3, v => (v || []).join('\n'), v => v.split('\n').map(s => s.trim()).filter(Boolean))),
      h('div', {class: 'ed-sub'}, 'Relevamiento de campo'),
      h('div', {class: 'grid2'},
        h('label', {}, 'Fecha o período', inp(f, 'date', {placeholder: 'AAAA-MM-DD, AAAA-MM o 1968–2022'})),
        h('label', {}, 'Responsable / equipo', inp(f, 'by'))),
      h('label', {}, 'Notas de campo (método, instrumentos, observaciones)', area(f, 'notes', 4)),
      this.orig.id && d.edited_from == null ? h('p', {class: 'hint'}, `Al guardar se crea un escenario nuevo a partir de "${this.orig.title}"; el ejemplo original no se modifica.`) : null,
    );
  }

  // ───────────── Parámetros escalares
  tab_params() {
    const p = this.d.params, o = this.orig.params || {};
    const box = h('div', {});
    const b = p.bbox || (p.bbox = {});
    box.append(h('div', {class: 'ed-sub'}, 'Zona de cálculo (bbox)'),
      h('div', {class: 'grid4'}, ['west', 'east', 'south', 'north'].map(k => h('label', {}, label(k),
        h('input', {type: 'number', step: 0.0001, value: b[k] ?? '', oninput: e => { b[k] = e.target.value === '' ? undefined : +e.target.value; }})))));
    for (const [title, keys] of GROUPS) {
      const rows = keys.filter(k => this.sim[k]).map(k => this.paramRow(p, o, k));
      box.append(h('div', {class: 'ed-sub'}, title), h('table', {class: 'ed-table'}, h('tbody', {}, rows)));
    }
    box.append(h('div', {class: 'ed-sub'}, label('release_polygon')),
      this.geomField(p, 'release_polygon', 'polygon', 'Sin polígono: se usa un círculo alrededor del punto de inicio.'));
    box.append(h('p', {class: 'hint'}, 'Estado: "ejemplo" = valor del escenario original · "formulario" = valor del panel izquierdo · "editado" = cambiado aquí · "por defecto" = el ejemplo no lo define y se usa el valor del backend (escribí un valor para agregarlo).'));
    return box;
  }

  paramRow(p, o, k) {
    const s = this.sim[k], has = p[k] !== undefined;
    const tag = () => !has ? ['por defecto', 'def'] : JSON.stringify(p[k]) !== JSON.stringify(o[k]) ? (k in o ? ['editado', 'mod'] : ['agregado', 'mod']) : ['ejemplo', 'ok'];
    const badge = h('span', {class: 'ed-tag'});
    const upd = () => { const [t, c] = tag(); badge.textContent = t; badge.className = 'ed-tag ' + c; };
    upd();
    const set = v => { if (v === undefined) delete p[k]; else p[k] = v; upd(); };
    let input;
    if (s.kind === 'enum') {
      input = h('select', {onchange: e => set(e.target.value === '' ? undefined : e.target.value)},
        h('option', {value: ''}, `— por defecto (${s.default ?? '—'}) —`), s.options.map(v => h('option', {value: v, selected: p[k] === v}, v)));
    } else if (s.kind === 'bool') {
      input = h('select', {onchange: e => set(e.target.value === '' ? undefined : e.target.value === 'true')},
        h('option', {value: ''}, `— por defecto (${s.default ? 'sí' : 'no'}) —`), h('option', {value: 'true', selected: p[k] === true}, 'sí'), h('option', {value: 'false', selected: p[k] === false}, 'no'));
    } else {
      const num = s.kind === 'number' || s.kind === 'int';
      input = h('input', {type: num ? 'number' : 'text', value: p[k] ?? '', step: 'any', min: s.min, max: s.max,
        placeholder: s.default != null ? `por defecto ${s.default}` : s.nullable ? 'vacío = automático' : '',
        oninput: e => {
          const v = e.target.value;
          e.target.classList.toggle('bad', num && !!e.target.validity && (e.target.validity.rangeUnderflow || e.target.validity.rangeOverflow));
          set(v === '' ? (s.nullable && k in o && o[k] === null ? null : undefined) : num ? +v : v);
        }});
    }
    const rng = s.min != null || s.max != null ? `${s.min ?? ''} – ${s.max ?? ''}` : '';
    return h('tr', {}, h('td', {title: k}, label(k)), h('td', {}, input), h('td', {class: 'ed-rng'}, rng), h('td', {}, badge));
  }

  // ───────────── Elementos (listas)
  tab_elements() {
    const p = this.d.params, box = h('div', {});
    for (const [key, title, ref, geom, single, one] of LISTS) {
      const sch = schemaOf(this.defs, ref);
      const items = single ? (p[key] ? [p[key]] : []) : (p[key] || []);
      const sec = h('details', {class: 'ed-list', open: items.length ? true : null},
        h('summary', {}, `${title} `, h('span', {class: 'ed-count'}, single ? (items.length ? 'definida' : 'no definida') : `${items.length}`)));
      items.forEach((it, idx) => sec.append(this.itemCard(it, sch, geom, () => {
        if (single) delete p[key]; else { p[key].splice(idx, 1); if (!p[key].length) delete p[key]; }
        this.render();
      })));
      if (!single || !items.length) sec.append(h('button', {class: 'tool ed-add', onclick: () => {
        const it = this.newItem(sch);
        if (single) p[key] = it; else (p[key] = p[key] || []).push(it);
        this.render();
      }}, I('plus'), 'Agregar ' + one));
      box.append(sec);
    }
    box.append(h('p', {class: 'hint'}, 'Las coordenadas son [lon, lat] (WGS84). Podés pegarlas desde un GPS o un SIG, o dibujarlas en el mapa. Los campos marcados "falta" son obligatorios.'));
    return box;
  }

  newItem(sch) {
    const it = {};
    for (const [k, s] of Object.entries(sch)) if (s.default !== undefined && s.kind !== 'list') it[k] = s.default;
    return it;
  }

  itemCard(it, sch, geomKind, onDelete) {
    const card = h('div', {class: 'ed-card'});
    const head = h('div', {class: 'ed-card-h'}, h('b', {}, it.name || '(sin nombre)'), h('button', {class: 'secondary ed-del', title: 'Quitar', onclick: onDelete}, I('trash')));
    card.append(head);
    const grid = h('div', {class: 'grid2'});
    for (const [k, s] of Object.entries(sch)) {
      if (s.kind === 'geom') { card.append(h('div', {class: 'ed-geomlbl'}, label(k), s.required && !(it[k] && it[k].length) ? h('span', {class: 'ed-tag def'}, 'falta') : null), this.geomField(it, k, k === 'section' ? 'section' : geomKind === 'polygon' ? 'polygon' : 'line')); continue; }
      if (s.kind === 'list') { card.append(this.subList(it, k, schemaOf(this.defs, s.ref))); continue; }
      if (s.kind === 'object') { card.append(this.subObject(it, k, s)); continue; }
      grid.append(this.scalarField(it, k, s, () => { if (k === 'name') head.firstChild.textContent = it.name || '(sin nombre)'; }));
    }
    card.insertBefore(grid, card.children[1] || null);
    return card;
  }

  // objeto anidado opcional (p. ej. desencadenante por lluvia de una masa)
  subObject(it, k, s) {
    const sch = schemaOf(this.defs, s.ref);
    const box = h('div', {class: 'ed-objbox'}, h('div', {class: 'ed-geomlbl'}, label(k)));
    if (!it[k]) {
      box.append(h('p', {class: 'hint'}, s.description || ''),
        h('button', {class: 'tool ed-add', onclick: () => { it[k] = this.newItem(sch); this.render(); }}, I('plus'), 'Agregar ' + label(k).toLowerCase()));
      return box;
    }
    box.append(h('div', {class: 'grid3'}, Object.entries(sch).map(([kk, ss]) => this.scalarField(it[k], kk, ss, null, ss.description))),
      h('button', {class: 'tool ed-add', onclick: () => { delete it[k]; this.render(); }}, I('trash'), 'Quitar ' + label(k).toLowerCase()));
    return box;
  }

  subList(it, k, sch) {
    const box = h('div', {class: 'ed-sublist'}, h('div', {class: 'ed-geomlbl'}, label(k)));
    (it[k] || []).forEach((sub, i) => box.append(h('div', {class: 'ed-subitem'},
      h('div', {class: 'grid3'}, Object.entries(sch).map(([kk, s]) => this.scalarField(sub, kk, s))),
      h('button', {class: 'secondary ed-del', onclick: () => { it[k].splice(i, 1); if (!it[k].length) delete it[k]; this.render(); }}, I('trash')))));
    box.append(h('button', {class: 'tool ed-add', onclick: () => { (it[k] = it[k] || []).push(this.newItem(sch)); this.render(); }}, I('plus'), 'Agregar'));
    return box;
  }

  scalarField(obj, k, s, after, text) {
    const miss = s.required && (obj[k] === undefined || obj[k] === null || obj[k] === '');
    const tag = h('span', {class: 'ed-tag def', hidden: !miss}, 'falta');
    const done = () => { tag.hidden = !(s.required && (obj[k] === undefined || obj[k] === '')); after && after(); };
    let input;
    if (s.kind === 'enum') input = h('select', {onchange: e => { obj[k] = e.target.value; done(); }}, s.options.map(v => h('option', {value: v, selected: obj[k] === v}, v)));
    else if (s.kind === 'bool') input = h('select', {onchange: e => { obj[k] = e.target.value === 'true'; done(); }},
      h('option', {value: 'false', selected: !obj[k]}, 'no'), h('option', {value: 'true', selected: !!obj[k]}, 'sí'));
    else {
      const num = s.kind === 'number' || s.kind === 'int';
      input = h('input', {type: num ? 'number' : 'text', step: 'any', value: obj[k] ?? '', min: s.min, max: s.max,
        placeholder: s.nullable ? 'vacío = automático / global' : s.required ? 'obligatorio' : '',
        oninput: e => { const v = e.target.value; if (v === '') delete obj[k]; else obj[k] = num ? +v : v; done(); }});
    }
    return h('label', {title: s.description || k}, text || label(k), ' ', tag, input);
  }

  geomField(obj, k, kind, emptyNote) {
    const c = obj[k];
    const n = c ? c.length : 0;
    const info = !n ? (emptyNote || 'Sin coordenadas') : kind === 'polygon' ? `${n} vértices · ${fmt(ringArea(c) / 1e4, 2)} ha` : `${n} puntos · ${fmt(lineLength(c), 0)} m`;
    const ta = h('textarea', {rows: 3, hidden: true, spellcheck: 'false'}, n ? JSON.stringify(c.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)])) : '');
    const err = h('span', {class: 'ed-err'});
    ta.addEventListener('change', () => {
      const t = ta.value.trim();
      if (!t) { delete obj[k]; this.render(); return; }
      try {
        const v = JSON.parse(t);
        if (!Array.isArray(v) || !v.every(q => Array.isArray(q) && q.length >= 2 && q.every(Number.isFinite))) throw new Error('formato [[lon, lat], …]');
        if (kind === 'section' && v.length !== 2) throw new Error('la sección necesita exactamente 2 puntos');
        if (v.some(([lo, la]) => Math.abs(la) > 90 || Math.abs(lo) > 180)) throw new Error('¿lat y lon invertidas?');
        obj[k] = v.map(q => [q[0], q[1]]); this.render();
      } catch (e) { err.textContent = 'Coordenadas inválidas: ' + e.message; }
    });
    return h('div', {class: 'ed-geom'},
      h('span', {class: 'ed-ginfo'}, info),
      h('button', {class: 'tool', onclick: () => { ta.hidden = !ta.hidden; }}, I('pencil'), 'Coordenadas'),
      h('button', {class: 'tool', onclick: () => this.startPick(obj, k, kind)}, I(kind === 'polygon' ? 'polygon' : 'measure'), 'Dibujar'),
      n ? h('button', {class: 'tool', onclick: () => this.flash(c, kind)}, I('zoom-to-object'), 'Ver') : null,
      ta, err);
  }

  // ───────────── dibujo en el mapa
  startPick(obj, k, kind) {
    this.cancelPick();
    const max = kind === 'section' ? 2 : Infinity;
    this.picking = {obj, k, kind, max, pts: [], msg: kind === 'section' ? 'Clic en las dos márgenes del cauce.' :
      `Clic en el mapa agrega vértices; doble clic o Enter termina (${kind === 'polygon' ? 'mín. 3' : 'mín. 2'}).`};
    this.map.doubleClickZoom.disable();
    document.getElementById('map').classList.add('drawing');
    this.render();
  }
  finishPick() {
    const P = this.picking;
    if (!P) return;
    const need = P.kind === 'polygon' ? 3 : 2;
    if (P.pts.length >= need) P.obj[P.k] = P.pts.map(ll => [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]);
    this.cancelPick();
  }
  cancelPick() {
    if (!this.picking) return;
    this.picking = null;
    this.map.doubleClickZoom.enable();
    document.getElementById('map').classList.remove('drawing');
    if (this.isOpen) this.render();
  }
  mapClick(e) {
    if (!this.isOpen) return;
    const P = this.picking;
    if (P) {
      P.pts.push(e.latlng);
      if (P.pts.length >= P.max) { this.finishPick(); return; }
      this.drawMapLayer();
      return;
    }
    if (this.mapSelect) { this.mapSelect = false; this.selectNear(e.latlng); }
  }
  flash(c, kind) {
    const ll = c.map(([lo, la]) => [la, lo]);
    const l = (kind === 'polygon' ? L.polygon(ll) : L.polyline(ll)).setStyle({color: '#ff3df2', weight: 4, fillOpacity: .15});
    this.layer.addLayer(l);
    this.map.fitBounds(l.getBounds(), {padding: [40, 40], maxZoom: 16});
    setTimeout(() => this.layer.removeLayer(l), 2500);
  }
  drawMapLayer() {
    this.layer.clearLayers();
    const P = this.picking;
    if (P && P.pts.length) {
      this.layer.addLayer((P.kind === 'polygon' ? L.polygon(P.pts) : L.polyline(P.pts)).setStyle({color: '#ff3df2', weight: 3, dashArray: '5 4', fillOpacity: .1, interactive: false}));
      P.pts.forEach(p => this.layer.addLayer(L.circleMarker(p, {radius: 4, color: '#ff3df2', fillOpacity: 1, interactive: false})));
    }
    if (this.isOpen && this.tab === 'buildings' && this.selected != null) {
      const b = this.d.buildings[this.selected];
      if (b) this.layer.addLayer(L.circleMarker([b.lat, b.lon], {radius: 9, color: '#ff3df2', weight: 3, fill: false, interactive: false}));
    }
  }

  // ───────────── Edificios
  bStats() {
    const B = this.d.buildings, c = {total: B.length, campo: 0, gba: 0, pisos: 0, none: 0};
    for (const b of B) {
      if (b.height > 0) c[b.hsrc === 'campo' ? 'campo' : 'gba']++;
      else if (b.levels > 0) c.pisos++;
      else c.none++;
    }
    c.src = Object.entries(B.reduce((m, b) => { const s = b.src || '—'; m[s] = (m[s] || 0) + 1; return m; }, {})).map(([s, n]) => `${s}: ${fmt(n, 0)}`).join(' · ');
    return c;
  }

  tab_buildings() {
    const d = this.d, B = d.buildings, c = this.bStats(), zones = (d.params.exposure || []).filter(z => z.polygon && z.polygon.length >= 3);
    const box = h('div', {});
    box.append(h('table', {class: 'ed-table ed-stats'}, h('tbody', {},
      h('tr', {}, h('td', {}, 'Edificios'), h('td', {}, h('b', {}, fmt(c.total, 0))), h('td', {class: 'hint', colspan: 2}, c.src)),
      h('tr', {}, h('td', {}, 'Altura de campo'), h('td', {}, fmt(c.campo, 0)), h('td', {}, 'Altura GBA / otra fuente'), h('td', {}, fmt(c.gba, 0))),
      h('tr', {}, h('td', {}, 'Solo pisos (3 m c/u)'), h('td', {}, fmt(c.pisos, 0)), h('td', {}, 'Sin dato de altura'), h('td', {class: c.none ? 'ed-warn' : ''}, fmt(c.none, 0))))));
    box.append(h('label', {class: 'ed-inline'}, 'Altura para edificios sin dato (m, solo visual)',
      h('input', {type: 'number', min: 2, max: 200, step: 0.5, value: d.building_defaults.height_m, oninput: e => { d.building_defaults.height_m = +e.target.value || 6; }})));

    // GlobalBuildingAtlas
    const mode = h('select', {},
      h('option', {value: 'complete'}, 'Completar: alturas para los existentes + sumar edificios nuevos'),
      h('option', {value: 'heights'}, 'Solo alturas para los edificios existentes'),
      h('option', {value: 'replace'}, 'Reemplazar por GBA (conserva los datos de campo cercanos)'));
    const onlyZones = h('input', {type: 'checkbox', checked: zones.length ? true : null, disabled: zones.length ? null : true});
    const gbaMsg = h('div', {class: 'hint'});
    box.append(h('div', {class: 'ed-sub'}, 'GlobalBuildingAtlas (huellas y alturas LoD1)'),
      h('div', {class: 'ed-row'}, mode,
        h('button', {class: 'tool', onclick: e => this.loadGBA(mode.value, onlyZones.checked ? zones : null, gbaMsg, e.currentTarget)}, I('download'), 'Obtener de GBA')),
      h('label', {class: 'check'}, onlyZones, `Solo edificios nuevos dentro de las zonas expuestas${zones.length ? '' : ' (no hay zonas)'}`), gbaMsg);

    // CSV de campo
    const csvMsg = h('div', {class: 'hint'});
    box.append(h('div', {class: 'ed-sub'}, 'Datos de campo (CSV)'),
      h('div', {class: 'ed-row'},
        h('label', {class: 'tool ed-file'}, I('file-csv'), 'Importar CSV', h('input', {type: 'file', accept: '.csv,.txt,.tsv', onchange: e => this.importCSV(e.target.files[0], csvMsg)})),
        h('button', {class: 'tool', onclick: () => this.exportCSV()}, I('download'), 'Exportar CSV (planilla de campo)')),
      h('p', {class: 'hint'}, 'Columnas reconocidas: id, lon, lat, altura (m), pisos, área, uso, estructura, notas, nombre. Cada fila se asocia por id o al edificio más cercano (≤ 15 m); si no hay ninguno, se agrega como edificio nuevo. Exportá la planilla, completala en campo y volvé a importarla.'),
      csvMsg);

    // tabla
    box.append(h('div', {class: 'ed-sub'}, 'Tabla de edificios'), this.buildingTable());
    return box;
  }

  buildingTable() {
    const B = this.d.buildings, PER = 40;
    const flt = {all: () => true, none: b => !(buildingHeight(b) > 0), campo: b => b.hsrc === 'campo' || b.src === 'campo', sel: (b, i) => i === this.selected};
    const idx = B.map((b, i) => i).filter(i => flt[this.filter](B[i], i));
    const pages = Math.max(1, Math.ceil(idx.length / PER));
    this.page = Math.min(this.page, pages - 1);
    const rows = idx.slice(this.page * PER, (this.page + 1) * PER).map(i => {
      const b = B[i];
      const cell = (k, type = 'number', w) => h('td', {}, h('input', {type, step: 'any', value: b[k] ?? '', style: w ? `width:${w}` : null,
        oninput: e => { const v = e.target.value; if (v === '') b[k] = null; else b[k] = type === 'number' ? +v : v; if (k === 'height') b.hsrc = v === '' ? null : 'campo'; }}));
      return h('tr', {class: i === this.selected ? 'sel' : null},
        h('td', {}, h('a', {href: '#', title: 'Ver en el mapa', onclick: e => { e.preventDefault(); this.selected = i; this.map.setView([b.lat, b.lon], Math.max(this.map.getZoom(), 17)); this.render(); }}, b.id)),
        cell('height', 'number', '62px'), h('td', {class: 'ed-src'}, b.height > 0 ? (b.hsrc || 'GBA') : ''), cell('levels', 'number', '48px'),
        cell('use', 'text', '90px'), cell('structure', 'text', '90px'), cell('notes', 'text', '130px'),
        h('td', {class: 'ed-src'}, fmt(b.area, 0)), h('td', {class: 'ed-src'}, b.src || ''),
        h('td', {}, h('button', {class: 'secondary ed-del', title: 'Quitar edificio', onclick: () => { B.splice(i, 1); this.selected = null; this.render(); }}, I('trash'))));
    });
    const fsel = h('select', {onchange: e => { this.filter = e.target.value; this.page = 0; this.render(); }},
      [['all', 'Todos'], ['none', 'Sin altura'], ['campo', 'Con datos de campo'], ['sel', 'Seleccionado en el mapa']].map(([v, t]) => h('option', {value: v, selected: this.filter === v}, t)));
    return h('div', {},
      h('div', {class: 'ed-row'}, fsel,
        h('button', {class: 'tool', disabled: this.page === 0 ? true : null, onclick: () => { this.page--; this.render(); }}, I('chevron-left')),
        h('span', {class: 'hint'}, `${fmt(idx.length, 0)} edificios · pág. ${this.page + 1}/${pages}`),
        h('button', {class: 'tool', disabled: this.page >= pages - 1 ? true : null, onclick: () => { this.page++; this.render(); }}, I('chevron-right'))),
      h('div', {class: 'ed-row'}, h('button', {class: 'tool', onclick: () => { this.mapSelect = true; this.render(); }}, I('cursor-click'), 'Elegir edificio en el mapa'),
        h('span', {class: 'hint'}, 'Cambiar la altura la marca como dato de campo.')),
      h('div', {class: 'ed-scroll'}, h('table', {class: 'ed-table ed-btable'},
        h('thead', {}, h('tr', {}, ['id', 'Altura (m)', 'fuente', 'Pisos', 'Uso', 'Estructura', 'Notas', 'Área m²', 'Origen', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, rows))));
  }

  selectNear(ll) {
    const B = this.d.buildings;
    let best = null, bd = 25;
    const p = this.map.latLngToContainerPoint(ll);
    B.forEach((b, i) => { const d = p.distanceTo(this.map.latLngToContainerPoint([b.lat, b.lon])); if (d < bd) { bd = d; best = i; } });
    this.selected = best;
    this.filter = best != null ? 'sel' : 'all';
    this.page = 0;
    this.render();
  }

  async loadGBA(mode, zones, msg, btn) {
    const b = this.d.params.bbox;
    if (!b || !(b.east > b.west && b.north > b.south)) { msg.textContent = 'Definí primero la zona de cálculo (bbox).'; return; }
    btn.disabled = true;
    msg.textContent = 'Descargando GlobalBuildingAtlas para la zona… (la primera vez puede tardar hasta un minuto)';
    try {
      const r = await fetch(this.api + '/api/buildings/gba', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)});
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      const res = this.mergeGBA(j.buildings, mode, zones);
      const src = 'GlobalBuildingAtlas LoD1 (Zhu et al., 2025, TUM; doi:10.14459/2025mp1782307) vía Source Cooperative.';
      this.d.sources = this.d.sources || [];
      if (!this.d.sources.some(s => s.includes('GlobalBuildingAtlas'))) this.d.sources.push('Edificios: ' + src);
      this.render();
      this.root.querySelector('.ed-body').scrollTop = 0;
      this.status(`GBA: ${fmt(j.count, 0)} edificios en la zona (${fmt(j.with_height, 0)} con altura). ${res}`);
    } catch (e) {
      msg.textContent = 'Error: ' + e.message;
      btn.disabled = false;
    }
  }

  mergeGBA(G, mode, zones) {
    const B = this.d.buildings;
    const inZones = g => !zones || zones.some(z => inPoly(g.lon, g.lat, z.polygon));
    const ix = spatialIndex(G), used = new Set();
    let hits = 0, hs = 0;
    const match = B.map(b => {
      const tol = Math.max(8, Math.sqrt(b.area || 60) / 2 + 5);
      const k = ix.nearest(b.lon, b.lat, tol, used);
      if (k >= 0) { used.add(k); hits++; }
      return k;
    });
    const fromG = (g, n) => ({id: 'g' + n, lon: g.lon, lat: g.lat, area: g.area, levels: null, height: g.height, hsrc: g.height ? 'GBA' : null, src: g.source});
    if (mode === 'replace') {
      const pos = new Map(), out = [];
      G.forEach((g, k) => { if (used.has(k) || inZones(g)) { pos.set(k, out.length); out.push(fromG(g, out.length + 1)); } });
      // conservar los datos de campo de los edificios que coinciden
      B.forEach((b, i) => {
        const k = match[i];
        if (k < 0) return;
        const t = out[pos.get(k)];
        for (const f of ['use', 'structure', 'notes', 'name', 'levels']) if (b[f] != null && b[f] !== '') t[f] = b[f];
        if (b.hsrc === 'campo') { t.height = b.height; t.hsrc = 'campo'; }
      });
      this.d.buildings = out;
      return `Reemplazados: ${fmt(out.length, 0)} edificios GBA (${fmt(hits, 0)} conservan datos del ejemplo).`;
    }
    B.forEach((b, i) => {
      const g = match[i] >= 0 ? G[match[i]] : null;
      if (!g) return;
      if (g.height && b.hsrc !== 'campo') { b.height = g.height; b.hsrc = 'GBA'; hs++; }
      if (!b.area) b.area = g.area;
    });
    let added = 0;
    if (mode === 'complete') {
      let n = B.length;
      G.forEach((g, k) => { if (!used.has(k) && inZones(g)) { B.push(fromG(g, ++n)); added++; } });
    }
    return `${fmt(hits, 0)} edificios del ejemplo encontrados en GBA, ${fmt(hs, 0)} con altura nueva${mode === 'complete' ? `, ${fmt(added, 0)} edificios agregados` : ''}.`;
  }

  exportCSV() {
    const cols = ['id', 'lon', 'lat', 'altura_m', 'fuente_altura', 'pisos', 'area_m2', 'uso', 'estructura', 'notas', 'origen'];
    const q = v => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.join(',')].concat(this.d.buildings.map(b =>
      [b.id, b.lon, b.lat, b.height, b.height > 0 ? b.hsrc || 'GBA' : '', b.levels, b.area, b.use, b.structure, b.notes, b.src].map(q).join(',')));
    this.saveFile(lines.join('\n'), (this.d.id || 'escenario') + '_edificios.csv', 'text/csv');
  }

  async importCSV(file, msg) {
    if (!file) return;
    const {sep, rows} = parseCSV(await file.text());
    if (rows.length < 2) { msg.textContent = 'El CSV no tiene filas.'; return; }
    const head = rows[0].map(s => s.trim().toLowerCase());
    const col = {};
    for (const [k, al] of Object.entries(CSV_COLS)) { const i = head.findIndex(x => al.includes(x)); if (i >= 0) col[k] = i; }
    if (col.id == null && (col.lon == null || col.lat == null)) { msg.textContent = 'Faltan columnas: se necesita id o lon + lat.'; return; }
    const B = this.d.buildings, byId = new Map(B.map((b, i) => [String(b.id), i])), ix = spatialIndex(B);
    const num = v => { if (v == null) return null; v = v.trim(); if (!v) return null; if (sep === ';') v = v.replace(',', '.'); const n = +v; return isFinite(n) ? n : null; };
    let upd = 0, add = 0, bad = 0;
    for (const r of rows.slice(1)) {
      const rec = {};
      for (const [k, i] of Object.entries(col)) rec[k] = NUM.has(k) ? num(r[i]) : (r[i] ?? '').trim();
      let i = rec.id && byId.has(rec.id) ? byId.get(rec.id) : -1;
      if (i < 0 && rec.lon != null && rec.lat != null) {
        if (Math.abs(rec.lat) > 90) { bad++; continue; }
        i = ix.nearest(rec.lon, rec.lat, 15);
      }
      let b;
      if (i >= 0) { b = B[i]; upd++; }
      else if (rec.lon != null && rec.lat != null) { b = {id: rec.id || 'c' + (B.length + 1), lon: rec.lon, lat: rec.lat, area: rec.area || 60, src: 'campo'}; B.push(b); add++; }
      else { bad++; continue; }
      if (rec.height != null) { b.height = rec.height; b.hsrc = 'campo'; }
      for (const k of ['levels', 'area']) if (rec[k] != null) b[k] = rec[k];
      for (const k of ['use', 'structure', 'notes', 'name']) if (rec[k]) b[k] = rec[k];
    }
    this.render();
    this.status(`CSV de campo: ${fmt(upd, 0)} edificios actualizados, ${fmt(add, 0)} agregados${bad ? `, ${fmt(bad, 0)} filas sin ubicación válida` : ''}.`);
  }

  // ───────────── datos faltantes
  missing() {
    const out = [], p = this.d.params;
    if (!p.bbox || ['west', 'east', 'south', 'north'].some(k => !isFinite(p.bbox[k]))) out.push(['params', 'Zona de cálculo (bbox) incompleta']);
    for (const [key, title, ref, , single] of LISTS) {
      const sch = schemaOf(this.defs, ref), items = single ? (p[key] ? [p[key]] : []) : (p[key] || []);
      items.forEach((it, i) => {
        for (const [k, s] of Object.entries(sch)) {
          const v = it[k];
          if (s.required && (v == null || v === '' || (Array.isArray(v) && !v.length))) out.push(['elements', `${title} · ${it.name || '#' + (i + 1)}: falta ${label(k)}`]);
          if (s.kind === 'list' && v) v.forEach((sub, j) => Object.entries(schemaOf(this.defs, s.ref)).forEach(([kk, ss]) => {
            if (ss.required && (sub[kk] == null || sub[kk] === '')) out.push(['elements', `${title} · ${it.name || '#' + (i + 1)} · ${label(k)} ${j + 1}: falta ${label(kk)}`]);
          }));
        }
      });
    }
    if (!p.bodies && !p.release_polygon && p.source_lon == null) out.push(['params', 'Desprendimiento: sin polígono ni punto de inicio (se elige una ladera automáticamente)', true]);
    const c = this.bStats();
    if (c.total && c.none) out.push(['buildings', `${fmt(c.none, 0)} de ${fmt(c.total, 0)} edificios sin altura (ni de campo, ni GBA, ni pisos)`, true]);
    if (!c.total) out.push(['buildings', 'El escenario no tiene edificios expuestos', true]);
    if (!(this.d.params.exposure || []).length) out.push(['elements', 'No hay zonas expuestas definidas', true]);
    if (!this.d.field.date) out.push(['general', 'Fecha del relevamiento de campo', true]);
    return out;
  }

  tab_missing() {
    const m = this.missing();
    if (!m.length) return h('p', {}, I('check-circle'), ' No faltan datos obligatorios.');
    return h('div', {},
      h('p', {class: 'hint'}, 'En rojo: obligatorio para simular. En amarillo: recomendable. Clic para ir a la pestaña.'),
      h('ul', {class: 'ed-miss'}, m.map(([tab, t, soft]) => h('li', {class: soft ? 'soft' : 'hard'},
        h('a', {href: '#', onclick: e => { e.preventDefault(); this.tab = tab; this.render(); }}, t)))));
  }

  // ───────────── salida
  result() {
    const d = clone(this.d);
    d.buildings = d.buildings.map(b => Object.fromEntries(Object.entries(b).filter(([, v]) => v != null && v !== '')));
    d.params.exposure_points = d.buildings.map(b => [b.lon, b.lat]);
    if (!d.buildings.length) { delete d.buildings; delete d.params.exposure_points; }
    if (!d.field.date && !d.field.by && !d.field.notes) delete d.field;
    if (d.credits && !d.credits.length) delete d.credits;
    return d;
  }

  apply(run) {
    const hard = this.missing().filter(m => !m[2]);
    if (hard.length) { this.tab = 'missing'; this.render(); this.status('Faltan datos obligatorios: ' + hard.map(m => m[1]).join(' · '), true); return; }
    const d = this.result();
    this.close();
    this.onApply(d, run);
  }

  async save() {
    const hard = this.missing().filter(m => !m[2]);
    if (hard.length) { this.tab = 'missing'; this.render(); this.status('No se puede guardar: faltan datos obligatorios.', true); return; }
    const d = this.result();
    if (!d.title) { this.tab = 'general'; this.render(); this.status('El escenario necesita un título.', true); return; }
    if (!this.orig.custom) {
      // copia de un ejemplo original: nuevo id; los resultados de referencia eran de los datos originales
      if (d.title === this.orig.title) d.title += ' — datos de campo';
      d.edited_from = this.orig.id;
      delete d.id;
      delete d.reference;
    }
    d.custom = true;
    d.updated = new Date().toISOString();
    try {
      const r = await fetch(this.api + '/api/examples', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({example: d})});
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail));
      d.id = j.id;
      this.d = Object.assign(this.d, {id: j.id, title: d.title, edited_from: d.edited_from, custom: true});
      this.orig = clone(this.d);
      this.status(`Escenario guardado como <b>${esc(d.title)}</b> (examples/${j.file}).`);
      this.onSaved(j.id, d);
      this.render();
    } catch (e) { this.status('Error al guardar: ' + e.message, true); }
  }

  download() { this.saveFile(JSON.stringify(this.result(), null, 1), (this.d.id || 'escenario') + '.json', 'application/json'); }

  saveFile(text, name, type) {
    const a = h('a', {href: URL.createObjectURL(new Blob([text], {type})), download: name});
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importJSON(file) {
    if (!file) return;
    try {
      const ex = JSON.parse(await file.text());
      if (!ex.params) throw new Error('el archivo no tiene "params"');
      await this.open(ex, {...ex, custom: false});
      this.status(`Escenario importado: <b>${esc(ex.title || file.name)}</b>. Revisalo y aplicalo o guardalo.`);
    } catch (e) { this.status('JSON inválido: ' + e.message, true); }
  }
}
