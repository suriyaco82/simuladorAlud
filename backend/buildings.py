"""Edificios de GlobalBuildingAtlas (GBA LoD1, Zhu et al. 2025): huellas y alturas para una zona.

Se lee la versión GeoParquet publicada en Source Cooperative (teselas de 5° × 5°, ordenadas espacialmente).
Solo se descargan, con pedidos HTTP por rango, los grupos de filas cuyo bbox toca la zona pedida.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import struct
from pathlib import Path

import numpy as np
import requests

GBA_URL = "https://data.source.coop/tge-labs/globalbuildingatlas-lod1/{tile}.parquet"
CACHE = Path(__file__).resolve().parents[1] / "cache" / "buildings"
NO_HEIGHT = -999.0


class BuildingsError(RuntimeError):
    pass


class _RangeFile(io.RawIOBase):
    """Archivo remoto de solo lectura: cada lectura es un pedido HTTP Range (lo que necesita pyarrow)."""

    def __init__(self, url):
        self.url, self.pos, self.ses = url, 0, requests.Session()
        r = self.ses.head(url, timeout=(10, 30), allow_redirects=True)
        if r.status_code == 404:
            raise FileNotFoundError(url)
        r.raise_for_status()
        self.size = int(r.headers["content-length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = {0: offset, 1: self.pos + offset, 2: self.size + offset}[whence]
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        r = self.ses.get(self.url, headers={"Range": f"bytes={self.pos}-{self.pos + n - 1}"}, timeout=(10, 120))
        r.raise_for_status()
        k = len(r.content)
        b[:k] = r.content
        self.pos += k
        return k


def _tiles(west, south, east, north):
    """Nombres de las teselas GBA de 5° que cubren el bbox, p. ej. w075_s45_w070_s50."""
    lon = lambda v: f"{'e' if v >= 0 else 'w'}{abs(v):03d}"
    lat = lambda v: f"{'n' if v >= 0 else 's'}{abs(v):02d}"
    out = []
    for x0 in range(int(math.floor(west / 5)) * 5, int(math.ceil(east / 5)) * 5, 5):
        for y0 in range(int(math.floor(south / 5)) * 5, int(math.ceil(north / 5)) * 5, 5):
            out.append(f"{lon(x0)}_{lat(y0 + 5)}_{lon(x0 + 5)}_{lat(y0)}")
    return out


def _ring(wkb: bytes):
    """Anillo exterior de un Polygon/MultiPolygon WKB como array (n, 2) [lon, lat]."""
    bo = "<" if wkb[0] == 1 else ">"
    gtype = struct.unpack_from(bo + "I", wkb, 1)[0] % 1000
    off = 5
    if gtype == 6:  # MultiPolygon: primer polígono
        bo = "<" if wkb[9] == 1 else ">"
        off = 14
    elif gtype != 3:
        return None
    nrings = struct.unpack_from(bo + "I", wkb, off)[0]
    if not nrings:
        return None
    npts = struct.unpack_from(bo + "I", wkb, off + 4)[0]
    return np.frombuffer(wkb, dtype=bo + "f8", count=2 * npts, offset=off + 8).reshape(-1, 2)


def _centroid_area(ring):
    """Centroide (lon, lat) y área (m²) de un anillo, en un plano local."""
    lat0 = ring[:, 1].mean()
    mx, my = 111320.0 * math.cos(math.radians(lat0)), 110540.0
    x = (ring[:, 0] - ring[0, 0]) * mx
    y = (ring[:, 1] - ring[0, 1]) * my
    cr = x[:-1] * y[1:] - x[1:] * y[:-1]
    a = cr.sum() / 2
    if abs(a) < 1e-6:
        return float(ring[:, 0].mean()), float(ring[:, 1].mean()), 0.0
    cx = ((x[:-1] + x[1:]) * cr).sum() / (6 * a)
    cy = ((y[:-1] + y[1:]) * cr).sum() / (6 * a)
    return float(ring[0, 0] + cx / mx), float(ring[0, 1] + cy / my), abs(float(a))


def _read_tile(tile, west, south, east, north):
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    try:
        f = _RangeFile(GBA_URL.format(tile=tile))
    except FileNotFoundError:
        return None  # sin edificios en esa tesela (mar, hielo…)
    pf = pq.ParquetFile(f)
    md = pf.metadata
    keep = []
    for i in range(md.num_row_groups):
        rg = md.row_group(i)
        st = {rg.column(j).path_in_schema: rg.column(j).statistics for j in range(rg.num_columns)}
        try:
            if (st["bbox.xmin"].min > east or st["bbox.xmax"].max < west
                    or st["bbox.ymin"].min > north or st["bbox.ymax"].max < south):
                continue
        except (KeyError, AttributeError):
            pass  # sin estadísticas: hay que leer el grupo
        keep.append(i)
    if not keep:
        return None
    t = pf.read_row_groups(keep, columns=["source", "height", "bbox", "geometry"])
    b = t["bbox"].combine_chunks()
    f_ = lambda k: pc.struct_field(b, k)
    m = pc.and_(pc.and_(pc.less_equal(f_("xmin"), east), pc.greater_equal(f_("xmax"), west)),
                pc.and_(pc.less_equal(f_("ymin"), north), pc.greater_equal(f_("ymax"), south)))
    return t.filter(m)


def fetch_gba(west, south, east, north):
    """Edificios GBA dentro del bbox: lista de dicts {lon, lat, area, height, source} (height None = sin dato)."""
    if east <= west or north <= south:
        raise BuildingsError("BBox inválido")
    if (east - west) * (north - south) > 0.25:
        raise BuildingsError("Zona demasiado grande para descargar edificios (máx. ~0,5° × 0,5°)")
    key = hashlib.sha1(f"gba1:{west:.5f},{south:.5f},{east:.5f},{north:.5f}".encode()).hexdigest()[:12]
    cache = CACHE / f"GBA_{key}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    try:
        import pyarrow  # noqa: F401
    except ImportError as e:
        raise BuildingsError("Falta pyarrow: pip install -r backend/requirements.txt") from e

    out = []
    for tile in _tiles(west, south, east, north):
        try:
            t = _read_tile(tile, west, south, east, north)
        except requests.RequestException as e:
            raise BuildingsError(f"No se pudo leer GlobalBuildingAtlas ({tile}): {e}") from e
        if t is None:
            continue
        src, hgt, geo = t["source"].to_pylist(), t["height"].to_pylist(), t["geometry"].to_pylist()
        for s, h, g in zip(src, hgt, geo):
            ring = _ring(g) if g else None
            if ring is None or len(ring) < 4:
                continue
            lon, lat, area = _centroid_area(ring)
            if not (west <= lon <= east and south <= lat <= north):
                continue
            out.append(dict(lon=round(lon, 6), lat=round(lat, 6), area=round(area, 1),
                            height=round(h, 1) if h is not None and h > 0 and h != NO_HEIGHT else None,
                            source=f"GBA:{s}"))
    res = dict(buildings=out, count=len(out), with_height=sum(b["height"] is not None for b in out),
               sources=sorted({b["source"] for b in out}),
               attribution="GlobalBuildingAtlas LoD1 (Zhu et al., 2025, TUM; doi:10.14459/2025mp1782307), "
                           "versión Parquet de Source Cooperative. Polígonos ODbL (OSM, Microsoft) y CC BY-NC.")
    CACHE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(res))
    return res
