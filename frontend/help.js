// Ayuda contextual (ícono "i") y preajustes de material.
// Cada entrada: t título, d descripción, r rango válido (coincide con el backend), v valores típicos,
// e efecto al cambiarlo; min/max se aplican al campo para marcarlo en rojo si queda fuera de rango.

export const HELP = {
  // ── Secciones
  'sec-examples': {t: 'Ejemplos', d: 'Escenarios completos y parametrizados: zona de cálculo, DEM, área de desprendimiento, material, agua, erosión, solver y elementos expuestos (zona urbana y edificios). "Cargar" completa todos los campos para que puedas revisarlos o modificarlos; "Cargar y simular" además lanza la simulación.',
    e: 'Al cargar un ejemplo se agregan su zona expuesta, sus edificios y, si es un escenario en cascada, sus masas iniciales (hielo, lago), brecha, cauces y estaciones de aforo; mientras está cargado no se puede dibujar otro desprendimiento. "Quitar ejemplo" vuelve al modo libre.'},
  'sec-zona': {t: 'Zona de cálculo', d: 'Rectángulo del terreno que se descarga y simula. Todo el recorrido del flujo tiene que quedar dentro: el material que llega al borde sale del dominio y se contabiliza como "Salió del dominio".',
    r: 'Hasta 1° por lado. En MPM el tamaño útil depende de dx: la grilla admite ~24 M nodos en GPU y ~10 M en CPU.',
    v: '3–10 km de lado con dx 10–25 m.', e: 'Una zona más chica permite un dx más fino y resultados más realistas. Si es muy grande, el backend aumenta dx automáticamente.'},
  'sec-release': {t: 'Desprendimiento', d: 'Define la masa que se moviliza: dónde está (polígono o círculo), cuánto volumen tiene y cómo se reparte su espesor. El DEM ya contiene esa masa: el modelo la "excava" (superficie de rotura = DEM − espesor) y la convierte en partículas, así que el volumen es real y queda la cicatriz.',
    v: 'Deslizamientos: 10³–10⁶ m³ · avalanchas de roca: 10⁶–10⁸ m³.'},
  'sec-rain': {t: 'Deslizamiento disparado por lluvia', d: 'El volumen del deslizamiento no se fija a mano: sale de la lluvia. La lluvia acumulada (más el deshielo) se infiltra y fluye ladera abajo dentro del suelo; las hondonadas, que reciben agua de más superficie, se saturan antes (SHALSTAB, Montgomery y Dietrich 1994). Con el nivel freático resultante se calcula el factor de seguridad de talud infinito en cada celda del DEM; las celdas con FS < 1 se desprenden con el espesor del suelo.',
    v: 'Episodios extremos en la cordillera patagónica: 100–250 mm en 2–4 días, a veces con lluvia sobre nieve. El Chaltén recibe ~550 mm/año; hacia el oeste, 1000–2000 mm/año (Srur et al. 2018, citado en Schmidt et al. 2023).',
    e: 'Más lluvia o menos días → más saturación → más área que falla y más volumen. La "lluvia crítica" indica cuánta lluvia hace falta para que empiecen los deslizamientos. Calibrá el suelo (espesor, c′, φ′, T) con datos de campo: con lluvias comunes la ladera tiene que ser estable.'},
  'sec-material': {t: 'Material', d: 'Propiedades mecánicas de la masa y de su contacto con el terreno. Si no tenés datos de laboratorio, empezá por un preajuste y ajustá la fricción basal δ, que es el parámetro que más controla el alcance.',
    e: 'Los valores publicados provienen de la calibración de eventos reales. Úsalos como punto de partida, no como verdad.'},
  'sec-agua': {t: 'Agua y presión de poros', d: 'El agua en los poros soporta parte del peso y reduce la fricción efectiva: tan φ·(1−λ), donde λ = presión de poros / tensión total. Así se representa cómo un flujo saturado "se licúa" y llega mucho más lejos que uno seco.',
    v: 'Seco: λ ≈ 0 · saturado en reposo: λ ≈ 0,4–0,5 · licuado: λ → 0,8–0,95.'},
  'sec-erosion': {t: 'Erosión y deposición', d: 'El flujo puede arrancar material del lecho por donde pasa (entrainment) y crecer en volumen, como los flujos de detritos que "engordan" en el cauce. El lecho desciende donde hay erosión. La deposición es el material que termina en reposo.',
    v: 'Espesor erosionable 0 = desactivado. Cauces con sedimento suelto: 1–5 m.'},
  'sec-solver': {t: 'Solver', d: 'Motor numérico y resolución. MPM 3D resuelve el material como medio continuo (con interacción entre partículas, presión de poros y erosión). "Partículas" es el motor rápido v0.1: trayectorias independientes, útil solo para previsualizar.',
    e: 'La primera corrida de MPM compila los kernels (~15 s).'},

  // ── Zona
  dataset: {t: 'Dataset DEM', d: 'Modelo digital de elevación que se usa como terreno. SYNTHETIC es un relieve de prueba que no necesita conexión. COP30, ANADEM, NASADEM, AW3D30 y SRTMGL1 se descargan de OpenTopography (con API key y caché local). AWS_TERRAIN usa las teselas públicas de AWS (Terrarium, ~30 m en tierra): no requiere key y suele responder aunque OpenTopography esté caído.',
    v: 'COP30 (Copernicus 30 m) es el más consistente a nivel global. ANADEM corrige la vegetación en Sudamérica. SRTMGL1/NASADEM: 30 m (año 2000). AWS_TERRAIN: respaldo rápido.',
    e: 'La resolución del DEM (~30 m) limita el detalle: un dx menor interpola, pero no agrega información del terreno.'},
  dem_fallback: {t: 'DEM de respaldo', d: 'OpenTopography a veces está saturado o caído (errores 500 o sin respuesta). Con esta opción marcada, si la descarga falla después de 3 intentos, la simulación sigue con AWS Terrain Tiles y el resumen muestra una advertencia con la fuente usada.',
    e: 'Desmarcala si necesitás un DEM específico (por ejemplo, COP30 para comparar): la simulación fallará en lugar de cambiar de fuente.'},

  // ── Desprendimiento
  release_radius_m: {t: 'Radio del círculo', d: 'Solo se usa si no dibujaste un polígono: la masa es un círculo con este radio, centrado en el punto de inicio (clic en el mapa) o, si no lo marcaste, en una ladera alta elegida automáticamente.',
    r: '5 – 5000 m', min: 5, max: 5000, v: '50–500 m', e: 'El área crece con r², así que con el mismo espesor el volumen también crece con r².'},
  release_mode: {t: 'Definir masa por', d: '"Espesor medio": el volumen resulta de área × espesor. "Volumen total": fijás el volumen (por ejemplo, de un inventario o de una estimación de campo) y el espesor medio se calcula como volumen / área.',
    e: 'El resumen muestra el volumen discretizado: si difiere más de 15% del objetivo, hay que reducir dx.'},
  release_thickness_m: {t: 'Espesor medio', d: 'Profundidad media de la superficie de rotura, medida en la vertical. Con el perfil "Domo", el máximo en el centro es ~1,5–2 veces este valor.',
    r: '0,1 – 500 m', min: 0.1, max: 500, v: 'Deslizamiento superficial: 1–5 m · rotacional: 5–30 m · avalancha de roca: 20–100 m',
    e: 'Si es menor que 2·dx, la masa queda sub-resuelta en la vertical (la app lo advierte).'},
  release_volume_m3: {t: 'Volumen total', d: 'Volumen movilizado in situ (antes del esponjamiento). Se reparte sobre el área según el perfil elegido.',
    r: '> 0 m³', min: 1, v: '10⁴ – 10⁸ m³', e: 'Más volumen → mayor alcance y velocidad (las masas grandes tienen menor H/L aparente).'},
  thickness_profile: {t: 'Perfil de espesor', d: '"Domo": el espesor es 0 en el borde y máximo en el centro, como una superficie de rotura cóncava real. "Uniforme": el mismo espesor en toda el área, con un escalón en el borde.',
    v: 'Domo para la mayoría de los deslizamientos.'},

  // ── Material
  preset: {t: 'Preajuste de material', d: 'Carga un conjunto coherente de parámetros para un tipo de movimiento. Cambia valores de Material, Agua y Erosión; después podés ajustarlos a mano (pasa a "Personalizado").'},
  density_solid: {t: 'Densidad de los sólidos ρs', d: 'Densidad de los granos, sin poros. Junto con la porosidad y el agua determina la densidad de la mezcla que se muestra en el resumen.',
    r: '1500 – 3200 kg/m³', min: 1500, max: 3200, v: 'Suelos: 2600–2700 · granito: 2650 · basalto: 2900–3000',
    e: 'Influye poco en el alcance (la fricción de Coulomb es proporcional al peso) y más en la inercia y la presión de impacto.'},
  porosity: {t: 'Porosidad n', d: 'Fracción de vacíos del material movilizado. Los vacíos pueden estar llenos de aire o de agua (ver Saturación).',
    r: '0,05 – 0,70', min: 0.05, max: 0.7, v: 'Roca fragmentada: 0,25–0,35 · detritos: 0,3–0,45 · limos y arcillas: 0,4–0,6',
    e: 'Más porosidad → más agua posible → mezcla menos densa y presión de poros hidrostática mayor.'},
  friction_angle_deg: {t: 'Fricción interna φ', d: 'Ángulo de fricción interna del material granular: controla la resistencia al corte dentro de la masa y el talud natural del depósito (Drucker-Prager). La presión de poros lo reduce: tan φ·(1−λ).',
    r: '5 – 50°', min: 5, max: 50, v: 'Arena: 30–35° · grava/roca fragmentada: 35–40° · arcilla remoldeada: 15–25°',
    e: 'Más alto → la masa se deforma menos, el depósito es más empinado y concentrado. Más bajo → se esparce como un fluido.'},
  basal_friction_deg: {t: 'Fricción basal δ', d: 'Ángulo de fricción entre la masa y el terreno (ley de Coulomb). Es el parámetro que más controla el alcance: una masa sin agua se detiene donde la pendiente cae por debajo de δ. La presión de poros lo reduce: tan δ·(1−λ).',
    r: '1 – 45°', min: 1, max: 45, v: 'Flujos de detritos: 5–15° · avalanchas de roca: 8–20° (H/L 0,1–0,35) · deslizamientos de suelo: 15–30°',
    e: '1° menos puede sumar cientos de metros de alcance. Calibrá comparando el H/L del resumen con eventos similares.'},
  viscosity_pa_s: {t: 'Viscosidad de la mezcla η', d: 'Resistencia viscosa (newtoniana) aportada por el agua y los finos. Frena las velocidades altas y suaviza el flujo sin afectar el reposo.',
    r: '0 – 20000 Pa·s', min: 0, max: 20000, v: 'Roca seca: 0 · flujos de detritos: 10–1000 · flujos de barro: 1000–10000',
    e: 'Más alta → menos velocidad máxima y un frente más redondeado. En espesores grandes su efecto es chico frente a la fricción.'},
  young_modulus: {t: 'Módulo elástico E', d: 'Rigidez elástica del material en el modelo numérico. Está reducido respecto de la roca real para permitir pasos de tiempo interactivos: define la compresibilidad, no la resistencia.',
    r: '10⁵ – 10⁹ Pa', min: 1e5, max: 1e9, v: '2·10⁷ Pa (recomendado)',
    e: 'Más alto → más preciso, pero el paso de tiempo baja con √E (10× E ≈ 3× más lento). Más bajo → la masa se comprime y "rebota".'},

  // ── Agua
  saturation: {t: 'Saturación Sr', d: 'Fracción de los poros ocupada por agua. Define la densidad de la mezcla y la presión de poros de equilibrio (hidrostática), λeq = Sr·ρw/ρ.',
    r: '0 – 1', min: 0, max: 1, v: 'Seco: 0–0,2 · húmedo: 0,4–0,7 · saturado (lluvias intensas, deshielo): 0,9–1',
    e: 'Más alta → mayor presión de poros y más generación por contracción → menor fricción efectiva y mayor alcance.'},
  lamAuto: {t: 'λ inicial hidrostático', d: 'Si está marcado, la presión de poros inicial es la de equilibrio con el agua presente (λeq, según Sr). Desmarcalo para imponer un λ inicial mayor: por ejemplo, un exceso de presión que dispara el evento.'},
  pore_ratio_initial: {t: 'λ inicial', d: 'Relación presión de poros / tensión total al inicio. λ = 0: sin agua a presión. λ → 1: la masa flota sobre el agua (licuefacción total).',
    r: '0 – 0,95', min: 0, max: 0.95, v: 'Hidrostático: 0,3–0,5 · con exceso de presión (disparo por lluvia): 0,6–0,8',
    e: 'Reduce ambas fricciones en el factor (1−λ). Con λ = 0,5 la fricción efectiva es la mitad.'},
  pore_diffusion_time_s: {t: 'Tiempo de disipación Td', d: 'Tiempo característico en el que el exceso de presión de poros drena y λ vuelve al valor hidrostático. Depende de la permeabilidad y del espesor: Td ~ h²/D.',
    r: '> 0 – 100000 s', min: 1, max: 100000, v: 'Grava y roca: 5–60 s · detritos con finos: 60–1000 s · barro/arcilla: 1000–10000 s',
    e: 'Más largo → la presión de poros se mantiene alta durante todo el recorrido (flujos muy móviles). Más corto → el flujo se "seca" y frena antes.'},
  pore_generation: {t: 'Generación por contracción κ', d: 'Cuánto sube λ cuando el material se compacta al moverse (tr ∇v < 0) y cuánto baja cuando se dilata. Representa el colapso de la estructura suelta de un suelo saturado. Se multiplica por Sr.',
    r: '0 – 50', min: 0, max: 50, v: 'Material denso/dilatante: 0–1 · suelto contractivo (licuable): 2–10',
    e: 'Más alto → el flujo puede licuarse durante el movimiento (λ → 0,95) aunque arranque con poca agua.'},

  // ── Erosión
  erodible_depth_m: {t: 'Espesor erosionable', d: 'Espesor máximo de sedimento suelto que el flujo puede arrancar del lecho en cada punto (fuera de la zona de rotura). 0 desactiva la erosión.',
    r: '0 – 50 m', min: 0, max: 50, v: 'Laderas: 0–1 m · cauces con depósitos: 1–5 m · conos aluviales: 2–10 m',
    e: 'Más espesor → más volumen incorporado (ver "Volumen erosionado"), un flujo más grande y un cauce más profundizado.'},
  entrainment_coeff: {t: 'Coeficiente de entrainment Es', d: 'Tasa de erosión por unidad de espesor y de distancia recorrida: dz/dt = Es·h·|v| (McDougall & Hungr, 2005). Un valor de 0,004 1/m significa que el volumen crece ~0,4% por cada metro recorrido sobre lecho erosionable.',
    r: '0 – 0,1 1/m', min: 0, max: 0.1, v: '0,001–0,01 1/m (calibrado con el volumen final / volumen inicial de eventos reales)',
    e: 'Más alto → erosión más rápida: el lecho erosionable se agota antes y el flujo crece más cerca de la fuente.'},
  critical_velocity: {t: 'Velocidad crítica', d: 'Por debajo de esta velocidad basal no hay erosión: el flujo lento no moviliza el lecho.',
    r: '0 – 50 m/s', min: 0, max: 50, v: '0,5–2 m/s', e: 'Más alta → la erosión se limita a los tramos rápidos y empinados.'},

  // ── Solver
  engine: {t: 'Motor', d: 'MPM 3D: medio continuo con interacción entre partículas, elastoplasticidad, presión de poros y erosión (física completa). Partículas: trayectorias independientes con fricción basal y λ inicial fijo; sin erosión ni interacción. Tarda segundos, pero no es físico.'},
  device: {t: 'Dispositivo', d: 'Dónde corre el solver MPM. Auto intenta usar la GPU (Metal en Mac, CUDA/Vulkan en otras plataformas) y, si no hay, usa la CPU. El mismo código se compila para ambas.',
    v: 'GPU: 5–20× más rápida y admite ~24 M nodos · CPU: ~10 M nodos.'},
  dx: {t: 'Tamaño de celda dx', d: 'Resolución de la grilla MPM (y de los mapas de resultado). Es el parámetro que más influye en el costo: nodos ≈ (L/dx)²·(relieve/dx).',
    r: '1 – 500 m', min: 1, max: 500, v: 'Preview: 25–50 m · detalle: 5–15 m. Para 3D real: dx ≤ espesor/2.',
    e: 'dx a la mitad → ~8× más nodos y ~16× más tiempo. Si la zona no entra en memoria, el backend lo aumenta y avisa.'},
  ppc: {t: 'Partículas por celda y por eje', d: 'Densidad de partículas: el espaciado es dx/ppc en planta, y cada columna se divide en capas de ese espesor.',
    r: '1 – 5', min: 1, max: 5, v: '2–3', e: 'Más partículas → deformación más suave y más costo (crece con ppc³ en masas gruesas). Con 1 aparecen huecos y ruido.'},
  duration_s: {t: 'Duración simulada', d: 'Tiempo físico máximo. La simulación se detiene antes si toda la masa queda en reposo (velocidad máxima < 0,3 m/s).',
    r: '1 – 10800 s (3 h)', min: 1, max: 10800, v: 'Deslizamientos: 30–120 s · avalanchas grandes y flujos largos: 120–600 s',
    e: 'Si al final el resumen no dice "(detenido)", la masa seguía en movimiento: aumentá la duración.'},
  display_particles: {t: 'Partículas visibles', d: 'Cuántas partículas se envían al visor 3D (un subconjunto fijo de todas las simuladas). No cambia el cálculo, solo la visualización.',
    r: '500 – 200000', min: 500, max: 200000, v: '20000–50000', e: 'Más → mayor detalle visual, pero más datos que descargar (~9 bytes por partícula y por cuadro).'},

  // ── Visor
  view: {t: 'Vista', d: 'Realista: terreno con imagen satelital, superficie del flujo reconstruida desde las partículas, bloques que ruedan y polvo en los frentes rápidos. Análisis: cada partícula como punto coloreado por una variable (velocidad, presión de poros, origen).',
    e: 'Solo cambia la visualización. La superficie del flujo usa el espesor calculado a partir de las partículas; los bloques son una representación visual y no tienen tamaño físico en el modelo.'},
  matStyle: {t: 'Material visual', d: 'Aspecto de la masa en la vista realista. Auto lo elige según los parámetros: Sr < 0,3 → roca seca con polvo; Sr ≥ 0,8 → detritos húmedos brillantes; Sr ≥ 0,85 con viscosidad ≥ 1000 Pa·s → barro; si el escenario tiene agua libre (lago o embalse), crecida; en otro caso, suelo. El material erosionado se ve con color de sedimento.',
    v: 'Roca: bloques grises angulosos, superficie de escombros · Suelo: terrones marrones · Detritos: matriz oscura húmeda con bloques · Barro: superficie lisa y brillante, pocos clastos · Crecida: agua turbia, más marrón donde lleva sedimento, con bloques de hielo.'},
  follow: {t: 'Seguir flujo', d: 'En la vista realista, la cámara acompaña al centroide del material en movimiento y ajusta la distancia al tamaño del flujo. Podés rotar la vista con el mouse; si hacés zoom con la rueda, se respeta esa distancia. ⌖ vuelve a encuadrar la zona afectada y ▣ muestra el dominio completo.'},
  exag: {t: 'Exageración vertical', d: 'Escala visual de las alturas en 3D. Solo afecta la visualización, no el cálculo.', v: '1× = proporciones reales · 1,5–3× para leer mejor el relieve'},
  colorBy: {t: 'Color de partículas', d: 'Velocidad: rapidez de cada partícula. Presión de poros λ: zonas licuadas en rojo. Origen: material del desprendimiento vs. material incorporado por erosión.'},
  psize: {t: 'Tamaño de partícula', d: 'Tamaño visual de los puntos. Solo afecta la visualización.'},
  mapLayer: {t: 'Capa en el mapa', d: 'Inundación actual (animada): espesor del flujo en el instante que se está reproduciendo; se va extendiendo al dar ▶. Las demás capas son resultados del evento que también se descubren a medida que el flujo llega a cada lugar. Puede ser distinto del terreno 3D: por ejemplo, intensidad en el mapa y satélite en 3D para ver el flujo de forma realista.'},
  layer: {t: 'Capa del terreno', d: 'Satélite: imagen Esri World Imagery sobre el DEM. Relieve: colores por altura. Las demás son resultados mapeados sobre el terreno (y sobre el mapa si "Capa en el mapa" está activo). Depósito: espesor final. Cambio neto: + depositado / − erosionado o excavado (incluye la cicatriz). Máximos: envolvente de todo el evento. Arribo: primer instante en que el flujo supera 10 cm en cada punto. Durante la reproducción, todas las capas se muestran solo donde el flujo ya llegó. Intensidad (flujos de detritos, Hürlimann et al. 2008): alta si h ≥ 1 m y v ≥ 1 m/s, media si se cumple una de las dos, baja en el resto. Presión dinámica: ρ·v² con la velocidad media de la columna.'},
};

