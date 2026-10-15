# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
from __future__ import annotations

import multiprocessing as mp
import os
from importlib import metadata
import queue
import shutil
import threading
import json
import re
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Literal

import numpy as np

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import buildings, dem, localdem
from .library import Library
from .worker import run_job

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "cache"
EXAMPLES = ROOT / "frontend" / "examples"
JOBS = CACHE / "jobs"  # versiones anteriores: se importan a la biblioteca al iniciar
library = Library(CACHE / "library")

AUTHOR = "Alfredo Toledo · SuriyacoValley · La Rioja, Argentina"
app = FastAPI(title="Suriyaco MassFlow 3D", version="0.2.0", description=f"Simulador de movimientos de masa e inundaciones. Desarrollado por {AUTHOR}.",
              contact={"name": AUTHOR, "url": "https://github.com/suriyaco82/simuladorAlud"},
              license_info={"name": "AGPL-3.0-or-later", "url": "https://www.gnu.org/licenses/agpl-3.0.html"})
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=4096)


class BBox(BaseModel):
    west: float
    south: float
    east: float
    north: float


class DemRequest(BaseModel):
    bbox: BBox
    dataset: str = "COP30"


class ExposureZone(BaseModel):
    name: str = "Zona expuesta"
    polygon: list[tuple[float, float]] = Field(..., description="[[lon, lat], ...]")
    erodible: bool = Field(False, description="False: el lecho no se erosiona dentro de la zona (suelo urbano)")


class RainTrigger(BaseModel):
    """Deslizamiento superficial disparado por lluvia acumulada (talud infinito + SHALSTAB)."""
    rain_mm: float = Field(150.0, ge=0, le=3000, description="Lluvia acumulada en el período (mm)")
    days: float = Field(3.0, gt=0, le=60, description="Duración del período de lluvia (días)")
    melt_mm: float = Field(0.0, ge=0, le=2000, description="Aporte de deshielo en el período (mm de agua)")
    infiltration: float = Field(0.7, ge=0.05, le=1, description="Fracción de la lluvia que se infiltra (0–1)")
    soil_depth_m: float = Field(6.0, gt=0.3, le=50, description="Espesor del suelo/morena sobre la superficie de rotura (m)")
    transmissivity_m2_day: float = Field(20.0, gt=0.1, le=1000, description="Transmisividad del suelo saturado (m²/día)")
    cohesion_kpa: float = Field(5.0, ge=0, le=200, description="Cohesión efectiva c' (kPa), incluye raíces")
    friction_angle_deg: float = Field(35.0, ge=10, le=50, description="Ángulo de fricción φ' del suelo para la estabilidad (°)")
    initial_saturation: float = Field(0.3, ge=0, le=1, description="Saturación del suelo no saturado antes de la lluvia")
    porosity: float | None = Field(None, ge=0.05, le=0.7, description="Porosidad del suelo (vacío = la del material)")
    min_slope_deg: float = Field(15.0, ge=0, le=60, description="Pendiente mínima con suelo inestable (°)")
    max_slope_deg: float = Field(50.0, ge=20, le=90, description="Pendiente máxima con cobertura de suelo; más empinado es roca (°)")
    channel_area_m2: float = Field(20000.0, ge=500, le=1e7, description="Área de aporte a partir de la cual una celda es cauce y no ladera (m²)")
    min_cells: int = Field(3, ge=1, le=200, description="Tamaño mínimo de un deslizamiento (celdas conectadas)")


class Body(BaseModel):
    name: str = "Cuerpo"
    kind: Literal["granular", "water"] = "granular"
    polygon: list[tuple[float, float]]
    release_mode: Literal["thickness", "volume"] = "thickness"
    thickness_m: float = Field(10.0, gt=0.1, le=500)
    volume_m3: float | None = Field(None, gt=0)
    profile: Literal["uniform", "dome"] = "dome"
    density: float | None = Field(None, ge=800, le=3200)
    friction_angle_deg: float | None = Field(None, ge=1, le=50)
    basal_friction_deg: float | None = Field(None, ge=0.5, le=45)
    pore_ratio_initial: float | None = Field(None, ge=0, le=0.95)
    turbulence_xi: float | None = Field(None, ge=0, le=10000, description="Voellmy ξ propio (m/s²)")
    rain: RainTrigger | None = Field(None, description="Si se define, el polígono es la zona de búsqueda y el volumen lo da la lluvia")


class Lake(BaseModel):
    polygon: list[tuple[float, float]]
    level_m: float


class Channel(BaseModel):
    line: list[tuple[float, float]] = Field(..., description="Polilínea [[lon, lat], ...] en sentido aguas abajo")
    width_m: float = Field(40.0, gt=1, le=1000)
    depth_m: float = Field(0.0, ge=0, le=50)


