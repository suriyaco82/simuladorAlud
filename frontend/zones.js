// Zonas de afectación en el mapa: polígonos por intensidad, con el detalle de la zona y de sus edificios al tocarlas.
import {DAMAGE_COLORS, DAMAGE_NAMES, LEVEL_COLORS, CRITICALITY_COLORS} from './palette.js';
import {buildingImpact, buildingHeight, damageChip} from './exposure.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const fmtT = s => s == null ? '—' : s < 120 ? fmt(s, 0) + ' s' : s < 7200 ? fmt(s / 60, 1) + ' min' : fmt(s / 3600, 2) + ' h';
const ha = m2 => m2 >= 1e6 ? fmt(m2 / 1e6, 2) + ' km²' : fmt(m2 / 1e4, 2) + ' ha';
export const critChip = c => `<span class="crit" style="background:${CRITICALITY_COLORS[c]}">${c}</span>`;

// barra apilada de edificios por grado de daño
export function damageBar(counts, total) {
  const n = total || [1, 2, 3, 4].reduce((a, g) => a + (counts[DAMAGE_NAMES[g]] || 0), 0);
  if (!n) return '';
  return `<div class="bar">${[4, 3, 2, 1].map(g => { const c = counts[DAMAGE_NAMES[g]] || 0; return c ? `<i style="width:${c / n * 100}%;background:${DAMAGE_COLORS[g]}" title="${DAMAGE_NAMES[g]}: ${c}"></i>` : ''; }).join('')}</div>`;
}

export class ImpactZones {
  constructor(map, exposure) {
    this.map = map;
    this.exposure = exposure;
    if (!map.getPane('zonesPane')) map.createPane('zonesPane').style.zIndex = 420;
    this.layer = L.layerGroup();
    this.polys = new Map();
    this.labels = L.layerGroup();
    this.zones = [];
  }

  clear() {
    this.layer.clearLayers(); this.labels.clearLayers(); this.polys.clear(); this.zones = [];
    this.layer.remove(); this.labels.remove();
  }

  show(meta) {
    this.clear();
    const imp = meta.impact;
    if (!imp || !imp.zones.length) return;
    this.meta = meta;
    this.zones = imp.zones;
    // las de menor intensidad abajo, para que las graves queden encima y se puedan tocar
    for (const z of [...imp.zones].sort((a, b) => a.level - b.level)) {
      const crit = z.criticality === 'Crítica';
      const latlngs = z.polygons.map(rings => rings.map(r => r.map(([lo, la]) => [la, lo])));
      const p = L.polygon(latlngs, {pane: 'zonesPane', className: 'zone-poly', color: crit ? CRITICALITY_COLORS['Crítica'] : LEVEL_COLORS[z.level],
        weight: crit ? 3 : 1.5, opacity: .95, fillColor: LEVEL_COLORS[z.level], fillOpacity: .28, bubblingMouseEvents: false});
      p.bindTooltip(`${z.code} · ${z.criticality} · intensidad ${z.level_name}${z.buildings_affected ? ` · ${z.buildings_affected} edificios` : ''}`, {sticky: true});
      p.on('click', e => this.open(z.code, e.latlng));
      p.on('mouseover', () => p.setStyle({fillOpacity: .45}));
      p.on('mouseout', () => p.setStyle({fillOpacity: .28}));
      p.addTo(this.layer);
      this.polys.set(z.code, p);
      if (z.criticality === 'Crítica' || z.criticality === 'Alta' || z.buildings_affected)
        L.marker([z.center[1], z.center[0]], {pane: 'zonesPane', interactive: false,
          icon: L.divIcon({className: 'zone-label', html: `<span style="border-color:${CRITICALITY_COLORS[z.criticality]}">${z.code}</span>`, iconSize: null})}).addTo(this.labels);
    }
    this.layer.addTo(this.map);
    this.labels.addTo(this.map);
  }

  setVisible(on) {
    if (!this.zones.length) return;
    if (on) { this.layer.addTo(this.map); this.labels.addTo(this.map); } else { this.layer.remove(); this.labels.remove(); }
  }

  focus(code) {
    const p = this.polys.get(code);
    if (!p) return;
    this.setVisible(true);
    this.map.fitBounds(p.getBounds(), {padding: [30, 30], maxZoom: 17});
    const z = this.zones.find(q => q.code === code);
    setTimeout(() => this.open(code, L.latLng(z.center[1], z.center[0])), 300);
  }

  open(code, latlng) {
    const z = this.zones.find(q => q.code === code);
    if (!z) return;
    const pop = L.popup({maxWidth: 460, minWidth: 340, maxHeight: Math.max(220, this.map.getSize().y - 60), className: 'zone-popup', autoPanPadding: [10, 10]})
      .setLatLng(latlng).setContent(this.zoneHTML(z)).openOn(this.map);
    const el = pop.getElement();
    el.querySelectorAll('[data-b]').forEach(tr => tr.onclick = () => this.exposure.openBuilding(+tr.dataset.b, true));
  }

