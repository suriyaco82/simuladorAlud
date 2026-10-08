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