class Breach(BaseModel):
    line: list[tuple[float, float]] = Field(..., description="Eje de la brecha [[lon, lat], ...], desde el lago hacia aguas abajo")
    width_m: float = Field(100.0, gt=5, le=2000)
    depth_m: float = Field(..., gt=0, le=200, description="Profundidad al inicio del eje (disminuye hasta 0 al final)")
    start_s: float = Field(0.0, ge=0)
    duration_s: float = Field(600.0, gt=0, le=36000)
    target_m: float | None = Field(None, description="Cota final absoluta del fondo de la brecha (rotura de muro)")


class Spillway(BaseModel):
    from_frac: float = Field(..., ge=0, le=1)
    to_frac: float = Field(..., ge=0, le=1)
    crest_m: float


class Dam(BaseModel):
    name: str = "Paredón"
    line: list[tuple[float, float]] = Field(..., description="Eje del muro [[lon, lat], ...] de estribo a estribo")
    crest_m: float = Field(..., description="Cota de coronamiento (m s.n.m.)")
    width_m: float = Field(20.0, gt=1, le=500)
    spillways: list[Spillway] | None = None


class Gauge(BaseModel):
    name: str
    section: list[tuple[float, float]] = Field(..., min_length=2, max_length=2, description="Sección transversal [[lon, lat], [lon, lat]]")


class ErodibleZone(BaseModel):
    name: str = "Zona erosionable"
    polygon: list[tuple[float, float]]
    depth_m: float = Field(..., ge=0, le=100)


class Storm(BaseModel):
    """Tormenta de diseño para el motor de inundación por lluvia."""
    rain_mm: float = Field(60.0, ge=0, le=1500, description="Lluvia total de la tormenta (mm, puntual)")
    duration_h: float = Field(3.0, gt=0.05, le=240, description="Duración de la tormenta (h); en llanura, lluvias de varios días")
    pattern: Literal["uniforme", "adelantado", "centrado", "atrasado", "bloques"] = Field(
        "adelantado", description="Forma del hietograma")
    cn: float = Field(80.0, ge=30, le=99, description="Número de curva SCS (condición de humedad II)")
    amc: Literal["I", "II", "III"] = Field("II", description="Humedad antecedente: I seca · II normal · III húmeda")
    ia_ratio: float = Field(0.2, ge=0.01, le=0.3, description="Abstracción inicial Ia/S")
    areal_reduction: bool = Field(True, description="Reducir la lluvia puntual según el área de la cuenca (Témez)")


class Soil(BaseModel):
    """Suelo de ladera para los deslizamientos superficiales (SHALSTAB). Vacío = valores por defecto de hydro.py."""
    soil_depth_m: float | None = Field(None, gt=0.1, le=20)
    transmissivity_m2_day: float | None = Field(None, gt=0.1, le=1000)
    cohesion_kpa: float | None = Field(None, ge=0, le=200)
    friction_angle_deg: float | None = Field(None, ge=10, le=50)
    infiltration: float | None = Field(None, ge=0.05, le=1)
    porosity: float | None = Field(None, ge=0.05, le=0.7)
    min_slope_deg: float | None = Field(None, ge=0, le=60)
    max_slope_deg: float | None = Field(None, ge=20, le=90)
    channel_area_m2: float | None = Field(None, ge=500, le=1e7)


class Debris(BaseModel):
    """Disparo y propagación de flujos de detritos en los cauces."""
    channel_erodible_m: float | None = Field(None, ge=0, le=20, description="Espesor erosionable del lecho de los cauces (m)")
    channel_area_km2: float | None = Field(None, gt=0, le=100, description="Área de aporte a partir de la cual hay cauce (km²)")
    grain_size_m: float | None = Field(None, gt=0.001, le=2, description="Diámetro medio del lecho (m), umbral de Gregoretti")
    debris_friction_deg: float | None = Field(None, ge=20, le=45, description="Fricción del material del lecho (°), Takahashi")
    bed_porosity: float | None = Field(None, ge=0.1, le=0.6)
    deposition_slope_deg: float | None = Field(None, ge=1, le=25, description="Pendiente bajo la cual el flujo deposita (°)")
    trigger_min_slope_deg: float | None = Field(None, ge=1, le=45, description="Pendiente mínima de disparo en el cauce (°)")
    wave_celerity_m_s: float | None = Field(None, gt=0.1, le=20, description="Celeridad para el tránsito entre subcuencas (m/s)")