// Preajustes: valores representativos para empezar; requieren calibración local.
export const PRESETS = {
  rock_dry: {name: 'Avalancha de roca seca', v: {density_solid: 2700, porosity: 0.3, friction_angle_deg: 36, basal_friction_deg: 14, viscosity_pa_s: 0, saturation: 0.1, pore_diffusion_time_s: 20, pore_generation: 0.5, erodible_depth_m: 0}},
  landslide: {name: 'Deslizamiento de suelo húmedo', v: {density_solid: 2650, porosity: 0.35, friction_angle_deg: 32, basal_friction_deg: 16, viscosity_pa_s: 50, saturation: 0.5, pore_diffusion_time_s: 60, pore_generation: 2, erodible_depth_m: 0}},
  debris_flow: {name: 'Flujo de detritos saturado', v: {density_solid: 2650, porosity: 0.4, friction_angle_deg: 32, basal_friction_deg: 11, viscosity_pa_s: 200, saturation: 0.95, pore_diffusion_time_s: 400, pore_generation: 5, erodible_depth_m: 2, entrainment_coeff: 0.004, critical_velocity: 1}},
  mudflow: {name: 'Flujo de barro', v: {density_solid: 2600, porosity: 0.5, friction_angle_deg: 25, basal_friction_deg: 8, viscosity_pa_s: 2000, saturation: 1, pore_diffusion_time_s: 3000, pore_generation: 3, erodible_depth_m: 1, entrainment_coeff: 0.003, critical_velocity: 0.5}},
};

