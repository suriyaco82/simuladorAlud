# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Uso del suelo para el motor de inundación: CN, rugosidad de Manning y factor de infiltración por celda.

Fuentes, de menor a mayor prioridad:
- ESA WorldCover 10 m (2021, v200), leído por ventana desde el bucket público de AWS (sin credenciales) y guardado en
  cache/landcover/.
- Polígonos con una clase (dibujados o de un GeoJSON).

Valores por defecto orientativos: CN para condición de humedad II y suelos de los grupos hidrológicos B–C (USDA-NRCS
TR-55, 1986); Manning de llanura de inundación (Chow 1959; Arcement y Schneider 1989); el factor multiplica la
conductividad saturada de Green-Ampt (el monte infiltra más por los macroporos; el urbano casi nada).
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np

CLASSES = {
    "cultivo": dict(name="Cultivo / agrícola", cn=78, manning=0.06, ks_factor=1.0, color="#e9c46a"),
    "pastura": dict(name="Pastura / pastizal", cn=69, manning=0.045, ks_factor=0.8, color="#a7c957"),
    "monte": dict(name="Monte / bosque", cn=60, manning=0.12, ks_factor=1.5, color="#2d6a4f"),
    "arbustal": dict(name="Arbustal", cn=65, manning=0.08, ks_factor=1.2, color="#6a994e"),
    "desnudo": dict(name="Suelo desnudo", cn=86, manning=0.03, ks_factor=0.5, color="#c9ada7"),
    "urbano": dict(name="Urbano / construido", cn=92, manning=0.03, ks_factor=0.05, color="#9d0208"),
    "agua": dict(name="Agua / laguna", cn=99, manning=0.03, ks_factor=0.0, color="#0077b6"),
    "humedal": dict(name="Humedal / bañado", cn=88, manning=0.08, ks_factor=0.2, color="#48cae4"),
}
ORDER = list(CLASSES)
# códigos de ESA WorldCover → clase
WORLDCOVER = {10: "monte", 20: "arbustal", 30: "pastura", 40: "cultivo", 50: "urbano", 60: "desnudo", 70: "desnudo",
              80: "agua", 90: "humedal", 95: "humedal", 100: "pastura"}
WC_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
CACHE = Path(__file__).resolve().parents[1] / "cache" / "landcover"


def classes(overrides=None):
    """Tabla de clases con los valores editados por el usuario (cn, manning, ks_factor)."""
    out = {k: dict(v) for k, v in CLASSES.items()}
    for k, ov in (overrides or {}).items():
        if k in out and isinstance(ov, dict):
            out[k].update({a: float(b) for a, b in ov.items() if a in ("cn", "manning", "ks_factor") and b is not None})
    return out


def _wc_tiles(w, s, e, n):
    tiles = []
    for la in range(int(math.floor(s / 3) * 3), int(math.floor((n - 1e-9) / 3) * 3) + 1, 3):
        for lo in range(int(math.floor(w / 3) * 3), int(math.floor((e - 1e-9) / 3) * 3) + 1, 3):
            tiles.append(f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}")
    return tiles


