// Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
// SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
// Asistente flotante de configuración: las secciones del escenario como pasos en orden (anterior / siguiente),
// en una ventana que se puede mover y minimizar sobre el mapa. La barra lateral muestra el índice de pasos.
import {ic} from './icons.js';

// cada paso agrupa las secciones <details data-step="…">; un paso sin secciones visibles (según el motor) no aparece
const STEPS = [
  {id: 'start', title: 'Escenario de partida', sub: 'Ejemplo precargado o modo libre'},
  {id: 'zone', title: 'Zona de cálculo', sub: 'Terreno (DEM), extensión y edificios'},
  {id: 'release', title: 'Desprendimiento', sub: 'Dónde y cuánto material se moviliza'},
  {id: 'basins', title: 'Cuencas y tormenta', sub: 'Delinear cuencas y definir la lluvia'},
  {id: 'plain', title: 'Llanura: suelo, ríos y caminos', sub: 'Infiltración, caudales de entrada, terraplenes y uso del suelo'},
  {id: 'material', title: 'Material', sub: 'Densidad y fricción'},
  {id: 'water', title: 'Agua y presión de poros', sub: 'Saturación y licuefacción'},
  {id: 'erosion', title: 'Erosión y deposición', sub: 'Material que el flujo incorpora'},
  {id: 'run', title: 'Solver y simulación', sub: 'Resolución, nombre del análisis y simular'},
];

export class Wizard {
  constructor({isFlood, onRun, hints = {}}) {
    Object.assign(this, {isFlood, onRun, hints});
    const $ = id => document.getElementById(id);
    this.el = $('wizard');
    this.host = this.el.parentElement;
    this.cur = 'start';
    this.visited = new Set(['start']);
    this.secs = [...this.el.querySelectorAll('details[data-step]')];
    // dentro del asistente las secciones no se pliegan: el encabezado es el título del paso
    this.secs.forEach(d => d.querySelector('summary').addEventListener('click', e => e.preventDefault()));
    $('wzPrev').onclick = () => this.move(-1);
    $('wzNext').onclick = () => this.move(1);
    $('wzMin').onclick = () => this.minimize(!this.el.classList.contains('min'));
    $('wzClose').onclick = () => this.hide();
    $('stepsOpen').onclick = () => this.el.hidden ? this.show() : this.minimize(false);
    this.drag($('wzHead'));
    // el motor y los ejemplos muestran u ocultan secciones: se rearma el índice
    new MutationObserver(() => this.render()).observe(this.el.querySelector('.wz-body'), {attributes: true, subtree: true, attributeFilter: ['hidden']});
    let pend = false;
    const later = () => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; this.renderList(); }); } };
    document.addEventListener('input', later);
    document.addEventListener('change', later);
    for (const id of ['gridInfo', 'releaseInfo', 'exInfo', 'gbaInfo']) {
      const n = $(id);
      if (n) new MutationObserver(later).observe(n, {childList: true, subtree: true, characterData: true});
    }
    this.render();
  }

  steps() { return STEPS.filter(s => this.secs.some(d => d.dataset.step === s.id && !d.hidden)); }

  show(step) {
    if (step) this.go(step);
    this.el.hidden = false;
    this.minimize(false);
    this.render();
  }
  hide() { this.el.hidden = true; this.renderList(); }
  minimize(on) {
    this.el.classList.toggle('min', on);
    const b = document.getElementById('wzMin');
    b.innerHTML = ic(on ? 'chevron-down' : 'chevron-up');
    b.title = on ? 'Expandir' : 'Minimizar';
  }
  go(id) {
    if (!STEPS.some(s => s.id === id)) return;
    this.cur = id;
    this.visited.add(id);
    this.render();
    this.el.querySelector('.wz-body').scrollTop = 0;
  }
  move(d) {
    const S = this.steps(), k = S.findIndex(s => s.id === this.cur);
    if (d > 0 && k === S.length - 1) { this.onRun(); return; }
    const n = S[Math.max(0, Math.min(S.length - 1, k + d))];
    if (n) this.go(n.id);
  }
  // mientras se dibuja en el mapa el asistente se achica para no taparlo
  drawing(on) { this.el.classList.toggle('drawing', on); document.getElementById('wzDraw').hidden = !on; }

  render() {
    const S = this.steps();
    if (!S.some(s => s.id === this.cur)) this.cur = (S[0] || STEPS[0]).id;
    const k = S.findIndex(s => s.id === this.cur), st = S[k];
    const mode = this.isFlood() ? 'Cuencas e inundación por lluvia' : 'Movimiento de masa';
    document.getElementById('wzMode').textContent = mode;
    document.getElementById('wzTitle').textContent = `Paso ${k + 1} de ${S.length} · ${st.title}`;
    for (const d of this.secs) d.classList.toggle('wz-off', d.dataset.step !== this.cur);
    const ol = document.getElementById('wzSteps');
    ol.innerHTML = S.map((s, i) => `<li class="${s.id === this.cur ? 'cur' : this.visited.has(s.id) ? 'done' : ''}">` +
      `<button type="button" data-go="${s.id}" title="${i + 1}. ${s.title}">${i + 1}</button></li>`).join('');
    ol.querySelectorAll('[data-go]').forEach(b => b.onclick = () => this.go(b.dataset.go));
    const prev = document.getElementById('wzPrev'), next = document.getElementById('wzNext');
    prev.disabled = k === 0;
    const last = k === S.length - 1;
    next.innerHTML = last ? ic('play') + 'Simular' : `Siguiente: ${S[k + 1].title}` + ic('chevron-right');
    next.classList.toggle('wz-run', last);
    this.renderList();
  }

  // índice de pasos en la barra lateral, con un resumen de lo elegido en cada uno
  renderList() {
    const S = this.steps(), open = !this.el.hidden;
    document.getElementById('stepsMode').textContent = this.isFlood() ? 'Pasos · inundación por lluvia' : 'Pasos · movimiento de masa';
    const ol = document.getElementById('stepList');
    ol.innerHTML = S.map((s, i) => {
      let hint = '';
      try { hint = (this.hints[s.id] && this.hints[s.id]()) || ''; } catch { /* la sección todavía no está lista */ }
      return `<li data-go="${s.id}" class="${open && s.id === this.cur ? 'cur' : ''}"><span class="st-n">${i + 1}</span>` +
        `<span class="st-t"><b>${s.title}</b><small>${esc(hint || s.sub)}</small></span>${ic('chevron-right', 16, 'st-go')}</li>`;
    }).join('');
    ol.querySelectorAll('[data-go]').forEach(li => li.onclick = () => this.show(li.dataset.go));
  }

  drag(handle) {
    let sx, sy, ox, oy;
    const mv = e => {
      const H = this.host.getBoundingClientRect(), W = this.el.offsetWidth;
      const x = Math.max(-W + 120, Math.min(H.width - 120, ox + e.clientX - sx)), y = Math.max(0, Math.min(H.height - 44, oy + e.clientY - sy));
      this.el.style.left = x + 'px'; this.el.style.top = y + 'px';
    };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); this.el.classList.remove('dragging'); };
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || e.button !== 0) return;
      sx = e.clientX; sy = e.clientY; ox = this.el.offsetLeft; oy = this.el.offsetTop;
      this.el.classList.add('dragging');
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
