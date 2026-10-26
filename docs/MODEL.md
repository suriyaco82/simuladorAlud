# Modelo v0.2 — MLS-MPM 3D

## Motores

| Motor | Qué resuelve | Uso |
|---|---|---|
| `mpm` | Medio continuo 3D (MLS-MPM) con elastoplasticidad, presión de poros, erosión y deposición | Escenarios físicos |
| `particles` | Partículas independientes con Coulomb basal (motor v0.1) | Previsualización rápida de trayectorias |

Ambos usan el mismo escenario (grilla, masa de desprendimiento y DEM) y el mismo formato de salida.

## Escenario

- **Marco métrico local**: proyección equirectangular con origen en la esquina SO del BBox. La grilla de columnas tiene paso `dx`.
- **Masa de desprendimiento (volumen real)**: un polígono dibujado en el mapa o, si no hay, un círculo alrededor del punto de inicio. El espesor sigue un perfil `uniform` o `dome` (máximo en el centro, 0 en el borde) y se escala hasta el espesor medio o el volumen pedido.
  - El DEM pre-evento **contiene** la masa: la superficie de rotura es `H_pre − h(x,y)` y las partículas llenan el espacio entre esa superficie y la original. El volumen es el real y no se apila material sobre el terreno. Al final queda la cicatriz.
  - Las partículas se ubican con espaciado `s = dx/ppc` en planta, y cada columna se divide en `round(h/s)` capas. El volumen discretizado se reporta junto al objetivo.
- **Lecho erosionable**: espesor uniforme `erodible_depth_m`, excluyendo la zona de rotura y los bordes.

## Física MPM

- **MLS-MPM / APIC** con B-spline cuadrática (Hu et al., 2018). Grilla euleriana densa `nx × ny × nz`.
- **Elastoplasticidad Drucker-Prager** sobre deformaciones de Hencky con retorno al cono (Klár et al., 2016). El material sin cohesión no soporta tracción.
- **Mezcla sólido-agua monofásica**:
  - `ρ = ρs(1−n) + ρw·n·Sr`
  - viscosidad newtoniana `τv = η(∇v + ∇vᵀ)`.
- **Presión de poros** `λ = p/σ` por partícula (enfoque de Iverson):
  - `dλ/dt = −(λ − λeq)/Td − κ·Sr·tr(∇v)`, con `λeq = Sr·ρw/ρ` (hidrostática)
  - la contracción eleva λ (licuefacción) y la dilatancia lo reduce; λ queda limitado a [0, 0.95]
  - fricción interna efectiva `tan φ·(1−λ)`; fricción basal efectiva `tan δ·(1−λ)`.
- **Terreno**: frontera de altura `H(x,y)` que evoluciona con la erosión.
  - En los nodos bajo el lecho se aplica impenetrabilidad y Coulomb (el impulso tangencial queda limitado por `μ·|vn|`).
  - En la proyección de partículas sobre el lecho se aplica la misma ley.
- **Erosión (entrainment)**, McDougall & Hungr (2005): `dz/dt = Es·h·|v_basal|` si `|v| > v_c`.
  - El lecho desciende y el volumen erosionado se incorpora como partículas nuevas en reposo, lo que conserva masa y momento.
  - El volumen erosionado que todavía no alcanzó el de una partícula se reporta como `entrained_pending_m3`.
- **Deposición**: el material que se detiene. El espesor de depósito es la suma de volúmenes de partículas por columna al final.
- **Bordes laterales**: salida libre. El volumen que abandona el dominio se reporta como `outflow_volume_m3`.
- **Paso de tiempo**: `dt = min(0.35·dx/(c_p + v_max), 0.5·dx/v_max, ρdx²/6η)`. Condición de parada: `v_max < 0.3 m/s` después de 10 s.

## Escenarios en cascada (glaciar → lago → río)

- **Agua libre**: fluido débilmente compresible, τ = K·J·(J−1)·I, sin tracción (superficie libre), con viscosidad baja.
  - Comparte la grilla con el material granular, así que una avalancha que entra al lago le transfiere momento al agua (ola de impulso) sin acoplamientos ad hoc.
  - El módulo K está reducido (4·10⁶ Pa, c ≈ 63 m/s) para permitir pasos de tiempo interactivos.
  - La presión hidrostática inicial se impone en J.
- **Propiedades por partícula**: densidad, φ, δ y ξ propios de cada cuerpo (hielo, roca, agua). En el lecho, μ y 1/ξ se ponderan por la masa de cada nodo: el agua no tiene fricción de Coulomb.
- **Resistencia turbulenta (Voellmy/Manning)**: dv/dt = −g·|v|²/(ξ·h), aplicada de forma implícita a la columna del flujo. La equivalencia con Manning es ξ ≈ h^(1/3)/n².
- **Terreno**:
  - `lakes` nivela el espejo de agua.
  - `burn_channels` graba el cauce con perfil monótono (*stream burning*), para eliminar diques falsos del DEM en angosturas que no resuelve.
  - `erodible_zones` asigna espesores erosionables propios (morenas, lechos).
