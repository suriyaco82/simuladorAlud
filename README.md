# Suriyaco MassFlow 3D — v0.2

Prototipo para simular movimientos de masa sobre un DEM. Incluye:

- **Zona de cálculo dibujada en el mapa**: se arrastra un rectángulo o se toma la vista actual. También se pueden editar las coordenadas.
- **Área de desprendimiento dibujada en el mapa** (polígono). La masa se define por espesor medio o por volumen total, con perfil uniforme o en domo. El DEM pre-evento contiene la masa, así que el volumen es real y queda la cicatriz.
- **Solver MLS-MPM 3D en CPU o GPU** (Taichi: Metal, CUDA, Vulkan o LLVM):
  - elastoplasticidad Drucker-Prager
  - mezcla sólido-agua (saturación, densidad, viscosidad)
  - **presión de poros** que evoluciona por disipación y por contracción/dilatancia, y reduce la fricción interna y basal
  - **erosión (entrainment)** que baja el lecho e incorpora material
  - **deposición**.
- **Motor rápido de partículas** (el de v0.1) para previsualizar.
- **Visor 3D**:
  - exageración vertical en vivo
  - reproducción interpolada, línea de tiempo y velocidad
  - partículas coloreadas por velocidad, presión de poros u origen
  - capas de depósito, cambio neto, erosión, profundidad y velocidad máximas, presión de poros y tiempo de arribo, también superpuestas en el mapa.
- **Vista realista**: terreno con imagen satelital, cielo y sombras; superficie del flujo reconstruida desde las partículas; bloques 3D que ruedan; polvo en frentes secos y rápidos. El aspecto se ajusta al material (roca, suelo, detritos, barro) y el material erosionado se ve con color de sedimento. La cámara puede seguir al flujo. Es una representación visual: el tamaño de los bloques no es un resultado del modelo.
- Mapas base: satélite, OSM y topográfico. Integración con OpenTopography (`COP30`, `ANADEM`, `NASADEM`, `AW3D30`, `SRTM_GL1`) y DEM sintético sin credenciales.
- Las simulaciones corren como *jobs* en un proceso aparte, con progreso y cancelación.

- **Análisis de exposición**: cruza el resultado con zonas urbanas y edificios. Calcula la superficie afectada por intensidad (alta, media, baja), la profundidad, velocidad y presión dinámica (ρv²), el tiempo de arribo y los edificios alcanzados. Las zonas urbanas no se erosionan.
- **Escenarios en cascada (GLOF)**: varios cuerpos con material propio (hielo, roca, **agua libre**) en la misma grilla MPM, lagos nivelados, cauces grabados en el DEM, zonas erosionables propias, **brecha prescrita** de morena, resistencia turbulenta de Voellmy/Manning y **estaciones de aforo** con hidrogramas.
- **Ejemplos precargados**: escenarios completos que se cargan con un clic:
  - [El Chaltén — flujo de detritos desde el escarpe oeste (hipotético)](docs/EJEMPLO_EL_CHALTEN.md), con 1212 edificios de OpenStreetMap.
  - [Laguna Torre → Río Fitz Roy → El Chaltén — GLOF por colapso del Glaciar Grande (hipotético)](docs/EJEMPLO_GLOF_LAGUNA_TORRE.md).
  - [Laguna Torre → Río Fitz Roy → El Chaltén — deslizamiento de la ladera sur por lluvias y GLOF (hipotético)](docs/EJEMPLO_DESLIZAMIENTO_LLUVIA_LAGUNA_TORRE.md), con datos del Glaciar Torre de Schmidt, Winocur y Pitte (2023).
  - [Dique Los Sauces → Río Los Sauces → La Rioja — rotura del paredón por sobrecarga (hipotético)](docs/EJEMPLO_DIQUE_LOS_SAUCES.md).

