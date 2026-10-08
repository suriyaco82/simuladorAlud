# Ejemplo: deslizamiento de la ladera sur de la Laguna Torre por lluvias y GLOF hacia El Chaltén (hipotético)

> **Escenario hipotético.** No representa un evento ocurrido ni un pronóstico, y no reemplaza un estudio de amenaza.

Segunda variante del [GLOF de la Laguna Torre](EJEMPLO_GLOF_LAGUNA_TORRE.md). Cambia el desencadenante: en lugar de una avalancha de seracs del Glaciar Grande, **un episodio de lluvia satura el suelo glacigénico de la ladera sur de la laguna y lo desliza al lago**. El resto de la cascada es igual: ola de impulso, brecha en la morena del desagüe, vaciado del lago por el Río Fitz Roy y llegada a El Chaltén.

Archivo: [`frontend/examples/laguna_torre_deslizamiento_lluvia.json`](../frontend/examples/laguna_torre_deslizamiento_lluvia.json).

## Por qué este desencadenante

Schmidt, Winocur y Pitte (2023) documentan que el Glaciar Torre retrocedió ~350 m desde 1968 y se adelgazó 60–75 m desde 1952. Además, la Laguna Torre creció ~0,6 km² y se formaron lagunas marginales entre el hielo y las laderas. Al perder el soporte basal del hielo, **las laderas del valle se desestabilizan progresivamente ladera arriba**. Los mismos autores describen deslizamientos activos en las laderas de los cerros Solo y Techado Negro, en el valle del glaciar Torre/Grande (Schmidt et al. 2022).

## Datos variables

| Dato | Dónde se cambia | Valor del ejemplo |
|---|---|---|
| **Ubicación** (zona de búsqueda) | Panel *Desencadenante: lluvia* → **Dibujar zona**, o el editor (*Elementos* → *Masas iniciales*) | Ladera sur de la laguna, de la orilla (632 m) a ~1000–1200 m (116 ha, 30–40° de pendiente) |
| **Lluvia acumulada** | Panel (deslizador) o editor | **200 mm** |
| **Días del período** | Ídem | **3 días** |
| **Deshielo** (lluvia sobre nieve) | Ídem | **30 mm** de agua |
| Suelo: espesor, c′, φ′, T, infiltración | Panel → *Suelo de la ladera* | 5 m · 12 kPa · 40° · 65 m²/día · 0,7 |

**El volumen no se fija a mano: lo calcula la lluvia.** El botón **Calcular volumen** y cada cambio en el panel muestran en el mapa qué celdas se desprenden (rojo) y cuáles quedan al límite (amarillo, FS < 1,2). También informan el volumen, el área, la saturación y la *lluvia crítica*. Todo antes de simular.

## Modelo del desencadenante

Para cada celda del DEM dentro de la zona de búsqueda:

1. **Recarga efectiva:** q = (lluvia + deshielo) × infiltración / días (mm/día).
2. **Área de aporte** a, con flujo multidireccional (Quinn et al. 1991): el agua infiltrada fluye ladera abajo por el suelo.
3. **Fracción saturada del suelo** (SHALSTAB, Montgomery y Dietrich 1994): W = min(1, q·a / (T·b·sen β)). Las hondonadas, que reciben agua de más superficie, se saturan antes.
4. **Factor de seguridad de talud infinito:** FS = c′ / (γ z cos β sen β) + (1 − W·γw/γ) tan φ′ / tan β, con γ = peso unitario del suelo según su saturación.
5. **Fallan** las celdas con FS < 1, en grupos de al menos 3 celdas conectadas. Se excluyen:
   - los **cauces** (más de 2 ha de aporte: agua superficial sobre roca);
   - las paredes de **más de 45°** (roca desnuda);
   - las pendientes de **menos de 15°**.
6. Lo que falla se desprende con el **espesor del suelo**. La masa ya sale saturada: la densidad y la presión de poros inicial λ resultan de la saturación calculada.

**Lluvia crítica:** la lluvia que, en el mismo número de días, lleva cada celda a FS = 1. El panel informa el mínimo, el percentil 10 y la mediana.

### Calibración

Los parámetros del suelo son **supuestos** para till y morena consolidados, no mediciones. El criterio fue que **la ladera existe, así que tiene que ser estable con lluvias comunes**:

| Lluvia en 3 días | Resultado con el suelo del ejemplo |
|---|---|
| 40–80 mm | Estable |
| 120 mm | Primeros deslizamientos chicos (~0,07 M m³) |
| 150 mm + 20 mm de deshielo | ~6 ha, ~0,3 M m³ |
| **200 mm + 30 mm de deshielo** | **16 deslizamientos, 16,4 ha, ~0,8 M m³** (el ejemplo) |
| 320 mm + 30 mm de deshielo | 37,7 ha, ~1,9 M m³ |

Para un estudio real hay que reemplazar estos valores con datos de campo: espesor del till (calicatas, geofísica), c′ y φ′ (ensayos de corte), transmisividad y la lluvia de diseño de la zona.

## Resultados

Corrida de referencia: MPM 3D en GPU (Metal), dx 20 m, 2 partículas por celda y eje, 2 h de evento (31 min de cómputo). Lluvia de **200 mm en 3 días + 30 mm de deshielo**.

### Desencadenante

