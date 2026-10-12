// Biblioteca de análisis: proyectos con nombre, análisis guardados para reabrir sin recalcular,
// selección de varios para compararlos e informes.
import {ic} from './icons.js';
import {normBuildings} from './exposure.js';

const fmt = (v, d = 1) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ENGINE_IC = {mpm: 'cube', particles: 'cube', flood: 'rain'};
const ENGINE_NAME = {mpm: 'MPM 3D', particles: 'Partículas', flood: 'Inundación'};

async function errText(r) {
  const t = await r.text();
  try { const j = JSON.parse(t); return typeof j.detail === 'string' ? j.detail : t; } catch { return t; }
}

// Un análisis listo para informes y comparaciones: meta (result.json), parámetros, edificios y campos bajo demanda.
// current: el resultado cargado en la escena, para no volver a descargar sus campos.
export async function loadAnalysis(api, id, current = null) {
  const [entry, meta] = await Promise.all([
    fetch(`${api}/api/library/${id}`).then(async r => { if (!r.ok) throw new Error(await errText(r)); return r.json(); }),
    current && current.id === id ? current.meta : fetch(`${api}/api/library/${id}/result`).then(r => r.json()),
  ]);
  const ex = entry.ui && entry.ui.example;
  let buildings = [];
  if (current && current.id === id && current.buildings) buildings = current.buildings;
  else if (ex && (ex.buildings || (ex.params && ex.params.exposure_points))) buildings = normBuildings(ex);
  else if (entry.params && entry.params.exposure_points) buildings = normBuildings({params: entry.params});
  const cache = {};
  return {
    id, entry, meta, params: entry.params, buildings,
    async field(name) {
      if (current && current.id === id && current.fields[name]) return current.fields[name];
      if (!(name in meta.arrays)) return null;
      if (!cache[name]) cache[name] = fetch(`${api}/api/library/${id}/field/${name}`).then(r => r.ok ? r.arrayBuffer() : null).then(b => b && new Float32Array(b));
      return cache[name];
    },
  };
}

export class LibraryPanel {
  constructor({api, status, toast, onOpen, onReport, onCompare}) {
    Object.assign(this, {api, status, toast, onOpen, onReport, onCompare});
    this.items = [];
    this.projects = [];
    this.selected = new Set();
    this.current = null;
    this.editing = null;
    const $ = id => document.getElementById(id);
    this.el = {list: $('libList'), project: $('libProject'), search: $('libSearch'), count: $('libCount'),
      compare: $('libCompare'), report: $('libReport'), clear: $('libClearSel'), projList: $('projList'), projName: $('projName'), anaName: $('anaName')};
    this.el.project.onchange = () => { this.selected.clear(); this.render(); };
    this.el.search.oninput = () => this.render();
    this.el.compare.onclick = () => this.onCompare([...this.selected]);
    this.el.report.onclick = () => this.selected.size === 1 ? this.onReport([...this.selected][0]) : this.onCompare([...this.selected]);
    this.el.clear.onclick = () => { this.selected.clear(); this.render(); };
  }

  async refresh() {
    try {
      const r = await fetch(this.api + '/api/library');
      const j = await r.json();
      this.items = j.analyses;
      this.projects = j.projects;
    } catch { return; }
    for (const id of [...this.selected]) if (!this.items.some(e => e.id === id)) this.selected.delete(id);
    const sel = this.el.project, keep = sel.value;
    sel.innerHTML = `<option value="">Todos los proyectos (${this.items.length})</option>` +
      this.projects.map(p => `<option value="${esc(p)}">${esc(p)} (${this.items.filter(e => e.project === p).length})</option>`).join('');
    sel.value = this.projects.includes(keep) ? keep : '';
    this.el.projList.innerHTML = this.projects.map(p => `<option value="${esc(p)}">`).join('');
    this.render();
  }

  setCurrent(id) { this.current = id; this.render(); }
  entry(id) { return this.items.find(e => e.id === id); }

  visible() {
    const p = this.el.project.value, q = this.el.search.value.trim().toLowerCase();
    return this.items.filter(e => (!p || e.project === p) && (!q || `${e.name} ${e.project} ${e.scenario || ''} ${e.notes || ''}`.toLowerCase().includes(q)));
  }

  render() {
    const list = this.visible(), n = this.selected.size;
    this.el.count.textContent = this.items.length ? `(${this.items.length})` : '';
    this.el.compare.disabled = n < 2;
    this.el.compare.innerHTML = ic('graph-bar-side-by-side') + `Comparar${n >= 2 ? ` (${n})` : ''}`;
    this.el.report.disabled = n < 1;
    this.el.report.innerHTML = ic('file-report') + (n > 1 ? 'Informe comparativo' : 'Informe');
    this.el.clear.hidden = !n;
    if (!this.items.length) {
      this.el.list.innerHTML = '<div class="hint lib-empty">Todavía no hay análisis guardados. Cada simulación que termina se guarda acá con el nombre y el proyecto de arriba.</div>';
      return;
    }
    // agrupados por proyecto
    const groups = new Map();
    for (const e of list) { if (!groups.has(e.project)) groups.set(e.project, []); groups.get(e.project).push(e); }
    let h = '';
    for (const [p, es] of groups) {
      h += `<div class="lib-proj">${ic('folder')}<span>${esc(p)}</span><small>${es.length}</small>` +
        `<button class="lib-mini" data-selproj="${esc(p)}" title="Seleccionar todos los análisis del proyecto">${ic('check-square')}</button></div>`;
      for (const e of es) h += this.itemHTML(e);
    }
    this.el.list.innerHTML = h || '<div class="hint lib-empty">Ningún análisis coincide con el filtro.</div>';
    this.bind();
  }

