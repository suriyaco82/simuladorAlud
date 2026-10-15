import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {initHelp, initPresets, invalidFields} from './help.js';
import {Realistic, STYLES, autoStyle, satelliteTexture, skyTexture} from './realistic.js';
import {Exposure, INTENSITY_COLORS, listExamples, fetchExample} from './exposure.js';
import {ScenarioEditor} from './editor.js';
import {ic, hydrateIcons} from './icons.js';
import {RainPanel} from './rain.js';
import {BasinsPanel, floodBasinsHTML, FLOW} from './basins.js';
import {PlainPanel} from './plain.js';
import {RAMPS, hexRGB} from './palette.js';
import {ImpactZones} from './zones.js';
import {LibraryPanel, loadAnalysis} from './library.js';
import {buildReport, buildComparison, DocViewer} from './report.js';
import {methodsHTML} from './methods.js';
import {Wizard} from './wizard.js';

// Servido por el backend (Render, uvicorn): mismo origen. Servidor estático aparte (dev en :8080): backend local.
const API = location.port === '8080' || location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';
const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const fmtVol = v => v == null ? '—' : v >= 1e6 ? fmt(v / 1e6, 2) + ' M m³' : fmt(v, 0) + ' m³';
const fmtArea = a => a >= 1e6 ? fmt(a / 1e6, 2) + ' km²' : fmt(a / 1e4, 1) + ' ha';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const align4 = n => (n + 3) & ~3;
const metersPerDeg = lat => ({mx: 111320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)), my: 110540});

// ───────────────────────────── Paletas
function makeLUT(stops) {
  const cs = stops.map(s => new THREE.Color(s));  // hex sRGB -> espacio lineal de trabajo
  const lut = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (cs.length - 1), k = Math.min(cs.length - 2, Math.floor(t)), f = t - k;
    const c = cs[k].clone().lerp(cs[k + 1], f);
    lut[i * 3] = c.r; lut[i * 3 + 1] = c.g; lut[i * 3 + 2] = c.b;
  }
  return lut;
}
const LUT = Object.fromEntries(Object.entries(RAMPS).map(([k, v]) => [k, makeLUT(v)]));
const lutIndex = t => Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
const gradientCSS = stops => `linear-gradient(90deg,${stops.join(',')})`;

const LAYERS = {
  deposit:    {name: 'Espesor de depósito', unit: 'm', ramp: 'depth', mask: v => v > 0.05},
  net_change: {name: 'Cambio neto de superficie', unit: 'm', ramp: 'diverging', mask: v => Math.abs(v) > 0.05, diverging: true},
  erosion:    {name: 'Profundidad de erosión', unit: 'm', ramp: 'depth', mask: v => v > 0.01},
  max_depth:  {name: 'Profundidad máx. del flujo', unit: 'm', ramp: 'depth', mask: v => v > 0.05},
  max_speed:  {name: 'Velocidad máx.', unit: 'm/s', ramp: 'speed', mask: v => v > 0.1},
  max_pore:   {name: 'Presión de poros máx. λ', unit: '', ramp: 'pore', mask: v => v > 0.001, fixed: [0, 1]},
  arrival:    {name: 'Tiempo de arribo', unit: 's', ramp: 'arrival', mask: v => v >= 0},
  current:    {name: 'Espesor actual del flujo', unit: 'm', ramp: 'depth', mask: v => v > 0.2, dynamic: true},
  intensity:  {name: 'Intensidad (flujo de detritos)', unit: '', ramp: 'intensity', mask: v => v >= 1, fixed: [1, 3], cats: ['baja', 'media', 'alta']},
  max_pressure: {name: 'Presión dinámica máx. ρv²', unit: 'kPa', ramp: 'depth', mask: v => v > 0.1},
  max_cv:     {name: 'Concentración de sedimento máx. Cv', unit: '', ramp: 'pore', mask: v => v > 0.01, fixed: [0, 0.6]},
  max_hv:     {name: 'h·v máx.', unit: 'm²/s', ramp: 'depth', mask: v => v > 0.05},
  runoff_total: {name: 'Lluvia efectiva (escorrentía)', unit: 'mm', ramp: 'arrival', mask: v => v > 0.5, always: true},
  wet_time:   {name: 'Duración del anegamiento (h > 0,1 m)', unit: 'h', ramp: 'arrival', mask: v => v > 0.05},
};

