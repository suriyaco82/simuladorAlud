"""DEM propios: rasters (GeoTIFF, IMG, ASC… p. ej. MDE-Ar del IGN) y nubes de puntos LiDAR (LAS/LAZ).

Cada archivo se convierte una sola vez a un GeoTIFF en lon/lat (EPSG:4326) dentro de cache/dem_local/<id>.tif, con
un <id>.json de metadatos. Las nubes LAS/LAZ se rasterizan con la media de los puntos de terreno (clase 2 de ASPRS)
en cada celda; si la nube no está clasificada se usa el mínimo de cada celda (aproxima el suelo bajo la vegetación).
"""
from __future__ import annotations

import json
import math
import time
import uuid
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.fill import fillnodata
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds

LOCAL_DIR = Path(__file__).resolve().parents[1] / "cache" / "dem_local"
PREFIX = "LOCAL:"
RASTER_EXT = {".tif", ".tiff", ".img", ".asc", ".vrt", ".bil", ".dem", ".nc", ".hgt"}
LIDAR_EXT = {".las", ".laz"}
MAX_LIDAR_CELLS = 60_000_000


class LocalDemError(ValueError):
    pass


def _meta_path(did):
    return LOCAL_DIR / f"{did}.json"


def _tif_path(did):
    return LOCAL_DIR / f"{did}.tif"


def _check_id(did):
    if not did or not all(c in "0123456789abcdef" for c in did):
        raise LocalDemError("Identificador de DEM propio inválido")
    if not _meta_path(did).exists():
        raise LocalDemError("El DEM propio no existe (¿se borró la caché?): volvé a cargarlo")
    return did


def parse_id(dataset: str):
    return _check_id(dataset[len(PREFIX):]) if dataset and dataset.startswith(PREFIX) else None


def meta(did):
    return json.loads(_meta_path(_check_id(did)).read_text(encoding="utf-8"))


def list_all():
    if not LOCAL_DIR.exists():
        return []
    out = []
    for p in sorted(LOCAL_DIR.glob("*.json"), key=lambda q: q.stat().st_mtime, reverse=True):
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if _tif_path(m["id"]).exists():
            out.append(m)
    return out


def delete(did):
    _check_id(did)
    for p in (_meta_path(did), _tif_path(did)):
        p.unlink(missing_ok=True)


def _crs_from(src_crs, epsg):
    if epsg:
        try:
            return CRS.from_epsg(int(epsg))
        except Exception as e:
            raise LocalDemError(f"EPSG {epsg} no reconocido: {e}")
    if src_crs:
        return src_crs
    raise LocalDemError("El archivo no declara su sistema de coordenadas: indicá el código EPSG (p. ej. 5347 para "
                        "POSGAR 2007 faja 5, 32720 para UTM 20S)")


def _units_m(crs):
    """Metros por unidad horizontal del CRS (grados → ~111 km)."""
    if crs.is_geographic:
        return 111320.0
    try:
        return float(crs.linear_units_factor[1])
    except Exception:
        return 1.0


def _to_wgs84(src, crs, out_path, progress=None):
    """Reproyecta un dataset de rasterio a EPSG:4326 (bilineal, por bloques, NaN fuera de los datos)."""
    nodata = src.nodata
    with WarpedVRT(src, src_crs=crs, crs="EPSG:4326", resampling=Resampling.bilinear, src_nodata=nodata,
                   nodata=np.nan, dtype="float32") as vrt:
        prof = dict(driver="GTiff", dtype="float32", count=1, width=vrt.width, height=vrt.height, crs="EPSG:4326",
                    transform=vrt.transform, nodata=np.nan, compress="deflate", predictor=3, tiled=True,
                    blockxsize=512, blockysize=512, BIGTIFF="IF_SAFER")
        with rasterio.open(out_path, "w", **prof) as dst:
            wins = [w for _, w in dst.block_windows(1)]
            zmin, zmax, valid = math.inf, -math.inf, 0
            for k, w in enumerate(wins):
                a = vrt.read(1, window=w).astype(np.float32)
                a[(a < -1000) | (a > 9000)] = np.nan  # nodata no declarado (-9999, -32767, 3.4e38)
                dst.write(a, 1, window=w)
                ok = np.isfinite(a)
                if ok.any():
                    zmin, zmax = min(zmin, float(a[ok].min())), max(zmax, float(a[ok].max()))
                    valid += int(ok.sum())
                if progress and k % 50 == 0:
                    progress(f"Reproyectando a WGS84… {k * 100 // max(1, len(wins))} %")
            b = dst.bounds
    if valid == 0:
        raise LocalDemError("El DEM no tiene valores válidos")
    return dict(bounds=[b.left, b.bottom, b.right, b.top], width=prof["width"], height=prof["height"],
                zmin=round(zmin, 2), zmax=round(zmax, 2), valid_fraction=round(valid / (prof["width"] * prof["height"]), 3))


