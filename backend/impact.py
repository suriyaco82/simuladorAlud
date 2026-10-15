# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Zonas de afectación (polígonos por intensidad) y grado de daño de cada edificio.

Trabaja solo con el dominio y los campos del resultado (no necesita el DEM ni la grilla del solver), así que sirve
tanto al terminar una simulación como para completar resultados guardados antes de que existiera.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

from .hydro import label_polygons

LEVELS = {1: "baja", 2: "media", 3: "alta"}
DAMAGE = {0: "Sin afectación", 1: "Daño leve", 2: "Daño moderado", 3: "Daño grave", 4: "Destrucción probable"}
# presión dinámica a partir de la cual una construcción de mampostería suele colapsar (Jakob et al. 2012;
# Zanchetta et al. 2004 registran colapsos entre 35 y 90 kPa)
COLLAPSE_KPA = 35.0
DAMAGE_WEIGHT = np.array([0, 1, 3, 6, 10], float)
MAX_ZONES = 80


class _Frame:
    def __init__(self, d):
        self.west, self.south, self.mx, self.my = d["west"], d["south"], d["mx"], d["my"]

    def to_lonlat(self, x, y):
        return self.west + np.asarray(x, float) / self.mx, self.south + np.asarray(y, float) / self.my

    def to_xy(self, lon, lat):
        return (np.asarray(lon, float) - self.west) * self.mx, (np.asarray(lat, float) - self.south) * self.my


def damage_grade(cls, depth, pressure, height=None):
    """Grado de daño orientativo (0–4) según la intensidad del flujo en el edificio.

    1 leve: intensidad baja · 2 moderado: media · 3 grave: alta · 4 destrucción probable: alta y presión dinámica
    ≥ 35 kPa, o el flujo supera la altura del edificio."""
    cls = np.asarray(cls, int)
    g = np.clip(cls, 0, 3)
    over = np.zeros(cls.shape, bool)
    if height is not None:
        hb = np.array([np.nan if q is None else q for q in height], float)
        over = np.isfinite(hb) & (hb > 0) & (np.asarray(depth, float) >= hb)
    g = np.where((cls >= 3) & ((np.asarray(pressure, float) >= COLLAPSE_KPA) | over), 4, g)
    g = np.where((cls >= 1) & over, np.maximum(g, 3), g)
    return g.astype(int)


def building_samples(domain, fields, points):
    """Valores del flujo en cada edificio: índices de celda y si cae dentro del dominio."""
    fr = _Frame(domain)
    nx, ny, dx = domain["nx"], domain["ny"], domain["dx"]
    lon = np.array([q[0] for q in points], float)
    lat = np.array([q[1] for q in points], float)
    x, y = fr.to_xy(lon, lat)
    i = np.clip(np.rint(x / dx).astype(int), 0, nx - 1)
    j = np.clip(np.rint(y / dx).astype(int), 0, ny - 1)
    inside = (x >= 0) & (y >= 0) & (x <= (nx - 1) * dx) & (y <= (ny - 1) * dx)
    return i, j, inside


def enrich_points(domain, fields, exposure_points, heights, pts):
    """Agrega velocidad, presión y grado de daño a exposure['points'] (en el mismo orden que los edificios)."""
    if not pts or not exposure_points:
        return pts
    i, j, inside = building_samples(domain, fields, exposure_points)
    F = lambda k: np.asarray(fields[k]).reshape(domain["ny"], domain["nx"])
    v = np.where(inside, F("max_speed")[j, i], 0)
    P = np.where(inside, F("max_pressure")[j, i], 0) if "max_pressure" in fields else np.zeros(len(i))
    cls = np.asarray(pts["intensity"], int)
    depth = np.asarray(pts["depth_m"], float)
    hl = heights if heights is not None and len(heights) == len(cls) else None
    dmg = damage_grade(cls, depth, P, hl)
    pts.update(speed_m_s=np.round(v, 2).tolist(), pressure_kPa=np.round(P, 1).tolist(), damage=dmg.tolist(),
               damage_counts={DAMAGE[k]: int((dmg == k).sum()) for k in range(1, 5)})
    return pts


def _clean(mask, it=1):
    """Cierre morfológico: une celdas vecinas y rellena huecos chicos (las zonas salen continuas, no pixeladas)."""
    if it <= 0 or not mask.any():
        return mask
    st = ndimage.generate_binary_structure(2, 2)
    return mask | ndimage.binary_closing(np.pad(mask, it), st, iterations=it)[it:-it, it:-it]