// ───────────────────────────── Mapa
const map = L.map('map').setView([-29.375, -66.925], 12);
const esri = (svc, attribution, maxZoom = 19) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`, {maxZoom, attribution: '© Esri' + (attribution ? ', ' + attribution : '')});
const baseLayers = {
  'Imágenes (Esri)': esri('World_Imagery', 'Maxar, Earthstar Geographics'),
  'Topográfico (Esri)': esri('World_Topo_Map', 'HERE, Garmin, USGS'),
  'Calles (Esri)': esri('World_Street_Map', 'HERE, Garmin'),
  'Gris claro (Esri)': esri('Canvas/World_Light_Gray_Base', 'HERE, Garmin', 16),
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '© OpenStreetMap'}),
  'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {maxZoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)'}),
};
const refLayers = {
  'Etiquetas y límites (Esri)': esri('Reference/World_Boundaries_and_Places', ''),
  'Relieve sombreado (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {maxZoom: 16, opacity: .45, attribution: '© Esri'}),
};
baseLayers['Imágenes (Esri)'].addTo(map);
L.control.layers(baseLayers, refLayers).addTo(map);
L.control.scale({imperial: false}).addTo(map);

// Divisor arrastrable entre el mapa y la vista 3D; el tamaño elegido se recuerda en este navegador
(() => {
  const sec = $('split').parentElement, bar = $('split');
  const set = pct => {
    pct = Math.max(12, Math.min(88, pct));
    sec.style.setProperty('--split', pct + '%');
    bar.setAttribute('aria-valuenow', Math.round(pct));
    map.invalidateSize({pan: false});
    return pct;
  };
  const save = pct => { try { localStorage.setItem('splitPct', String(pct)); } catch { /* sin almacenamiento */ } };
  try { const v = parseFloat(localStorage.getItem('splitPct')); if (v) set(v); } catch { /* sin almacenamiento */ }
  let last = 42;
  const move = e => { const r = sec.getBoundingClientRect(); last = set((e.clientY - r.top) / r.height * 100); };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    bar.classList.remove('on'); document.body.classList.remove('splitting'); save(last);
  };
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    bar.classList.add('on'); document.body.classList.add('splitting');
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  bar.addEventListener('dblclick', () => save(last = set(42)));
  bar.addEventListener('keydown', e => {
    const cur = parseFloat(getComputedStyle(sec).getPropertyValue('--split')) || 42;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); save(last = set(cur + (e.key === 'ArrowUp' ? -4 : 4))); }
  });
})();

let rectangle = null, marker = null, releasePoly = null, releaseOutline = null, overlay = null;
let drawMode = null, suppressClick = false;

// ───────────────────────────── Asistente de pasos (ventana flotante); la barra lateral queda para los resultados
const wizard = new Wizard({
  isFlood: () => $('engine').value === 'flood',
  onRun: () => $('run').click(),
  hints: {
    start: () => exposure.example && !exposure.example.free ? exposure.example.title : 'Modo libre (sin ejemplo)',
    zone: () => `${($('dataset').selectedOptions[0] || {}).text || $('dataset').value} · ${$('gridInfo').textContent.split('Zona grande')[0]}`,
    release: () => $('releaseInfo').innerHTML.replace(/<br\s*\/?>/g, ' · ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 90),
    plain: () => { const v = plainPanel.v; return [v.flood.depressions === 'keep' ? 'bajos conservados' : null, v.infiltration.method === 'green_ampt' ? 'Green-Ampt' : 'SCS-CN',
      v.inflows.length ? `${v.inflows.length} entrada(s) de caudal` : null, v.roads.items.length ? `${v.roads.items.length} caminos` : null,
      v.landuse.worldcover || v.landuse.polygons.length ? 'uso del suelo' : null].filter(Boolean).join(' · '); },
    basins: () => { const st = basinsPanel.params().storm; return `Tormenta ${fmt(st.rain_mm ?? 60, 0)} mm en ${fmt(st.duration_h ?? 3, 2)} h · ${basinsPanel.data ? 'cuencas delineadas' : plainPanel.skipBasins ? 'lluvia en toda la zona' : 'falta delinear las cuencas'}`; },
    material: () => $('preset').selectedOptions[0] && $('preset').selectedOptions[0].text,
    water: () => `Saturación ${(+$('saturation').value).toFixed(2)}`,
    erosion: () => { const v = +document.querySelector('[data-param=erodible_depth_m]').value; return v > 0 ? `Lecho erosionable de ${fmt(v)} m` : 'Sin erosión del lecho'; },
    run: () => `${$('engine').selectedOptions[0].text} · dx ${$('dx').value} m${$('anaName').value.trim() ? ' · ' + $('anaName').value.trim() : ''}`,
  },
});

const bbox = () => ({west: +$('west').value, south: +$('south').value, east: +$('east').value, north: +$('north').value});

function setBBox(b, fit = true) {
  $('west').value = b.west.toFixed(4); $('east').value = b.east.toFixed(4);
  $('south').value = b.south.toFixed(4); $('north').value = b.north.toFixed(4);
  drawBox(fit);
}
function drawBox(fit = true) {
  const b = bbox();
  if (rectangle) rectangle.remove();
  rectangle = L.rectangle([[b.south, b.west], [b.north, b.east]], {color: '#37d18e', weight: 2, fillOpacity: .03, interactive: false}).addTo(map);
  if (fit) map.fitBounds(rectangle.getBounds(), {padding: [10, 10]});
  updateGridInfo();
}
function updateGridInfo() {
  const b = bbox(), {mx, my} = metersPerDeg((b.south + b.north) / 2), dx = +$('dx').value;
  const Lx = (b.east - b.west) * mx, Ly = (b.north - b.south) * my;
  if (!(Lx > 0 && Ly > 0)) { $('gridInfo').textContent = 'BBox inválido'; return; }
  const nx = Math.floor(Lx / dx) + 1, ny = Math.floor(Ly / dx) + 1;
  $('gridInfo').innerHTML = `${fmt(Lx / 1000, 2)} × ${fmt(Ly / 1000, 2)} km · ${fmt(nx, 0)} × ${fmt(ny, 0)} columnas (dx ${dx} m)` +
    (nx * ny > ($('engine').value === 'flood' ? 450000 : 250000) ? '<br><span style="color:#f4b64c">Zona grande: el backend puede aumentar dx para respetar la memoria.</span>' : '');
}
['west', 'east', 'south', 'north'].forEach(id => $(id).addEventListener('change', () => drawBox()));
$('dx').addEventListener('input', updateGridInfo);

function setMode(m) {
  if (drawMode === 'poly' && m !== 'poly') cancelDraft();
  if (drawMode === 'bbox' && m !== 'bbox') resetRect();
  if (m === 'bbox') status('Zona de cálculo: arrastrá sobre el mapa, o hacé clic en dos esquinas opuestas.');
  if (m === 'poly' && !polyTarget) status('Área de desprendimiento: clic en el mapa agrega vértices; doble clic, Enter o clic en el primer vértice cierra; Esc cancela.');
  drawMode = m;
  wizard.drawing(!!m);
  $('map').classList.toggle('drawing', !!m);
  $('drawBox').classList.toggle('active', m === 'bbox');
  $('drawPoly').classList.toggle('active', m === 'poly');
  if (m) { map.dragging.disable(); map.doubleClickZoom.disable(); }
  else { map.dragging.enable(); map.doubleClickZoom.enable(); }
}
$('drawBox').onclick = () => { if (drawMode !== 'bbox') clearZoneOutline(); setMode(drawMode === 'bbox' ? null : 'bbox'); };
$('drawPoly').onclick = () => setMode(drawMode === 'poly' ? null : 'poly');
$('viewBox').onclick = () => {
  clearZoneOutline();
  const b = map.getBounds().pad(-0.05);
  setBBox({west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth()}, false);
};

// DEM propios (MDE-Ar del IGN, LiDAR LAS/LAZ, GeoTIFF): se suben una vez, el backend los reproyecta a WGS84 y
// quedan en «Dataset» como LOCAL:<id>
let localDems = [], demOutline = null;
const localDem = () => localDems.find(d => 'LOCAL:' + d.id === $('dataset').value) || null;
function renderLocalDems(sel) {
  const ds = $('dataset'), prev = sel || ds.value;
  ds.querySelector('optgroup[data-local]')?.remove();
  if (localDems.length) {
    const og = document.createElement('optgroup');
    og.label = 'DEM propios'; og.dataset.local = '1';
    for (const d of localDems) og.append(new Option(`${d.name} · ${d.kind === 'lidar' ? 'LiDAR' : 'raster'} ${fmt(d.res_m, 1)} m`, 'LOCAL:' + d.id));
    ds.append(og);
  }
  ds.value = prev;
  if (!ds.value) ds.value = 'AWS_TERRAIN';  // el DEM elegido se borró
  showLocalDem();
}
function showLocalDem() {
  const d = localDem();
  if (demOutline) { demOutline.remove(); demOutline = null; }
  $('demFit').hidden = $('demDel').hidden = !d;
  if (!d) { $('demInfo').innerHTML = localDems.length ? `${localDems.length} DEM propio${localDems.length > 1 ? 's' : ''} guardado${localDems.length > 1 ? 's' : ''}: elegilo en «Dataset».` : ''; return; }
  const [w, s, e, n] = d.bounds;
  demOutline = L.rectangle([[s, w], [n, e]], {color: '#3fa9f5', weight: 1.5, dashArray: '6 4', fill: false, interactive: false})
    .bindTooltip(`DEM propio: ${esc(d.name)}`).addTo(map);
  $('demLocalBox').open = true;
  $('demInfo').innerHTML = `<b>${esc(d.name)}</b> · ${d.kind === 'lidar' ? `LiDAR, ${fmt(d.points, 0)} puntos · ${esc(d.method)}` : 'raster'} · celda ${fmt(d.res_m, 2)} m · ` +
    `cotas ${fmt(d.zmin, 1)}–${fmt(d.zmax, 1)} m · ${esc(d.crs_src)} → WGS84. Fuera de su cobertura (rectángulo azul) se completa con AWS Terrain Tiles si está activada la opción de arriba.` +
    (d.warnings || []).map(x => `<div class="hint">${esc(x)}</div>`).join('');
}
fetch(API + '/api/dem/local').then(r => r.json()).then(j => { localDems = j.dems || []; renderLocalDems(); }).catch(() => {});
$('dataset').addEventListener('change', showLocalDem);
$('demFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  if ($('demEpsg').value) fd.append('epsg', $('demEpsg').value);
  if ($('demRes').value) fd.append('res_m', $('demRes').value);
  fd.append('ground_only', $('demGround').checked);
  $('demInfo').innerHTML = `${ic('refresh', 16, 'spin')} Procesando ${esc(file.name)} (${fmt(file.size / 1e6, 1)} MB)… una nube LiDAR grande puede tardar unos minutos.`;
  try {
    const r = await fetch(API + '/api/dem/upload', {method: 'POST', body: fd});
    if (!r.ok) throw new Error(await errText(r));
    const m = await r.json();
    localDems.unshift(m);
    renderLocalDems('LOCAL:' + m.id);
    const b = bbox(), [w, s, ee, n] = m.bounds;
    if (b.east < w || b.west > ee || b.north < s || b.south > n) $('demFit').click();
    status(`DEM propio cargado: <b>${esc(m.name)}</b> (celda ${fmt(m.res_m, 2)} m). Ya está elegido como Dataset.`);
  } catch (err) {
    $('demInfo').innerHTML = `<span style="color:#f4b64c">No se pudo cargar el DEM: ${esc(err.message)}</span>`;
    status('No se pudo cargar el DEM: ' + esc(err.message), true);
  }
};
$('demFit').onclick = () => {
  const d = localDem();
  if (!d) return;
  const [w, s, e, n] = d.bounds, mx = (e - w) * 0.01, my = (n - s) * 0.01;
  clearZoneOutline();
  setBBox({west: w + mx, south: s + my, east: e - mx, north: n - my});
};
$('demDel').onclick = async () => {
  const d = localDem();
  if (!d || !confirm(`¿Borrar el DEM propio «${d.name}» del servidor?`)) return;
  await fetch(API + '/api/dem/local/' + d.id, {method: 'DELETE'}).catch(() => {});
  localDems = localDems.filter(x => x.id !== d.id);
  renderLocalDems('AWS_TERRAIN');
};

// Zona de cálculo desde un GeoJSON: la zona es la extensión de sus geometrías más un margen,
// y el contorno queda dibujado como referencia
let zoneOutline = null;
function clearZoneOutline() { if (zoneOutline) { zoneOutline.remove(); zoneOutline = null; } }
$('zoneGeojson').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';  // permite volver a elegir el mismo archivo
  if (!file) return;
  try {
    const gj = JSON.parse(await file.text());
    const name = gj.crs?.properties?.name || '';
    if (name && !/4326|CRS84/i.test(name)) throw new Error(`el sistema de coordenadas es ${name}; exportalo en WGS84 (EPSG:4326, lon/lat)`);
    const b = {west: Infinity, south: Infinity, east: -Infinity, north: -Infinity};
    const walk = c => {
      if (typeof c[0] === 'number') {
        const [lon, lat] = c;
        if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) throw new Error(`coordenada fuera de rango (${lon}, ${lat}): el archivo no parece estar en lon/lat WGS84`);
        b.west = Math.min(b.west, lon); b.east = Math.max(b.east, lon);
        b.south = Math.min(b.south, lat); b.north = Math.max(b.north, lat);
      } else c.forEach(walk);
    };
    const geom = g => {
      if (!g) return;
      if (g.type === 'GeometryCollection') g.geometries.forEach(geom);
      else if (g.coordinates) walk(g.coordinates);
    };
    if (gj.type === 'FeatureCollection') gj.features.forEach(f => geom(f.geometry));
    else if (gj.type === 'Feature') geom(gj.geometry);
    else geom(gj);
    if (!isFinite(b.west)) throw new Error('no tiene geometrías');
    // margen del 5 % por lado (mínimo ~100 m) para que el contorno no quede pegado al borde del dominio
    const padX = Math.max((b.east - b.west) * .05, .001), padY = Math.max((b.north - b.south) * .05, .001);
    if (b.east - b.west + 2 * padX > 1 || b.north - b.south + 2 * padY > 1) throw new Error('la extensión supera 1° por lado');
    if (drawMode === 'bbox') setMode(null);
    setBBox({west: b.west - padX, south: b.south - padY, east: b.east + padX, north: b.north + padY});
    clearZoneOutline();
    zoneOutline = L.geoJSON(gj, {
      style: {color: '#37d18e', weight: 2, dashArray: '6 4', fillOpacity: .06}, interactive: false,
      pointToLayer: (_, ll) => L.circleMarker(ll, {radius: 4, color: '#37d18e', interactive: false}),
    }).addTo(map);
    status(`Zona de cálculo tomada de <b>${file.name}</b> (extensión de sus geometrías + 5 % de margen).`);
  } catch (err) { status('GeoJSON inválido: ' + err.message, true); }
};

// Rectángulo: arrastrando, o con un clic en cada esquina
let dragStart = null, dragRect = null, cornerPlaced = false;
function resetRect() { if (dragRect) dragRect.remove(); dragStart = dragRect = null; cornerPlaced = false; }
map.on('mousedown', e => {
  if (drawMode !== 'bbox' || dragStart) return;
  dragStart = e.latlng;
  dragRect = L.rectangle(L.latLngBounds(e.latlng, e.latlng), {color: '#f4b64c', weight: 2, dashArray: '5 4', fillOpacity: .05}).addTo(map);
});
map.on('mousemove', e => {
  if (drawMode === 'bbox' && dragStart) dragRect.setBounds(L.latLngBounds(dragStart, e.latlng));
  if (drawMode === 'poly') updateRubber(e.latlng);
});
map.on('mouseup', e => {
  if (drawMode !== 'bbox' || !dragStart) return;
  const b = L.latLngBounds(dragStart, e.latlng);
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 60);
  const p1 = map.latLngToContainerPoint(b.getSouthWest()), p2 = map.latLngToContainerPoint(b.getNorthEast());
  if (Math.abs(p1.x - p2.x) < 8 || Math.abs(p1.y - p2.y) < 8) {
    // clic sin arrastrar: queda fijada la primera esquina, el rectángulo sigue al cursor hasta el segundo clic
    if (!cornerPlaced) { cornerPlaced = true; status('Primera esquina marcada: hacé clic en la esquina opuesta (Esc cancela).'); }
    return;
  }
  resetRect();
  setMode(null);
  setBBox({west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth()}, false);
});

// Polígono de desprendimiento
let draftPts = [], draftLine = null, rubber = null, draftDots = [];
function addVertex(ll) {
  if (draftPts.length >= 3 && map.latLngToContainerPoint(draftPts[0]).distanceTo(map.latLngToContainerPoint(ll)) < 10) { finishPoly(); return; }
  draftPts.push(ll);
  if (!draftLine) draftLine = L.polyline([], {color: '#ff8a3d', weight: 2, interactive: false}).addTo(map);
  draftLine.setLatLngs(draftPts);
  draftDots.push(L.circleMarker(ll, {radius: draftPts.length === 1 ? 6 : 4, color: '#ff8a3d', fillColor: '#1d1405', fillOpacity: 1, weight: 2, interactive: false}).addTo(map));
}
function updateRubber(ll) {
  if (!draftPts.length) return;
  if (!rubber) rubber = L.polyline([], {color: '#ff8a3d', weight: 1, dashArray: '4 4', interactive: false}).addTo(map);
  rubber.setLatLngs([draftPts[draftPts.length - 1], ll, draftPts[0]]);
}
function cancelDraft() {
  [draftLine, rubber, ...draftDots].forEach(l => l && l.remove());
  draftPts = []; draftLine = rubber = null; draftDots = [];
}
let polyTarget = null;  // si está definido, el polígono dibujado va a otro destino (p. ej. zona del deslizamiento por lluvia)
function finishPoly() {
  const pts = draftPts.filter((p, i) => i === 0 || map.latLngToContainerPoint(p).distanceTo(map.latLngToContainerPoint(draftPts[i - 1])) > 4);
  const target = polyTarget;
  polyTarget = null;
  cancelDraft(); setMode(null);
  if (pts.length < 3) return;
  if (target) target(pts); else setRelease(pts);
}
function setRelease(pts) {
  if (releasePoly) releasePoly.remove();
  releasePoly = pts ? L.polygon(pts, {color: '#ff8a3d', weight: 2, fillOpacity: .25}).addTo(map) : null;
  updateReleaseInfo();
}
$('clearPoly').onclick = () => { setRelease(null); if (drawMode === 'poly') setMode(null); };
map.on('dblclick', e => { if (drawMode === 'poly') { L.DomEvent.stop(e); finishPoly(); } });
map.on('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  if (editor.capturesMapClicks) return;
  if (basinsPanel.capturesMapClicks) { basinsPanel.addOutlet(e.latlng); return; }
  if (plainPanel.capturesMapClicks) { plainPanel.onMapClick(e.latlng); return; }
  if (drawMode === 'poly') { addVertex(e.latlng); return; }
  if (drawMode) return;
  if (marker) marker.remove();
  marker = L.marker(e.latlng).addTo(map).bindTooltip('Inicio').openTooltip();
  updateReleaseInfo();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && basinsPanel.capturesMapClicks) basinsPanel.setPicking(false);
  if (e.key === 'Escape' && plainPanel.capturesMapClicks) plainPanel.setPick(null);
  if (!drawMode || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'Escape') setMode(null);
  if (drawMode === 'poly' && e.key === 'Enter') finishPoly();
  if (drawMode === 'poly' && e.key === 'Backspace' && draftPts.length) {
    e.preventDefault();
    const pts = draftPts.slice(0, -1); cancelDraft(); pts.forEach(addVertex);
  }
});

function polygonArea(latlngs) {
  const lat0 = latlngs.reduce((s, p) => s + p.lat, 0) / latlngs.length, {mx, my} = metersPerDeg(lat0);
  let a = 0;
  for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++)
    a += (latlngs[j].lng * mx) * (latlngs[i].lat * my) - (latlngs[i].lng * mx) * (latlngs[j].lat * my);
  return Math.abs(a / 2);
}
function updateReleaseInfo() {
  let bodies = null;
  try { bodies = exposure.bodies; } catch { /* la escena aún no se creó (inicio de la página) */ }
  // un ejemplo en cascada define sus propias masas iniciales: no se mezclan con un polígono dibujado
  for (const id of ['drawPoly', 'clearPoly']) $(id).disabled = !!bodies;
  for (const k of ['release_radius_m', 'release_mode', 'release_thickness_m', 'release_volume_m3', 'thickness_profile'])
    document.querySelector(`[data-param="${k}"]`).closest('label').hidden = !!bodies || (k === 'release_volume_m3' && $('release_mode').value !== 'volume') || (k === 'release_thickness_m' && $('release_mode').value === 'volume');
  if (bodies) {
    $('releaseInfo').innerHTML = '<b>Masas iniciales definidas por el ejemplo</b>' + bodies.map(b =>
      `<br>${ic(b.kind === 'water' ? 'water-drop' : b.rain ? 'rain' : 'cube')} ${b.name} · ${b.rain ? 'volumen según la lluvia (ver "Desencadenante: lluvia")' : `espesor ${b.thickness_m} m`}`).join('') +
      '<br><span class="hint">Para dibujar tu propio desprendimiento, usá "Quitar ejemplo" en la sección Ejemplos.</span>';
    return;
  }
  const vol = $('release_mode').value === 'volume';
  $('thkLabel').hidden = vol; $('volLabel').hidden = !vol;
  const r = +document.querySelector('[data-param=release_radius_m]').value;
  const area = releasePoly ? polygonArea(releasePoly.getLatLngs()[0]) : Math.PI * r * r;
  const V = vol ? +$('release_volume_m3').value : +$('release_thickness_m').value * area;
  const where = releasePoly ? 'Polígono' : `Círculo r = ${r} m ${marker ? 'en el punto de inicio' : '(ubicación automática: ladera alta)'}`;
  $('releaseInfo').innerHTML = `${where}<br>Área ${fmtArea(area)} · Volumen ${fmtVol(V)} · espesor medio ${fmt(V / area, 1)} m`;
}
['release_mode', 'release_thickness_m', 'release_volume_m3'].forEach(id => $(id).addEventListener('input', updateReleaseInfo));
document.querySelector('[data-param=release_radius_m]').addEventListener('input', updateReleaseInfo);

// Controles varios
$('saturation').oninput = () => $('saturationOut').value = (+$('saturation').value).toFixed(2);
$('pore_ratio_initial').oninput = () => $('lamOut').value = (+$('pore_ratio_initial').value).toFixed(2);
$('lamAuto').onchange = () => $('lamLabel').hidden = $('lamAuto').checked;

initPresets();
initHelp();
hydrateIcons();
drawBox(); updateReleaseInfo();
fetch(API + '/api/capabilities').then(r => r.json()).then(c => {
  if (!c.engines.includes('mpm')) {
    $('engine').value = 'particles';
    $('engine').querySelector('option[value=mpm]').disabled = true;
    status('Taichi no está instalado en el backend: solo motor de partículas.', true);
  }
}).catch(() => status('Backend no disponible en ' + API, true));

// ───────────────────────────── Edificios de GlobalBuildingAtlas para la zona actual
function updateGbaInfo() {
  const B = exposure.buildings || [];
  $('gbaClear').hidden = !B.length;
  const wh = B.filter(b => b.height > 0).length;
  $('gbaInfo').innerHTML = B.length ? `${fmt(B.length, 0)} edificios (${fmt(wh, 0)} con altura). Al simular se pintan según la intensidad del flujo que los alcanza: ` +
    `<span class="sw" style="background:${INTENSITY_COLORS[1]};margin-left:0"></span>baja <span class="sw" style="background:${INTENSITY_COLORS[2]}"></span>media <span class="sw" style="background:${INTENSITY_COLORS[3]}"></span>alta` : '';
}
$('gbaLoad').onclick = async () => {
  const b = bbox(), btn = $('gbaLoad');
  btn.disabled = true;
  $('gbaInfo').innerHTML = ic('refresh', 16, 'spin') + ' Descargando GlobalBuildingAtlas para la zona… (la primera vez puede tardar hasta un minuto)';
  try {
    const r = await fetch(API + '/api/buildings/gba', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)});
    if (!r.ok) throw new Error(await errText(r));
    const j = await r.json();
    exposure.setBuildings(j.buildings.map((g, n) => ({id: 'g' + (n + 1), lon: g.lon, lat: g.lat, area: g.area, levels: null,
      height: g.height, hsrc: g.height ? 'GBA' : null, src: g.source})));
    if (exposure.example.free) $('exClear').hidden = false;
    updateGbaInfo();
    status(`GlobalBuildingAtlas: ${fmt(j.count, 0)} edificios en la zona (${fmt(j.with_height, 0)} con altura).`);
  } catch (e) {
    $('gbaInfo').textContent = 'No se pudieron cargar los edificios: ' + e.message;
  } finally { btn.disabled = false; }
};
$('gbaClear').onclick = () => {
  if (exposure.example && exposure.example.free) { exposure.clear(); $('exClear').hidden = true; }
  else if (exposure.example) exposure.setBuildings([]);
  updateGbaInfo();
};

// ───────────────────────────── Ejemplos precargados
let examples = [];
async function refreshExamples(select) {
  const list = await listExamples();
  examples = list;
  const sel = $('exampleSel');
  while (sel.options.length > 1) sel.remove(1);
  for (const e of list) sel.add(new Option((e.custom ? '★ ' : '') + e.title, e.id));
  if (select) { sel.value = select; sel.onchange(); }
}
refreshExamples().catch(() => {});
$('exampleSel').onchange = async () => {
  const e = examples.find(x => x.id === $('exampleSel').value);
  $('exInfo').textContent = '';
  if (!e) return;
  try {
    const ex = await fetchExample(e.file), f = ex.field;
    const link = t => t.replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    $('exInfo').innerHTML = `${ex.description || ''}` +
      (ex.credits && ex.credits.length ? `<div class="credits"><b>${ic('notebook')}Créditos científicos</b>${ex.credits.map(c => `<p>${link(c)}</p>`).join('')}</div>` : '') +
      (f ? `<div class="fielddata"><b>${ic('pin')}Datos de campo</b>${f.date ? ' · ' + f.date : ''}${f.by ? '<br>' + f.by : ''}${f.notes ? `<p>${f.notes}</p>` : ''}</div>` : '') +
      `<span class="hint">${(ex.sources || []).join('<br>')}</span>`;
  } catch (err) { $('exInfo').textContent = err.message; }
};
async function applyExample(run) {
  const e = examples.find(x => x.id === $('exampleSel').value);
  if (!e) { status('Elegí un ejemplo de la lista.', true); return; }
  loadExample(await fetchExample(e.file), run);
}
function loadExample(ex, run, quiet = false) {
  const p = ex.params;
  setMode(null);
  clearZoneOutline();
  setBBox(p.bbox, false);
  for (const [k, v] of Object.entries(p)) {
    const el = document.querySelector(`[data-param="${k}"]`);
    if (!el || v == null || typeof v === 'object') continue;
    el.value = v;
    el.dispatchEvent(new Event('input', {bubbles: true}));
  }
  $('dem_fallback').checked = p.dem_fallback !== false;
  $('lamAuto').checked = p.pore_ratio_initial == null;
  $('lamLabel').hidden = $('lamAuto').checked;
  if (p.pore_ratio_initial != null) $('pore_ratio_initial').value = p.pore_ratio_initial;
  $('preset').value = 'custom';
  if (marker) { marker.remove(); marker = null; }
  exposure.set(ex);
  rainPanel.refresh();
  basinsPanel.load(p);
  plainPanel.load(p);
  updateGbaInfo();
  applyEngine();
  setRelease(p.release_polygon ? p.release_polygon.map(([lo, la]) => L.latLng(la, lo)) : null);
  $('exClear').hidden = false;
  const v = ex.view || {};
  if (v.center) map.setView(v.center, v.zoom || 14);
  if (v.exag) { $('exag').value = v.exag; applyExag(); }
  if (v.matStyle) $('matStyle').value = v.matStyle;
  if (v.layer) pendingLayer = v.layer;
  if (v.mapLayer) $('mapLayer').value = v.mapLayer;
  updateGridInfo(); updateReleaseInfo();
  if (!quiet) status(`Ejemplo cargado: <b>${ex.title}</b>`);
  if (run) $('run').click();
}
let pendingLayer = null;
$('exLoad').onclick = () => applyExample(false).catch(e => status('Error: ' + e.message, true));
$('exRun').onclick = () => applyExample(true).catch(e => status('Error: ' + e.message, true));

// ───────────────────────────── Desencadenante por lluvia
const rainPanel = new RainPanel({
  api: API, map, sec: $('rainSec'), body: $('rainBody'), status,
  getExample: () => exposure.example,
  getParams: () => collectParams(),
  onZone: () => { exposure.set(exposure.example); updateReleaseInfo(); },
  startDraw: cb => { polyTarget = cb; setMode('poly'); status('Dibujá la zona de búsqueda del deslizamiento: clic agrega vértices, doble clic o Enter cierra.'); },
});

// ───────────────────────────── Cuencas y tormenta (motor de inundación por lluvia)
const basinsPanel = new BasinsPanel({
  api: API, map, sec: $('basinSec'), body: $('basinBody'), status,
  getParams: () => collectParams(),
  isDrawing: () => !!drawMode,
  hasUrbanZone: () => {
    try { return !!(exposure.example && (exposure.example.params.exposure || []).some(z => (z.polygon || []).length >= 3)); }
    catch { return false; }  // al iniciar, el módulo de exposición todavía no existe
  },
  startDraw: cb => { polyTarget = cb; setMode('poly'); status('Zona urbana: clic en el mapa agrega vértices; doble clic, Enter o clic en el primer vértice cierra; Esc cancela.'); },
});
// ───────────────────────────── Llanura: suelo, ríos que entran, caminos y uso del suelo (motor de inundación)
const plainPanel = new PlainPanel({
  api: API, map, sec: $('plainSec'), body: $('plainBody'), status, getBBox: () => bbox(), onPick: on => wizard.drawing(on),
  startDraw: cb => { polyTarget = cb; setMode('poly'); status('Polígono de uso del suelo: clic agrega vértices; doble clic, Enter o clic en el primer vértice cierra; Esc cancela.'); },
  onPreset: () => {
    const st = basinsPanel.v.storm, simH = Math.max(basinsPanel.v.sim.sim_h || 0, (st.duration_h || 3) + 24);
    basinsPanel.patch({flood: {landslides: false, boulders: 0, trees_per_km: 0, hillslope_erodible_m: 0, entrainment_coeff: 0},
      debris: {channel_erodible_m: 0}, storm: {amc: 'III', areal_reduction: false}, sim: {sim_h: simH}});
    if (!$('dataset').value.startsWith('LOCAL:') && $('dataset').value !== 'ANADEM') {
      $('dataset').value = 'ANADEM'; $('dataset').dispatchEvent(new Event('change'));
      toast('info', 'DEM cambiado a ANADEM', 'ANADEM es un modelo del terreno sin vegetación, mejor para llanura. Si tenés MDE-Ar o LiDAR, cargalo como DEM propio en el paso Zona de cálculo.', [], 9000);
    }
  },
});
const isFlood = () => $('engine').value === 'flood';
// el motor de inundación no usa desprendimiento, material ni partículas: se muestran solo sus controles
function applyEngine() {
  const fl = isFlood();
  basinsPanel.setVisible(fl);
  plainPanel.setVisible(fl);
  $('plainSec').hidden = !fl;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', (b.dataset.mode === 'flood') === fl));
  $('basinSec').hidden = !fl;
  for (const id of ['releaseSec', 'materialSec', 'aguaSec', 'erosionSec']) $(id).hidden = fl;
  if (fl) $('rainSec').hidden = true; else rainPanel.refresh();
  for (const k of ['device', 'ppc', 'duration_s', 'display_particles'])
    document.querySelector(`[data-param="${k}"]`).closest('label').hidden = fl;
  if (!fl && basinsPanel.capturesMapClicks) basinsPanel.setPicking(false);
  if (!result) $('empty').textContent = fl ? 'Dibujá la zona de cálculo, delineá las cuencas y definí la tormenta, luego Simular.'
    : 'Dibujá la zona y el área de desprendimiento, luego Simular.';
  updateGridInfo();
}
// selector de tipo de simulación (arriba de la barra lateral): elige el motor
document.querySelectorAll('.mode-btn').forEach(b => b.onclick = () => {
  const fl = b.dataset.mode === 'flood';
  if (fl === isFlood()) { wizard.show(); return; }
  $('engine').value = fl ? 'flood' : ($('engine').querySelector('option[value=mpm]').disabled ? 'particles' : 'mpm');
  // las cuencas necesitan el terreno real: el DEM sintético es un relieve inventado
  if (fl && $('dataset').value === 'SYNTHETIC') {
    $('dataset').value = 'AWS_TERRAIN';
    toast('info', 'DEM cambiado a AWS_TERRAIN', 'Las cuencas se delinean sobre el terreno real. El DEM SYNTHETIC es un relieve de prueba que no corresponde al lugar del mapa.', [], 8000);
  }
  applyEngine();
  wizard.show('start');
});
$('engine').addEventListener('change', applyEngine);
$('engine').addEventListener('input', applyEngine);

// ───────────────────────────── Editor del escenario (datos de campo)
const editor = new ScenarioEditor({
  api: API, map, host: document.querySelector('main > section'), status,
  onApply: (ex, run) => loadExample(ex, run),
  onSaved: id => refreshExamples(id).catch(() => {}),
});
// el escenario cargado, con los valores actuales del formulario (lo que se enviaría al simular)
function currentScenario() {
  const ex = JSON.parse(JSON.stringify(exposure.example)), form = collectParams();
  for (const [k, v] of Object.entries(form)) {
    const el = document.querySelector(`[data-param="${k}"]`);
    const def = el && (el.tagName === 'SELECT' ? ([...el.options].find(o => o.defaultSelected) || el.options[0] || {}).value : el.defaultValue);
    const changed = el && el.value !== def;
    if (k in ex.params || changed || ['bbox', 'release_polygon', 'source_lon', 'source_lat'].includes(k)) ex.params[k] = v;
  }
  delete ex.params.exposure_heights;
  return ex;
}
$('exEdit').onclick = async () => {
  const e = examples.find(x => x.id === $('exampleSel').value);
  if (!e) { status('Elegí un ejemplo de la lista para editarlo.', true); $('status').scrollIntoView({block: 'center'}); return; }
  try {
    const orig = await fetchExample(e.file);
    orig.custom = !!e.custom;
    // si ese ejemplo ya está cargado, se parte de lo que hay en el formulario y en el mapa
    const loaded = exposure.example && exposure.example.id === orig.id;
    await editor.open(loaded ? currentScenario() : orig, orig);
    status(loaded ? 'Editor abierto con los valores actuales del formulario.' : 'Editor abierto con los valores del ejemplo.');
  } catch (err) { status('No se pudo abrir el editor: ' + err.message, true); $('status').scrollIntoView({block: 'center'}); }
};
$('exClear').onclick = () => { exposure.clear(); rainPanel.clear(); updateGbaInfo(); $('exClear').hidden = true; $('exampleSel').value = ''; $('exInfo').textContent = ''; updateReleaseInfo(); };

// ───────────────────────────── Jobs
let job = null, pollTimer = null, result = null;
function status(html, isErr = false) { $('status').innerHTML = html; $('status').classList.toggle('err', isErr); }
function setRunning(on) {
  $('run').disabled = on; $('cancel').disabled = !on;
  if (!on) { $('bar').style.width = '0'; $('run').innerHTML = ic('play') + 'Simular'; }
}

// ───────────────────────────── Progreso y avisos
const BASE_TITLE = document.title;
const fmtDur = s => s == null || !isFinite(s) ? '—' : s < 60 ? `${fmt(s, 0)} s` : s < 3600 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`
  : `${Math.floor(s / 3600)} h ${String(Math.round(s % 3600 / 60)).padStart(2, '0')} min`;