// Solo rango (no step): el paso del campo es una comodidad, no una restricción.
const outOfRange = el => !!el.validity && (el.validity.rangeUnderflow || el.validity.rangeOverflow || el.validity.badInput);
const markRange = el => el.classList.toggle('bad', outOfRange(el));

const fieldFor = key => document.querySelector(`[data-param="${key}"]`) || document.getElementById(key);

function makeIcon(key) {
  const b = document.createElement('span');
  b.className = 'help-i';
  b.textContent = 'i';
  b.tabIndex = 0;
  b.setAttribute('role', 'button');
  b.setAttribute('aria-label', 'Ayuda: ' + HELP[key].t);
  b.dataset.help = key;
  return b;
}

const pop = document.createElement('div');
pop.id = 'helpPop';
pop.hidden = true;
pop.setAttribute('role', 'tooltip');
document.body.appendChild(pop);
let pinned = null;

function show(icon) {
  const h = HELP[icon.dataset.help];
  const row = (k, v) => v ? `<div class="hrow"><span>${k}</span><div>${v}</div></div>` : '';
  pop.innerHTML = `<b>${h.t}</b><p>${h.d}</p>${row('Rango', h.r)}${row('Típico', h.v)}${row('Efecto', h.e)}`;
  pop.hidden = false;
  const r = icon.getBoundingClientRect(), w = pop.offsetWidth, ht = pop.offsetHeight;
  let top = r.bottom + 6;
  if (top + ht > innerHeight - 8) top = Math.max(8, r.top - ht - 6);
  pop.style.left = Math.max(8, Math.min(r.left - 12, innerWidth - w - 8)) + 'px';
  pop.style.top = top + 'px';
}
function hide() { pop.hidden = true; pinned = null; }

