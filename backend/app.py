from __future__ import annotations

import multiprocessing as mp
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

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import buildings, dem
from .worker import run_job

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "cache"
EXAMPLES = ROOT / "frontend" / "examples"
JOBS = CACHE / "jobs"
JOBS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Suriyaco MassFlow 3D", version="0.2.0")
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


class SimRequest(BaseModel):
    bbox: BBox = Field(default_factory=lambda: BBox(west=-66.96, south=-29.41, east=-66.89, north=-29.34))
    dataset: str = "SYNTHETIC"
    dem_fallback: bool = Field(True, description="Si OpenTopography falla, usar AWS Terrain Tiles")
    engine: Literal["mpm", "particles"] = "mpm"
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
    duration_s: float = Field(120.0, gt=1, le=10800)
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
    # exposición (análisis de impacto)
    scenario_name: str | None = None
    exposure: list[ExposureZone] | None = None
    exposure_points: list[tuple[float, float]] | None = Field(None, description="Elementos expuestos (p. ej. edificios): [[lon, lat], ...]")
    exposure_heights: list[float | None] | None = Field(None, description="Altura (m) de cada elemento expuesto, en el mismo orden; None = sin dato")
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

    def submit(self, params: dict) -> str:
        jid = uuid.uuid4().hex[:12]
        d = JOBS / jid
        d.mkdir(parents=True)
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
                    job.update(status="done", stage="Completada", finished=time.time())
                    finished = True
                elif msg["type"] == "error":
                    job.update(status="error", error=msg["error"], trace=msg.get("trace"), stage="Error")
                    finished = True
            proc.join(timeout=5)
            job["proc"] = None

    def _cleanup(self, keep=8):
        done = sorted((j for j in self.jobs.values() if j["status"] in ("done", "error", "cancelled")),
                      key=lambda j: j["created"])
        for j in done[:-keep]:
            shutil.rmtree(j["dir"], ignore_errors=True)
            self.jobs.pop(j["id"], None)

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


jobs: JobManager | None = None


@app.on_event("startup")
def _startup():
    global jobs
    jobs = JobManager()


@app.get("/api/health")
def health():
    return {"ok": True, "service": "Suriyaco MassFlow 3D", "version": app.version}


@app.get("/api/datasets")
def datasets():
    return {"datasets": ["SYNTHETIC", dem.TERRAIN_TILES] + dem.SUPPORTED, "opentopography_key_configured": bool(dem.api_key())}


@app.get("/api/capabilities")
def capabilities():
    try:
        tv = metadata.version("taichi")
    except metadata.PackageNotFoundError:
        tv = None
    return {"engines": ["mpm", "particles"] if tv else ["particles"], "taichi": tv, "devices": ["auto", "gpu", "cpu"]}


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
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    entry = next((e for e in index if e["id"] == slug), None)
    if entry and not entry.get("custom"):
        raise HTTPException(409, "Ese identificador pertenece a un ejemplo original: usá otro nombre")
    ex["id"] = slug
    (EXAMPLES / f"{slug}.json").write_text(json.dumps(ex, ensure_ascii=False, separators=(",", ":")))
    if entry:
        entry["title"] = ex["title"]
    else:
        index.append({"id": slug, "title": ex["title"], "file": f"{slug}.json", "custom": True})
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1))
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


@app.post("/api/simulate")
def simulate(req: SimRequest):
    b = req.bbox
    if b.east <= b.west or b.north <= b.south:
        raise HTTPException(400, "BBox inválido")
    if (b.east - b.west) > 1.0 or (b.north - b.south) > 1.0:
        raise HTTPException(400, "Zona de cálculo demasiado grande (máx. 1° por lado)")
    if req.engine == "mpm" and capabilities()["taichi"] is None:
        raise HTTPException(400, "Taichi no está instalado: pip install -r backend/requirements.txt")
    params = req.model_dump()
    params["bbox"] = b.model_dump()
    jid = jobs.submit(params)
    return jobs.public(jid)


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    return jobs.public(jid)


@app.delete("/api/jobs/{jid}")
def job_cancel(jid: str):
    if not jobs.cancel(jid):
        raise HTTPException(404, "Job inexistente")
    return jobs.public(jid)


def _job_file(jid, name):
    j = jobs.jobs.get(jid)
    if not j:
        raise HTTPException(404, "Job inexistente")
    if j["status"] != "done":
        raise HTTPException(409, f"Job en estado {j['status']}")
    return Path(j["dir"]) / name


@app.get("/api/jobs/{jid}/result")
def job_result(jid: str):
    return FileResponse(_job_file(jid, "result.json"), media_type="application/json")


@app.get("/api/jobs/{jid}/data.bin")
def job_data(jid: str):
    return FileResponse(_job_file(jid, "data.bin"), media_type="application/octet-stream")


@app.get("/")
def root():
    return {"message": "Suriyaco MassFlow 3D API", "docs": "/docs"}