class FloodOptions(BaseModel):
    """Parámetros numéricos y de rugosidad del modelo 2D de inundación."""
    max_cells: int | None = Field(None, ge=10_000, le=3_000_000, description="Presupuesto de celdas (aumenta dx si se supera)")
    manning_channel: float | None = Field(None, gt=0.005, le=0.3)
    manning_hillslope: float | None = Field(None, gt=0.005, le=0.5)
    manning_urban: float | None = Field(None, gt=0.005, le=0.3)
    cn_urban: float | None = Field(None, ge=30, le=99)
    entrainment_coeff: float | None = Field(None, ge=0, le=0.1)
    critical_velocity: float | None = Field(None, ge=0, le=10)
    hillslope_erodible_m: float | None = Field(None, ge=0, le=2)
    landslides: bool | None = None
    subgrid_channels: bool | None = None
    boulders: int | None = Field(None, ge=0, le=20000)
    boulder_dmin_m: float | None = Field(None, gt=0.05, le=5)
    boulder_dmax_m: float | None = Field(None, gt=0.1, le=10)
    trees_per_km: float | None = Field(None, ge=0, le=1000)
    max_trees: int | None = Field(None, ge=0, le=20000)
    auto_gauges: int | None = Field(None, ge=0, le=60, description="Estaciones automáticas en salidas de cuencas y subcuencas")
    rain_outside: bool | None = Field(None, description="Llover también fuera de las cuencas elegidas")
    theta: float | None = Field(None, ge=0.5, le=1)
    froude_max: float | None = Field(None, gt=0.3, le=5)
    depressions: Literal["carve", "keep", "shallow"] | None = Field(
        None, description="Depresiones del DEM: carve abre salida (montaña, por defecto) · keep conserva bajos y lagunas "
                          "(llanura) · shallow rellena solo las de menos de pit_depth_m")
    pit_depth_m: float | None = Field(None, gt=0, le=20, description="Profundidad máxima de las depresiones que se rellenan (shallow)")
    dt_max: float | None = Field(None, ge=1, le=60, description="Paso de tiempo máximo (s); más alto acelera simulaciones de días")


class Infiltration(BaseModel):
    """Infiltración continua (Green-Ampt) sobre el agua en superficie, con saturación del suelo hasta la napa."""
    method: Literal["scs", "green_ampt"] = Field("scs", description="scs: SCS-CN sobre la lluvia (como antes) · green_ampt: continua")
    texture: str | None = Field(None, description="Textura del suelo (Rawls et al. 1983): arena … arcilla")
    ks_mm_h: float | None = Field(None, gt=0, le=500, description="Conductividad saturada (mm/h); vacío = la de la textura")
    suction_mm: float | None = Field(None, gt=0, le=2000, description="Succión en el frente de humedecimiento (mm)")
    porosity: float | None = Field(None, gt=0.05, le=0.7, description="Porosidad efectiva")
    initial_saturation: float | None = Field(None, ge=0, le=1, description="Saturación inicial del suelo (0 seco – 1 saturado)")
    water_table_m: float | None = Field(None, gt=0, le=50, description="Profundidad de la napa (m); vacío = sin límite")
    evaporation_mm_day: float | None = Field(None, ge=0, le=20, description="Evaporación del agua encharcada (mm/día)")


class Inflow(BaseModel):
    name: str | None = None
    section: list[tuple[float, float]] = Field(..., min_length=2, description="Sección de entrada [[lon, lat], [lon, lat]] a través del cauce o del valle")
    hydrograph: list[tuple[float, float]] = Field(..., min_length=2, description="[[t (h), Q (m³/s)], ...]")
    cv: float | None = Field(None, ge=0, le=0.5, description="Concentración de sedimento del agua que entra")


class RoadItem(BaseModel):
    id: int | str | None = None
    cls: str
    name: str | None = None
    bridge: bool = False
    line: list[tuple[float, float]] = Field(..., min_length=2)


class Culvert(BaseModel):
    point: tuple[float, float]
    diameter_m: float = Field(1.0, gt=0.1, le=10)
    count: int = Field(1, ge=1, le=50)
    name: str | None = None


class Roads(BaseModel):
    items: list[RoadItem] | None = None
    classes: dict[str, dict] | None = Field(None, description="Por categoría: embankment_m, width_m, include")
    culverts: list[Culvert] | None = None


class LanduseZone(BaseModel):
    name: str | None = None
    cls: str
    polygon: list[tuple[float, float]] = Field(..., min_length=3)


class Landuse(BaseModel):
    worldcover: bool = Field(False, description="Usar ESA WorldCover 10 m donde no hay polígonos")
    polygons: list[LanduseZone] | None = None
    classes: dict[str, dict] | None = Field(None, description="Por clase: cn, manning, ks_factor")


class Outlet(BaseModel):
    lon: float
    lat: float
    name: str | None = None