| Indicador | Valor |
|---|---|
| Deslizamientos | **16**, en las hondonadas de la ladera |
| Área que falla | **16,4 ha** de 81 ha de ladera con suelo (116 ha de zona; 22 ha son cauces) |
| Volumen | **0,80 M m³** (0,82 M m³ antes de discretizar) |
| Saturación media | 84 % del espesor del suelo · densidad 1 950 kg/m³ · λ inicial 0,43 |
| Lluvia crítica (en 3 días) | p10 ~130 mm · mediana ~270 mm |
| Velocidad máxima | ~33 m/s al bajar a la laguna |

### Crecida

| Estación | Llegada (h > 0,5 m) | Caudal pico | Hora del pico | Volumen en 2 h |
|---|---|---|---|---|
| Salida del lago (km 1,5) | 4 min | **~9.200 m³/s** | 38 min | 24 M m³ |
| Mitad del recorrido (km 5) | 30 min | ~4.300 m³/s | 90 min | 14 M m³ |
| El Chaltén (km 9,6) | 77 min | ~2.300 m³/s | 111 min | 3,1 M m³ |

### Impacto sobre El Chaltén

| Indicador | Valor | Confianza |
|---|---|---|
| Llegada al casco urbano | **~83 min** desde el deslizamiento | Media |
| Edificios alcanzados | **~507 de 1212 (42 %)**: 496 en intensidad alta y 11 en media | Baja–media |
| Superficie urbana alcanzada | ~39 ha (47 %) | Baja–media |
| Profundidad / velocidad en el pueblo | p50 ~5 m (limitada por la resolución: 1 partícula ≈ 2,5 m) · v p50 ~2,4 m/s | Baja / media |

### Comparación con la avalancha de seracs

| | Avalancha de seracs | Deslizamiento por lluvia |
|---|---|---|
| Masa que entra al lago | 6,3 M m³ de hielo | 0,8 M m³ de suelo saturado |
| Caudal pico a la salida | ~8.700 m³/s (37 min) | ~9.200 m³/s (38 min) |
| Llegada a El Chaltén | ~76–82 min | ~77–83 min |
| Edificios alcanzados | ~570 | ~507 |

**Lectura:** la crecida aguas abajo es casi la misma con los dos desencadenantes, aunque la masa que entra al lago es 8 veces menor. Lo que controla el caudal es la **brecha prescrita** (25 m, 15 min), no el desencadenante. Este escenario es útil para dos cosas: ver **qué lluvia empieza a desestabilizar la ladera** (~120–130 mm en 3 días con el suelo supuesto) y saber que, con más de una hora entre el deslizamiento y la llegada al pueblo, un sistema de alerta basado en la lluvia acumulada daría todavía más margen. Para saber si un deslizamiento de ~1 M m³ alcanza a romper la morena hace falta modelar la erosión de la brecha, no prescribirla.

Los valores máximos puntuales de profundidad del resumen no son físicos: son apilamientos transitorios de partículas en angosturas, igual que en el otro ejemplo.

## Interpretación y límites

- **El modelo del desencadenante es estacionario** (SHALSTAB). Supone que la lluvia del período alcanza a establecer el flujo subsuperficial. Por eso lo que cuenta es la lluvia acumulada repartida en los días (mm/día). Lluvias muy cortas e intensas saturan menos de lo que indica el modelo; lluvias largas, más parecido. Para tiempos de infiltración explícitos hace falta un modelo transitorio (por ejemplo, TRIGRS, Baum et al. 2008).
- **El DEM es de ~30 m (SRTM 2000).** Las hondonadas pequeñas y los escarpes no están resueltos, y la pendiente se suaviza. Un DEM de 1–5 m de la ladera cambiaría la ubicación y el tamaño de los deslizamientos.
- **Espesor uniforme del suelo.** En la realidad varía con la pendiente y la forma del terreno.
- **Masa delgada frente a la grilla.** El espesor (5 m) es menor que dx (20 m), así que la masa queda sub-resuelta en la vertical (la app lo advierte). El volumen se conserva, pero el detalle del flujo por la ladera es grueso.
- **La brecha sigue siendo prescrita** (25 m, desde t = 120 s, en 15 min). Es el supuesto que más pesa en el caudal pico. Un deslizamiento de ~0,8 M m³ genera una ola menor que la avalancha de 6,3 M m³ del otro ejemplo. Que esa ola alcance a abrir la brecha es un supuesto del escenario, no un resultado del modelo.

## Créditos

- Schmidt, D. I., Winocur, D. A. y Pitte, P. (2023). *Dinámica del Glaciar Torre y su relación con el cambio climático, PNLG, Santa Cruz.* Actas de Trabajos Completos del E-ICES 18. UBA · IDEAN (UBA-CONICET) · IANIGLA-CONICET. [ri.conicet.gov.ar/handle/11336/282104](https://ri.conicet.gov.ar/handle/11336/282104)
- Schmidt, D., Winocur, D. y Pitte, P. (2022). *Caracterización y evolución temporal de los deslizamientos activos en las laderas de los cerros Solo y Techado Negro, valle del glaciar Torre/Grande, provincia de Santa Cruz.* VIII Congreso Argentino de Cuaternario y Geomorfología, Actas: 67-68 (citado en Schmidt et al. 2023).
- Montgomery, D. R. y Dietrich, W. E. (1994). A physically based model for the topographic control on shallow landsliding. *Water Resources Research* 30(4): 1153-1171.
- Quinn, P., Beven, K., Chevallier, P. y Planchon, O. (1991). The prediction of hillslope flow paths for distributed hydrological modelling using digital terrain models. *Hydrological Processes* 5: 59-79.