def worldcover(lon, lat, bbox, progress=None):
    """Código WorldCover en cada punto (lon, lat). 0 = sin dato. Lee solo la ventana del bbox de cada tesela."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds
    w, s, e, n = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
    key = hashlib.sha1(f"{w:.5f}_{s:.5f}_{e:.5f}_{n:.5f}".encode()).hexdigest()[:14]
    path = CACHE / f"wc_{key}.npz"
    if path.exists():
        z = np.load(path)
        arr, tr = z["arr"], tuple(z["tr"])
    else:
        # ~10 m por píxel, hasta 4000 píxeles por lado (moda al reducir)
        W = int(min(4000, max(2, (e - w) / 8.33e-5)))
        H = int(min(4000, max(2, (n - s) / 8.33e-5)))
        arr = np.zeros((H, W), np.uint8)
        env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", GDAL_HTTP_TIMEOUT="60")
        got = 0
        with rasterio.Env(**env):
            for t in _wc_tiles(w, s, e, n):
                if progress:
                    progress(f"Descargando uso del suelo ESA WorldCover ({t})…")
                try:
                    with rasterio.open("/vsicurl/" + WC_URL.format(tile=t)) as src:
                        b = src.bounds
                        ww, ss, ee, nn = max(w, b.left), max(s, b.bottom), min(e, b.right), min(n, b.top)
                        if ee <= ww or nn <= ss:
                            continue
                        c0, c1 = int((ww - w) / (e - w) * W), int(math.ceil((ee - w) / (e - w) * W))
                        r0, r1 = int((n - nn) / (n - s) * H), int(math.ceil((n - ss) / (n - s) * H))
                        if c1 <= c0 or r1 <= r0:
                            continue
                        part = src.read(1, window=from_bounds(ww, ss, ee, nn, src.transform), out_shape=(r1 - r0, c1 - c0),
                                        resampling=Resampling.mode)
                        arr[r0:r1, c0:c1] = np.where(part > 0, part, arr[r0:r1, c0:c1])
                        got += 1
                except Exception:  # tesela inexistente (océano) o error de red
                    continue
        if not got:
            raise RuntimeError("ESA WorldCover no disponible para la zona (sin conexión o fuera de cobertura)")
        tr = (w, n, (e - w) / W, (n - s) / H)
        CACHE.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, arr=arr, tr=np.array(tr))
    x0, y0, rx, ry = tr
    H, W = arr.shape
    i = np.clip(((np.asarray(lon) - x0) / rx).astype(int), 0, W - 1)
    j = np.clip(((y0 - np.asarray(lat)) / ry).astype(int), 0, H - 1)
    return arr[j, i]


def grid(g, opts, progress=None):
    """Clase de uso del suelo en cada celda de la grilla. Devuelve dict(code (ny, nx) int8 con −1 = sin clase,
    table, notes, warnings) o None si no se pidió uso del suelo."""
    if not opts:
        return None
    from .scenario import zone_mask
    ny, nx, dx, fr = g["ny"], g["nx"], g["dx"], g["frame"]
    code = np.full((ny, nx), -1, np.int8)
    notes, warnings = [], []
    if opts.get("worldcover"):
        X, Y = np.meshgrid(np.arange(nx) * dx, np.arange(ny) * dx)
        lon, lat = fr.to_lonlat(X, Y)
        bbox = dict(west=fr.west, south=fr.south, east=fr.east, north=fr.north)
        try:
            wc = worldcover(lon, lat, bbox, progress)
            for c, k in WORLDCOVER.items():
                code[wc == c] = ORDER.index(k)
            notes.append("Uso del suelo: ESA WorldCover 10 m (2021)")
        except Exception as e:
            warnings.append(f"No se pudo leer ESA WorldCover ({e}): se usan los valores generales donde no hay polígonos")
    n_poly = 0
    for z in opts.get("polygons") or []:
        k = z.get("cls")
        if k not in CLASSES or len(z.get("polygon") or []) < 3:
            continue
        code[zone_mask(g, z["polygon"])] = ORDER.index(k)
        n_poly += 1
    if n_poly:
        notes.append(f"Uso del suelo: {n_poly} polígono{'s' if n_poly > 1 else ''} propio{'s' if n_poly > 1 else ''}")
    if (code < 0).all():
        return None
    return dict(code=code, table=classes(opts.get("classes")), notes=notes, warnings=warnings)


def per_cell(lu, key, default):
    """Arreglo (ny, nx) con el valor `key` de la clase de cada celda; `default` donde no hay clase."""
    vals = np.array([lu["table"][k][key] for k in ORDER], float)
    c = lu["code"]
    out = np.full(c.shape, default, float) if np.isscalar(default) else np.array(default, float, copy=True)
    m = c >= 0
    out[m] = vals[c[m]]
    return out


def report(lu, fields, dx):
    """Superficie de cada clase y cuánto se anegó (h > 0,1 m) y por cuánto tiempo."""
    if lu is None:
        return None
    A = dx * dx / 1e4  # ha
    h = fields["max_depth"]
    wt = fields.get("wet_time")
    rows = []
    for k_i, k in enumerate(ORDER):
        m = lu["code"] == k_i
        if not m.any():
            continue
        wet = m & (h > 0.1)
        r = dict(cls=k, name=lu["table"][k]["name"], color=CLASSES[k]["color"], area_ha=round(float(m.sum() * A), 1),
                 flooded_ha=round(float(wet.sum() * A), 1), deep_ha=round(float((m & (h > 0.5)).sum() * A), 1),
                 mean_depth_m=round(float(h[wet].mean()), 2) if wet.any() else 0.0)
        if wt is not None:
            r["over_24h_ha"] = round(float((m & (wt >= 86400)).sum() * A), 1)
            r["over_72h_ha"] = round(float((m & (wt >= 3 * 86400)).sum() * A), 1)
        r["flooded_pct"] = round(r["flooded_ha"] / r["area_ha"] * 100, 1) if r["area_ha"] else 0.0
        rows.append(r)
    return dict(classes=rows, criteria="Anegado: profundidad máxima > 0,1 m · profundo: > 0,5 m · duración: tiempo "
                                       "acumulado con más de 0,1 m de agua")
