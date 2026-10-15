# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Caminos, vías férreas y alcantarillas para el motor de inundación.

- Descarga de OpenStreetMap (Overpass API) dentro de la zona: rutas por categoría, vías férreas, puentes y
  alcantarillas (waterway + tunnel=culvert).
- Terraplenes: el DEM de 5–30 m no resuelve un terraplén de 0,5–2 m, que en llanura decide por dónde va el agua.
  Cada camino se levanta a (terreno mediano a lo largo de ~100 m) + altura del terraplén de su categoría, en su ancho.
  Los tramos con puente no se levantan.
- Alcantarillas: conducto bajo el terraplén entre las celdas de ambos lados; Q = Cd·A·√(2g·Δη), con el área mojada
  reducida cuando la entrada no está sumergida.
- Informe: km de cada categoría con agua sobre la calzada por encima de los umbrales de tránsito (Shand et al. 2011,
  Australian Rainfall and Runoff: 0,15 m pierde el control un auto; 0,3 m flota; 0,6 m ningún vehículo).
"""
from __future__ import annotations

import math

import numpy as np
import requests

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
CLASSES = {
    "autopista": dict(name="Autopista / autovía", embankment_m=1.5, width_m=25.0, include=True),
    "primaria": dict(name="Ruta primaria", embankment_m=1.2, width_m=12.0, include=True),
    "secundaria": dict(name="Ruta secundaria", embankment_m=1.0, width_m=10.0, include=True),
    "terciaria": dict(name="Ruta terciaria", embankment_m=0.6, width_m=8.0, include=True),
    "vecinal": dict(name="Camino vecinal / rural", embankment_m=0.4, width_m=7.0, include=True),
    "huella": dict(name="Huella / camino de tierra", embankment_m=0.0, width_m=4.0, include=True),
    "ferrocarril": dict(name="Vía férrea", embankment_m=1.5, width_m=8.0, include=True),
}
HIGHWAY = {"motorway": "autopista", "motorway_link": "autopista", "trunk": "autopista", "trunk_link": "autopista",
           "primary": "primaria", "primary_link": "primaria", "secondary": "secundaria", "secondary_link": "secundaria",
           "tertiary": "terciaria", "tertiary_link": "terciaria", "unclassified": "vecinal", "residential": "vecinal",
           "service": "vecinal", "track": "huella"}
THRESHOLDS = [(0.15, "precaucion", "Precaución (> 0,15 m)"), (0.3, "livianos", "Intransitable para autos (> 0,3 m)"),
              (0.6, "todos", "Intransitable para todo vehículo (> 0,6 m)")]


class RoadsError(RuntimeError):
    pass


def classes(overrides=None):
    out = {k: dict(v) for k, v in CLASSES.items()}
    for k, ov in (overrides or {}).items():
        if k in out and isinstance(ov, dict):
            for a in ("embankment_m", "width_m"):
                if ov.get(a) is not None:
                    out[k][a] = float(ov[a])
            if ov.get("include") is not None:
                out[k]["include"] = bool(ov["include"])
    return out


def _simplify(pts, tol_deg):
    from .hydro import douglas_peucker
    P = np.asarray(pts, float)
    if len(P) <= 2:
        return P
    return np.asarray(douglas_peucker(P, tol_deg))


def fetch_osm(west, south, east, north):
    """Caminos, vías y alcantarillas de OSM en el bbox."""
    bb = f"{south},{west},{north},{east}"
    q = (f'[out:json][timeout:120];('
         f'way["highway"~"^({"|".join(HIGHWAY)})$"]({bb});'
         f'way["railway"~"^(rail|narrow_gauge|disused|abandoned)$"]({bb});'
         f'way["waterway"]["tunnel"="culvert"]({bb});'
         f'node["waterway"="culvert"]({bb});'
         f');out geom tags;')
    last = None
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": q}, timeout=(10, 150), headers={"User-Agent": "SuriyacoMassFlow/0.2"})
            if r.status_code == 200:
                data = r.json()
                break
            last = f"HTTP {r.status_code} ({url.split('/')[2]})"
        except (requests.RequestException, ValueError) as e:
            last = f"{e} ({url.split('/')[2]})"
    else:
        raise RoadsError(f"OpenStreetMap (Overpass) no respondió: {last}")
    roads, culverts = [], []
    tol = 3.0 / 111320  # simplificación ~3 m
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "node":
            culverts.append(dict(point=[round(el["lon"], 6), round(el["lat"], 6)], diameter_m=1.0, count=1,
                                 name=tags.get("name") or "Alcantarilla (OSM)"))
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        pts = [[g["lon"], g["lat"]] for g in geom]
        if "waterway" in tags:
            mid = pts[len(pts) // 2]
            d = tags.get("diameter") or tags.get("width")
            try:
                d = float(str(d).replace("m", "").replace(",", ".").strip()) if d else 1.0
                d = d / 1000 if d > 20 else d  # diámetros en mm
            except ValueError:
                d = 1.0
            culverts.append(dict(point=[round(mid[0], 6), round(mid[1], 6)], diameter_m=round(min(max(d, 0.3), 6.0), 2),
                                 count=1, name=tags.get("name") or "Alcantarilla (OSM)"))
            continue
        cls = "ferrocarril" if "railway" in tags else HIGHWAY.get(tags.get("highway"))
        if not cls:
            continue
        line = np.round(_simplify(pts, tol), 6).tolist()
        roads.append(dict(id=el["id"], cls=cls, name=tags.get("name") or tags.get("ref") or "",
                          bridge=tags.get("bridge") not in (None, "no") or tags.get("tunnel") not in (None, "no", "culvert"),
                          line=line))
    counts = {}
    for r in roads:
        counts[r["cls"]] = counts.get(r["cls"], 0) + 1
    return dict(roads=roads, culverts=culverts, counts=counts, source="© OpenStreetMap contributors (ODbL)")


def _densify(g, line, step):
    from .scenario import _line_xy
    lx, ly = _line_xy(g, line)
    seg = np.hypot(np.diff(lx), np.diff(ly))
    s = np.r_[0, np.cumsum(seg)]
    if s[-1] <= 0:
        return None
    ss = np.arange(0, s[-1] + step / 2, step)
    return np.interp(ss, s, lx), np.interp(ss, s, ly), s[-1]


def apply_embankments(g, opts):
    """Levanta los terraplenes sobre g['H_pre']. Devuelve (notas, geometría de los caminos en la grilla)."""
    if not opts or not opts.get("items"):
        return [], None
    from scipy.ndimage import median_filter
    from .scenario import bilinear
    H0 = g["H_pre"].astype(np.float64)
    H = H0.copy()
    dx, ny, nx = g["dx"], g["ny"], g["nx"]
    tab = classes(opts.get("classes"))
    step = dx / 2
    win = max(3, int(round(100.0 / step)) | 1)
    geo = []
    raised_cells, km = 0, 0.0
    for r in opts["items"]:
        c = tab.get(r.get("cls"))
        if c is None or not c["include"]:
            continue
        d = _densify(g, r["line"], step)
        if d is None:
            continue
        px, py, L = d
        inside = (px >= 0) & (py >= 0) & (px <= (nx - 1) * dx) & (py <= (ny - 1) * dx)
        if inside.sum() < 2:
            continue
        geo.append(dict(px=px, py=py, cls=r["cls"], bridge=bool(r.get("bridge")), name=r.get("name") or "",
                        half=c["width_m"] / 2))
        emb = float(c["embankment_m"])
        if emb <= 0 or r.get("bridge"):
            continue
        px, py = px[inside], py[inside]
        ground = bilinear(H0, dx, px, py)
        crest = median_filter(ground, size=min(win, ground.size | 1), mode="nearest") + emb
        half = c["width_m"] / 2
        rad = int(math.ceil(max(half, 0.5 * dx) / dx))
        offs = [(dj, di) for dj in range(-rad, rad + 1) for di in range(-rad, rad + 1)
                if math.hypot(dj, di) * dx <= max(half, 0.5 * dx) + 1e-6] or [(0, 0)]
        i0 = np.rint(px / dx).astype(int)
        j0 = np.rint(py / dx).astype(int)
        for dj, di in offs:
            jj, ii = np.clip(j0 + dj, 0, ny - 1), np.clip(i0 + di, 0, nx - 1)
            before = H[jj, ii].copy()
            np.maximum.at(H, (jj, ii), crest)
            raised_cells += int((H[jj, ii] > before).sum())
        km += L / 1000
    g["H_pre"] = H.astype(np.float32)
    notes = [f"Terraplenes de caminos y vías: {km:.1f} km levantados sobre el DEM ({raised_cells} celdas)"] if km else []
    return notes, geo


def culvert_links(g, geo, culverts):
    """Pares de celdas (aguas a un lado y al otro del terraplén) de cada alcantarilla. Devuelve (links, avisos)."""
    links, warnings = [], []
    if not culverts:
        return links, warnings
    dx, ny, nx, fr = g["dx"], g["ny"], g["nx"], g["frame"]
    pts = [(r, k) for r in (geo or []) for k in range(len(r["px"]))]
    if not pts:
        warnings.append("Hay alcantarillas pero no hay caminos cargados: se ignoran")
        return links, warnings
    PX = np.array([r["px"][k] for r, k in pts])
    PY = np.array([r["py"][k] for r, k in pts])
    skipped = 0
    for cv in culverts:
        x, y = fr.to_xy(*cv["point"])
        d2 = (PX - x) ** 2 + (PY - y) ** 2
        m = int(np.argmin(d2))
        if d2[m] > (60.0 + dx) ** 2:
            skipped += 1
            continue
        r, k = pts[m]
        k0, k1 = max(0, k - 1), min(len(r["px"]) - 1, k + 1)
        tx, ty = r["px"][k1] - r["px"][k0], r["py"][k1] - r["py"][k0]
        L = math.hypot(tx, ty) or 1.0
        nxv, nyv = -ty / L, tx / L
        off = r["half"] + dx
        ia, ja = int(round((r["px"][k] + nxv * off) / dx)), int(round((r["py"][k] + nyv * off) / dx))
        ib, jb = int(round((r["px"][k] - nxv * off) / dx)), int(round((r["py"][k] - nyv * off) / dx))
        if not (0 <= ia < nx and 0 <= ib < nx and 0 <= ja < ny and 0 <= jb < ny):
            skipped += 1
            continue
        d = float(cv.get("diameter_m", 1.0))
        links.append(dict(a=ja * nx + ia, b=jb * nx + ib, d=d, area=math.pi * d * d / 4 * int(cv.get("count", 1)),
                          name=cv.get("name") or "Alcantarilla"))
    if skipped:
        warnings.append(f"{skipped} alcantarilla{'s' if skipped > 1 else ''} lejos de todo camino cargado (> 60 m) o "
                        "fuera de la zona: se ignoraron")
    return links, warnings


def culvert_step(h, z, links, dt, A, cd=0.6):
    """Transfiere agua por las alcantarillas en un paso (h y z aplanados in situ). Devuelve el volumen movido (m³)."""
    vol = 0.0
    G = 9.81
    for c in links:
        a, b = c["a"], c["b"]
        ea, eb = z[a] + h[a], z[b] + h[b]
        if ea < eb:
            a, b, ea, eb = b, a, eb, ea
        hu = h[a]
        if hu <= 1e-3:
            continue
        area = c["area"] * min(1.0, hu / c["d"])
        Q = cd * area * math.sqrt(2 * G * (ea - eb))
        V = min(Q * dt, 0.5 * (ea - eb) * A / 2, 0.9 * hu * A)
        if V <= 0:
            continue
        h[a] -= V / A
        h[b] += V / A
        vol += V
    return vol


def report(g, geo, fields, opts):
    """Km de camino con agua sobre la calzada, por categoría y umbral, y los tramos cortados para el mapa."""
    if not geo:
        return None
    dx, ny, nx, fr = g["dx"], g["ny"], g["nx"], g["frame"]
    h = fields["max_depth"]
    wt = fields.get("wet_time")
    arr = fields.get("arrival")
    tab = classes((opts or {}).get("classes"))
    step = dx / 2
    by = {}
    cut_lines = []
    for r in geo:
        if r["bridge"]:
            continue
        i = np.clip(np.rint(r["px"] / dx).astype(int), 0, nx - 1)
        j = np.clip(np.rint(r["py"] / dx).astype(int), 0, ny - 1)
        inside = (r["px"] >= 0) & (r["py"] >= 0) & (r["px"] <= (nx - 1) * dx) & (r["py"] <= (ny - 1) * dx)
        d = np.where(inside, h[j, i], 0.0)
        e = by.setdefault(r["cls"], dict(cls=r["cls"], name=tab[r["cls"]]["name"], km=0.0, over_24h_km=0.0,
                                         **{f"{key}_km": 0.0 for _, key, _ in THRESHOLDS}))
        e["km"] += inside.sum() * step / 1000
        for thr, key, _ in THRESHOLDS:
            e[f"{key}_km"] += float((d > thr).sum()) * step / 1000
        if wt is not None:
            e["over_24h_km"] += float((inside & (wt[j, i] >= 86400) & (d > 0.15)).sum()) * step / 1000
        # tramos cortados (> 0,3 m) como polilíneas
        cut = d > 0.3
        if cut.any():
            k = np.nonzero(np.diff(np.r_[0, cut.astype(int), 0]))[0]
            for a, b in zip(k[::2], k[1::2]):
                if b - a < 2:
                    continue
                lon, lat = fr.to_lonlat(r["px"][a:b], r["py"][a:b])
                sel = slice(None, None, max(1, (b - a) // 40))
                ta = arr[j[a:b], i[a:b]] if arr is not None else None
                ta = ta[ta >= 0] if ta is not None else np.zeros(0)
                cut_lines.append(dict(cls=r["cls"], name=r["name"], km=round((b - a) * step / 1000, 2),
                                      max_depth_m=round(float(d[a:b].max()), 2),
                                      first_cut_s=round(float(ta.min()), 0) if ta.size else None,
                                      line=np.round(np.c_[lon, lat][sel], 6).tolist() + [[round(float(lon[-1]), 6), round(float(lat[-1]), 6)]]))
    rows = []
    for k in CLASSES:
        if k in by:
            e = by[k]
            rows.append({a: (round(v, 2) if isinstance(v, float) else v) for a, v in e.items()})
    cut_lines.sort(key=lambda c: -c["km"])
    tot = {a: round(sum(r[a] for r in rows), 2) for a in ["km", "over_24h_km"] + [f"{key}_km" for _, key, _ in THRESHOLDS]}
    return dict(classes=rows, totals=tot, cuts=cut_lines[:400],
                thresholds=[dict(key=key, depth_m=thr, name=name) for thr, key, name in THRESHOLDS],
                criteria="Profundidad máxima sobre la calzada (sobre la corona del terraplén). Umbrales de estabilidad de "
                         "vehículos: Shand et al. (2011), Australian Rainfall and Runoff. Los puentes no se cuentan.")