def _ingest_raster(path, epsg, out_path, progress):
    with rasterio.open(path) as src:
        crs = _crs_from(src.crs, epsg)
        res_m = abs(src.res[0]) * _units_m(crs)
        info = _to_wgs84(src, crs, out_path, progress)
        info.update(kind="raster", res_m=round(res_m, 2), crs_src=crs.to_string(),
                    size_src=[src.width, src.height])
    return info


def _ingest_lidar(path, epsg, res_m, ground_only, out_path, progress):
    try:
        import laspy
    except ImportError:
        raise LocalDemError("Falta laspy en el backend: pip install 'laspy[lazrs]'")
    warn = []
    with laspy.open(path) as f:
        hdr = f.header
        n_pts = int(hdr.point_count)
        if n_pts == 0:
            raise LocalDemError("La nube de puntos está vacía")
        crs = None
        try:
            pc = hdr.parse_crs()
            if pc is not None:
                crs = CRS.from_wkt(pc.to_wkt())
        except Exception:
            crs = None
        crs = _crs_from(crs, epsg)
        u = _units_m(crs)
        x0, y0 = float(hdr.mins[0]), float(hdr.mins[1])
        x1, y1 = float(hdr.maxs[0]), float(hdr.maxs[1])
        area_m2 = max((x1 - x0) * (y1 - y0) * u * u, 1.0)
        if not res_m:
            # ~3 puntos de terreno por celda (suponiendo que el 40 % son terreno)
            res_m = float(np.clip(math.sqrt(area_m2 / (0.4 * n_pts) * 3), 0.5, 20))
            res_m = round(res_m * 2) / 2 or 0.5
        res = res_m / u
        nx = int(math.ceil((x1 - x0) / res)) + 1
        ny = int(math.ceil((y1 - y0) / res)) + 1
        if nx * ny > MAX_LIDAR_CELLS:
            f2 = math.sqrt(nx * ny / MAX_LIDAR_CELLS)
            res *= f2
            res_m *= f2
            nx = int(math.ceil((x1 - x0) / res)) + 1
            ny = int(math.ceil((y1 - y0) / res)) + 1
            warn.append(f"Resolución aumentada a {res_m:.1f} m para no superar {MAX_LIDAR_CELLS / 1e6:.0f} M de celdas")
        N = nx * ny
        g_sum = np.zeros(N)
        g_cnt = np.zeros(N, np.int32)
        a_min = np.full(N, np.inf)
        n_ground = 0
        done = 0
        for chunk in f.chunk_iterator(2_000_000):
            x = np.asarray(chunk.x, float)
            y = np.asarray(chunk.y, float)
            z = np.asarray(chunk.z, float)
            i = np.clip(((x - x0) / res).astype(np.int64), 0, nx - 1)
            j = np.clip(((y1 - y) / res).astype(np.int64), 0, ny - 1)  # fila 0 = norte
            k = j * nx + i
            try:
                cls = np.asarray(chunk.classification)
            except Exception:
                cls = np.zeros(x.size, np.uint8)
            noise = (cls == 7) | (cls == 18)
            g = (cls == 2) & ~noise
            n_ground += int(g.sum())
            if g.any():
                g_sum += np.bincount(k[g], weights=z[g], minlength=N)
                g_cnt += np.bincount(k[g], minlength=N).astype(np.int32)
            ok = ~noise
            np.minimum.at(a_min, k[ok], z[ok])
            done += x.size
            if progress:
                progress(f"Leyendo la nube de puntos… {done * 100 // n_pts} % ({done / 1e6:.1f} M puntos)")
    use_ground = ground_only and n_ground > 0.02 * n_pts
    if use_ground:
        arr = np.where(g_cnt > 0, g_sum / np.maximum(g_cnt, 1), np.nan)
        src_txt = f"media de {n_ground:,} puntos de terreno (clase 2)".replace(",", ".")
    else:
        arr = np.where(np.isfinite(a_min), a_min, np.nan)
        src_txt = "mínimo de cada celda (nube sin clasificar)" if n_ground <= 0.02 * n_pts else "mínimo de todos los puntos"
        if ground_only:
            warn.append("La nube no tiene puntos de terreno clasificados (clase 2): se usó el mínimo de cada celda, que "
                        "puede conservar vegetación densa o edificios")
    arr = arr.reshape(ny, nx).astype(np.float32)
    hole = ~np.isfinite(arr)
    if hole.all():
        raise LocalDemError("No quedaron celdas con datos")
    if hole.any():
        if progress:
            progress("Interpolando huecos de la nube…")
        filled = fillnodata(np.nan_to_num(arr, nan=0.0), mask=(~hole).astype(np.uint8),
                            max_search_distance=max(10, int(50 / res_m)))
        # lo que sigue sin datos (lejos de todo punto) queda como NaN
        far = hole & (filled == 0)
        arr = np.where(far, np.nan, filled).astype(np.float32)
    tr = from_origin(x0, y1 + res / 2, res, res)
    prof = dict(driver="GTiff", dtype="float32", count=1, width=nx, height=ny, crs=crs, transform=tr, nodata=np.nan)
    with MemoryFile() as mem:
        with mem.open(**prof) as tmp:
            tmp.write(arr, 1)
        with mem.open() as src:
            info = _to_wgs84(src, crs, out_path, progress)
    info.update(kind="lidar", res_m=round(res_m, 2), crs_src=crs.to_string(), points=n_pts, ground_points=n_ground,
                method=src_txt, warnings=warn)
    return info