class BasinOptions(BaseModel):
    mode: Literal["edge", "outlets", "target"] = Field(
        "edge", description="Salidas: borde de la zona · puntos marcados · entradas de cauces a la zona urbana")
    stream_area_km2: float = Field(0.5, gt=0, le=1000, description="Área mínima para dibujar un cauce (km²)")
    subbasin_area_km2: float = Field(5.0, gt=0, le=10000, description="Subcuenca en cada confluencia de cauces mayores que esto (km²)")
    min_basin_area_km2: float = Field(2.0, gt=0, le=10000, description="Área mínima de una cuenca principal (km²)")
    snap_radius_m: float = Field(300.0, ge=0, le=5000, description="Radio para llevar cada salida al cauce más cercano (m)")
    outlets: list[Outlet] | None = None
    target_polygon: list[tuple[float, float]] | None = None
    target_name: str | None = None
    selected: list[tuple[float, float]] | None = Field(
        None, description="Salidas [lon, lat] de las cuencas principales a simular (de /api/basins); vacío = todas")


class SimRequest(BaseModel):
    bbox: BBox = Field(default_factory=lambda: BBox(west=-66.96, south=-29.41, east=-66.89, north=-29.34))
    dataset: str = "SYNTHETIC"
    dem_fallback: bool = Field(True, description="Si OpenTopography falla, usar AWS Terrain Tiles")
    engine: Literal["mpm", "particles", "flood"] = Field("mpm", description="mpm · particles · flood (inundación por lluvia en cuencas)")
    device: Literal["auto", "gpu", "cpu"] = "auto"
    # desprendimiento
    release_polygon: list[tuple[float, float]] | None = Field(None, description="[[lon, lat], ...]")
    source_lon: float | None = None
    source_lat: float | None = None
    release_radius_m: float = Field(200.0, gt=5, le=5000)
    release_mode: Literal["thickness", "volume"] = "thickness"
    release_thickness_m: float = Field(20.0, gt=0.1, le=500)
    release_volume_m3: float | None = Field(None, gt=0)
    thickness_profile: Literal["uniform", "dome"] = "dome"
    # material
    density_solid: float = Field(2650.0, ge=1500, le=3200)
    porosity: float = Field(0.35, ge=0.05, le=0.7)
    friction_angle_deg: float = Field(32.0, ge=5, le=50)
    basal_friction_deg: float = Field(16.0, ge=1, le=45)
    viscosity_pa_s: float = Field(50.0, ge=0, le=20000)
    young_modulus: float = Field(2e7, ge=1e5, le=1e9)
    # agua / presión de poros
    saturation: float = Field(0.5, ge=0, le=1)
    pore_ratio_initial: float | None = Field(None, ge=0, le=0.95, description="None = hidrostático")
    pore_diffusion_time_s: float = Field(60.0, gt=0, le=1e5)
    pore_generation: float = Field(2.0, ge=0, le=50)
    # erosión / deposición
    erodible_depth_m: float = Field(0.0, ge=0, le=50)
    entrainment_coeff: float = Field(0.004, ge=0, le=0.1, description="E_s (1/m)")
    critical_velocity: float = Field(1.0, ge=0, le=50)
    entrained_as: Literal["granular", "suspension"] = Field("granular", description="Material erosionado: granular o en suspensión (limos finos)")
    suspension_density: float = Field(1600.0, ge=1000, le=2200, description="Densidad del flujo hiperconcentrado (kg/m³)")
    # numérica
    dx: float = Field(25.0, ge=1, le=500)
    ppc: int = Field(3, ge=1, le=5)
    duration_s: float = Field(120.0, gt=1, le=864000, description="Tiempo simulado (s); MPM y partículas hasta 10800, inundación hasta 10 días")
    max_frames: int = Field(180, ge=10, le=400)
    display_particles: int = Field(30000, ge=500, le=200000)
    max_particles: int = Field(600000, ge=1000, le=5000000)
    random_seed: int = 42
    # escenarios en cascada (glaciar → lago → río)
    bodies: list[Body] | None = None
    lakes: list[Lake] | None = None
    burn_channels: list[Channel] | None = None
    erodible_zones: list[ErodibleZone] | None = None
    breach: Breach | None = None
    dams: list[Dam] | None = None
    gauges: list[Gauge] | None = None
    water_bulk_modulus: float = Field(4e6, ge=1e5, le=1e9, description="Módulo volumétrico del agua (Pa), reducido")
    water_viscosity_pa_s: float = Field(5.0, ge=0, le=1000)
    turbulence_xi: float = Field(0.0, ge=0, le=10000, description="Voellmy ξ (m/s²); 0 = sin resistencia turbulenta")
    # biblioteca: nombre y proyecto con que se guarda el análisis
    project: str | None = Field(None, max_length=120)
    analysis_name: str | None = Field(None, max_length=160)
    analysis_notes: str | None = Field(None, max_length=4000)
    ui: dict | None = Field(None, description="Escenario del frontend (edificios, vista) para reabrir el análisis")
    # exposición (análisis de impacto)
    scenario_name: str | None = None
    exposure: list[ExposureZone] | None = None
    exposure_points: list[tuple[float, float]] | None = Field(None, description="Elementos expuestos (p. ej. edificios): [[lon, lat], ...]")
    exposure_heights: list[float | None] | None = Field(None, description="Altura (m) de cada elemento expuesto, en el mismo orden; None = sin dato")
    # inundación por lluvia en cuencas (engine = "flood")
    storm: Storm | None = None
    soil: Soil | None = None
    debris: Debris | None = None
    flood: FloodOptions | None = None
    basins: BasinOptions | None = None
    infiltration: Infiltration | None = None
    inflows: list[Inflow] | None = None
    roads: Roads | None = None
    landuse: Landuse | None = None
    # solo motor de partículas
    damping: float = Field(0.985, ge=0.8, le=1.0)
    dt: float = Field(0.35, gt=0.05, le=2.0)