const runUI = {
  start(name) {
    this.samples = [];
    $('rcName').textContent = name || '';
    $('runCard').hidden = false; $('runCard').classList.remove('mini');
    for (const id of ['rcT', 'rcEta', 'rcN', 'rcV', 'rcW', 'rcE']) $(id).textContent = '—';
    this.show('Enviando…', 0);
  },
  show(stage, pct) {
    $('rcStage').textContent = stage;
    $('rcPct').textContent = pct == null ? '' : `${Math.floor(pct)}%`;
    $('rcBar').style.width = (pct || 0) + '%';
    $('rcBar').classList.toggle('indet', pct == null || pct === 0);
    $('runChip').hidden = false;
    $('runChip').innerHTML = ic('refresh', 16, 'spin') + `${stage}${pct ? ' · ' + Math.floor(pct) + '%' : ''}`;
    $('run').innerHTML = ic('refresh', 16, 'spin') + (pct ? `${Math.floor(pct)}%` : 'Simulando…');
    document.title = (pct ? `${Math.floor(pct)}% · ` : '') + `${stage} — ${BASE_TITLE}`;
  },
  update(s) {
    const pr = s.progress || {}, pct = pr.t != null ? Math.min(100, pr.t / s.duration_s * 100) : null;
    this.show(s.stage || s.status, pct);
    $('rcE').textContent = {mpm: 'MPM 3D', particles: 'Partículas', flood: 'Inundación 2D'}[s.engine] || s.engine;
    if (pr.t != null) {
      $('rcT').textContent = `${fmtDur(pr.t)} / ${fmtDur(s.duration_s)}`;
      $('rcN').textContent = fmt(pr.particles, 0);
      $('rcV').textContent = `${fmt(pr.vmax, 1)} m/s`;
      // ritmo medido en la ventana reciente (excluye la compilación y la descarga del DEM)
      if (s.elapsed_s != null) {
        this.samples.push([s.elapsed_s, pr.t]);
        while (this.samples.length > 2 && s.elapsed_s - this.samples[0][0] > 30) this.samples.shift();
        const [w0, t0] = this.samples[0], dw = s.elapsed_s - w0, dt = pr.t - t0;
        $('rcEta').textContent = dw >= 3 && dt > 0 ? '≈ ' + fmtDur((s.duration_s - pr.t) * dw / dt) : 'calculando…';
      }
    }
    if (s.elapsed_s != null) $('rcW').textContent = fmtDur(s.elapsed_s);
  },
  end() { $('runCard').hidden = true; $('runChip').hidden = true; document.title = BASE_TITLE; },
};
$('rcMin').onclick = () => $('runCard').classList.toggle('mini');
$('runChip').onclick = () => { $('runCard').hidden = false; $('runCard').classList.remove('mini'); };
$('rcCancel').onclick = () => $('cancel').click();

