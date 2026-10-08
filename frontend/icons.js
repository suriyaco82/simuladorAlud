// Íconos Calcite UI (Esri). Se cargan desde la CDN oficial del paquete @esri/calcite-ui-icons
// (licencia Esri MLA: redistribución solo sin modificar), y se pintan con currentColor vía CSS mask.
export const ICON_CDN = 'https://cdn.jsdelivr.net/npm/@esri/calcite-ui-icons@4.5.0/icons/';

export const ic = (name, size = 16, cls = '') =>
  `<span class="ic${cls ? ' ' + cls : ''}" style="--ic:url(${ICON_CDN}${name}-${size}.svg)" aria-hidden="true"></span>`;

// agrega el ícono indicado en data-ic al comienzo de cada elemento
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-ic]').forEach(el => {
    if (el.querySelector(':scope > .ic')) return;
    el.insertAdjacentHTML('afterbegin', ic(el.dataset.ic, +(el.dataset.icSize || 16)));
  });
}