class JobManager:
    """Ejecuta simulaciones de a una por vez (GPU compartida), cada una en un proceso separado."""

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.pending: queue.Queue[str] = queue.Queue()
        self.ctx = mp.get_context("spawn")
        self.lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def submit(self, params: dict, ui: dict | None = None) -> str:
        jid = uuid.uuid4().hex[:12]
        d = library.root / jid
        d.mkdir(parents=True)
        library.save_request(d, params, ui)
        self.jobs[jid] = dict(id=jid, status="queued", stage="En cola", created=time.time(), params=params,
                              dir=str(d), proc=None, progress={})
        self.pending.put(jid)
        return jid

    def cancel(self, jid):
        job = self.jobs.get(jid)
        if not job:
            return False
        job["cancel"] = True
        proc = job.get("proc")
        if proc is not None and proc.is_alive():
            proc.terminate()
        if job["status"] in ("queued", "running"):
            job["status"] = "cancelled"
            job["stage"] = "Cancelada"
        return True

    def _loop(self):
        while True:
            jid = self.pending.get()
            job = self.jobs.get(jid)
            if not job or job.get("cancel"):
                continue
            self._cleanup()
            q = self.ctx.Queue()
            proc = self.ctx.Process(target=run_job, args=(job["dir"], job["params"], q), daemon=True)
            job.update(status="running", stage="Iniciando…", started=time.time(), proc=proc)
            proc.start()
            finished = False
            while not finished:
                try:
                    msg = q.get(timeout=0.5)
                except queue.Empty:
                    if not proc.is_alive():
                        if job["status"] == "running":
                            job.update(status="error", error="El proceso de simulación terminó inesperadamente "
                                                             f"(código {proc.exitcode}).")
                        finished = True
                    continue
                if msg["type"] == "progress":
                    if "stage" in msg:
                        job["stage"] = msg["stage"]
                    job["progress"].update({k: v for k, v in msg.items() if k not in ("type", "stage")})
                    if "t" in msg:
                        job["stage"] = "Simulando"
                elif msg["type"] == "done":
                    try:
                        library.finalize(Path(job["dir"]), created=job["created"])
                    except Exception as e:  # el resultado queda igual disponible por /api/jobs
                        job["library_error"] = str(e)
                    job.update(status="done", stage="Completada", finished=time.time())
                    finished = True
                elif msg["type"] == "error":
                    job.update(status="error", error=msg["error"], trace=msg.get("trace"), stage="Error")
                    finished = True
            proc.join(timeout=5)
            job["proc"] = None
            if job["status"] != "done":
                shutil.rmtree(job["dir"], ignore_errors=True)

    def _cleanup(self, keep=8):
        # los análisis terminados quedan en la biblioteca: acá solo se olvida el estado del job
        done = sorted((j for j in self.jobs.values() if j["status"] in ("done", "error", "cancelled")),
                      key=lambda j: j["created"])
        for j in done[:-keep]:
            if j["status"] != "done":
                shutil.rmtree(j["dir"], ignore_errors=True)
            self.jobs.pop(j["id"], None)

    def get(self, jid):
        return self.jobs.get(jid)

    def forget(self, jid):
        self.jobs.pop(jid, None)

    def public(self, jid):
        j = self.jobs.get(jid)
        if not j:
            raise HTTPException(404, "Job inexistente")
        p = j["params"]
        out = {k: j.get(k) for k in ("id", "status", "stage", "error", "progress")}
        out["duration_s"] = p["duration_s"]
        out["engine"] = p["engine"]
        if j.get("started"):
            out["elapsed_s"] = round((j.get("finished") or time.time()) - j["started"], 1)
        return out