- **Inundación por lluvia en cuencas** (motor `flood`): una tormenta (lluvia, duración, hietograma, CN, humedad previa) llueve sobre toda la zona. El backend delinea cuencas y subcuencas sobre el DEM: relleno Priority-Flood, D8, área acumulada, orden de Strahler y salidas al borde, en puntos marcados o donde los cauces entran a la zona urbana. Para cada una calcula Tc, número de Melton y la hidrología SCS (SCS-CN, hidrograma unitario, Muskingum entre subcuencas). Después simula en 2D (aguas someras, inercial local) el agua y el sedimento:
  - reología de barro O'Brien-Julien
  - erosión y depósito hacia el equilibrio de Takahashi: la crecida se vuelve flujo de detritos en los cauces empinados
  - deslizamientos de ladera SHALSTAB
  - bloques y árboles arrastrados como trazadores
  - estaciones de aforo automáticas en la salida de cada cuenca, comparadas con el hidrograma SCS.

  Flujo de trabajo en el panel *Cuencas e inundación por lluvia* (botón arriba de la barra lateral):
  1. **Delinear cuencas** digitaliza cuencas, subcuencas, cauces y salidas sobre el DEM real (`POST /api/basins`). Muestra en el mapa dónde la escorrentía puede disparar un alud (Gregoretti) y los caudales pico SCS. Se exporta en **GeoJSON**.
  2. Elegí las cuencas a simular, con casillas o con clic en el mapa.
  3. **Simular**: llueve solo sobre las cuencas elegidas, y el agua sigue aguas abajo de sus salidas. Hay una estación de aforo en la salida de cada cuenca y subcuenca, cuyo caudal es el flujo neto que sale de su área de aporte, comparado con el hidrograma SCS.

  Si cambiás la zona, el dx o los umbrales después de delinear, la app pide volver a delinear. El DEM SYNTHETIC no sirve para cuencas: al entrar en este modo se cambia a AWS_TERRAIN.