export function initHelp() {
  for (const [key, h] of Object.entries(HELP)) {
    if (key.startsWith('sec-')) continue;
    const el = fieldFor(key);
    const label = el && el.closest('label');
    if (!label) continue;
    if (h.min != null && el.tagName === 'INPUT') el.min = h.min;
    if (h.max != null && el.tagName === 'INPUT') el.max = h.max;
    if (el.tagName === 'INPUT') { el.addEventListener('input', () => markRange(el)); markRange(el); }
    const icon = makeIcon(key);
    const first = label.firstElementChild;
    if (first && first === el && el.type === 'checkbox') label.appendChild(icon);
    else label.insertBefore(icon, label.querySelector('input,select,output'));
  }
  document.querySelectorAll('summary[data-help]').forEach(s => s.appendChild(makeIcon(s.dataset.help)));

  document.addEventListener('mouseover', e => {
    const ic = e.target.closest && e.target.closest('.help-i');
    if (ic && !pinned) show(ic);
  });
  document.addEventListener('mouseout', e => {
    const ic = e.target.closest && e.target.closest('.help-i');
    if (ic && !pinned && !(e.relatedTarget && ic.contains(e.relatedTarget))) pop.hidden = true;
  });
  document.addEventListener('click', e => {
    const ic = e.target.closest('.help-i');
    if (ic) {
      // que el clic no enfoque el campo del label ni pliegue la sección
      e.preventDefault(); e.stopPropagation();
      if (pinned === ic) { hide(); return; }
      pinned = ic; show(ic); return;
    }
    if (!pop.contains(e.target)) hide();
  }, true);
  document.addEventListener('keydown', e => {
    const ic = e.target.closest && e.target.closest('.help-i');
    if (ic && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pinned = ic; show(ic); }
    if (e.key === 'Escape') hide();
  });
  document.querySelector('aside').addEventListener('scroll', hide);
}

