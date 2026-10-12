"""DEM: descarga (OpenTopography o AWS Terrain Tiles), caché, DEM sintético, muestreo bilineal y marco métrico local."""
from __future__ import annotations

import hashlib
import math
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from rasterio.enums import Resampling
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds

OT_URL = "https://portal.opentopography.org/API/globaldem"
SUPPORTED = ["COP30", "ANADEM", "NASADEM", "AW3D30", "SRTMGL1"]
ALIASES = {"SRTM_GL1": "SRTMGL1"}  # nombre usado en v0.1 (inválido para la API)
TERRAIN_TILES = "AWS_TERRAIN"
TILES_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
DEM_CACHE = Path(__file__).resolve().parents[1] / "cache" / "dem"


def _load_env(path=Path(__file__).resolve().parent / ".env"):
    """Variables de backend/.env (KEY=valor). No pisa las que ya vienen del entorno (p. ej. las de Render)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()


class DemError(RuntimeError):
    pass


def synthetic_dem(west, south, east, north, width=360, height=360):
    """Montaña + valle inciso SW->NE. Fila 0 = norte (coherente con el transform)."""
    xs = np.linspace(west, east, width)
    ys = np.linspace(north, south, height)
    X, Y = np.meshgrid(xs, ys)
    xn = (X - west) / max(1e-12, east - west)
    yn = (Y - south) / max(1e-12, north - south)
    base = 1300 + 1450 * (0.75 * yn + 0.25 * (1 - xn))
    ridge = 620 * np.exp(-(((xn - 0.28) / 0.20) ** 2 + ((yn - 0.72) / 0.23) ** 2))
    valley_axis = 0.15 + 0.60 * yn
    valley = -420 * np.exp(-((xn - valley_axis) / 0.055) ** 2)
    rough = 35 * np.sin(18 * xn) * np.sin(15 * yn)
    dem = base + ridge + valley + rough
    transform = from_bounds(west, south, east, north, width, height)
    return dem.astype("float32"), transform


def api_key():
    return os.getenv("OPENTOPOGRAPHY_API_KEY", "").strip()


def _redact(msg: str) -> str:
    key = api_key()
    return msg.replace(key, "***") if key else msg


def fetch_opentopography(dataset, west, south, east, north, retries=1, progress=None) -> bytes:
    dataset = ALIASES.get(dataset, dataset)
    if dataset not in SUPPORTED:
        raise DemError(f"Dataset no soportado: {dataset}")
    key = api_key()
    if not key:
        raise DemError("Falta OPENTOPOGRAPHY_API_KEY en el backend")
    params = dict(demtype=dataset, south=south, north=north, west=west, east=east,
                  outputFormat="GTiff", API_Key=key)
    last = None
    for attempt in range(retries + 1):
        if progress:
            progress(f"Descargando {dataset} de OpenTopography (intento {attempt + 1}/{retries + 1})…")
        try:
            r = requests.get(OT_URL, params=params, timeout=(10, 60))
            if r.status_code == 200 and r.content[:2] in (b"II", b"MM"):
                return r.content
            ctype = r.headers.get("content-type", "")
            detail = r.text[:200] if ("xml" in ctype or "text" in ctype) else ""
            last = f"HTTP {r.status_code} {detail}".strip()
            if 400 <= r.status_code < 500:
                break  # error del pedido (dataset, área o clave): no tiene sentido reintentar
        except requests.Timeout:
            last = "sin respuesta (tiempo de espera agotado)"
        except requests.RequestException as e:
            last = str(e)
        if attempt < retries:
            time.sleep(2 * (attempt + 1))
    raise DemError(f"OpenTopography ({dataset}) no respondió correctamente: {_redact(last or 'error desconocido')}.")


def _tile_elevation(z, x, y, retries=2):
    url = TILES_URL.format(z=z, x=x, y=y)
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, timeout=(10, 30))
            if r.status_code == 200:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", NotGeoreferencedWarning)
                    with MemoryFile(r.content) as mem, mem.open() as src:
                        a = src.read().astype(np.float32)
                return a[0] * 256 + a[1] + a[2] / 256 - 32768
            if r.status_code == 404:
                return None
        except requests.RequestException:
            pass
        time.sleep(1 + attempt)
    raise DemError(f"No se pudo descargar la tesela de elevación {z}/{x}/{y} de AWS Terrain Tiles")


def _merc_x(lon, z):
    return (np.asarray(lon, float) + 180) / 360 * 2 ** z


def _merc_y(lat, z):
    r = np.radians(np.asarray(lat, float))
    return (1 - np.log(np.tan(r) + 1 / np.cos(r)) / np.pi) / 2 * 2 ** z


def load_terrain_tiles(west, south, east, north, max_tiles=144):
    """DEM global sin API key: AWS Terrain Tiles (Terrarium; SRTM, GMTED, ETOPO y otros; ~30 m en tierra).

    Mosaico en Web Mercator remuestreado bilinealmente a una grilla regular lon/lat.
    """
    z = 12
    while True:
        x0, x1 = int(_merc_x(west, z)), int(_merc_x(east, z))
        y0, y1 = int(_merc_y(north, z)), int(_merc_y(south, z))
        if (x1 - x0 + 1) * (y1 - y0 + 1) <= max_tiles or z <= 6:
            break
        z -= 1
    coords = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    with ThreadPoolExecutor(12) as ex:
        tiles = list(ex.map(lambda c: _tile_elevation(z, *c), coords))
    if all(t is None for t in tiles):
        raise DemError("AWS Terrain Tiles: sin datos de elevación para la zona")
    W, H = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    mosaic = np.full((H, W), np.nan, np.float32)
    for (x, y), t in zip(coords, tiles):
        if t is not None:
            mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = t
    deg = 360 / (256 * 2 ** z)
    lat_mid = math.radians((south + north) / 2)
    out_w = max(2, int(math.ceil((east - west) / deg)))
    out_h = max(2, int(math.ceil((north - south) / (deg * math.cos(lat_mid)))))
    lons = west + (np.arange(out_w) + 0.5) * (east - west) / out_w
    lats = north - (np.arange(out_h) + 0.5) * (north - south) / out_h
    px = np.clip((_merc_x(lons, z) - x0) * 256 - 0.5, 0, W - 1.001)
    py = np.clip((_merc_y(lats, z) - y0) * 256 - 0.5, 0, H - 1.001)
    PX, PY = np.meshgrid(px, py)
    i0, j0 = PX.astype(int), PY.astype(int)
    fx, fy = PX - i0, PY - j0
    m = mosaic
    arr = ((m[j0, i0] * (1 - fx) + m[j0, i0 + 1] * fx) * (1 - fy) +
           (m[j0 + 1, i0] * (1 - fx) + m[j0 + 1, i0 + 1] * fx) * fy).astype(np.float32)
    return arr, from_bounds(west, south, east, north, out_w, out_h), z


def _cache_path(dataset, west, south, east, north):
    key = f"{dataset}_{west:.5f}_{south:.5f}_{east:.5f}_{north:.5f}"
    return DEM_CACHE / f"{dataset}_{hashlib.sha1(key.encode()).hexdigest()[:12]}.tif"


def _read_geotiff(content, max_dim):
    with MemoryFile(content) as mem:
        with mem.open() as src:
            scale = max(src.height, src.width) / max_dim
            if scale > 1:
                out_h = max(2, int(src.height / scale))
                out_w = max(2, int(src.width / scale))
                arr = src.read(1, out_shape=(out_h, out_w), resampling=Resampling.bilinear,
                               masked=True).filled(np.nan).astype("float32")
                transform = src.transform * src.transform.scale(src.width / out_w, src.height / out_h)
            else:
                arr = src.read(1, masked=True).filled(np.nan).astype("float32")
                transform = src.transform
    return arr, transform


def load_dem(dataset, bbox, max_dim=640, fallback=True, progress=None):
    """Devuelve (array float32 fila0=norte, affine transform en lon/lat, info).

    info = {source, cached, warning}. Las descargas de OpenTopography se guardan en cache/dem.
    Si OpenTopography falla y fallback=True, se usa AWS Terrain Tiles.
    """
    w, s, e, n = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
    dataset = ALIASES.get(dataset, dataset)
    info = dict(source=dataset, cached=False, warning=None)
    if dataset == "SYNTHETIC":
        arr, tr = synthetic_dem(w, s, e, n)
        return arr, tr, info
    content = None
    if dataset == TERRAIN_TILES:
        if progress:
            progress("Descargando teselas de AWS Terrain Tiles…")
        arr, tr, z = load_terrain_tiles(w, s, e, n)
        info["source"] = f"{TERRAIN_TILES} (z{z})"
    else:
        path = _cache_path(dataset, w, s, e, n)
        if path.exists():
            content = path.read_bytes()
            info["cached"] = True
        else:
            try:
                content = fetch_opentopography(dataset, w, s, e, n, progress=progress)
                DEM_CACHE.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            except DemError as err:
                if not fallback:
                    raise
                if progress:
                    progress("OpenTopography no responde: usando AWS Terrain Tiles…")
                arr, tr, z = load_terrain_tiles(w, s, e, n)
                info.update(source=f"{TERRAIN_TILES} (z{z})",
                            warning=f"{err} Se usó el DEM alternativo AWS Terrain Tiles (~30 m; SRTM y otros).")
        if content is not None:
            arr, tr = _read_geotiff(content, max_dim)
    if not np.isfinite(arr).any():
        raise DemError("DEM sin valores válidos")
    fill = float(np.nanmedian(arr))
    return np.nan_to_num(arr, nan=fill), tr, info


def sample_dem(arr, transform, lon, lat):
    """Interpolación bilineal sobre centros de píxel, con borde replicado."""
    inv = ~transform
    col, row = inv * (np.asarray(lon, float), np.asarray(lat, float))
    col = np.clip(col - 0.5, 0, arr.shape[1] - 1.000001)
    row = np.clip(row - 0.5, 0, arr.shape[0] - 1.000001)
    c0 = np.floor(col).astype(int)
    r0 = np.floor(row).astype(int)
    fc = col - c0
    fr = row - r0
    a = arr[r0, c0] * (1 - fc) + arr[r0, c0 + 1] * fc
    b = arr[r0 + 1, c0] * (1 - fc) + arr[r0 + 1, c0 + 1] * fc
    return a * (1 - fr) + b * fr


class LocalFrame:
    """Proyección equirectangular local (m) con origen en la esquina SO del BBox."""

    def __init__(self, bbox):
        self.west, self.south = bbox["west"], bbox["south"]
        self.east, self.north = bbox["east"], bbox["north"]
        midlat = (self.south + self.north) / 2
        self.mx = 111320.0 * max(0.1, math.cos(math.radians(midlat)))
        self.my = 110540.0
        self.Lx = (self.east - self.west) * self.mx
        self.Ly = (self.north - self.south) * self.my

    def to_xy(self, lon, lat):
        return (np.asarray(lon, float) - self.west) * self.mx, (np.asarray(lat, float) - self.south) * self.my

    def to_lonlat(self, x, y):
        return self.west + np.asarray(x, float) / self.mx, self.south + np.asarray(y, float) / self.my