class _LazyJobs:
    """Administrador de simulaciones, creado en el primer uso (con Passenger/WSGI no hay evento de arranque).

    SIMULADOR_JOBS=detached (cPanel): cada simulación en un proceso propio con el estado en disco (runner.py).
    Si no, en procesos hijos de este servidor con el estado en memoria (uvicorn, Render, uso local)."""
    _m = None
    _lock = threading.Lock()

    def __getattr__(self, name):
        if self._m is None:
            with self._lock:
                if self._m is None:
                    library.import_legacy(JOBS)
                    if os.environ.get("SIMULADOR_JOBS") == "detached":
                        from .runner import DetachedJobManager
                        type(self)._m = DetachedJobManager(library)
                    else:
                        type(self)._m = JobManager()
        return getattr(self._m, name)


jobs = _LazyJobs()


@app.get("/api/health")
def health():
    return {"ok": True, "service": "Suriyaco MassFlow 3D", "version": app.version, "author": AUTHOR,
            "license": "AGPL-3.0-or-later", "source": "https://github.com/suriyaco82/simuladorAlud"}


@app.get("/api/datasets")
def datasets():
    return {"datasets": ["SYNTHETIC", dem.TERRAIN_TILES] + dem.SUPPORTED, "opentopography_key_configured": bool(dem.api_key()),
            "local": localdem.list_all()}


# ───────────────────────────── DEM propios (MDE-Ar, LiDAR LAS/LAZ, GeoTIFF)
@app.post("/api/dem/upload")
def dem_upload(file: UploadFile = File(...), epsg: int | None = Form(None), res_m: float | None = Form(None),
               ground_only: bool = Form(True), name: str | None = Form(None)):
    """Carga un DEM propio: raster (GeoTIFF, IMG, ASC…) o nube LiDAR (LAS/LAZ, se rasteriza el terreno).
    Queda disponible como dataset «LOCAL:<id>»."""
    if res_m is not None and not 0.25 <= res_m <= 100:
        raise HTTPException(400, "res_m: entre 0,25 y 100 m")
    fname = Path(file.filename or "dem.tif").name
    tmp_dir = localdem.LOCAL_DIR / "upload"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / f"{uuid.uuid4().hex[:8]}{Path(fname).suffix.lower()}"
    try:
        with tmp.open("wb") as f:
            shutil.copyfileobj(file.file, f, length=8 << 20)
        return localdem.ingest(tmp, fname, epsg=epsg, res_m=res_m, ground_only=ground_only, name=name)
    except localdem.LocalDemError as e:
        raise HTTPException(400, str(e))
    finally:
        tmp.unlink(missing_ok=True)


@app.get("/api/dem/local")
def dem_local_list():
    return {"dems": localdem.list_all()}


@app.delete("/api/dem/local/{did}")
def dem_local_delete(did: str):
    try:
        localdem.delete(did)
    except localdem.LocalDemError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


# ───────────────────────────── Llanura: caminos de OSM y tablas por defecto
@app.post("/api/roads/osm")
def roads_osm(b: BBox):
    """Caminos, vías férreas, puentes y alcantarillas de OpenStreetMap dentro del bbox."""
    from . import roads
    if (b.east - b.west) > 1.0 or (b.north - b.south) > 1.0:
        raise HTTPException(400, "Zona demasiado grande (máx. 1° por lado)")
    try:
        return roads.fetch_osm(b.west, b.south, b.east, b.north)
    except roads.RoadsError as e:
        raise HTTPException(502, str(e))


@app.get("/api/plain/defaults")
def plain_defaults():
    """Tablas para el panel de llanura: texturas de suelo, clases de uso del suelo y de caminos."""
    from . import flood, landcover, roads
    return {"textures": flood.SOIL_TEXTURES, "landuse": landcover.CLASSES, "roads": roads.CLASSES,
            "road_thresholds": [dict(depth_m=t, key=k, name=n) for t, k, n in roads.THRESHOLDS]}


@app.get("/api/capabilities")
def capabilities():
    try:
        tv = metadata.version("taichi")
    except metadata.PackageNotFoundError:
        tv = None
    return {"engines": (["mpm", "particles"] if tv else ["particles"]) + ["flood"], "taichi": tv,
            "devices": ["auto", "gpu", "cpu"]}


@app.post("/api/dem/download")
def download_dem(req: DemRequest):
    b = req.bbox
    try:
        content = dem.fetch_opentopography(req.dataset, b.west, b.south, b.east, b.north)
    except dem.DemError as e:
        raise HTTPException(502, str(e))
    name = f"{req.dataset}_{uuid.uuid4().hex[:8]}.tif"
    path = CACHE / name
    path.write_bytes(content)
    return FileResponse(path, filename=name, media_type="image/tiff")