- **Brecha prescrita** (`breach`): el lecho baja linealmente a lo largo de un eje (profundidad máxima en el lago, que se reduce a 0 aguas abajo) entre `start_s` y `start_s + duration_s`.
  - El material removido se considera evacuado como carga del flujo y se reporta en `breach_removed_m3`.
  - Prescribir la brecha es la práctica habitual en modelación de GLOF, porque su mecánica depende de la estructura interna de la morena, que el DEM no muestra.
- **Estaciones de aforo** (`gauges`): caudal Q = Σ h·(v·n)·ancho a través de una sección, además de h y v máximos. El resultado son los hidrogramas.

Verificación del agua (`python -m backend.validation gpu --agua`):
- **Ruptura de presa sobre fondo liso:** el frente avanza −14% respecto de 2·√(g·h₀) (Ritter), sin cambios entre dx 2 y 1 m. Es lo habitual en modelos numéricos, porque la solución ideal supone una punta infinitamente delgada.
- **Lámina con Voellmy:** entre −14% y −32% respecto de √(ξ·h·sin θ) con el espesor medido. La lámina sigue adelgazándose durante la prueba y no llega al régimen uniforme, así que es una verificación aproximada.

## Inundación en llanura

Son opciones del motor `flood`. Ninguna está activa por defecto.

- **Depresiones** (`flood.depressions`):
  - `carve` (por defecto) abre salida a todo pozo con caminos D4;
  - `keep` usa el DEM sin modificar, así que los bajos y lagunas almacenan agua en el 2D;
  - `shallow` rellena solo los pozos de menos de `pit_depth_m`.

  La delineación de cuencas usa siempre el DEM rellenado (Priority-Flood).
- **Infiltración Green-Ampt** (`infiltration.method = "green_ampt"`). La lluvia cae entera sobre la grilla y en cada paso infiltra f = Ks·(1 + ψ·Δθ/F), limitada por el agua disponible en la celda y por la capacidad hasta la napa, F ≤ Δθ·z_napa, con Δθ = θe·(1 − Se₀). Al llenarse, la celda deja de infiltrar (exceso por saturación). No hay redistribución ni recarga entre eventos. Ks se multiplica por el factor del uso del suelo y por 0,05 en zonas urbanas. La evaporación descuenta una lámina constante del agua en superficie.
- **Entradas de caudal** (`inflows`). Q(t) se suma como fuente en las celdas de la sección, ponderadas por (z_max − z + 0,1)², de modo que el agua entra por el cauce.
- **Terraplenes** (`roads`). Cada camino se levanta a la mediana del terreno en ~100 m de su eje más la altura de su categoría, en su ancho, sin bajar nunca el terreno. Los puentes no se levantan. Con `depressions = carve`, la apertura de pozos también corta los terraplenes donde cruzan un drenaje. En llanura conviene `keep` con alcantarillas.
- **Alcantarillas**. Unen las celdas a ambos lados del terraplén con Q = Cd·A·√(2g·Δη), Cd = 0,6. El área mojada se reduce con h/D si la entrada no está sumergida, y el volumen por paso queda limitado para no invertir el desnivel.
- **Uso del suelo** (`landuse`). La clase de cada celda (WorldCover o polígonos) define CN (condición II), el Manning fuera de los cauces y el factor de Ks.
- **Informes**. Caminos: profundidad máxima sobre la calzada, muestreada cada dx/2 (umbrales de Shand et al. 2011). Uso del suelo: superficie con h > 0,1 m y tiempo acumulado con h > 0,1 m.

## Inundación urbana

Opción del motor `flood` (`urban`), en `backend/urbanflood.py`.

