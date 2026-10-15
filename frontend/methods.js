// Documento «Métodos de cálculo»: qué calcula cada motor y con qué ecuaciones. Las tablas de parámetros (uso del
// suelo, texturas, caminos) se leen del backend (/api/plain/defaults) para que coincidan con lo que se simula.
import {shell} from './report.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmt = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('es-AR', {maximumFractionDigits: d});
const ul = items => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
const table = (head, rows) => `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
  `<tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

function plainTables(d) {
  if (!d) return '<p class="note">No se pudieron leer las tablas de parámetros del backend.</p>';
  return `<h3>Clases de uso del suelo (valores por defecto, editables)</h3>` +
    table(['Clase', 'CN (AMC II)', 'Manning n', 'Factor de Ks'],
      Object.values(d.landuse).map(c => [`<span class="sw" style="background:${c.color}"></span>${esc(c.name)}`, fmt(c.cn, 0), fmt(c.manning, 3), fmt(c.ks_factor, 2)])) +
    `<p class="note">CN para suelos de los grupos hidrológicos B–C (USDA-NRCS TR-55, 1986); Manning de llanura de inundación (Chow 1959; Arcement y Schneider 1989). ESA WorldCover se asigna así: árboles → monte; arbustos → arbustal; pastizal y musgo → pastura; cultivo → cultivo; construido → urbano; suelo desnudo y nieve → desnudo; agua → agua; humedal y manglar → humedal.</p>` +
    `<h3>Texturas de suelo para Green-Ampt (Rawls, Brakensiek y Miller 1983)</h3>` +
    table(['Textura', 'Ks (mm/h)', 'Succión ψ (mm)', 'Porosidad efectiva θe'],
      Object.values(d.textures).map(t => [esc(t.name), fmt(t.ks_mm_h, 1), fmt(t.suction_mm, 1), fmt(t.porosity, 3)])) +
    `<h3>Categorías de caminos (valores por defecto, editables)</h3>` +
    table(['Categoría', 'Terraplén sobre el terreno (m)', 'Ancho (m)'],
      Object.values(d.roads).map(r => [esc(r.name), fmt(r.embankment_m, 1), fmt(r.width_m, 0)]));
}