def ingest(path, filename, epsg=None, res_m=None, ground_only=True, name=None, progress=None):
    """Convierte el archivo subido en un DEM propio. Devuelve sus metadatos."""
    ext = Path(filename).suffix.lower()
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    did = uuid.uuid4().hex[:12]
    out = _tif_path(did)
    try:
        if ext in LIDAR_EXT:
            info = _ingest_lidar(path, epsg, res_m, ground_only, out, progress)
        elif ext in RASTER_EXT or ext == "":
            info = _ingest_raster(path, epsg, out, progress)
        else:
            raise LocalDemError(f"Formato {ext} no soportado: usá GeoTIFF (.tif), IMG, ASC o LiDAR (.las/.laz)")
    except LocalDemError:
        out.unlink(missing_ok=True)
        raise
    except rasterio.errors.RasterioIOError as e:
        out.unlink(missing_ok=True)
        raise LocalDemError(f"No se pudo leer el archivo como raster: {e}")
    except Exception as e:
        out.unlink(missing_ok=True)
        raise LocalDemError(f"{type(e).__name__}: {e}")
    w = info.setdefault("warnings", [])
    w.append("Verificá que la cota vertical sea ortométrica (sobre el nivel del mar, p. ej. SRVN16 del IGN): una "
             "altura elipsoidal difiere ~15–30 m en la Argentina. Al completar fuera de la cobertura se corrige el "
             "desnivel medio con el DEM global.")
    m = dict(id=did, name=name or Path(filename).stem, filename=filename, created=time.time(), **info)
    _meta_path(did).write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    return m


def read_bbox(did, bbox, max_dim):
    """Recorte del DEM propio en el bbox (lon/lat), remuestreado a ≤ max_dim píxeles por lado. NaN sin datos.

    Devuelve (arr float32 fila 0 = norte, transform, fracción del bbox con datos)."""
    w, s, e, n = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
    with rasterio.open(_tif_path(_check_id(did))) as src:
        win = from_bounds(w, s, e, n, src.transform)
        W, H = max(2, int(round(win.width))), max(2, int(round(win.height)))
        scale = max(W, H) / max_dim
        if scale > 1:
            W, H = max(2, int(W / scale)), max(2, int(H / scale))
        arr = src.read(1, window=win, out_shape=(H, W), boundless=True, fill_value=np.nan,
                       resampling=Resampling.bilinear).astype(np.float32)
    from rasterio.transform import from_bounds as fb
    arr[(arr < -1000) | (arr > 9000)] = np.nan
    return arr, fb(w, s, e, n, W, H), float(np.isfinite(arr).mean())