function toast(kind, title, body = '', actions = [], timeout = 0) {
  const icon = {success: 'check-circle', danger: 'x-circle', info: 'information', warning: 'exclamation-mark-triangle'}[kind];
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `${ic(icon, 24, 'tk-ic')}<div class="tk-body"><b>${title}</b>${body ? `<div>${body}</div>` : ''}<div class="tk-act"></div></div>` +
    `<button class="tk-x" title="Cerrar">${ic('x')}</button>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.querySelector('.tk-x').onclick = close;
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = a.primary ? '' : 'secondary';
    b.innerHTML = (a.icon ? ic(a.icon) : '') + a.label;
    b.onclick = () => { a.fn(); close(); };
    el.querySelector('.tk-act').appendChild(b);
  }
  $('toasts').appendChild(el);
  if (timeout) setTimeout(close, timeout);
  return el;
}
// sonido corto al terminar (el contexto de audio se habilita con el clic en Simular)
let audioCtx = null;
function chime(ok = true) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  (ok ? [660, 880] : [440, 330]).forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, t + i * 0.16); g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.35);
    o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.4);
  });
}
function osNotify(title, body) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(title, {body});
}
function runFinished(meta, wall) {
  const s = meta.summary, ex = meta.exposure && meta.exposure.points, ft = meta.flood && meta.flood.totals;
  const body = `${meta.scenario_name ? `<b>${meta.scenario_name}</b><br>` : ''}Cómputo ${fmtDur(wall ?? s.wall_time_s)} · ` +
    (ft ? `área inundada ${fmt(ft.flooded_area_km2, 2)} km² · escorrentía ${fmtVol(ft.runoff_m3)} · Cv máx. ${fmt(s.max_cv, 2)}`
      : `alcance ${fmt(s.runout_m, 0)} m · v máx. ${fmt(s.max_speed_m_s, 1)} m/s · depósito ${fmtVol(s.deposit_volume_m3)}`) +
    (ex ? `<br>Edificios alcanzados: <b>${fmt(ex.affected, 0)}</b> de ${fmt(ex.total, 0)}` : '');
  const id = result.id;
  toast('success', 'Simulación finalizada', body + '<br><span class="hint">Guardada en la biblioteca.</span>', [
    {label: 'Reproducir', icon: 'play', primary: true, fn: () => { if (!playing) $('play').click(); }},
    {label: 'Ver resumen', icon: 'graph-time-series', fn: () => $('summary').scrollIntoView({behavior: 'smooth', block: 'start'})},
    {label: 'Informe', icon: 'file-report', fn: () => openReport(id)},
  ]);
  chime(true);
  osNotify('Simulación finalizada', `${meta.scenario_name || 'Suriyaco MassFlow 3D'} · cómputo ${fmtDur(wall ?? s.wall_time_s)}`);
}
async function errText(r) {
  const t = await r.text();
  try { const j = JSON.parse(t); return typeof j.detail === 'string' ? j.detail : j.detail.map(d => `${d.loc.slice(-1)[0]}: ${d.msg}`).join('; '); }
  catch { return t; }
}
function collectParams() {
  const p = {bbox: bbox()};
  document.querySelectorAll('[data-param]').forEach(el => {
    p[el.dataset.param] = (el.type === 'number' || el.type === 'range') ? +el.value : el.value;
  });
  p.pore_ratio_initial = $('lamAuto').checked ? null : +$('pore_ratio_initial').value;
  p.dem_fallback = $('dem_fallback').checked;
  if (p.release_mode !== 'volume') delete p.release_volume_m3;
  if (releasePoly) p.release_polygon = releasePoly.getLatLngs()[0].map(ll => [ll.lng, ll.lat]);
  if (marker) { p.source_lon = marker.getLatLng().lng; p.source_lat = marker.getLatLng().lat; }
  if (exposure.bodies) { delete p.release_polygon; delete p.source_lon; delete p.source_lat; }
  Object.assign(p, exposure.params());
  if (p.engine === 'flood') {
    Object.assign(p, basinsPanel.params());
    const pp = plainPanel.params();
    p.flood = {...p.flood, ...pp.flood};
    delete pp.flood;
    Object.assign(p, pp);
    const uz = basinsPanel.urbanZone;
    if (uz && !(p.exposure || []).length) p.exposure = [{name: 'Zona urbana', polygon: uz, erodible: false}];
  }
  delete p.ui;
  p.project = $('projName').value.trim() || null;
  p.analysis_name = $('anaName').value.trim() || null;
  p.analysis_notes = $('anaNotes').value.trim() || null;
  return p;
}
// escenario del frontend que se guarda con el análisis para reabrirlo tal cual (edificios, zona urbana, cuencas…)
function uiState() {
  const ex = exposure.example ? currentScenario() : {id: '_libre', title: '', params: collectParams(), free: true};
  for (const k of ['project', 'analysis_name', 'analysis_notes', 'ui']) delete ex.params[k];
  return {example: ex, view: {layer: $('layer').value, mapLayer: $('mapLayer').value, exag: exag(), matStyle: $('matStyle').value}};
}
$('run').onclick = async () => {
  const bad = invalidFields();
  if (bad.length) {
    status('Valores fuera de rango: ' + bad.join(' · '), true);
    const el = [...document.querySelectorAll('[data-param]')].find(e => e.classList.contains('bad')), sec = el && el.closest('details[data-step]');
    if (sec) wizard.show(sec.dataset.step);
    return;
  }
  if (isFlood()) {
    const why = plainPanel.skipBasins ? null : basinsPanel.checkReady();
    if (why) {
      status(why, true);
      toast('warning', 'Falta definir las cuencas', why, [{label: 'Ir al panel', icon: 'arrow-up', primary: true, fn: () => wizard.show('basins')}], 10000);
      return;
    }
  }
  setMode(null); clearTimeout(pollTimer); setRunning(true); status('Enviando…');
  wizard.minimize(true);
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch { /* sin audio */ }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  const params = collectParams();
  if (!params.analysis_name) params.analysis_name = params.scenario_name || (exposure.example && exposure.example.title) || null;
  params.ui = uiState();
  runUI.start(params.analysis_name || '');
  try {
    const r = await fetch(API + '/api/simulate', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(params)});
    if (!r.ok) throw new Error(await errText(r));
    job = await r.json(); poll();
  } catch (e) {
    status('Error: ' + e.message, true); setRunning(false); runUI.end();
    toast('danger', 'No se pudo iniciar la simulación', e.message);
  }
};
$('cancel').onclick = async () => {
  if (!job) return;
  clearTimeout(pollTimer);
  await fetch(`${API}/api/jobs/${job.id}`, {method: 'DELETE'}).catch(() => {});
  job = null; status('Cancelada.'); setRunning(false); runUI.end();
  toast('info', 'Simulación cancelada', '', [], 5000);
};
async function poll() {
  if (!job) return;
  const id = job.id;
  try {
    const s = await (await fetch(`${API}/api/jobs/${id}`)).json();
    if (!job || job.id !== id) return;
    const pr = s.progress || {};
    $('bar').style.width = (pr.t != null ? Math.min(100, pr.t / s.duration_s * 100) : 2) + '%';
    let txt = `<b>${s.stage || s.status}</b>`;
    if (pr.t != null) txt += `<br>t = ${fmt(pr.t, 1)} / ${s.duration_s} s · ${fmt(pr.particles, 0)} partículas · v<sub>máx</sub> ${fmt(pr.vmax, 1)} m/s`;
    if (s.elapsed_s != null) txt += `<br>Tiempo de cómputo ${fmt(s.elapsed_s, 0)} s`;
    status(txt);
    runUI.update(s);
    if (s.status === 'done') {
      runUI.show('Descargando resultados…', 100);
      await library.refresh();
      await loadResult(id); setRunning(false); runUI.end();
      library.setCurrent(id);
      runFinished(result.meta, s.elapsed_s);
      return;
    }
    if (s.status === 'error' || s.status === 'cancelled') {
      status(s.status === 'error' ? 'Error: ' + s.error : 'Cancelada.', s.status === 'error'); setRunning(false); runUI.end();
      if (s.status === 'error') { toast('danger', 'La simulación terminó con error', s.error); chime(false); osNotify('Error en la simulación', s.error); }
      return;
    }
  } catch (e) {
    status('Sin conexión con el backend: ' + e.message, true); setRunning(false); runUI.end();
    toast('danger', 'Sin conexión con el backend', e.message); return;
  }
  pollTimer = setTimeout(poll, 600);
}

async function loadResult(id, base = `${API}/api/jobs/${id}`) {
  status('Descargando resultados…');
  const [meta, buf] = await Promise.all([
    fetch(`${base}/result`).then(r => { if (!r.ok) throw new Error('resultado no disponible'); return r.json(); }),
    fetch(`${base}/data.bin`).then(r => { if (!r.ok) throw new Error('datos no disponibles'); return r.arrayBuffer(); }),
  ]);
  const d = meta.domain, n = d.nx * d.ny, gm = meta.grid_frames, gn = gm ? gm.nx * gm.ny : 0;
  const fields = {};
  for (const [k, a] of Object.entries(meta.arrays)) fields[k] = new Float32Array(buf, a.offset, a.length);
  let lastEro = -1;
  const frames = meta.frames.map((f, i) => {
    const c = f.count, o = f.offset, o8 = o + align4(6 * c);
    if (f.erosion_offset != null) lastEro = i;
    return {t: f.t, count: c, x: new Uint16Array(buf, o, c), y: new Uint16Array(buf, o + 2 * c, c), z: new Uint16Array(buf, o + 4 * c, c),
      s: new Uint8Array(buf, o8, c), l: new Uint8Array(buf, o8 + c, c), f: new Uint8Array(buf, o8 + 2 * c, c),
      ero: f.erosion_offset != null ? new Uint8Array(buf, f.erosion_offset, n) : null, eroIdx: lastEro,
      gh: f.grid_offset != null ? new Uint8Array(buf, f.grid_offset, gn) : null, gc: f.cv_offset != null ? new Uint8Array(buf, f.cv_offset, gn) : null};
  });
  result = {id, meta, fields, frames, tEnd: frames[frames.length - 1].t, flood: meta.engine === 'flood'};
  // capas que este resultado no tiene (p. ej. Cv en MPM, presión de poros en inundación)
  for (const sel of [$('layer'), $('mapLayer')]) for (const o of sel.options)
    o.disabled = !!LAYERS[o.value] && o.value !== 'current' && !fields[o.value];
  for (const sel of [$('layer'), $('mapLayer')]) if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = sel === $('layer') ? 'satellite' : 'current';
  buildScene();
  showSummary();
  $('summary').insertAdjacentHTML('afterbegin', exposure.applyResult(meta));
  result.buildings = exposure.buildings;  // los edificios con que se calculó (para informes aunque después se cambie el escenario)
  zones.show(meta);
  $('summary').insertAdjacentHTML('afterbegin', zones.panelHTML());
  $('summary').insertAdjacentHTML('afterbegin', analysisHeader());
  zones.bindPanel($('summary'));
  bindAnalysisHeader();
  if (releaseOutline) releaseOutline.remove();
  if (result.flood) {
    basinsPanel.showResult(meta.flood.geo);
    plainPanel.showResult(meta);
    const ph = plainPanel.resultHTML(meta);
    if (ph) ($('anaHead') || $('summary')).insertAdjacentHTML($('anaHead') ? 'afterend' : 'afterbegin', ph);
  }
  releaseOutline = L.polygon(meta.release.polygon.map(([lo, la]) => [la, lo]), {color: '#ffd28a', weight: 1.5, dashArray: '4 3', fill: false, interactive: false}).addTo(map);
  if (pendingLayer && [...$('layer').options].some(o => o.value === pendingLayer)) { $('layer').value = pendingLayer; pendingLayer = null; applyLayer(); }
  simT = 0; dynKey = null; playing = false; updatePlayBtn(); showTime(0); refreshDynamic(true);
  status(`${ic('check-circle')} Listo · ${meta.model} · ${meta.solver.device} — <b>Reproducir</b> para ver el evento`);
}

// ───────────────────────────── Biblioteca, informes y comparaciones
const library = new LibraryPanel({api: API, status, toast: (...a) => toast(...a), onOpen: openAnalysis, onReport: openReport, onCompare: openCompare});
library.onRenamed = e => { const h = $('anaHead'); if (h && result && result.id === e.id) { h.outerHTML = analysisHeader(); bindAnalysisHeader(); } };
library.refresh();
const docs = new DocViewer(document.querySelector('main > section'));
$('methodsBtn').onclick = () => docs.show('Métodos de cálculo', 'Metodos de calculo Suriyaco MassFlow 3D', () => methodsHTML(API));

function analysisHeader() {
  const e = library.entry(result.id);
  return `<div class="ana-head" id="anaHead"><div>${ic('folder')}<b>${esc(e ? e.name : result.meta.scenario_name || 'Análisis')}</b>` +
    `<small>${e ? esc(e.project) : 'Análisis sin guardar'}</small></div>` +
    `<div class="row"><button class="tool" id="anaReport">${ic('file-report')}Informe completo</button>` +
    `<button class="tool" id="anaCompare" title="Marcá otros análisis en la biblioteca para compararlos con este">${ic('graph-bar-side-by-side')}Comparar…</button></div></div>`;
}
function bindAnalysisHeader() {
  const id = result.id;
  $('anaReport').onclick = () => openReport(id);
  $('anaCompare').onclick = () => {
    library.selected.add(id); library.render();
    $('libSec').open = true; $('libSec').scrollIntoView({behavior: 'smooth', block: 'start'});
    status('Marcá en la biblioteca los otros análisis a comparar y tocá <b>Comparar</b>.');
  };
}
async function openAnalysis(id) {
  if (!$('cancel').disabled) { status('Hay una simulación en curso: esperá a que termine o cancelala para abrir otro análisis.', true); return; }
  try {
    status(ic('refresh', 16, 'spin') + ' Abriendo el análisis guardado…');
    const r = await fetch(`${API}/api/library/${id}`);
    if (!r.ok) throw new Error(await errText(r));
    const e = await r.json(), ex = e.ui && e.ui.example, v = (e.ui && e.ui.view) || {};
    setMode(null);
    if (ex) loadExample(ex, false, true);
    else { $('exClear').click(); setBBox(e.bbox, false); $('engine').value = e.engine; applyEngine(); }
    $('projName').value = e.project === 'Sin proyecto' ? '' : e.project;
    $('anaName').value = e.name;
    $('anaNotes').value = e.notes || '';
    if (v.layer) pendingLayer = v.layer;
    if (v.mapLayer) $('mapLayer').value = v.mapLayer;
    if (v.exag) { $('exag').value = v.exag; applyExag(); }
    if (v.matStyle) $('matStyle').value = v.matStyle;
    await loadResult(id, `${API}/api/library/${id}`);
    library.setCurrent(id);
    const d = result.meta.domain;
    map.fitBounds([[d.south, d.west], [d.north, d.east]], {padding: [10, 10]});
    status(`${ic('folder-open')} Análisis abierto sin recalcular: <b>${esc(e.name)}</b> · ${esc(e.project)}. <b>Reproducir</b> para ver el evento; tocá las zonas del mapa para ver su detalle.`);
  } catch (err) { status('No se pudo abrir el análisis: ' + err.message, true); }
}
// el resultado de la escena, para que los informes no vuelvan a descargar sus campos
const loaded = () => result && {id: result.id, meta: result.meta, fields: result.fields, buildings: result.buildings};
function snapshot3D() {
  if (!result) return null;
  const keep = simT;
  showTime(result.tEnd);
  controls.update();
  renderer.render(scene, camera);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  showTime(keep);
  return url;
}
function openReport(id) {
  const e = library.entry(id), name = e ? e.name : 'Análisis';
  docs.show(`Informe · ${name}`, `Informe ${name}`, async msg => {
    msg('Leyendo el análisis…');
    const A = await loadAnalysis(API, id, loaded());
    if (result && result.id === id) A.snapshot3D = snapshot3D();
    return buildReport(A, msg);
  });
}
function openCompare(ids) {
  if (ids.length < 2) { if (ids.length) openReport(ids[0]); return; }
  docs.show(`Comparación de ${ids.length} escenarios`, `Comparacion ${ids.length} escenarios`, async msg => {
    msg('Leyendo los análisis…');
    const As = await Promise.all(ids.map(id => loadAnalysis(API, id, loaded())));
    As.sort((a, b) => a.entry.created - b.entry.created);
    return buildComparison(As, msg);
  });
}

function showSummary() {
  if (result.flood) return showFloodSummary();
  const m = result.meta, s = m.summary, r = m.release, v = m.solver;
  const rows = [
    ['Volumen liberado', fmtVol(r.volume_m3)],
    ['Área / espesor medio · máx.', `${fmtArea(r.area_m2)} · ${fmt(r.mean_thickness_m, 1)} / ${fmt(r.max_thickness_m, 1)} m`],
    ['Volumen erosionado', fmtVol(s.eroded_volume_m3)],
    ['Volumen depositado', fmtVol(s.deposit_volume_m3)],
    ['Salió del dominio', fmtVol(v.outflow_volume_m3)],
    ['Alcance (runout)', fmt(s.runout_m, 0) + ' m'],
    ['H/L (fricción aparente)', fmt(s.H_over_L, 3)],
    ['Velocidad máx.', `${fmt(s.max_speed_m_s, 1)} m/s (${fmt(s.max_speed_km_h, 0)} km/h)`],
    ['Profundidad máx.', fmt(s.max_depth_m, 1) + ' m'],
    ['λ máx. (presión de poros)', fmt(s.max_pore_ratio, 2)],
    ['Área afectada', fmtArea(s.affected_area_m2)],
    ['Densidad mezcla', fmt(m.material.rho_mixture, 0) + ' kg/m³'],
    ['DEM', m.dem_source || m.dataset],
    ['Solver', `${v.device} · ${v.grid ? v.grid.join('×') + ' nodos' : ''} · dx ${fmt(m.domain.dx, 1)} m`],
    ['Partículas (inicio → final)', `${fmt(r.particles, 0)} → ${fmt(v.particles_final, 0)}`],
    ['Tiempo simulado / cómputo', `${fmt(v.t_end, 1)} s / ${fmt(s.wall_time_s, 0)} s${v.stopped_early ? ' (detenido)' : ''}`],
  ];
  for (const b of m.bodies || []) {
    const t = b.trigger;
    if (!t) continue;
    rows.unshift(
      [`${ic('rain')} Lluvia que dispara «${b.name}»`, `${fmt(t.rain_mm, 0)} mm en ${fmt(t.days, 0)} días${t.melt_mm ? ` + ${fmt(t.melt_mm, 0)} mm deshielo` : ''}`],
      ['Área que falla / volumen', `${fmt(t.failed_area_m2 / 1e4, 1)} ha · ${fmtVol(t.volume_m3)}`],
      ['Saturación media / FS mínimo', `${fmt(t.saturated_fraction_mean * 100, 0)} % · ${fmt(t.fs_min, 2)}`],
      ['Lluvia crítica (mín · p50)', t.critical_rain_min_mm != null ? `${fmt(t.critical_rain_min_mm, 0)} · ${fmt(t.critical_rain_p50_mm, 0)} mm` : '—']);
  }
  $('summary').innerHTML = `<b>Resumen</b><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>` +
    m.warnings.map(w => `<div class="warn">⚠ ${w}</div>`).join('');
}

function showFloodSummary() {
  const m = result.meta, s = m.summary, v = m.solver, f = m.flood, t = f.totals, st = f.storm;
  const rows = [
    [`${ic('rain')} Tormenta`, `${fmt(st.rain_mm, 0)} mm en ${fmt(st.duration_h, 2)} h · pico ${fmt(st.peak_intensity_mm_h, 0)} mm/h`],
    ['Lluvia areal (reducción)', `${fmt(t.rain_mm, 1)} mm (× ${fmt(t.areal_reduction, 2)})`],
    ['Lluvia / escorrentía', `${fmtVol(t.rain_m3)} / ${fmtVol(t.runoff_m3)} (C = ${fmt(t.runoff_coeff, 2)})`],
    ['Salió de la zona / queda en ella', `${fmtVol(t.outflow_m3)} / ${fmtVol(t.stored_m3)}`],
    ['Área inundada (h > 0,1 m)', fmt(t.flooded_area_km2, 2) + ' km²'],
    ['Profundidad · velocidad máx.', `${fmt(s.max_depth_m, 1)} m · ${fmt(s.max_speed_m_s, 1)} m/s`],
    ['Cv máx. (sedimento)', `${fmt(s.max_cv, 2)}${s.max_cv >= 0.4 ? ' · flujo de detritos' : s.max_cv >= 0.2 ? ' · hiperconcentrado' : ''}`],
    ['Deslizamientos de ladera', t.landslide_cells ? `${fmt(t.landslide_cells, 0)} celdas · ${fmtVol(t.landslide_m3)}` : 'ninguno'],
    ['Erosionado / depositado', `${fmtVol(t.eroded_m3)} / ${fmtVol(t.deposited_m3)}`],
    ['Bloques movilizados', `${fmt(t.boulders_moved, 0)} de ${fmt(t.boulders, 0)} · recorrido máx. ${fmt(t.boulder_max_travel_m, 0)} m${t.boulders_in_urban ? ` · ${t.boulders_in_urban} en zona urbana` : ''}`],
    ['Árboles arrancados', `${fmt(t.trees_uprooted, 0)} de ${fmt(t.trees, 0)} · recorrido máx. ${fmt(t.log_max_travel_m, 0)} m${t.logs_in_urban ? ` · ${t.logs_in_urban} en zona urbana` : ''}`],
    ['DEM', m.dem_source || m.dataset],
    ['Solver', `${v.device} · ${v.grid.join('×')} celdas · dx ${fmt(m.domain.dx, 1)} m · ${fmt(v.steps, 0)} pasos`],
    ['Tiempo simulado / cómputo', `${fmtDur(v.t_end)} / ${fmtDur(s.wall_time_s)}`],
  ];
  $('summary').innerHTML = `<b>Resumen</b><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>` +
    floodBasinsHTML(f) + m.warnings.map(w => `<div class="warn">⚠ ${w}</div>`).join('');
}

// ───────────────────────────── Escena 3D
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({canvas, antialias: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02070b);
const camera = new THREE.PerspectiveCamera(40, 2, 0.001, 50);
camera.up.set(0, 0, 1);
camera.position.set(0.55, -1.05, 0.75);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const hemi = new THREE.HemisphereLight(0xdfefff, 0x1d2630, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(-1.2, 1.0, 2.2);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, {left: -0.8, right: 0.8, top: 0.8, bottom: -0.8, near: 0.5, far: 6});
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.002;
scene.add(sun);
scene.add(sun.target);
const SUN_DIR = new THREE.Vector3(-1.2, 1.0, 2.2).normalize();
const world = new THREE.Group();
scene.add(world);
let terrain = null, points = null, reliefColors = null, currentEro = -2, satTex = null;
const realistic = new Realistic(world);
const exposure = new Exposure(map, world);
const zones = new ImpactZones(map, exposure);
const SKY = skyTexture(), DARK = new THREE.Color(0x02070b);
let spdA = new Float32Array(0), lamA = new Float32Array(0), flgA = new Uint8Array(0);
for (const [k, st] of Object.entries(STYLES)) $('matStyle').add(new Option(st.name, k));

const dot = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.7, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
})();

function exag() { return +$('exag').value; }
function applyExag() {
  $('exagOut').value = exag().toFixed(1) + '×';
  if (!result) return;
  const S = result.S;
  world.scale.set(S, S, S * exag());
  exposure.layout3D(exag());
}
$('exag').oninput = () => { applyExag(); if (result && !playing) showTime(simT); };

function disposeObj(o) { if (!o) return; world.remove(o); o.geometry.dispose(); o.material.dispose(); }

function buildScene() {
  const d = result.meta.domain, {nx, ny, dx} = d;
  result.S = 1 / Math.max(d.Lx, d.Ly);
  world.position.set(-d.Lx * result.S / 2, -d.Ly * result.S / 2, 0);
  applyExag();
  disposeObj(terrain); disposeObj(points);

  const bed = result.fields.terrain_bed0, n = nx * ny;
  const pos = new Float32Array(n * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    pos[k * 3] = i * dx; pos[k * 3 + 1] = j * dx; pos[k * 3 + 2] = bed[k] - d.zmin;
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let q = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
    idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = e; idx[q++] = c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  terrain = new THREE.Mesh(g, new THREE.MeshStandardMaterial({vertexColors: true, roughness: .95, metalness: 0, side: THREE.DoubleSide}));
  terrain.receiveShadow = true;
  world.add(terrain);
  satTex = null;
  const thisResult = result;
  satelliteTexture(d).then(({tex, uv}) => {
    if (result !== thisResult) { tex.dispose(); return; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    satTex = tex;
    applyLayer();
  }).catch(e => console.warn('Imagen satelital no disponible:', e));

  const pre = result.fields.terrain_pre;
  let hmin = Infinity, hmax = -Infinity;
  for (const h of pre) { if (h < hmin) hmin = h; if (h > hmax) hmax = h; }
  reliefColors = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const c = lutIndex((bed[k] - hmin) / Math.max(1, hmax - hmin));
    reliefColors[k * 3] = LUT.relief[c]; reliefColors[k * 3 + 1] = LUT.relief[c + 1]; reliefColors[k * 3 + 2] = LUT.relief[c + 2];
  }
  currentEro = -2;
  for (const k of Object.keys(LAYERS)) delete LAYERS[k].range;

  const cap = Math.max(...result.frames.map(f => f.count));
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  // las partículas inactivas van en NaN: esfera fija para que three.js no la calcule (solo se usa para ordenar)
  pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(d.Lx / 2, d.Ly / 2, 0), Math.hypot(d.Lx, d.Ly));
  points = new THREE.Points(pg, new THREE.PointsMaterial({size: 1, vertexColors: true, map: dot, alphaTest: 0.5, sizeAttenuation: true}));
  points.frustumCulled = false;
  world.add(points);
  updatePointSize();
  spdA = new Float32Array(cap); lamA = new Float32Array(cap); flgA = new Uint8Array(cap);
  realistic.build(result, cap);
  realistic.setStyle(styleName());
  exposure.build3D(result, (x, y) => {
    const i = Math.min(nx - 1, Math.max(0, Math.round(x / dx))), j = Math.min(ny - 1, Math.max(0, Math.round(y / dx)));
    return pre[j * nx + i] - d.zmin;
  });
  exposure.layout3D(exag());

  result.speedMax = Math.max(10, Math.ceil(result.meta.summary.max_speed_m_s * 0.8 / 10) * 10);
  $('empty').hidden = true;
  $('play').disabled = false; $('time').disabled = false; $('focus').disabled = false; $('overview').disabled = false;
  applyView();
  result.hmax = hmax;
  focusFlow();
}

// Encuadre: bbox de la zona afectada (profundidad máx. > 0,1 m) + área de desprendimiento.
function flowExtent() {
  const d = result.meta.domain, F = result.fields.max_depth;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let j = 0; j < d.ny; j++) for (let i = 0; i < d.nx; i++) if (F[j * d.nx + i] > 0.1) {
    x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j);
  }
  if (!isFinite(x0)) return null;
  return {cx: (x0 + x1) / 2 * d.dx, cy: (y0 + y1) / 2 * d.dx, ext: Math.max(x1 - x0, y1 - y0, 8) * d.dx,
    k: Math.round((y0 + y1) / 2) * d.nx + Math.round((x0 + x1) / 2)};
}
function frameCamera(cx, cy, cz, dist, shadowHalf, dir = new THREE.Vector3(0.42, -0.8, 0.55)) {
  const t = new THREE.Vector3(cx, cy, cz);
  controls.target.copy(t);
  camera.position.copy(t).add(dir.clone().normalize().multiplyScalar(dist));
  controls.update();
  // sombras nítidas en la zona encuadrada
  sun.target.position.copy(t);
  sun.position.copy(t).addScaledVector(SUN_DIR, 2.5);
  shadowHalf = Math.min(shadowHalf, 0.35);
  Object.assign(sun.shadow.camera, {left: -shadowHalf, right: shadowHalf, top: shadowHalf, bottom: -shadowHalf, near: 0.5, far: 5});
  sun.shadow.camera.updateProjectionMatrix();
}
function focusFlow() {
  if (!result) return;
  const d = result.meta.domain, S = result.S, e = flowExtent();
  if (!e) return overview();
  const z = (result.fields.terrain_pre[e.k] - d.zmin) * S * exag();
  const ext = e.ext * S;
  // dirección del flujo: del centroide del desprendimiento al centroide del depósito;
  // la cámara mira pendiente arriba desde aguas abajo y de costado
  const rel = result.meta.release, rx = (rel.centroid_lon - d.west) * d.mx, ry = (rel.centroid_lat - d.south) * d.my;
  const D = result.fields.deposit;
  let sx = 0, sy = 0, sw = 0;
  for (let j = 0; j < d.ny; j++) for (let i = 0; i < d.nx; i++) { const w = D[j * d.nx + i]; if (w > 0.1) { sx += w * i * d.dx; sy += w * j * d.dx; sw += w; } }
  let fx = sw ? sx / sw - rx : 0, fy = sw ? sy / sw - ry : 0;
  const fl = Math.hypot(fx, fy);
  const dir = fl > d.dx ? new THREE.Vector3(fx / fl * 0.75 - fy / fl * 0.55, fy / fl * 0.75 + fx / fl * 0.55, 0.62) : undefined;
  frameCamera(e.cx * S - d.Lx * S / 2, e.cy * S - d.Ly * S / 2, z, Math.max(0.12, ext * 1.35), Math.max(0.08, ext * 0.9), dir);
}
function overview() {
  if (!result) return;
  const d = result.meta.domain;
  frameCamera(0, 0, (result.hmax - d.zmin) * result.S * exag() * 0.4, 1.9, 0.8);
}
// Cámara que acompaña al flujo: desplaza objetivo y cámara juntos (conserva el ángulo elegido por el usuario).
const _goal = new THREE.Vector3(), _delta = new THREE.Vector3();
function followFlow() {
  const st = realistic.stats;
  if (!$('follow').checked || !st || !result) return;
  const d = result.meta.domain, S = result.S;
  _goal.set(st.x * S - d.Lx * S / 2, st.y * S - d.Ly * S / 2, st.z * S * exag());
  _delta.subVectors(_goal, controls.target).multiplyScalar(playing ? 0.12 : 1);
  controls.target.add(_delta);
  camera.position.add(_delta);
  // acercar/alejar suavemente según el tamaño actual del flujo
  const want = Math.max(0.06, st.ext * S * 2.2), cur = camera.position.distanceTo(controls.target);
  if (!followFlow.userZoom) camera.position.sub(controls.target).multiplyScalar(1 + (want / cur - 1) * (playing ? 0.05 : 1)).add(controls.target);
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(SUN_DIR, 2.5);
}
// si el usuario hace zoom con la rueda, respetar su distancia
renderer.domElement.addEventListener('wheel', () => { followFlow.userZoom = true; }, {passive: true});
$('follow').onchange = () => { followFlow.userZoom = false; if (!playing) showTime(simT); };
$('focus').onclick = () => { followFlow.userZoom = false; focusFlow(); };
$('overview').onclick = overview;

function updatePointSize() {
  if (!points || !result) return;
  // inundación: los puntos son bloques y árboles (no representan volumen)
  if (result.flood) { points.material.size = Math.max(3, result.meta.domain.dx * 0.3) * result.S * +$('psize').value; return; }
  const sp = result.meta.release.spacing_m || result.meta.domain.dx / 3;
  // si se muestra un subconjunto, cada punto representa más volumen
  const shown = result.frames[0].count, ratio = Math.max(1, result.meta.release.particles / Math.max(1, shown));
  points.material.size = sp * Math.cbrt(ratio) * result.S * 1.5 * +$('psize').value;
}
$('psize').oninput = updatePointSize;

function layerRange(name) {
  if (name === 'current') return layerRange('max_depth');
  const lay = LAYERS[name];
  if (lay.range) return lay.range;
  if (lay.fixed) return (lay.range = lay.fixed);
  const vals = [];
  for (const v of result.fields[name]) if (lay.mask(v)) vals.push(lay.diverging ? Math.abs(v) : v);
  vals.sort((a, b) => a - b);
  const hi = vals.length ? vals[Math.floor(vals.length * 0.99)] || vals[vals.length - 1] : 1;
  return (lay.range = lay.diverging ? [-hi, hi] : [0, hi || 1]);
}

function applyLayer() {
  if (!result) return;
  const name = $('layer').value, col = terrain.geometry.attributes.color.array, mat = terrain.material;
  const useSat = name === 'satellite' && satTex;
  if (mat.map !== (useSat ? satTex : null) || mat.vertexColors !== !useSat) {
    mat.map = useSat ? satTex : null; mat.vertexColors = !useSat; mat.needsUpdate = true;
  }
  col.set(reliefColors);
  if (LAYERS[name] && result.fields[name]) {
    const lay = LAYERS[name], F = result.fields[name], [lo, hi] = layerRange(name), lut = LUT[lay.ramp];
    for (let k = 0; k < F.length; k++) {
      if (!lay.mask(F[k]) || !reached(name, k)) { col[k * 3] *= .55; col[k * 3 + 1] *= .55; col[k * 3 + 2] *= .55; continue; }
      const c = lutIndex((F[k] - lo) / (hi - lo));
      col[k * 3] = lut[c]; col[k * 3 + 1] = lut[c + 1]; col[k * 3 + 2] = lut[c + 2];
    }
  }
  terrain.geometry.attributes.color.needsUpdate = true;
  updateMapOverlay();
  updateLegend();
}
// las capas de resultados se descubren a medida que el flujo llega (arribo ≤ t); la capa "actual" es instantánea
function reached(name, k) {
  if (name === 'current' || LAYERS[name].always) return true;
  const a = result.fields.arrival[k];
  return a >= 0 && a <= simT + 1e-6;
}
let dynKey = null;
function refreshDynamic(force = false) {
  const F = result.frames;
  let a = 0;
  while (a < F.length - 1 && F[a + 1].t <= simT) a++;
  if (!force && a === dynKey) return;
  dynKey = a;
  const ml = $('mapLayer').value, onMap = ml === 'same' ? $('layer').value : ml;
  if (LAYERS[$('layer').value] || LAYERS[onMap]) {
    if ($('layer').value === 'current' || onMap === 'current') computeCurrentDepth();
    applyLayer();
  }
}
// tirante (m) y Cv del instante t en la grilla completa, interpolados entre cuadros (motor de inundación)
function gridAt(t) {
  const F = result.frames, gm = result.meta.grid_frames, d = result.meta.domain, n = d.nx * d.ny;
  let a = 0;
  while (a < F.length - 1 && F[a + 1].t <= t) a++;
  const b = Math.min(a + 1, F.length - 1), w = b === a ? 0 : Math.max(0, Math.min(1, (t - F[a].t) / (F[b].t - F[a].t)));
  const key = a + ':' + w.toFixed(3);
  if (result._gkey === key) return result._grid;
  const H = result._grid ? result._grid.h : new Float32Array(n), C = result._grid ? result._grid.cv : new Float32Array(n);
  const A = F[a].gh, B = F[b].gh, Ac = F[a].gc, Bc = F[b].gc, hs = gm.h_scale, cs = gm.cv_scale / 255, st = gm.stride;
  if (!A || !B) return null;
  for (let j = 0; j < d.ny; j++) {
    const gj = Math.min(gm.ny - 1, Math.round(j / st)) * gm.nx;
    for (let i = 0; i < d.nx; i++) {
      const g = gj + Math.min(gm.nx - 1, Math.round(i / st)), qa = A[g] / 255, qb = B[g] / 255, k = j * d.nx + i;
      H[k] = (qa * qa + (qb * qb - qa * qa) * w) * hs;
      C[k] = (Ac[g] + (Bc[g] - Ac[g]) * w) * cs;
    }
  }
  result._gkey = key;
  return (result._grid = {h: H, cv: C});
}
// espesor actual del flujo a partir de las partículas visibles del instante (volumen por partícula visible / área)
function computeCurrentDepth() {
  const d = result.meta.domain, {nx, ny, dx} = d, n = nx * ny;
  const F = result.fields.current || (result.fields.current = new Float32Array(n));
  if (result.flood) { const g = gridAt(simT); if (g) F.set(g.h); return; }
  const T = result._tmpDepth || (result._tmpDepth = new Float32Array(n));
  F.fill(0);
  const pos = points.geometry.attributes.position.array, cnt = points.geometry.drawRange.count;
  const rel = result.meta.release, vdisp = (rel.volume_m3 + (rel.water_volume_m3 || 0)) / Math.max(1, result.frames[0].count);
  const add = vdisp / (dx * dx);
  for (let p = 0; p < cnt; p++) {
    if (flgA[p] === 255 || isNaN(pos[p * 3])) continue;
    const i = Math.round(pos[p * 3] / dx), j = Math.round(pos[p * 3 + 1] / dx);
    if (i >= 0 && j >= 0 && i < nx && j < ny) F[j * nx + i] += add;
  }
  // suavizado 3×3 (conserva volumen) para que una partícula no se vea como una celda aislada
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const jj = Math.min(ny - 1, Math.max(0, j + dj)), ii = Math.min(nx - 1, Math.max(0, i + di));
      s += F[jj * nx + ii] * (di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1);
    }
    T[j * nx + i] = s / 16;
  }
  F.set(T);
}
$('layer').onchange = () => { if (result) refreshDynamic(true); else applyLayer(); };
$('mapLayer').onchange = () => { if (result) refreshDynamic(true); };
$('colorBy').onchange = () => { updateLegend(); showTime(simT); };

LAYERS.current.mask = v => v > (result && result.flood ? 0.05 : 0.2);
function updateMapOverlay() {
  const ml = $('mapLayer').value, name = ml === 'same' ? $('layer').value : ml;
  if (!result || !LAYERS[name] || !result.fields[name]) { if (overlay) { overlay.remove(); overlay = null; } return; }
  const d = result.meta.domain, lay = LAYERS[name], F = result.fields[name], [lo, hi] = layerRange(name);
  const cv = document.createElement('canvas'); cv.width = d.nx; cv.height = d.ny;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(d.nx, d.ny);
  const cs = RAMPS[lay.ramp].map(hexRGB);
  for (let j = 0; j < d.ny; j++) for (let i = 0; i < d.nx; i++) {
    const v = F[j * d.nx + i], o = ((d.ny - 1 - j) * d.nx + i) * 4;
    if (!lay.mask(v) || !reached(name, j * d.nx + i)) continue;
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * (cs.length - 1), k = Math.min(cs.length - 2, Math.floor(t));
    for (let ch = 0; ch < 3; ch++) img.data[o + ch] = cs[k][ch] + (cs[k + 1][ch] - cs[k][ch]) * (t - k);
    img.data[o + 3] = 210;
  }
  ctx.putImageData(img, 0, 0);
  const hx = d.dx / 2 / d.mx, hy = d.dx / 2 / d.my;
  const url = cv.toDataURL();
  if (overlay && overlay._resultRef === result) overlay.setUrl(url);
  else {
    if (overlay) overlay.remove();
    overlay = L.imageOverlay(url, [[d.south - hy, d.west - hx], [d.north + hy, d.east + hx]], {opacity: .8, interactive: false}).addTo(map);
    overlay._resultRef = result;
  }
}

function updateLegend() {
  const by = $('colorBy').value;
  let html = '';
  if (view() === 'realistic' && result && result.flood) html += `<div style="margin-bottom:4px">Vista realista · lámina de agua y barro<br>` +
    `<span class="sw" style="background:#6f9aa0;margin-left:0"></span>agua <span class="sw" style="background:#a2804f"></span>hiperconcentrado <span class="sw" style="background:#6e5238"></span>flujo de detritos</div>`;
  else if (view() === 'realistic') html += `<div style="margin-bottom:4px">Vista realista · ${STYLES[styleName()].name}<br><span class="sw" style="background:${STYLES[styleName()].surface};margin-left:0"></span>masa desprendida <span class="sw" style="background:#a08c6c"></span>material erosionado</div>`;
  else if (by === 'speed') html += legendRow('Velocidad de partículas', RAMPS.speed, 0, result ? result.speedMax : 60, 'm/s');
  else if (by === 'pore') html += legendRow('Presión de poros λ = p/σ', RAMPS.pore, 0, 1, '');
  else if (result && result.flood) html += `<div>Trazadores <span class="sw" style="background:#9aa3ab"></span>bloque<span class="sw" style="background:#2f8f3a"></span>árbol en pie<span class="sw" style="background:#8b5a2b"></span>tronco arrastrado</div>`;
  else html += `<div>Origen <span class="sw" style="background:#c9a36b"></span>desprendimiento<span class="sw" style="background:#ff6a2b"></span>erosionado<span class="sw" style="background:#3fa9f5"></span>agua</div>`;
  const name = $('layer').value;
  if (result && LAYERS[name]) {
    const [lo, hi] = layerRange(name);
    html += LAYERS[name].cats
      ? `<div>${LAYERS[name].name}<br>${LAYERS[name].cats.map((c, k) => `<span class="sw" style="background:${RAMPS[LAYERS[name].ramp][k]};margin-left:${k ? 8 : 0}px"></span>${c}`).join('')}</div>`
      : legendRow(LAYERS[name].name, RAMPS[LAYERS[name].ramp], lo, hi, LAYERS[name].unit);
  }
  $('legend').innerHTML = html;
}
function legendRow(title, stops, lo, hi, unit) {
  const mid = (lo + hi) / 2, d = Math.abs(hi) < 10 ? 2 : 0;
  return `<div style="margin-bottom:4px">${title}${unit ? ' (' + unit + ')' : ''}<div class="ramp" style="background:${gradientCSS(stops)}"></div>` +
    `<div class="ticks"><span>${fmt(lo, d)}</span><span>${fmt(mid, d)}</span><span>${fmt(hi, d)}${hi === (result && result.speedMax) ? '+' : ''}</span></div></div>`;
}

// ───────────────────────────── Reproducción
let playing = false, simT = 0, lastTs = null;
const ORIGIN = [new THREE.Color('#c9a36b'), new THREE.Color('#ff6a2b'), new THREE.Color('#3fa9f5')];
// trazadores del motor de inundación (bandera): 3 tronco arrastrado · 4 bloque de roca · 5 árbol en pie
const TRACER = {3: new THREE.Color('#8b5a2b'), 4: new THREE.Color('#9aa3ab'), 5: new THREE.Color('#2f8f3a')};

function updateTerrainErosion(fi) {
  const fr = result.frames[fi], ei = fr.eroIdx;
  if (ei === currentEro) return;
  currentEro = ei;
  const d = result.meta.domain, bed = result.fields.terrain_bed0, pos = terrain.geometry.attributes.position.array;
  const sc = result.meta.frame_format.erosion_scale / 255, ero = ei >= 0 ? result.frames[ei].ero : null;
  for (let k = 0; k < bed.length; k++) pos[k * 3 + 2] = bed[k] - d.zmin - (ero ? ero[k] * sc : 0);
  terrain.geometry.attributes.position.needsUpdate = true;
  terrain.geometry.computeVertexNormals();
}

function showTime(t) {
  if (!result) return;
  const F = result.frames;
  let a = 0;
  while (a < F.length - 1 && F[a + 1].t <= t) a++;
  const b = Math.min(a + 1, F.length - 1);
  const w = b === a ? 0 : Math.max(0, Math.min(1, (t - F[a].t) / (F[b].t - F[a].t)));
  const fa = F[a], fb = F[b], ff = result.meta.frame_format, d = result.meta.domain;
  const kx = ff.Lx / 65535, ky = ff.Ly / 65535, kz = (ff.zmax - ff.zmin) / 65535, z0 = ff.zmin - d.zmin + (result.meta.release.spacing_m || 2) * 0.4;
  const pos = points.geometry.attributes.position.array, col = points.geometry.attributes.color.array;
  const by = $('colorBy').value, lutS = LUT.speed, lutP = LUT.pore, vs = ff.speed_max / 255 / result.speedMax, ks = ff.speed_max / 255;
  const n = Math.max(fa.count, fb.count);
  for (let i = 0; i < n; i++) {
    const ia = i < fa.count && fa.f[i] !== 255, ib = i < fb.count && fb.f[i] !== 255;
    let src = null, ww = w;
    if (ia && ib) src = 'ab'; else if (ib && w >= 0.5) { src = 'b'; } else if (ia && w < 0.5) { src = 'a'; }
    if (!src) { pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = NaN; flgA[i] = 255; continue; }
    if (src === 'a') ww = 0; else if (src === 'b') ww = 1;
    const A = ww < 1 ? fa : fb, B = ww > 0 ? fb : fa;
    pos[i * 3] = (A.x[i] + (B.x[i] - A.x[i]) * ww) * kx;
    pos[i * 3 + 1] = (A.y[i] + (B.y[i] - A.y[i]) * ww) * ky;
    pos[i * 3 + 2] = (A.z[i] + (B.z[i] - A.z[i]) * ww) * kz + z0;
    spdA[i] = (A.s[i] + (B.s[i] - A.s[i]) * ww) * ks;
    lamA[i] = (A.l[i] + (B.l[i] - A.l[i]) * ww) / 255;
    flgA[i] = (ww < 0.5 ? A : B).f[i];
    let c;
    if (by === 'speed') { const c0 = lutIndex((A.s[i] + (B.s[i] - A.s[i]) * ww) * vs); col[i * 3] = lutS[c0]; col[i * 3 + 1] = lutS[c0 + 1]; col[i * 3 + 2] = lutS[c0 + 2]; continue; }
    if (by === 'pore') { const c0 = lutIndex((A.l[i] + (B.l[i] - A.l[i]) * ww) / 255); col[i * 3] = lutP[c0]; col[i * 3 + 1] = lutP[c0 + 1]; col[i * 3 + 2] = lutP[c0 + 2]; continue; }
    const of = (ww < 0.5 ? A : B).f[i];
    c = TRACER[of] || ORIGIN[of === 1 ? 1 : of === 2 ? 2 : 0];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  points.geometry.setDrawRange(0, n);
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
  updateTerrainErosion(w < 0.5 ? a : b);
  exposure.update3D(t);
  refreshDynamic();
  if (view() === 'realistic') {
    const bed = terrain.geometry.attributes.position.array, gr = result.flood && gridAt(t);
    if (gr) realistic.updateGrid({h: gr.h, cv: gr.cv, pos, lam: lamA, flg: flgA, n, exag: exag(), bed});
    else realistic.update({pos, spd: spdA, lam: lamA, flg: flgA, n, exag: exag(), bed});
    followFlow();
  }
  $('time').value = result.tEnd ? t / result.tEnd : 0;
  $('timeLabel').textContent = `${fmt(t, 1)} / ${fmt(result.tEnd, 0)} s`;
}

// ───────────────────────────── Vista (análisis / realista)
function view() { return $('view').value; }
function styleName() {
  const v = $('matStyle').value;
  if (v === 'auto' && result && result.flood) return 'debris';
  return v === 'auto' ? autoStyle(result && result.meta.material, !!(result && (result.meta.bodies || []).some(b => b.material === 'agua'))) : v;
}
function applyView() {
  const real = view() === 'realistic';
  scene.background = real ? SKY : DARK;
  scene.fog = real ? new THREE.Fog(0xcfd9df, 2.2, 7) : null;
  sun.castShadow = real;
  sun.intensity = real ? 3.0 : 2.6;
  hemi.intensity = real ? 2.1 : 1.5;
  hemi.groundColor.set(real ? 0x5a5040 : 0x1d2630);
  // en la barra solo los controles de la vista activa
  $('colorBy').closest('label').hidden = real;
  $('psize').closest('label').hidden = real;
  $('matStyle').closest('label').hidden = !real;
  $('follow').closest('label').hidden = !real;
  if (real && $('layer').value === 'relief') $('layer').value = 'satellite';
  if (result) {
    points.visible = !real;
    realistic.group.visible = real;
    applyLayer();
    showTime(simT);
  }
  updateLegend();
}
$('view').onchange = applyView;
$('matStyle').onchange = () => { if (result) { realistic.setStyle(styleName()); showTime(simT); } updateLegend(); };

function updatePlayBtn() { $('play').innerHTML = ic(playing ? 'pause' : 'play'); }
$('play').onclick = () => {
  if (!result) return;
  if (!playing && simT >= result.tEnd) simT = 0;
  playing = !playing; updatePlayBtn();
};
$('time').oninput = () => { if (!result) return; playing = false; updatePlayBtn(); simT = +$('time').value * result.tEnd; showTime(simT); };

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
function tick(ts) {
  requestAnimationFrame(tick);
  resize();
  if (playing && result) {
    if (lastTs != null) {
      simT += (ts - lastTs) / 1000 * +$('speed').value;
      if (simT >= result.tEnd) { simT = result.tEnd; playing = false; updatePlayBtn(); }
      showTime(simT);
    }
    lastTs = ts;
  } else lastTs = null;
  controls.update();
  renderer.render(scene, camera);
}
applyView();
applyEngine();
wizard.show('start');
requestAnimationFrame(tick);