export async function methodsHTML(api) {
  let d = null;
  try { const r = await fetch(api + '/api/plain/defaults'); if (r.ok) d = await r.json(); } catch { /* sin tablas */ }
  const body = `
<h1>Métodos de cálculo</h1>
<p style="font-size:12.5pt;color:#0b2e4a;margin-top:0">Suriyaco MassFlow 3D · qué calcula cada motor y con qué ecuaciones</p>
<div class="callout">El simulador está <b>verificado</b> contra soluciones analíticas simples, pero <b>no está calibrado</b> contra eventos reales. Sirve para explorar escenarios; no debe usarse para alertas, evacuaciones, diseño de obra ni zonificación oficial.</div>

<h2>1. Terreno y datos de base</h2>
<h3>Fuentes del DEM</h3>
${ul([
  'API de OpenTopography: COP30, ANADEM, NASADEM, AW3D30, SRTMGL1. ANADEM es un modelo del terreno sin vegetación y conviene en llanura.',
  'AWS Terrain Tiles en formato Terrarium, sin credenciales.',
  'Un DEM sintético que no necesita credenciales.',
  '<b>DEM propios</b>: rasters (GeoTIFF, IMG, ASC; por ejemplo el MDE-Ar de 5 m del IGN) y nubes LiDAR <b>LAS/LAZ</b>. Se reproyectan a WGS84 (EPSG:4326) con interpolación bilineal. Las nubes LiDAR se rasterizan con la media de los puntos de terreno (clase 2 de ASPRS); si la nube no está clasificada se usa el mínimo de cada celda. Los huecos se interpolan. Fuera de la cobertura, el DEM se completa con AWS Terrain Tiles corrido por la mediana de la diferencia entre ambos en la franja común (corrige un datum vertical distinto).',
])}
<h3>Zona de cálculo y coordenadas</h3>
${ul([
  'La zona es un rectángulo: dibujado, tomado de la vista actual o calculado como la extensión de un GeoJSON (WGS84) más un 5 % de margen por lado. Hasta 1° por lado.',
  'Se pasa a un marco métrico local con proyección equirectangular, con origen en la esquina SO de la zona. Es válido hasta unos 50 km.',
  'Muestreo: interpolación bilineal del DEM sobre una grilla de paso dx.',
])}
<h3>Acondicionamiento del terreno</h3>
${ul([
  'Nivelación de lagos a una cota dada.',
  'Stream burning: el cauce se graba con un perfil monótono decreciente y una profundidad y ancho dados.',
  'Presas y vertederos: el muro se construye a la cota de coronamiento.',
  'Zonas erosionables con espesor propio.',
  '<b>Terraplenes de caminos y vías</b> (motor de inundación): ver la sección 7.',
])}
<h3>Masa de desprendimiento</h3>
${ul([
  'Polígono con perfil de espesor uniforme o en domo, escalado al espesor o al volumen pedido.',
  'Superficie de rotura = H<sub>pre</sub> − h(x,y). La masa está dentro del DEM, así que al final queda la cicatriz.',
  'Partículas con espaciado s = dx/ppc.',
])}

<h2>2. Motor MPM 3D (Taichi, CPU o GPU)</h2>
${ul([
  'Método: MLS-MPM / APIC con B-spline cuadrática (Hu et al. 2018).',
  'Sólido: elastoplasticidad Drucker-Prager sobre deformaciones de Hencky, con retorno al cono (Klár et al. 2016). No admite tracción porque no tiene cohesión.',
  'Mezcla sólido-agua (monofásica): densidad ρ = ρ<sub>s</sub>(1−n) + ρ<sub>w</sub>·n·S<sub>r</sub>; viscosidad newtoniana τ<sub>v</sub> = η(∇v + ∇vᵀ).',
  'Presión de poros (enfoque de Iverson), con λ = p/σ: dλ/dt = −(λ−λ<sub>eq</sub>)/T<sub>d</sub> − κ·S<sub>r</sub>·tr(∇v), con λ<sub>eq</sub> = S<sub>r</sub>·ρ<sub>w</sub>/ρ. La contracción la sube (licuefacción) y la dilatancia la baja. Reduce la fricción interna, tan φ·(1−λ), y la basal, tan δ·(1−λ).',
  'Contacto con el lecho: impenetrabilidad más fricción de Coulomb, con el impulso tangencial limitado a μ·|v<sub>n</sub>|.',
  'Erosión (entrainment): McDougall y Hungr (2005), dz/dt = E<sub>s</sub>·h·|v| cuando |v| > v<sub>c</sub>. El material erosionado entra como partículas nuevas.',
  'Resistencia turbulenta (Voellmy/Manning): dv/dt = −g|v|²/(ξh), aplicada en forma implícita; equivalencia con Manning ξ ≈ h<sup>1/3</sup>/n².',
  'Agua libre (lagos, GLOF): fluido débilmente compresible, τ = K·J·(J−1)·I, con K = 4·10⁶ Pa. Comparte la grilla con el material granular, así que la ola de impulso aparece sola, sin acoplamientos ad hoc.',
  'Brecha prescrita de morena: el lecho baja linealmente en el tiempo a lo largo de un eje.',
  'Estaciones de aforo: caudal por sección, Q = Σ h·(v·n)·ancho.',
  'Paso de tiempo (CFL): dt = min(0,35·dx/(c<sub>p</sub>+v<sub>max</sub>), 0,5·dx/v<sub>max</sub>, ρdx²/6η).',
  'Parada: cuando v<sub>max</sub> &lt; 0,3 m/s (o se mueve menos del 0,2 % del material) después de 10 s.',
  'Requiere Taichi instalado en el servidor; sin Taichi solo están disponibles los motores de partículas e inundación.',
])}

<h2>3. Motor rápido de partículas</h2>
${ul([
  'Partículas independientes que siguen el gradiente del lecho.',
  'Fricción de Coulomb basal, μ = tan δ·(1−λ).',
  'Amortiguamiento numérico de 0,985 por paso.',
  'No hay interacción entre partículas: sirve solo para previsualizar.',
])}

<h2>4. Deslizamiento disparado por lluvia</h2>
${ul([
  'Modelo: SHALSTAB (Montgomery y Dietrich 1994) combinado con talud infinito.',
  'Área de aporte: flujo multidireccional MFD (Quinn et al. 1991, exponente 1,1).',
  'Fracción saturada: W = min(1, q·a/(T·b·sen β)).',
  'Factor de seguridad: FS = c′/(γ z cos β sen β) + (1 − Wγ<sub>w</sub>/γ)·tan φ′/tan β.',
  'Fallan las celdas con FS &lt; 1. El modelo también calcula la lluvia crítica que lleva cada celda a FS = 1.',
])}

<h2>5. Cuencas e hidrología</h2>
${ul([
  'Relleno de depresiones: Priority-Flood + ε (Barnes et al. 2014) para la red de drenaje y la delineación.',
  '<b>Depresiones en el modelo 2D</b>, a elección: <i>abrir salida</i> a todo pozo con caminos D4 (breaching, Lindsay 2016; Soille 2004; por defecto, para montaña); <i>conservar bajos y lagunas</i> (llanura: almacenan agua); o <i>rellenar solo los pozos</i> menos profundos que un umbral (artefactos del DEM).',
  'Dirección de flujo: D8 por máxima pendiente, con área acumulada y orden de Strahler.',
  'Tiempo de concentración: Kirpich, t<sub>c</sub> = 0,0195·L<sup>0,77</sup>·S<sup>−0,385</sup> (minutos); Témez, t<sub>c</sub> = 0,3·(L/S<sup>0,25</sup>)<sup>0,76</sup>.',
  'Propensión de la cuenca: número de Melton R = relieve/√A, clasificado según Wilford et al. (2004).',
  'Tormenta: hietograma uniforme, adelantado, centrado, atrasado o por bloques, de hasta 240 h; reducción areal de Témez, 1 − log<sub>10</sub>(A)/15.',
  'Infiltración SCS-CN: P<sub>e</sub> = (P−I<sub>a</sub>)²/(P−I<sub>a</sub>+S), con S = 25400/CN − 254 e I<sub>a</sub> = 0,2·S; ajuste por humedad antecedente (AMC I/II/III, Chow et al. 1988) y por pendiente (Sharpley y Williams 1990).',
  'Hidrograma: unitario adimensional SCS, con t<sub>p</sub> = dt/2 + 0,6·t<sub>c</sub>; tránsito de Muskingum entre subcuencas.',
  'Flujos de detritos: concentración de equilibrio de Takahashi, C<sub>v</sub> = ρ<sub>w</sub>·tan θ/((ρ<sub>s</sub>−ρ<sub>w</sub>)(tan φ − tan θ)); tipo de flujo según C<sub>v</sub> (agua &lt; 0,2; hiperconcentrado 0,2–0,4; detritos ≥ 0,4); disparo por escorrentía de Gregoretti y Dalla Fontana (2008), q<sub>c</sub> = 0,78·d<sup>1,5</sup>/(tan θ)<sup>1,27</sup>; caudal pico de Rickenmann (1999), Q<sub>p</sub> = 0,1·M<sup>0,833</sup>; ancho de cauce por geometría hidráulica, w ≈ 3·A<sup>0,4</sup>.',
])}

<h2>6. Inundación 2D</h2>
${ul([
  'Lluvia sobre toda la grilla (rain-on-grid): sobre las cuencas elegidas o, en llanura, sobre toda la zona sin delinear cuencas.',
  'Infiltración, a elección: <b>SCS-CN</b> celda por celda sobre la lluvia, con las zonas urbanas casi impermeables (CN 92); o <b>Green-Ampt continuo</b> (sección 7), que actúa sobre toda el agua en superficie.',
  'Hidrodinámica: aguas someras con aproximación inercial local (Bates et al. 2010) y esquema θ de de Almeida et al. (2012); limitadores de volumen y de número de Froude (Fr ≤ 1,5); paso de tiempo por CFL, con un máximo configurable (10–60 s) para simulaciones de varios días (hasta 10 días).',
  'Fricción de Manning por defecto: ladera 0,06, cauce 0,045, zona urbana 0,03; con uso del suelo, la de cada clase fuera de los cauces. Cauces de subgrilla: el agua corre concentrada en un ancho w &lt; dx hasta superar la altura de las márgenes.',
  'Reología del barro: modelo cuadrático de O’Brien y Julien (1988), el mismo de FLO-2D: τ<sub>y</sub> = α<sub>2</sub>·e<sup>β<sub>2</sub>C<sub>v</sub></sup> y η = α<sub>1</sub>·e<sup>β<sub>1</sub>C<sub>v</sub></sup>; la mezcla se detiene donde ρgh·sen θ &lt; τ<sub>y</sub>.',
  'Sedimento: advección upwind de C<sub>v</sub>. El lecho se erosiona o recibe depósito según el equilibrio de Takahashi.',
  'Deslizamientos durante la tormenta: SHALSTAB, revisado cada 30 s.',
  'Bloques y árboles (trazadores): un bloque se mueve con el umbral de Costa (1983), v<sub>c</sub> = 0,18·d<sub>mm</sub><sup>0,487</sup>, reducido por la flotación en la matriz densa; un árbol se arranca por erosión, deslizamiento o arrastre, y flota mientras el tirante supera su calado.',
  'Estaciones de aforo automáticas en la salida de cada cuenca: caudal neto que sale de su área de aporte, comparado con el hidrograma SCS.',
])}

<h2>7. Llanura: suelo, ríos y caminos</h2>
<p>Opciones del motor de inundación para campos y caminos que se anegan por desborde de ríos y por saturación del suelo. Ninguna está activa por defecto; el preset «llanura» las configura juntas y apaga los procesos de montaña (erosión, deslizamientos, bloques y árboles).</p>
<h3>Infiltración continua Green-Ampt (Mein y Larson 1973)</h3>
${ul([
  'Tasa potencial: f = K<sub>s</sub>·(1 + ψ·Δθ/F), con F la lámina ya infiltrada y Δθ = θ<sub>e</sub>·(1 − S<sub>e0</sub>) (porosidad efectiva por la fracción libre según la saturación inicial).',
  'En cada paso infiltra min(f·dt, h, F<sub>cap</sub> − F): nunca más que el agua presente, ni más que la capacidad hasta la napa, F<sub>cap</sub> = Δθ·z<sub>napa</sub>. Al llenarse, la celda deja de infiltrar (exceso por saturación).',
  'Actúa sobre la lluvia y también sobre el agua estancada, desbordada o que llega por los bordes.',
  'K<sub>s</sub> se multiplica por el factor del uso del suelo y por 0,05 en zonas urbanas.',
  'Evaporación del agua en superficie: lámina constante (mm/día).',
  'Limitación: no hay redistribución en el suelo ni recuperación entre eventos.',
])}
<h3>Caudales de entrada</h3>
${ul([
  'Hidrograma Q(t) de un río que viene de aguas arriba de la zona, en una sección marcada a través del cauce.',
  'Se suma como fuente en las celdas de la sección, ponderadas por (z<sub>max</sub> − z + 0,1)², así que entra por las celdas más bajas (el cauce).',
  'Forma generada (opcional): gamma, Q(t) = Q<sub>b</sub> + (Q<sub>p</sub> − Q<sub>b</sub>)·[(t/t<sub>p</sub>)·e<sup>1−t/t<sub>p</sub></sup>]<sup>3,7</sup>; o tabla pegada de una planilla.',
])}
<h3>Terraplenes y alcantarillas</h3>
${ul([
  'Caminos y vías de OpenStreetMap (Overpass) o de un GeoJSON. Cada camino se levanta a la mediana del terreno en ~100 m de su eje más la altura del terraplén de su categoría, en su ancho, sin bajar nunca el terreno. Los puentes no se levantan.',
  'Alcantarillas (de OSM o marcadas en el mapa): unen las celdas a ambos lados del terraplén con Q = C<sub>d</sub>·A·√(2g·Δη), C<sub>d</sub> = 0,6. El área mojada se reduce con h/D si la entrada no está sumergida, y el volumen por paso queda limitado para no invertir el desnivel.',
  'Con «abrir salida a los pozos», la apertura también corta los terraplenes donde cruzan un drenaje; en llanura conviene «conservar bajos» con alcantarillas.',
])}
<h3>Uso del suelo</h3>
${ul([
  'Clase por celda desde ESA WorldCover 10 m (2021, leído por ventana del bucket público de AWS) o polígonos propios (dibujados o GeoJSON), que tienen prioridad.',
  'Cada clase define el CN (condición II), el Manning fuera de los cauces y el factor de K<sub>s</sub>.',
])}
${plainTables(d)}

<h2>8. Impacto y exposición</h2>
${ul([
  'Intensidad para flujos de detritos y barro (C<sub>v</sub> ≥ 0,2): criterio de Hürlimann et al. (2008) y recomendaciones suizas BUWAL. Alta: h ≥ 1 m y v ≥ 1 m/s; media: se cumple solo una de las dos; baja: el resto de la zona afectada (h &gt; 0,1 m).',
  'Intensidad para crecidas de agua (C<sub>v</sub> &lt; 0,2): alta si h &gt; 2 m o h·v &gt; 2 m²/s; media si h &gt; 0,5 m o h·v &gt; 0,5 m²/s; baja con h &gt; 0,1 m.',
  'Presión dinámica: ρv².',
  'Grado de daño (0–4) según la intensidad. «Destrucción probable» con presión ≥ 35 kPa (Jakob et al. 2012; Zanchetta et al. 2004) o cuando el flujo supera la altura del edificio.',
  'Zonas de afectación: cierre morfológico de la grilla; contornos simplificados con Douglas-Peucker; criticidad según la intensidad y los edificios con daño.',
  'Métricas: alcance (runout), coeficiente H/L (ángulo de alcance), volúmenes depositado y erosionado, tiempo de arribo, área inundada y <b>duración del anegamiento</b> (tiempo acumulado con h &gt; 0,1 m).',
  'Edificios: huellas y alturas de GlobalBuildingAtlas LoD1 (Zhu et al. 2025), más los datos de campo cargados por CSV.',
  '<b>Caminos</b>: km de cada categoría con agua sobre la calzada (profundidad máxima sobre la corona del terraplén, muestreada cada dx/2) por encima de los umbrales de estabilidad de vehículos de Shand et al. (2011), Australian Rainfall and Runoff: 0,15 m precaución, 0,3 m intransitable para autos, 0,6 m para todo vehículo; km anegados más de 24 h. Los puentes no se cuentan.',
  '<b>Campos y uso del suelo</b>: hectáreas de cada clase anegadas (h &gt; 0,1 m), profundas (h &gt; 0,5 m) y con agua más de 24 h y más de 72 h.',
  'Balance de agua: lluvia + entradas = infiltración + evaporación + salida por los bordes + almacenada en superficie.',
])}

<h2>9. Verificación</h2>
${ul([
  'Bloque sobre plano inclinado: se compara con a = g(sen θ − tan δ(1−λ)cos θ). El error queda dentro de ±1,4 %.',
  'Agua: rotura de presa contra la solución de Ritter, 2√(gh<sub>0</sub>): el frente queda un 14 % por detrás; lámina con Voellmy contra √(ξh·sen θ): entre −14 % y −32 %, y la lámina no llega al régimen uniforme.',
  'Llanura (pruebas con terreno sintético, río, terraplén y alcantarilla): el balance de agua cierra con un error menor al 0,1 %.',
  'Sin las opciones de llanura, el motor de inundación da el mismo resultado que la versión anterior.',
  'Esto verifica el solver contra soluciones analíticas y balances, pero no está calibrado contra eventos reales.',
])}
<p class="note">El frontend solo visualiza: dibuja la superficie del flujo a partir de las partículas y los bloques 3D con fines visuales, sin cálculos físicos propios.</p>
`;
  return shell('Métodos de cálculo · Suriyaco MassFlow 3D', body, 'Métodos de cálculo');
}