  zoneHTML(z) {
    const pts = this.meta.exposure && this.meta.exposure.points, B = this.exposure.buildings || [];
    const rows = [
      ['Intensidad del flujo', `<span class="sw" style="background:${LEVEL_COLORS[z.level]};margin-left:0"></span>${z.level_name}`],
      ['Superficie', ha(z.area_m2)],
      ['Profundidad máx. · p90', `${fmt(z.max_depth_m, 2)} · ${fmt(z.p90_depth_m, 2)} m`],
      ['Velocidad máx. · p90', `${fmt(z.max_speed_m_s, 1)} · ${fmt(z.p90_speed_m_s, 1)} m/s`],
      ['Presión dinámica máx.', `${fmt(z.max_pressure_kPa, 0)} kPa`],
      z.max_cv != null ? ['Concentración de sedimento Cv máx.', fmt(z.max_cv, 2)] : null,
      ['Primer arribo', z.first_arrival_s != null ? fmtT(z.first_arrival_s) : '—'],
      ['Material depositado', z.deposit_volume_m3 >= 1e3 ? `${fmt(z.deposit_volume_m3 / 1e3, 1)} mil m³` : `${fmt(z.deposit_volume_m3, 0)} m³`],
    ].filter(Boolean);
    let h = `<div class="pop"><div class="pop-h"><b>Zona ${z.code}</b>${critChip(z.criticality)}</div>` +
      `<table>${rows.map(([a, v]) => `<tr><td>${a}</td><td>${v}</td></tr>`).join('')}</table>`;
    const idx = z.buildings || [];
    if (idx.length && pts) {
      const dc = z.damage_counts || {};
      h += `<div class="pop-sec">Edificios afectados: <b>${idx.length}</b></div>${damageBar(dc, idx.length)}` +
        `<div class="dmg-legend">${[4, 3, 2, 1].filter(g => dc[DAMAGE_NAMES[g]]).map(g => `${damageChip(g)} ${dc[DAMAGE_NAMES[g]]}`).join(' ')}</div>`;
      const list = idx.map(i => ({i, b: B[i], r: buildingImpact(pts, i)})).filter(o => o.b && o.r)
        .sort((a, b) => b.r.damage - a.r.damage || (a.r.arrival ?? 1e9) - (b.r.arrival ?? 1e9));
      const shown = list.slice(0, 250);
      h += `<div class="pop-list"><table><thead><tr><th>Edificio</th><th>Daño</th><th>h máx.</th><th>v</th><th>P</th><th>Llega</th><th>Altura</th></tr></thead><tbody>` +
        shown.map(({i, b, r}) => `<tr data-b="${i}" title="Ver en el mapa"><td>${b.id}</td><td>${damageChip(r.damage)}</td><td>${fmt(r.depth, 1)} m</td>` +
          `<td>${fmt(r.speed, 1)}</td><td>${fmt(r.pressure, 0)}</td><td>${r.arrival != null ? fmtT(r.arrival) : '—'}</td><td>${buildingHeight(b) ? fmt(buildingHeight(b), 0) + ' m' : '—'}</td></tr>`).join('') +
        `</tbody></table></div>` + (list.length > shown.length ? `<div class="hint">Se muestran ${shown.length} de ${list.length}; el informe tiene la lista completa.</div>` : '') +
        `<div class="hint">v en m/s · P = presión dinámica en kPa. Tocá un edificio para ubicarlo.</div>`;
    } else h += `<div class="pop-sec hint">Sin edificios relevados dentro de la zona.</div>`;
    return h + '</div>';
  }

  // listado de zonas para el panel lateral
  panelHTML() {
    const Z = this.zones;
    if (!Z.length) return '';
    const top = Z.filter(z => z.criticality !== 'Baja' || z.buildings_affected).slice(0, 12);
    const count = c => Z.filter(z => z.criticality === c).length;
    return `<div class="impact zones-panel"><b>Zonas de afectación</b>` +
      `<div class="hint">${Z.length} zonas: ${['Crítica', 'Alta', 'Media', 'Baja'].map(c => `${count(c)} ${c.toLowerCase()}${count(c) === 1 ? '' : 's'}`).join(' · ')}. Tocá una zona en el mapa o en la lista para ver su detalle y los edificios afectados.</div>` +
      `<label class="check"><input type="checkbox" id="zonesToggle" checked> Mostrar las zonas en el mapa</label>` +
      `<table class="zlist"><tr><th>Zona</th><th>Criticidad</th><th>Área</th><th>Edif.</th></tr>` +
      top.map(z => `<tr data-zone="${z.code}"><td><span class="sw" style="background:${LEVEL_COLORS[z.level]};margin-left:0"></span>${z.code}</td>` +
        `<td>${critChip(z.criticality)}</td><td>${ha(z.area_m2)}</td><td>${z.buildings_affected || '—'}</td></tr>`).join('') + `</table>` +
      (Z.length > top.length ? `<div class="hint">Más ${Z.length - top.length} zonas de criticidad baja sin edificios.</div>` : '') + `</div>`;
  }

  bindPanel(root) {
    root.querySelectorAll('[data-zone]').forEach(tr => tr.onclick = () => this.focus(tr.dataset.zone));
    const t = root.querySelector('#zonesToggle');
    if (t) t.onchange = () => this.setVisible(t.checked);
  }
}