@app.post("/api/buildings/gba")
def buildings_gba(b: BBox):
    """Huellas y alturas de edificios de GlobalBuildingAtlas (LoD1) dentro del bbox."""
    try:
        return buildings.fetch_gba(b.west, b.south, b.east, b.north)
    except buildings.BuildingsError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # red, formato remoto
        raise HTTPException(502, f"GlobalBuildingAtlas no disponible: {e}")


class ExampleSave(BaseModel):
    example: dict


@app.post("/api/examples")
def save_example(req: ExampleSave):
    """Guarda un escenario editado (p. ej. con datos de campo) como ejemplo nuevo del frontend."""
    ex = req.example
    if not isinstance(ex.get("params"), dict) or not ex.get("title"):
        raise HTTPException(400, "El escenario necesita título y parámetros")
    SimRequest(**{k: v for k, v in ex["params"].items() if k in SimRequest.model_fields})  # valida
    base = unicodedata.normalize("NFKD", str(ex.get("id") or ex["title"])).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "_", base.lower()).strip("_")[:60].strip("_") or uuid.uuid4().hex[:8]
    index_path = EXAMPLES / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    entry = next((e for e in index if e["id"] == slug), None)
    if entry and not entry.get("custom"):
        raise HTTPException(409, "Ese identificador pertenece a un ejemplo original: usá otro nombre")
    ex["id"] = slug
    (EXAMPLES / f"{slug}.json").write_text(json.dumps(ex, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if entry:
        entry["title"] = ex["title"]
    else:
        index.append({"id": slug, "title": ex["title"], "file": f"{slug}.json", "custom": True})
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"id": slug, "file": f"{slug}.json"}


_dem_cache: dict = {}


@app.post("/api/trigger/preview")
def trigger_preview(req: SimRequest):
    """Vista previa del deslizamiento por lluvia: qué celdas fallan, volumen y lluvia crítica, sin simular."""
    from . import scenario
    p = req.model_dump()
    bodies = [(k, b) for k, b in enumerate(p.get("bodies") or []) if b.get("rain") and b.get("kind") != "water"]
    if not bodies:
        raise HTTPException(400, "El escenario no tiene un deslizamiento por lluvia")
    b = req.bbox
    key = (req.dataset, b.west, b.south, b.east, b.north)
    try:
        if key not in _dem_cache:
            _dem_cache.clear()
            _dem_cache[key] = dem.load_dem(req.dataset, b.model_dump(), max_dim=900, fallback=req.dem_fallback)
        arr, transform, info = _dem_cache[key]
    except dem.DemError as e:
        raise HTTPException(502, str(e))
    g = scenario.build_grid(arr, transform, b.model_dump(), float(req.dx))
    scenario.condition_terrain(g, p)
    fr = g["frame"]
    out = []
    for k, body in bodies:
        try:
            rf = scenario.rain_failure(g, g["H_pre"], body["polygon"], body["rain"], p)
        except ValueError as e:
            raise HTTPException(400, str(e))
        jj, ii = np.nonzero(rf["fail"])
        lon, lat = fr.to_lonlat(ii * g["dx"], jj * g["dx"])
        mj, mi = np.nonzero(rf["cand"] & ~rf["fail"] & (rf["FS"] < 1.2))
        mlon, mlat = fr.to_lonlat(mi * g["dx"], mj * g["dx"])
        out.append(dict(index=k, name=body.get("name"), info=rf["info"], dx=g["dx"],
                        cells=np.round(np.c_[lon, lat], 6).tolist(), marginal=np.round(np.c_[mlon, mlat], 6).tolist()))
    return {"bodies": out, "dem_source": info["source"]}


_terrain_cache: dict = {}


@app.post("/api/basins")
def basins(req: SimRequest, storm: bool = True):
    """Cuencas, subcuencas y red de drenaje sobre el DEM, con la hidrología SCS de la tormenta (sin simular en 2D).

    El análisis del terreno (relleno, direcciones de flujo, áreas) se guarda en memoria: cambiar los umbrales, las
    salidas o la tormenta no lo recalcula."""
    from . import flood, scenario
    b = req.bbox
    if b.east <= b.west or b.north <= b.south:
        raise HTTPException(400, "BBox inválido")
    if (b.east - b.west) > 1.0 or (b.north - b.south) > 1.0:
        raise HTTPException(400, "Zona de cálculo demasiado grande (máx. 1° por lado)")
    p = req.model_dump()
    p["bbox"] = b.model_dump()
    dx, _ = flood.flood_dx(p)
    key = json.dumps([req.dataset, p["bbox"], dx, p.get("flood"), p.get("lakes"), p.get("burn_channels"), p.get("dams"),
                      p.get("breach"), p.get("roads")], sort_keys=True, default=str)
    try:
        if key not in _terrain_cache:
            _terrain_cache.clear()
            _terrain_cache[key] = flood.prepare_terrain(p, lambda **kw: None)
        g, T, dem_info, notes, warnings = _terrain_cache[key]
        out = flood.basins_preview(g, T, p, with_storm=storm)
    except dem.DemError as e:
        raise HTTPException(502, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    out["warnings"] = warnings + out["warnings"]
    out["terrain_notes"] = notes
    out["dem_source"] = dem_info["source"]
    return Response(json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=scenario._json_default),
                    media_type="application/json")


@app.post("/api/simulate")
def simulate(req: SimRequest):
    b = req.bbox
    if b.east <= b.west or b.north <= b.south:
        raise HTTPException(400, "BBox inválido")
    if (b.east - b.west) > 1.0 or (b.north - b.south) > 1.0:
        raise HTTPException(400, "Zona de cálculo demasiado grande (máx. 1° por lado)")
    if req.engine == "mpm" and capabilities()["taichi"] is None:
        raise HTTPException(400, "Taichi no está instalado: pip install -r backend/requirements.txt")
    if req.engine != "flood" and req.duration_s > 10800:
        raise HTTPException(400, "duration_s: hasta 10800 s con los motores MPM y de partículas")
    params = req.model_dump(exclude={"ui"})
    params["bbox"] = b.model_dump()
    jid = jobs.submit(params, req.ui)
    return jobs.public(jid)


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    return jobs.public(jid)


@app.delete("/api/jobs/{jid}")
def job_cancel(jid: str):
    if not jobs.cancel(jid):
        raise HTTPException(404, "Job inexistente")
    try:
        return jobs.public(jid)
    except HTTPException:  # modo desacoplado: la carpeta del job cancelado ya se borró
        return {"id": jid, "status": "cancelled", "stage": "Cancelada", "error": None, "progress": {}}


def _job_file(jid, name):
    j = jobs.get(jid)
    if not j or library.exists(jid):
        if library.exists(jid):  # job de una sesión anterior del servidor: está en la biblioteca
            return library.dir(jid) / name
        raise HTTPException(404, "Job inexistente")
    if j["status"] != "done":
        raise HTTPException(409, f"Job en estado {j['status']}")
    return Path(j.get("dir") or library.root / jid) / name


@app.get("/api/jobs/{jid}/result")
def job_result(jid: str):
    return FileResponse(_job_file(jid, "result.json"), media_type="application/json")


@app.get("/api/jobs/{jid}/data.bin")
def job_data(jid: str):
    return FileResponse(_job_file(jid, "data.bin"), media_type="application/octet-stream")


# ───────────────────────────── Biblioteca de análisis
def _lib(aid):
    if not library.exists(aid):
        raise HTTPException(404, "Análisis inexistente")
    return aid


@app.get("/api/library")
def library_list():
    es = library.entries()
    return {"analyses": es, "projects": sorted({e["project"] for e in es}, key=str.lower)}


@app.get("/api/library/{aid}")
def library_get(aid: str):
    return library.get(_lib(aid))


class LibraryPatch(BaseModel):
    name: str | None = Field(None, max_length=160)
    project: str | None = Field(None, max_length=120)
    notes: str | None = Field(None, max_length=4000)


@app.patch("/api/library/{aid}")
def library_patch(aid: str, req: LibraryPatch):
    return library.update(_lib(aid), **req.model_dump())


@app.delete("/api/library/{aid}")
def library_delete(aid: str):
    j = jobs.get(aid)
    if j and j["status"] in ("queued", "running"):
        raise HTTPException(409, "El análisis todavía se está calculando")
    library.delete(_lib(aid))
    if j:
        jobs.forget(aid)
    return {"ok": True}


@app.get("/api/library/{aid}/result")
def library_result(aid: str):
    _lib(aid)
    try:
        library.ensure_impact(aid)  # resultados anteriores a las zonas de afectación
    except Exception as e:
        print(f"[biblioteca] no se pudieron calcular las zonas de {aid}: {e}")
    return FileResponse(library.dir(aid) / "result.json", media_type="application/json")


@app.get("/api/library/{aid}/data.bin")
def library_data(aid: str):
    return FileResponse(library.dir(_lib(aid)) / "data.bin", media_type="application/octet-stream")


@app.get("/api/library/{aid}/field/{name}")
def library_field(aid: str, name: str):
    """Un campo float32 (ny × nx) del resultado, sin descargar todo data.bin (informes y comparaciones)."""
    try:
        return Response(library.field_bytes(_lib(aid), name), media_type="application/octet-stream")
    except KeyError:
        raise HTTPException(404, f"El análisis no tiene el campo {name}")


# Frontend estático en "/" (montado al final para no tapar las rutas /api)
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