  itemHTML(e) {
    const k = e.kpis || {}, d = new Date(e.created * 1000);
    if (this.editing === e.id) {
      return `<div class="lib-item editing" data-id="${e.id}"><label>Nombre<input class="ed-name" value="${esc(e.name)}"></label>` +
        `<label>Proyecto<input class="ed-proj" list="projList" value="${esc(e.project)}"></label>` +
        `<label>Notas<textarea class="ed-notes" rows="2">${esc(e.notes || '')}</textarea></label>` +
        `<div class="row"><button class="tool ed-save">${ic('save')}Guardar</button><button class="tool ed-cancel">Cancelar</button></div></div>`;
    }
    const facts = [];
    if (k.buildings_total) facts.push(`${fmt(k.buildings_affected, 0)}/${fmt(k.buildings_total, 0)} edif.`);
    if (k.zones_critical) facts.push(`<span class="lib-crit">${k.zones_critical} zona${k.zones_critical > 1 ? 's' : ''} crítica${k.zones_critical > 1 ? 's' : ''}</span>`);
    if (k.flooded_area_km2 != null) facts.push(`${fmt(k.flooded_area_km2, 2)} km²`);
    else if (k.affected_area_m2) facts.push(k.affected_area_m2 >= 1e6 ? `${fmt(k.affected_area_m2 / 1e6, 2)} km²` : `${fmt(k.affected_area_m2 / 1e4, 1)} ha`);
    if (k.rain_mm != null) facts.push(`${fmt(k.rain_mm, 0)} mm/${fmt(k.duration_h, 1)} h`);
    return `<div class="lib-item${this.current === e.id ? ' current' : ''}${this.selected.has(e.id) ? ' sel' : ''}" data-id="${e.id}">` +
      `<input type="checkbox" class="lib-chk" title="Seleccionar para comparar o para el informe"${this.selected.has(e.id) ? ' checked' : ''}>` +
      `<div class="lib-main" title="Abrir este análisis (sin recalcular)"><b>${ic(ENGINE_IC[e.engine] || 'cube')}${esc(e.name)}</b>` +
      `<small>${ENGINE_NAME[e.engine] || e.engine} · ${d.toLocaleDateString('es-AR')} ${d.toLocaleTimeString('es-AR', {hour: '2-digit', minute: '2-digit'})}</small>` +
      (facts.length ? `<small class="lib-facts">${facts.join(' · ')}</small>` : '') + `</div>` +
      `<div class="lib-acts"><button class="lib-mini" data-act="open" title="Abrir">${ic('folder-open')}</button>` +
      `<button class="lib-mini" data-act="report" title="Informe completo">${ic('file-report')}</button>` +
      `<button class="lib-mini" data-act="edit" title="Renombrar / mover de proyecto">${ic('pencil')}</button>` +
      `<button class="lib-mini" data-act="del" title="Eliminar">${ic('trash')}</button></div></div>`;
  }

  bind() {
    this.el.list.querySelectorAll('[data-selproj]').forEach(b => b.onclick = () => {
      const es = this.visible().filter(e => e.project === b.dataset.selproj), all = es.every(e => this.selected.has(e.id));
      es.forEach(e => all ? this.selected.delete(e.id) : this.selected.add(e.id));
      this.render();
    });
    this.el.list.querySelectorAll('.lib-item').forEach(it => {
      const id = it.dataset.id;
      if (it.classList.contains('editing')) {
        const save = async () => {
          const body = {name: it.querySelector('.ed-name').value, project: it.querySelector('.ed-proj').value, notes: it.querySelector('.ed-notes').value};
          const r = await fetch(`${this.api}/api/library/${id}`, {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
          if (!r.ok) { this.status('No se pudo guardar: ' + await errText(r), true); return; }
          this.editing = null;
          await this.refresh();
          if (this.current === id) this.onRenamed && this.onRenamed(this.entry(id));
        };
        it.querySelector('.ed-save').onclick = save;
        it.querySelector('.ed-cancel').onclick = () => { this.editing = null; this.render(); };
        it.querySelectorAll('input').forEach(i => i.onkeydown = ev => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') { this.editing = null; this.render(); } });
        it.querySelector('.ed-name').focus();
        return;
      }
      it.querySelector('.lib-chk').onchange = ev => { ev.target.checked ? this.selected.add(id) : this.selected.delete(id); this.render(); };
      it.querySelector('.lib-main').onclick = () => this.onOpen(id);
      it.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'open') this.onOpen(id);
        if (act === 'report') this.onReport(id);
        if (act === 'edit') { this.editing = id; this.render(); }
        if (act === 'del') {
          const e = this.entry(id);
          if (!confirm(`¿Eliminar el análisis «${e.name}»? Se borran sus resultados y no se puede deshacer.`)) return;
          const r = await fetch(`${this.api}/api/library/${id}`, {method: 'DELETE'});
          if (!r.ok) { this.status('No se pudo eliminar: ' + await errText(r), true); return; }
          this.selected.delete(id);
          this.toast('info', 'Análisis eliminado', esc(e.name), [], 4000);
          this.refresh();
        }
      });
    });
  }
}