export function initPresets() {
  const sel = document.getElementById('preset');
  for (const [k, p] of Object.entries(PRESETS)) sel.add(new Option(p.name, k));
  sel.add(new Option('Personalizado', 'custom'));
  let applying = false;
  const keys = new Set(Object.values(PRESETS).flatMap(p => Object.keys(p.v)));
  sel.onchange = () => {
    const p = PRESETS[sel.value];
    if (!p) return;
    applying = true;
    for (const [k, v] of Object.entries(p.v)) {
      const el = fieldFor(k);
      if (!el) continue;
      el.value = v;
      el.dispatchEvent(new Event('input', {bubbles: true}));
    }
    applying = false;
    document.getElementById('presetNote').textContent = 'Valores de referencia: calibrá δ con eventos similares de la zona.';
  };
  for (const k of keys) fieldFor(k)?.addEventListener('input', () => { if (!applying) sel.value = 'custom'; });
  sel.value = 'landslide';
}

// Nombres legibles de los campos fuera de rango (para bloquear el envío).
export function invalidFields() {
  return [...document.querySelectorAll('[data-param]')].filter(outOfRange)
    .map(el => (HELP[el.dataset.param]?.t || el.dataset.param) + (el.min !== '' || el.max !== '' ? ` (${HELP[el.dataset.param]?.r || ''})` : ''));
}