def impact_zones(domain, fields, points=None, exposure_points=None):
    """Polígonos de las áreas alcanzadas, separadas por intensidad (alta / media / baja) y por continuidad.

    Cada zona trae sus estadísticas, los edificios que contiene con su grado de daño y una categoría de
    criticidad. Se ordenan de la más a la menos comprometida."""
    nx, ny, dx = domain["nx"], domain["ny"], domain["dx"]
    A = dx * dx
    fr = _Frame(domain)
    cls = np.asarray(fields["intensity"], np.float32).reshape(ny, nx)
    h = fields["max_depth"].reshape(ny, nx)
    v = fields["max_speed"].reshape(ny, nx)
    P = fields["max_pressure"].reshape(ny, nx) if "max_pressure" in fields else np.zeros_like(h)
    arr = fields["arrival"].reshape(ny, nx)
    dep = fields["deposit"].reshape(ny, nx) if "deposit" in fields else np.zeros_like(h)
    cv = fields["max_cv"].reshape(ny, nx) if "max_cv" in fields else None

    # zonas anidadas (≥ alta, ≥ media, ≥ baja) suavizadas, luego exclusivas por nivel
    nested = {}
    for L in (3, 2, 1):
        m = _clean(cls >= L, 1 if dx >= 10 else 2)
        nested[L] = m | (nested.get(L + 1, np.zeros_like(m)))
    excl = {3: nested[3], 2: nested[2] & ~nested[3], 1: nested[1] & ~nested[2]}

    # edificios
    bi = bj = None
    dmg = None
    if points and exposure_points and len(exposure_points) == len(points.get("intensity", [])):
        bi, bj, inside = building_samples(domain, fields, exposure_points)
        dmg = np.asarray(points.get("damage") or points["intensity"], int)
        dmg = np.where(inside, dmg, 0)

    st = ndimage.generate_binary_structure(2, 2)
    min_cells = max(3, int(round(2500 / A)))  # ≥ ~0,25 ha o 3 celdas
    cand = []
    lab_all = np.zeros((ny, nx), np.int32)
    nid = 0
    for L in (3, 2, 1):
        lab, n = ndimage.label(excl[L], st)
        if not n:
            continue
        bl = lab[bj, bi] * (dmg > 0) if bi is not None else None
        for k, sl in enumerate(ndimage.find_objects(lab), 1):
            m = lab[sl] == k
            nb = int((bl == k).sum()) if bl is not None else 0
            if m.sum() < min_cells and nb == 0:
                continue
            nid += 1
            lab_all[sl][m] = nid
            idx = np.nonzero(bl == k)[0] if bl is not None else np.zeros(0, int)
            cand.append((nid, L, sl, m, idx))

    zones = []
    for nid, L, sl, m, idx in cand:
        hz, vz, pz = h[sl][m], v[sl][m], P[sl][m]
        ta = arr[sl][m]
        ta = ta[ta >= 0]
        z = dict(level=L, level_name=LEVELS[L], area_m2=round(float(m.sum() * A), 0),
                 max_depth_m=round(float(hz.max()), 2), p90_depth_m=round(float(np.percentile(hz, 90)), 2),
                 max_speed_m_s=round(float(vz.max()), 2), p90_speed_m_s=round(float(np.percentile(vz, 90)), 2),
                 max_pressure_kPa=round(float(pz.max()), 1),
                 first_arrival_s=round(float(ta.min()), 1) if ta.size else None,
                 deposit_volume_m3=round(float(np.clip(dep[sl][m], 0, None).sum() * A), 0))
        if cv is not None:
            z["max_cv"] = round(float(cv[sl][m].max()), 3)
        # punto de la etiqueta: la celda de la zona más cercana al centroide (en zonas curvas el centroide cae afuera)
        jj, ii = np.nonzero(m)
        c = int(np.argmin((ii - ii.mean()) ** 2 + (jj - jj.mean()) ** 2))
        clon, clat = fr.to_lonlat((ii[c] + sl[1].start) * dx, (jj[c] + sl[0].start) * dx)
        z["center"] = [round(float(clon), 6), round(float(clat), 6)]
        if bi is not None:
            z["buildings"] = idx.tolist()
            z["damage_counts"] = {DAMAGE[k]: int((dmg[idx] == k).sum()) for k in range(1, 5)}
        nbld = len(idx)
        worst = int(dmg[idx].max()) if nbld else 0
        score = float(DAMAGE_WEIGHT[dmg[idx]].sum()) if nbld else 0.0
        score += z["area_m2"] / 1e4 * {3: 3.0, 2: 1.0, 1: 0.3}[L]
        if L == 3 and worst >= 3:
            crit = "Crítica"
        elif L == 3 or (L == 2 and nbld):
            crit = "Alta"
        elif L == 2 or nbld:
            crit = "Media"
        else:
            crit = "Baja"
        z.update(buildings_affected=nbld, worst_damage=worst, score=round(score, 1), criticality=crit, _id=nid)
        zones.append(z)

    order = {"Crítica": 0, "Alta": 1, "Media": 2, "Baja": 3}
    zones.sort(key=lambda z: (order[z["criticality"]], -z["score"]))
    if len(zones) > MAX_ZONES:
        # las zonas de baja intensidad, chicas y sin edificios se quedan fuera del listado
        zones = zones[:MAX_ZONES]
    keep = {z["_id"] for z in zones}
    lab_all[~np.isin(lab_all, list(keep))] = 0
    polys = label_polygons(lab_all, dx, fr, simplify=0.8)
    out = []
    for n, z in enumerate(zones, 1):
        geom = polys.get(z.pop("_id"))
        if not geom:
            continue
        z["code"] = f"Z{n}"
        z["polygons"] = geom
        out.append(z)
    tot = {LEVELS[L]: round(float(excl[L].sum() * A), 0) for L in (1, 2, 3)}
    return dict(zones=out, area_by_level_m2=tot, criteria=dict(
        intensity="Hürlimann et al. (2008): alta h ≥ 1 m y v ≥ 1 m/s; media, una de las dos; baja, h > 0,1 m "
                  "(inundación con Cv < 0,2: alta si h > 2 m o h·v > 2 m²/s; media si h > 0,5 m o h·v > 0,5 m²/s)",
        damage=f"Leve: intensidad baja · moderado: media · grave: alta · destrucción probable: alta con presión "
               f"dinámica ≥ {COLLAPSE_KPA:.0f} kPa o flujo más alto que el edificio",
        criticality="Crítica: intensidad alta con edificios con daño grave o destrucción · Alta: intensidad alta, o "
                    "media con edificios · Media: intensidad media, o baja con edificios · Baja: el resto"))