- **Calles** (`urban.streets`). Cada tramo se rasteriza con el ancho de su categoría (avenida 18 m, colectora 12, calle 9, pasaje 5) sin saltos en diagonal, porque el agua pasa solo por las caras. La calzada pavimentada baja `curb_m` (0,15 m) respecto de las manzanas, tiene CN 98, Manning 0,015 y no infiltra. Las calles de tierra tienen CN 88, n 0,025 y 0,3·Ks. Las manzanas (el resto de la zona urbana) tienen CN 92, n 0,08 (rugosidad equivalente de las edificaciones) y 0,05·Ks. Si dx > 2 veces el ancho de las calles, cada calle ocupa una celda entera y se avisa.
- **Canales** (`urban.canals`). El lecho se baja a la mediana del terreno en ~60 m menos `depth_m`, en `width_m`.
- **Sectores** (`urban.barrios`). Cada polígono es un sector, y cada barrio que es solo un punto toma las celdas urbanas más cercanas (Voronoi, hasta 2 km). La zona urbana es la unión de las zonas expuestas, los barrios y, si no hay zona dibujada, el área a menos de 60 m de las calles. Lo que no cae en ningún barrio forma el sector «Resto de la zona urbana».
- **Red pluvial**: un depósito por sector con capacidad de conducción Q = i·A (i = `design_mm_h`) y volumen V = `storage_mm`·A. Las bocas captan en las celdas de calle como vertedero, Q = 1,66·L·h^1,5, con L = `inlet_m_per_100m`·dx/100. Si lo que llega supera lo que la red puede recibir en el paso (volumen libre + conducción), la captación se escala. Los techos conectados (`direct_fraction`) entran primero, y lo que no cabe sale por el 3 % de las celdas de calle más bajas del sector (sobrecarga). Lo conducido sale de la zona o, con `outlet`, vuelve a la superficie en ese punto.
- **Red cloacal**: igual, con capacidad libre `capacity_mm_h` (0,5 mm/h ≈ 1,4 l/s·ha). Entran la fracción `rdii_fraction` de la lluvia (conexiones clandestinas) y el agua de las tapas anegadas por encima de `ingress_depth_m`, por orificio: Q = 0,6·a·(dx/espaciamiento)·√(2gh). Lo que no cabe desborda por las bocas más bajas. Ese volumen se marca en un trazador pasivo, transportado aguas abajo con el flujo como el sedimento, que da la capa `max_sewage` (fracción máxima de agua cloacal).
- **Colapso**: el instante en que la red está llena (≥ 95 %) y no puede recibir todo lo que le llega. Se informan también las horas a capacidad y el llenado máximo.
- **Informes**. Calles: profundidad máxima muestreada cada dx/2, km sobre 0,15 m (cordón), 0,3 m y 0,6 m, y peligrosidad H1–H6 de Smith et al. (2014), *Australian Rainfall and Runoff* (2019), con los máximos de h, v y h·v, que no son simultáneos (conservador). Barrios: superficie con h > 0,1 m y > 0,3 m, afectación (alta: ≥ 25 % anegado o ≥ 5 % con más de 0,3 m; media: ≥ 5 % o ≥ 0,1 ha con más de 0,3 m), calles, edificios y redes.

Las redes son un modelo agregado (depósitos por barrio), no una red de caños con su línea piezométrica: no representan remansos ni la ubicación real de cada boca. Sirven para comparar escenarios (con o sin red pluvial, más capacidad, menos conexiones clandestinas), no para dimensionar obras.

## CPU / GPU

El solver está escrito en [Taichi](https://www.taichi-lang.org/): el mismo código se compila para CPU (LLVM, multinúcleo) o GPU (Metal en macOS, CUDA o Vulkan). `device: auto` intenta usar la GPU y, si no hay, cae a CPU.

- **Compilación**: los kernels se compilan en cada corrida (~15 s), porque las constantes y el tamaño de la grilla forman parte del kernel.
- **Memoria**: hay un presupuesto de nodos de grilla (24 M en GPU, 10 M en CPU). Si la zona excede ese presupuesto, `dx` aumenta automáticamente y se muestra una advertencia.

## Verificación

`python -m backend.validation [gpu|cpu]` compara un bloque deslizando sobre un plano inclinado con la solución analítica `a = g(sin θ − tan δ(1−λ) cos θ)`. Resultado actual (Metal):

| θ | δ | λ | dx | h | a teórica | a MPM | error |
|---|---|---|---|---|---|---|---|
| 30 | 20 | 0 | 10 | 20 | 1.81 | 1.83 | +0.8% |
| 30 | 20 | 0 | 25 | 20 | 1.81 | 1.79 | −1.4% |
| 40 | 10 | 0 | 10 | 20 | 4.98 | 4.98 | −0.1% |
| 25 | 15 | 0 | 10 | 5 | 1.76 | 1.76 | 0.0% |
| 30 | 20 | 0.5 | 10 | 20 | 3.36 | 3.34 | −0.6% |
| 15 | 20 | 0 | 10 | 20 | reposo | reposo | ✓ |

Esto verifica la fricción basal y el acoplamiento con la presión de poros. **No** valida el modelo contra eventos reales: eso requiere calibrar contra eventos históricos (alcance, área, espesores y tiempos).

## Limitaciones conocidas

- En los flujos de detritos el agua intersticial es parte de la mezcla (monofásica): no drena ni se separa del sólido. El agua libre de un lago sí es un material propio, pero se mezcla con el sedimento solo a través de la grilla, sin intercambio de fases. Un MPM bifásico (u-p) es el paso siguiente.
- **Resolución**: si el espesor es menor que ~2·dx, la masa queda sub-resuelta en la vertical y el flujo se comporta como una lámina deslizante. En ese caso conviene achicar la zona y bajar `dx`.
- El módulo elástico está reducido (2·10⁷ Pa) para permitir pasos de tiempo interactivos. Afecta la compresibilidad, no la resistencia friccional.
- Sin cohesión, sin ley μ(I), sin fragmentación y sin turbulencia tipo Voellmy.
- Erosión con espesor uniforme; no hay mapas de lecho erosionable.
- Equirectangular local: válido para zonas de hasta ~50 km.