- **Deslizamiento disparado por lluvia**: una masa puede definirse por una *zona de búsqueda* y la lluvia acumulada (mm, días, deshielo) en lugar de un volumen fijo. El volumen sale de un modelo de talud infinito + SHALSTAB (Montgomery y Dietrich 1994) sobre el DEM: la lluvia infiltrada fluye ladera abajo, satura las hondonadas y fallan las celdas con FS < 1. El panel *Desencadenante: lluvia* muestra en el mapa qué se desprende, el volumen y la lluvia crítica antes de simular (`POST /api/trigger/preview`).
- **Editor de escenarios y datos de campo** (botón "✎ Editar datos / cargar datos de campo" en Ejemplos): trae todos los valores del ejemplo elegido, incluidos los que no están en el formulario (masas iniciales, lagos, diques y vertederos, brecha, cauces, zonas erosionables, estaciones de aforo, zonas expuestas y edificios). Indica de dónde viene cada valor (ejemplo, formulario, editado o por defecto) y lista los **datos faltantes**. Las geometrías se editan pegando coordenadas `[lon, lat]` (GPS/SIG) o dibujándolas en el mapa. El escenario editado se aplica, se simula, se descarga como JSON o se **guarda como escenario nuevo** (★ en la lista; el original no se modifica).
- **Edificios de GlobalBuildingAtlas** (GBA LoD1, Zhu et al. 2025, TUM): huellas y alturas por edificio, leídas solo para la zona de cálculo desde la versión GeoParquet de [Source Cooperative](https://source.coop/tge-labs/globalbuildingatlas-lod1) y guardadas en `cache/buildings/`. Se pueden usar para completar alturas de los edificios del ejemplo, sumar edificios faltantes o reemplazarlos. GBA no tiene alturas en toda la Patagonia (en El Chaltén las huellas vienen sin altura).
- **Planilla de campo de edificios (CSV)**: exportar, completar en campo (altura, pisos, uso, estructura, notas) y volver a importar. Cada fila se asocia por `id` o al edificio más cercano (≤ 15 m), o se agrega como nuevo. La altura de campo tiene prioridad sobre GBA. Con alturas conocidas, el impacto informa cuántos edificios tienen un flujo más profundo que la mitad o que toda su altura.

Detalles del modelo y verificación: [docs/MODEL.md](docs/MODEL.md).

## Importante

El solver MPM está **verificado** contra soluciones analíticas simples (`python -m backend.validation`), pero **NO está validado ni calibrado** contra eventos reales, y no sustituye RAMMS, DAN3D, r.avaflow, OpenFOAM, MPM científico u otros modelos calibrados. Sirve para explorar escenarios. No debe usarse para alertas, evacuaciones, diseño de obra o zonificación oficial.

## Requisitos

- Python 3.11+ recomendado (Taichi 1.7 soporta hasta 3.12)
- GPU opcional: Metal (macOS), CUDA o Vulkan. Sin GPU se usa la CPU
- Conexión a Internet para mapas base / librerías JS y OpenTopography

## Arranque rápido (macOS/Linux)

```bash
cd suriyaco_massflow3d
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app:app --reload --port 8000
```

En otra terminal:

```bash
cd suriyaco_massflow3d/frontend
python3 -m http.server 8080
```

Abrir: `http://127.0.0.1:8080`

El modo `SYNTHETIC` funciona sin API Key.

## OpenTopography

Configurá la clave solo en el backend:

```bash
export OPENTOPOGRAPHY_API_KEY="TU_CLAVE"
uvicorn backend.app:app --reload --port 8000
```

Nunca incrustes una clave personal en el frontend. Para integración comercial/multiusuario, verificá las condiciones vigentes de OpenTopography y su modalidad Enterprise.

## API

- `GET /api/health`, `GET /api/datasets`, `GET /api/capabilities`
- `POST /api/dem/download`
- `POST /api/buildings/gba` (body: bbox) → edificios de GlobalBuildingAtlas `{buildings: [{lon, lat, area, height, source}], count, with_height}`
- `POST /api/examples` (body: `{example}`) → guarda un escenario editado en `frontend/examples/` y lo agrega a `index.json`
- `POST /api/basins` (mismo body que `/api/simulate`, con `storm`, `basins`, `soil`, `debris`) → cuencas y subcuencas con sus polígonos, red de drenaje, morfometría e hidrología SCS de la tormenta. `?storm=false` devuelve solo la delineación. El análisis del terreno queda en memoria: cambiar umbrales, salidas o la tormenta no lo recalcula.
- `POST /api/simulate` → crea un job: `{id, status, ...}`. `engine`: `mpm`, `particles` o `flood` (inundación por lluvia, `duration_s` hasta 48 h).
- `GET /api/jobs/{id}` → estado y progreso · `DELETE /api/jobs/{id}` → cancelar
- `GET /api/jobs/{id}/result` → metadatos y resumen (JSON) · `GET /api/jobs/{id}/data.bin` → cuadros y campos (binario)
- `GET /api/library` → análisis guardados y proyectos · `GET /api/library/{id}` → nombre, proyecto, notas, parámetros y escenario del frontend
- `PATCH /api/library/{id}` (body: `{name, project, notes}`) · `DELETE /api/library/{id}`
- `GET /api/library/{id}/result`, `/data.bin` y `/field/{campo}` (un campo float32 ny × nx, para informes y comparaciones)
- Swagger: `http://127.0.0.1:8000/docs` (lista todos los parámetros con sus rangos)

### Ejemplo /api/simulate

```json
{
  "bbox": {"west": -66.96, "south": -29.41, "east": -66.89, "north": -29.34},
  "dataset": "SYNTHETIC",
  "engine": "mpm",
  "device": "auto",
  "release_polygon": [[-66.93, -29.366], [-66.925, -29.366], [-66.925, -29.371], [-66.93, -29.371]],
  "release_mode": "volume",
  "release_volume_m3": 1500000,
  "friction_angle_deg": 32,
  "basal_friction_deg": 16,
  "saturation": 0.6,
  "erodible_depth_m": 2,
  "dx": 20,
  "duration_s": 120
}
```

### Ejemplo /api/simulate · inundación por lluvia

```json
{
  "bbox": {"west": -66.96, "south": -29.41, "east": -66.89, "north": -29.34},
  "dataset": "SYNTHETIC",
  "engine": "flood",
  "dx": 30,
  "duration_s": 14400,
  "storm": {"rain_mm": 60, "duration_h": 2, "pattern": "adelantado", "cn": 82, "amc": "II"},
  "basins": {"mode": "edge", "subbasin_area_km2": 1, "selected": [[-66.920725, -29.41]]},
  "debris": {"channel_erodible_m": 1.5, "grain_size_m": 0.1},
  "flood": {"boulders": 1500, "trees_per_km": 40}
}
```

## Próxima etapa científica recomendada

Hecho en v0.2: área de rotura, volumen y espesor variables, erosión y deposición, presión de poros y MPM 3D en CPU/GPU.

1. Importación de inventarios de deslizamientos y de mapas de espesor o de lecho erosionable (GeoTIFF/GeoJSON).
2. Reologías adicionales: μ(I), Voellmy-Salm, Bingham/Herschel-Bulkley, cohesión.
3. MPM bifásico (sólido + agua con drenaje real) y consolidación.
4. Calibración contra eventos históricos argentinos y métricas runout/área/tiempo de llegada.
5. Mapas de intensidad, profundidad, velocidad, presión dinámica y tiempo de llegada.
6. Exportación GeoTIFF/GeoJSON/KML y reportes reproducibles.

## Proyectos, zonas de afectación, informes y comparaciones

- **Proyectos y biblioteca.** Cada simulación que termina se guarda en `cache/library/<id>/` con el nombre, el proyecto y las notas de la sección «Proyecto y análisis». Desde la biblioteca se reabre sin recalcular (resultados, edificios y parámetros en el formulario), se renombra, se mueve de proyecto o se elimina. Los resultados que estaban en `cache/jobs/` de versiones anteriores se importan solos al proyecto «Análisis anteriores».
- **Zonas de afectación.** Al terminar el cálculo, las áreas alcanzadas se agrupan en polígonos por intensidad (alta / media / baja) y continuidad, ordenados por criticidad (crítica, alta, media, baja). Al tocar una zona en el mapa se ve su detalle y la lista de edificios afectados con su grado de daño (leve, moderado, grave, destrucción probable: intensidad alta con presión dinámica ≥ 35 kPa o flujo más alto que el edificio). Los edificios también se pueden tocar uno por uno.
- **Informe.** Documento completo con portada, resumen ejecutivo, parámetros, mapas sobre imagen satelital (intensidad y zonas, profundidad, velocidad, presión, arribo, erosión/depósito o Cv), vista 3D, zonas con acercamientos, gráficos, listado de edificios, hidrogramas y metodología. Se imprime o guarda como PDF, o se descarga como HTML.
- **Comparación.** Con dos o más análisis marcados: indicadores lado a lado (el más y el menos desfavorable resaltados), gráficos, mapas con la misma extensión, envolvente de intensidad, coincidencia entre escenarios, edificios afectados en cada uno y los parámetros que cambian.

## Despliegue en Render.com

El repo incluye `render.yaml` (Blueprint): un único Web Service que sirve la API y el frontend desde el mismo origen.

1. En Render: **New → Blueprint** y elegir este repositorio.
2. Cargar la variable `OPENTOPOGRAPHY_API_KEY` cuando la pida (no se guarda en el repo).
3. Abrir la URL del servicio: el frontend está en `/`, la API en `/api/...` y la documentación en `/docs`.

Notas: Render no tiene GPU, así que Taichi corre en CPU. El directorio `cache/` (DEM, edificios, biblioteca de análisis) y los ejemplos guardados desde el editor son efímeros: se pierden en cada redeploy salvo que se agregue un Persistent Disk.
