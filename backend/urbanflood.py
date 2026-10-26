# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Inundación urbana por lluvia intensa: calles pavimentadas, desagües pluviales y cloacales, barrios y calles afectadas.

- Calles (OpenStreetMap o GeoJSON): la calzada pavimentada es impermeable (CN 98), lisa (Manning 0,015) y queda
  `curb_m` por debajo de las manzanas (cordón cuneta), así que el agua de techos y patios baja a la calle y corre por
  ella como por un canal. Las calles de tierra infiltran algo y son más rugosas. Los canales a cielo abierto se graban
  en el DEM.
- Manzanas: el resto de la zona urbana, casi impermeable (techos, veredas) y con rugosidad alta por las
  edificaciones (enfoque de rugosidad equivalente).
- Red pluvial (si existe, por barrio): un depósito por sector con capacidad de conducción Qmax = i_diseño·A y un volumen
  de conductos V = almacenamiento·A. Las bocas de tormenta captan de las celdas de calle como vertedero,
  Q = Cw·L·h^1,5 (L = metros de reja por celda). Cuando la red se llena, las bocas dejan de captar (colapso) y lo que
  llega por conexiones directas (techos) sale por los puntos bajos del sector (sobrecarga).
- Red cloacal (separada): capacidad ociosa chica para agua de lluvia. Le entran las conexiones pluviales clandestinas
  (fracción de la lluvia) y el agua que pasa por las tapas de registro anegadas (orificio). Al superar su capacidad
  desborda por las bocas de registro más bajas del sector: ese agua se marca como mezclada con líquido cloacal y se
  transporta con el flujo (trazador pasivo).
- Informe por barrio (superficie anegada, profundidad, calles afectadas, edificios, colapso de la red y desbordes
  cloacales) y por calle (km con agua sobre el cordón y por umbral de tránsito, peligrosidad H1–H6 de Smith et al.
  2014 / Australian Rainfall and Runoff 2019).
"""
from __future__ import annotations

import math

import numpy as np
import requests

from .roads import OVERPASS, RoadsError, _densify, _simplify

G = 9.81
STREET_CLASSES = {
    "avenida": dict(name="Avenida / ruta urbana", width_m=18.0, include=True),
    "colectora": dict(name="Calle colectora", width_m=12.0, include=True),
    "calle": dict(name="Calle", width_m=9.0, include=True),
    "pasaje": dict(name="Pasaje / servicio", width_m=5.0, include=True),
}
HIGHWAY = {"motorway": "avenida", "motorway_link": "avenida", "trunk": "avenida", "trunk_link": "avenida",
           "primary": "avenida", "primary_link": "avenida", "secondary": "avenida", "secondary_link": "avenida",
           "tertiary": "colectora", "tertiary_link": "colectora", "residential": "calle", "unclassified": "calle",
           "living_street": "calle", "service": "pasaje", "pedestrian": "pasaje"}
PAVED = {"asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett", "cobblestone",
         "unhewn_cobblestone", "bricks", "metal", "wood", "chipseal"}
UNPAVED = {"unpaved", "dirt", "earth", "ground", "gravel", "fine_gravel", "compacted", "sand", "grass", "mud",
           "pebblestone", "rock", "soil"}
SURFACE = {
    "paved": dict(name="Calzada pavimentada", cn=98.0, manning=0.015, ks_factor=0.0),
    "unpaved": dict(name="Calle de tierra / ripio", cn=88.0, manning=0.025, ks_factor=0.3),
    "blocks": dict(name="Manzanas (techos, patios, veredas)", cn=92.0, manning=0.08, ks_factor=0.05),
}
STORM = dict(enabled=False, design_mm_h=20.0, storage_mm=5.0, inlet_m_per_100m=3.0, direct_fraction=0.0, outlet=None)
SEWER = dict(enabled=True, capacity_mm_h=0.5, storage_mm=1.5, rdii_fraction=0.03, manhole_spacing_m=100.0,
             lid_area_m2=0.02, ingress_depth_m=0.05)
# umbrales sobre la calzada: el cordón (el agua sube a la vereda y entra a las viviendas), autos y todo vehículo
THRESHOLDS = [(0.15, "cordon", "Supera el cordón (> 0,15 m)"), (0.3, "autos", "Intransitable para autos (> 0,3 m)"),
              (0.6, "todos", "Intransitable para todo vehículo (> 0,6 m)")]
# peligrosidad combinada (Smith, Davey y Cox 2014; ARR 2019 libro 6 cap. 7): (h máx m, v máx m/s, h·v máx m²/s)
HAZARD = [(1, 0.3, 2.0, 0.3, "H1 · en general seguro"),
          (2, 0.5, 2.0, 0.6, "H2 · peligroso para vehículos chicos"),
          (3, 1.2, 2.0, 0.6, "H3 · peligroso para vehículos, niños y ancianos"),
          (4, 2.0, 2.0, 1.0, "H4 · peligroso para personas y vehículos"),
          (5, 4.0, 4.0, 4.0, "H5 · daño estructural en edificios"),
          (6, math.inf, math.inf, math.inf, "H6 · colapso de edificios")]


def options(p):
    o = p.get("urban")
    if not o:
        return None
    o = {k: v for k, v in o.items() if v is not None}
    o["storm"] = {**STORM, **{k: v for k, v in (o.get("storm") or {}).items() if v is not None}}
    o["sewer"] = {**SEWER, **{k: v for k, v in (o.get("sewer") or {}).items() if v is not None}}
    sf = {k: dict(v) for k, v in SURFACE.items()}
    for k, ov in (o.get("surface") or {}).items():
        if k in sf and isinstance(ov, dict):
            sf[k].update({a: float(b) for a, b in ov.items() if a in ("cn", "manning", "ks_factor") and b is not None})
    o["surface"] = sf
    return o


def classes(overrides=None):
    out = {k: dict(v) for k, v in STREET_CLASSES.items()}
    for k, ov in (overrides or {}).items():
        if k in out and isinstance(ov, dict):
            if ov.get("width_m") is not None:
                out[k]["width_m"] = float(ov["width_m"])
            if ov.get("include") is not None:
                out[k]["include"] = bool(ov["include"])
    return out


def hazard_class(h, v, hv):
    """Clase de peligrosidad H1–H6 (0 = seco) por celda o muestra."""
    h, v, hv = np.asarray(h), np.asarray(v), np.asarray(hv)
    out = np.full(h.shape, 6, np.int8)
    for k, dm, vm, dvm, _ in reversed(HAZARD[:-1]):
        out[(h <= dm) & (v <= vm) & (hv <= dvm)] = k
    out[h <= 0.05] = 0
    return out


# ───────────────────────── OpenStreetMap: calles, barrios y desagües
def _rings(ways):
    """Une las vías exteriores de una relación en anillos cerrados."""
    segs = [list(map(tuple, w)) for w in ways if len(w) >= 2]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for k, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s + ring[1:]
                elif s[0] == ring[0]:
                    ring = s[::-1] + ring[1:]
                else:
                    continue
                segs.pop(k)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def _ring_area(r):
    x, y = np.asarray(r).T
    return 0.5 * abs(float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def fetch_osm(west, south, east, north):
    """Calles (con su superficie), barrios (polígonos o puntos) y elementos de desagüe de OSM en el bbox."""
    bb = f"{south},{west},{north},{east}"
    q = (f'[out:json][timeout:150];('
         f'way["highway"~"^({"|".join(HIGHWAY)})$"]({bb});'
         f'node["place"~"^(neighbourhood|suburb|quarter)$"]({bb});'
         f'way["place"~"^(neighbourhood|suburb|quarter)$"]({bb});'
         f'relation["place"~"^(neighbourhood|suburb|quarter)$"]({bb});'
         f'relation["boundary"="administrative"]["admin_level"~"^(9|10)$"]({bb});'
         f'way["landuse"="residential"]["name"]({bb});'
         f'node["manhole"]({bb});node["man_made"~"^(manhole|storm_drain)$"]({bb});'
         f'way["waterway"~"^(drain|canal|ditch)$"]({bb});'
         f');out geom tags;')
    last = None
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": q}, timeout=(10, 180), headers={"User-Agent": "SuriyacoMassFlow/0.2"})
            if r.status_code == 200:
                data = r.json()
                break
            last = f"HTTP {r.status_code} ({url.split('/')[2]})"
        except (requests.RequestException, ValueError) as e:
            last = f"{e} ({url.split('/')[2]})"
    else:
        raise RoadsError(f"OpenStreetMap (Overpass) no respondió: {last}")
    tol = 3.0 / 111320
    streets, polys, points, drains, canals = [], [], [], [], []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name") or ""
        if el["type"] == "node":
            if "place" in tags:
                if name:
                    points.append(dict(name=name, point=[round(el["lon"], 6), round(el["lat"], 6)], source="osm"))
            else:
                kind = tags.get("manhole") or tags.get("man_made")
                drains.append(dict(point=[round(el["lon"], 6), round(el["lat"], 6)],
                                   kind="pluvial" if kind in ("drain", "storm_drain") else
                                   "cloacal" if kind in ("sewer", "sewage") else "registro"))
            continue
        if el["type"] == "relation":
            if not name:
                continue
            rings = _rings([[(g["lon"], g["lat"]) for g in m.get("geometry") or []]
                            for m in el.get("members", []) if m.get("type") == "way" and m.get("role") in ("outer", "")])
            if rings:
                ring = max(rings, key=_ring_area)
                polys.append(dict(name=name, polygon=np.round(_simplify(ring[:-1], tol), 6).tolist(), source="osm"))
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        pts = [[g["lon"], g["lat"]] for g in geom]
        if "waterway" in tags:
            canals.append(dict(name=name or {"canal": "Canal", "drain": "Desagüe a cielo abierto"}.get(tags["waterway"], "Zanja"),
                               line=np.round(_simplify(pts, tol), 6).tolist(),
                               covered=tags.get("tunnel") not in (None, "no") or tags.get("covered") == "yes"))
            continue
        if "highway" in tags:
            cls = HIGHWAY.get(tags["highway"])
            if not cls:
                continue
            s = (tags.get("surface") or "").lower()
            paved = True if s in PAVED else False if s in UNPAVED else None
            streets.append(dict(id=el["id"], cls=cls, name=name or tags.get("ref") or "", paved=paved,
                                line=np.round(_simplify(pts, tol), 6).tolist()))
            continue
        if name and pts[0] == pts[-1] and len(pts) >= 4:
            polys.append(dict(name=name, polygon=np.round(_simplify(pts[:-1], tol), 6).tolist(), source="osm"))
    # un barrio puede estar como punto y como polígono: se queda el polígono
    from .scenario import points_in_polygon
    names = {b["name"].lower() for b in polys}
    keep = []
    for b in points:
        if b["name"].lower() in names:
            continue
        lo, la = b["point"]
        if any(points_in_polygon(np.array([lo]), np.array([la]), [tuple(q) for q in z["polygon"]])[0] for z in polys):
            continue
        keep.append(b)
    seen, uniq = set(), []
    for b in sorted(polys, key=lambda z: -_ring_area(z["polygon"])):
        if b["name"].lower() not in seen:
            seen.add(b["name"].lower())
            uniq.append(b)
    culverted = [c for c in canals if not c["covered"]]
    counts = dict(streets=len(streets), paved=sum(1 for s in streets if s["paved"] is True),
                  unpaved=sum(1 for s in streets if s["paved"] is False), barrios=len(uniq) + len(keep),
                  drains=len(drains), canals=len(culverted))
    return dict(streets=streets, barrios=uniq + keep, drains=drains, canals=culverted, counts=counts,
                source="© OpenStreetMap contributors (ODbL)")


# ───────────────────────── terreno: calles con cordón y canales
def _cells_along(px, py, dx, nx, ny, half):
    """Celdas (j, i) de una línea densificada con su ancho; sin saltos en diagonal (el agua corre por caras)."""
    i0 = np.rint(px / dx).astype(int)
    j0 = np.rint(py / dx).astype(int)
    di, dj = np.diff(i0), np.diff(j0)
    diag = np.nonzero((di != 0) & (dj != 0))[0]
    i0, j0 = np.r_[i0, i0[diag + 1]], np.r_[j0, j0[diag]]
    rad = int(math.ceil(max(half, 0.5 * dx) / dx))
    offs = [(a, b) for a in range(-rad, rad + 1) for b in range(-rad, rad + 1)
            if math.hypot(a, b) * dx <= max(half, 0.5 * dx) + 1e-6] or [(0, 0)]
    jj = np.concatenate([j0 + a for a, _ in offs])
    ii = np.concatenate([i0 + b for _, b in offs])
    ok = (jj >= 0) & (jj < ny) & (ii >= 0) & (ii < nx)
    return jj[ok], ii[ok]


def apply_streets(g, p):
    """Calzadas bajo el cordón y canales grabados en g['H_pre']. Devuelve (notas, avisos)."""
    o = options(p)
    g["urban_geo"] = None
    if not o:
        return [], []
    from scipy.ndimage import median_filter
    from .scenario import bilinear
    dx, ny, nx = g["dx"], g["ny"], g["nx"]
    H0 = g["H_pre"].astype(np.float64)
    H = H0.copy()
    tab = classes(o.get("classes"))
    assume = bool(o.get("assume_paved", True))
    curb = float(o.get("curb_m", 0.15))
    street = np.zeros((ny, nx), bool)
    paved = np.zeros((ny, nx), bool)
    geo, km = [], 0.0
    for r in o.get("streets") or []:
        c = tab.get(r.get("cls"))
        if c is None or not c["include"]:
            continue
        d = _densify(g, r["line"], dx / 2)
        if d is None:
            continue
        px, py, L = d
        inside = (px >= 0) & (py >= 0) & (px <= (nx - 1) * dx) & (py <= (ny - 1) * dx)
        if inside.sum() < 2:
            continue
        pv = r.get("paved")
        pv = assume if pv is None else bool(pv)
        geo.append(dict(px=px, py=py, cls=r["cls"], name=(r.get("name") or "").strip(), paved=pv))
        jj, ii = _cells_along(px[inside], py[inside], dx, nx, ny, c["width_m"] / 2)
        street[jj, ii] = True
        if pv:
            paved[jj, ii] = True
        km += float(inside.mean()) * L / 1000
    notes, warnings = [], []
    if km:
        if curb > 0:
            H[paved] -= curb
        notes.append(f"Calles: {km:.1f} km ({paved.sum() * dx * dx / 1e4:.1f} ha de calzada pavimentada"
                     + (f", {curb:g} m bajo el cordón" if curb > 0 else "") + ")")
        wmin = min(tab[k]["width_m"] for k in {r["cls"] for r in geo})
        if dx > 2 * wmin:
            warnings.append(f"Con dx = {dx:g} m cada calle ocupa una celda entera (más ancha que la real): el agua "
                            "corre por las calles, pero las profundidades son aproximadas. Para calles bien resueltas, "
                            "dx ≤ 5 m con un DEM de detalle (MDE-Ar 5 m o LiDAR como DEM propio).")
    ck = 0.0
    for c in o.get("canals") or []:
        d = _densify(g, c["line"], dx / 2)
        if d is None:
            continue
        px, py, L = d
        inside = (px >= 0) & (py >= 0) & (px <= (nx - 1) * dx) & (py <= (ny - 1) * dx)
        if inside.sum() < 2:
            continue
        px, py = px[inside], py[inside]
        ground = bilinear(H0, dx, px, py)
        win = max(3, int(round(60.0 / (dx / 2))) | 1)
        bed = median_filter(ground, size=min(win, ground.size | 1), mode="nearest") - float(c.get("depth_m", 1.5))
        jj, ii = _cells_along(px, py, dx, nx, ny, float(c.get("width_m", 4.0)) / 2)
        # cada celda recibe el lecho de la muestra más cercana a lo largo del canal
        from scipy.spatial import cKDTree
        _, near = cKDTree(np.c_[px / dx, py / dx]).query(np.c_[ii, jj])
        np.minimum.at(H, (jj, ii), bed[near])
        ck += float(inside.mean()) * L / 1000
    if ck:
        notes.append(f"Canales a cielo abierto: {ck:.1f} km grabados en el DEM")
    g["H_pre"] = H.astype(np.float32)
    g["street_mask"], g["street_paved"] = street, paved
    g["urban_geo"] = geo
    return notes, warnings


# ───────────────────────── sectores (barrios) y superficie
def grid(g, p):
    """Zona urbana, sectores de drenaje (barrios) y celdas de calle. None si no hay modo urbano."""
    o = options(p)
    if not o:
        return None
    from scipy.ndimage import binary_dilation
    from .scenario import zone_mask
    dx, ny, nx, fr = g["dx"], g["ny"], g["nx"], g["frame"]
    street = g.get("street_mask")
    if street is None:
        street = np.zeros((ny, nx), bool)
    paved = g.get("street_paved")
    if paved is None:
        paved = np.zeros((ny, nx), bool)
    area = np.zeros((ny, nx), bool)
    for z in p.get("exposure") or []:
        if len(z.get("polygon") or []) >= 3:
            area |= zone_mask(g, z["polygon"])
    drawn = area.any()
    lab = np.zeros((ny, nx), np.int32)
    sectors, warnings, notes = [], [], []
    barrios = o.get("barrios") or []
    for b in barrios:
        if len(b.get("polygon") or []) < 3:
            continue
        m = zone_mask(g, b["polygon"]) & (lab == 0)
        if m.any():
            lab[m] = len(sectors) + 1
            sectors.append(dict(name=b.get("name") or f"Barrio {len(sectors) + 1}", polygon=b["polygon"], src=b))
    area |= lab > 0
    if not drawn and street.any():
        # sin zona urbana dibujada: los barrios y el área a menos de 60 m de las calles
        r = max(1, int(round(60.0 / dx)))
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        area |= binary_dilation(street, structure=(xx ** 2 + yy ** 2) <= r * r)
        notes.append("Zona urbana tomada como los barrios y el área a menos de 60 m de las calles cargadas")
    if not area.any():
        raise ValueError("Inundación urbana: dibujá la zona urbana, cargá barrios o calles")
    pts = [b for b in barrios if b.get("point") and len(b.get("polygon") or []) < 3]
    if pts:
        from scipy.spatial import cKDTree
        rest = area & (lab == 0)
        jj, ii = np.nonzero(rest)
        P = np.array([fr.to_xy(*b["point"]) for b in pts], float)
        d, k = cKDTree(P).query(np.c_[ii * dx, jj * dx])
        ok = d <= 2000.0
        base = len(sectors)
        used = np.unique(k[ok])
        remap = {int(u): base + 1 + n for n, u in enumerate(used)}
        for u in used:
            sectors.append(dict(name=pts[u].get("name") or f"Barrio {len(sectors) + 1}", polygon=None, src=pts[u]))
        lab[jj[ok], ii[ok]] = np.array([remap[int(x)] for x in k[ok]], np.int32)
        if used.size:
            notes.append(f"{used.size} barrio{'s' if used.size > 1 else ''} sin límite (solo un punto): se asignó a cada "
                         "uno el área urbana más cercana (Voronoi), aproximada")
    rest = area & (lab == 0)
    if rest.any():
        lab[rest] = len(sectors) + 1
        sectors.append(dict(name="Resto de la zona urbana" if sectors else "Zona urbana", polygon=None, src={}))
    A = dx * dx
    zf = g["H_pre"].ravel()
    lab_f = lab.ravel()
    st_f = (street & area).ravel()
    for k, s in enumerate(sectors, 1):
        m = lab_f == k
        cells = np.nonzero(m & st_f)[0]
        if cells.size == 0:
            cells = np.nonzero(m)[0]  # sin calles cargadas: las bocas en todo el sector
        nlow = int(np.clip(round(cells.size * 0.03), 1, 30))
        low = cells[np.argsort(zf[cells])[:nlow]]
        src = s["src"]
        storm = src.get("storm_drain")
        s.update(area_m2=float(m.sum()) * A, cells=cells, low=low,
                 storm=bool(o["storm"]["enabled"] if storm is None else storm),
                 design_mm_h=float(src.get("design_mm_h") or o["storm"]["design_mm_h"]))
    blocks = area & ~street
    return dict(o=o, area=area, lab=lab, sectors=sectors, street=street, paved=paved, blocks=blocks,
                notes=notes, warnings=warnings)


def _surfaces(U):
    st, pv = U["street"], U["paved"]
    return ((U["blocks"], "blocks"), (st & ~pv, "unpaved"), (pv, "paved"))


def apply_surface(U, n=None, CN=None):
    """Rugosidad y CN de calzadas y manzanas (modifica los arreglos in situ)."""
    sf = U["o"]["surface"]
    for m, k in _surfaces(U):
        if n is not None:
            n[m] = sf[k]["manning"]
        if CN is not None:
            CN[m] = sf[k]["cn"]


def ks_factor(U):
    """Factor de la conductividad de Green-Ampt: 1 fuera de la ciudad, el de cada superficie adentro."""
    f = np.ones(U["lab"].shape)
    for m, k in _surfaces(U):
        f[m] = U["o"]["surface"][k]["ks_factor"]
    return f


# ───────────────────────── redes de desagüe
class UrbanNet:
    """Red pluvial y cloacal por sector, como depósitos con capacidad de conducción (modelo agregado 1D–2D)."""

    def __init__(self, U, dx, frame, nx):
        o = U["o"]
        self.U, self.dx, self.A = U, dx, dx * dx
        S = self.S = len(U["sectors"])
        sec = U["sectors"]
        self.area = np.array([s["area_m2"] for s in sec])
        self.ci = np.concatenate([s["cells"] for s in sec])
        self.cs = np.concatenate([np.full(s["cells"].size, k) for k, s in enumerate(sec)])
        self.lab_f = U["lab"].ravel() - 1  # sector de cada celda (−1 fuera de la zona urbana)
        self.in_area = self.lab_f >= 0
        self.low = [s["low"] for s in sec]
        so, se = o["storm"], o["sewer"]
        self.storm_on = np.array([s["storm"] for s in sec])
        self.sewer = bool(se["enabled"])
        self.outlet = None
        if so.get("outlet") and self.storm_on.any():
            x, y = frame.to_xy(*so["outlet"])
            i, j = int(round(x / dx)), int(round(y / dx))
            ny = U["lab"].shape[0]
            if 0 <= i < nx and 0 <= j < ny:
                self.outlet = j * nx + i
        mmh = 1 / 1000 / 3600
        self.st = dict(q=np.array([s["design_mm_h"] for s in sec]) * mmh * self.area * self.storm_on,
                       vmax=float(so["storage_mm"]) / 1000 * self.area * self.storm_on,
                       Lw=float(so["inlet_m_per_100m"]) * dx / 100, frac=float(so["direct_fraction"]))
        self.sw = dict(q=float(se["capacity_mm_h"]) * mmh * self.area, vmax=float(se["storage_mm"]) / 1000 * self.area,
                       a=0.6 * float(se["lid_area_m2"]) * dx / float(se["manhole_spacing_m"]),
                       frac=float(se["rdii_fraction"]), h0=float(se["ingress_depth_m"]))
        for d in (self.st, self.sw):
            d.update(V=np.zeros(S), t_full=np.full(S, np.nan), full_s=np.zeros(S), peak=np.zeros(S),
                     captured=np.zeros(S), direct=np.zeros(S), conveyed=np.zeros(S), surcharge=np.zeros(S),
                     low_vol=[np.zeros(lw.size) for lw in self.low])
        self.series = dict(t=[], storm=[], sewer=[])

    def _system(self, d, h, hc, pot, direct, dt, t, contaminated):
        """Un paso de una red: conexiones directas, captación limitada por la capacidad, conducción y sobrecarga."""
        A, S = self.A, self.S
        room = np.maximum(d["vmax"] - d["V"], 0) + d["q"] * dt
        d_in = np.minimum(direct, room)
        over = direct - d_in
        room -= d_in
        potS = np.bincount(self.cs, pot, minlength=S)
        f = np.where(potS > 0, np.clip(room / np.maximum(potS, 1e-12), 0, 1), 0.0)
        cap = pot * f[self.cs]
        if cap.any():
            hh = h[self.ci]
            r = np.where(hh > 1e-9, cap / A / np.maximum(hh, 1e-9), 0)
            h[self.ci] = np.maximum(hh - cap / A, 0)
            if hc is not None:
                hc[self.ci] *= 1 - np.clip(r, 0, 1)
        capS = np.bincount(self.cs, cap, minlength=S)
        d["V"] += d_in + capS
        out = np.minimum(d["V"], d["q"] * dt)
        d["V"] -= out
        d["captured"] += capS
        d["direct"] += d_in
        d["conveyed"] += out
        # sobrecarga: lo que no entra sale por las bocas más bajas del sector
        for k in np.nonzero(over > 1e-9)[0]:
            lw = self.low[k]
            v = over[k] / lw.size
            h[lw] += v / A
            if contaminated and hc is not None:
                hc[lw] += v / A
            d["low_vol"][k] += v
        d["surcharge"] += over
        fill = np.where(d["vmax"] > 0, d["V"] / np.maximum(d["vmax"], 1e-12), 0)
        np.maximum(d["peak"], fill, out=d["peak"])
        # colapso: la red llena no puede recibir todo lo que le llega
        full = (d["q"] > 0) & (fill >= 0.95) & ((over > 1e-9) | (f < 0.999) & (potS > 1e-6))
        d["t_full"] = np.where(np.isnan(d["t_full"]) & full, t, d["t_full"])
        d["full_s"] += np.where(full, dt, 0)
        return out

    def step(self, h2, hc2, dP_mm, dt, t):
        h = h2.ravel()
        hc = hc2.ravel() if hc2 is not None else None
        A = self.A
        rain = max(dP_mm, 0.0) / 1000
        # red pluvial: bocas de tormenta como vertedero en las celdas de calle
        on = self.storm_on[self.cs]
        if on.any():
            hh = h[self.ci]
            pot = np.where(on, np.minimum(1.66 * self.st["Lw"] * hh ** 1.5 * dt, 0.9 * hh * A), 0)
            direct = self._take_direct(h, hc, self.st["frac"] * rain, self.storm_on)
            out = self._system(self.st, h, hc, pot, direct, dt, t, contaminated=False)
            if self.outlet is not None:
                h[self.outlet] += out.sum() / A
        # red cloacal: conexiones clandestinas y tapas de registro anegadas
        if self.sewer:
            hh = h[self.ci]
            pot = np.where(hh > self.sw["h0"], np.minimum(self.sw["a"] * np.sqrt(2 * G * hh) * dt, 0.9 * hh * A), 0)
            direct = self._take_direct(h, hc, self.sw["frac"] * rain, np.ones(self.S, bool))
            self._system(self.sw, h, hc, pot, direct, dt, t, contaminated=True)

    def _take_direct(self, h, hc, depth, sectors_on):
        """Lluvia que va directo a la red (techos conectados): se descuenta de la superficie. Volumen por sector."""
        if depth <= 0:
            return np.zeros(self.S)
        m = self.in_area & sectors_on[np.maximum(self.lab_f, 0)]
        idx = np.nonzero(m)[0]
        d = np.minimum(h[idx], depth)
        if hc is not None:
            hc[idx] *= np.where(h[idx] > 1e-9, 1 - d / np.maximum(h[idx], 1e-9), 1)
        h[idx] -= d
        return np.bincount(self.lab_f[idx], d * self.A, minlength=self.S)

    def record(self, t):
        self.series["t"].append(round(t, 1))
        for key, d in (("storm", self.st), ("sewer", self.sw)):
            fill = np.where(d["vmax"] > 0, d["V"] / np.maximum(d["vmax"], 1e-12), 0)
            self.series[key].append(np.round(fill, 3).tolist())


# ───────────────────────── informe: barrios y calles afectadas
def report(g, U, net, fields, p):
    dx, ny, nx, fr = g["dx"], g["ny"], g["nx"], g["frame"]
    A = dx * dx
    h, v, hv = fields["max_depth"], fields["max_speed"], fields["max_hv"]
    arr, wt = fields.get("arrival"), fields.get("wet_time")
    sew = fields.get("max_sewage")
    lab = U["lab"]
    S = len(U["sectors"])
    names = [s["name"] for s in U["sectors"]]
    tab = classes(U["o"].get("classes"))
    step = dx / 2
    streets, segs = {}, []
    sec_streets = [dict() for _ in range(S)]
    for r in g.get("urban_geo") or []:
        inside = (r["px"] >= 0) & (r["py"] >= 0) & (r["px"] <= (nx - 1) * dx) & (r["py"] <= (ny - 1) * dx)
        i = np.clip(np.rint(r["px"] / dx).astype(int), 0, nx - 1)
        j = np.clip(np.rint(r["py"] / dx).astype(int), 0, ny - 1)
        d = np.where(inside, h[j, i], 0.0)
        vv, dv = v[j, i], hv[j, i]
        hz = hazard_class(d, vv, dv)
        sk = lab[j, i] - 1
        key = r["name"] or f"(sin nombre) · {tab[r['cls']]['name']}"
        e = streets.setdefault(key, dict(name=r["name"] or "(sin nombre)", cls=r["cls"], km=0.0, paved_km=0.0,
                                         max_depth_m=0.0, max_speed_m_s=0.0, hazard=0, first_s=None, barrios=set(),
                                         **{f"{k}_km": 0.0 for _, k, _ in THRESHOLDS}))
        e["km"] += float(inside.sum()) * step / 1000
        if r["paved"]:
            e["paved_km"] += float(inside.sum()) * step / 1000
        for thr, k, _ in THRESHOLDS:
            e[f"{k}_km"] += float((d > thr).sum()) * step / 1000
        wet = d > 0.15
        if wet.any():
            e["max_depth_m"] = max(e["max_depth_m"], float(d[wet].max()))
            e["max_speed_m_s"] = max(e["max_speed_m_s"], float(vv[wet].max()))
            e["hazard"] = max(e["hazard"], int(hz[wet].max()))
            if arr is not None:
                ta = arr[j[wet], i[wet]]
                ta = ta[ta >= 0]
                if ta.size:
                    e["first_s"] = float(ta.min()) if e["first_s"] is None else min(e["first_s"], float(ta.min()))
            for k in np.unique(sk[wet]):
                if k >= 0:
                    e["barrios"].add(names[k])
                    km = float((wet & (sk == k)).sum()) * step / 1000
                    sec_streets[k][e["name"]] = sec_streets[k].get(e["name"], 0.0) + km
            k = np.nonzero(np.diff(np.r_[0, wet.astype(int), 0]))[0]
            for a, b in zip(k[::2], k[1::2]):
                if b - a < 2:
                    continue
                lon, lat = fr.to_lonlat(r["px"][a:b], r["py"][a:b])
                sel = slice(None, None, max(1, (b - a) // 30))
                segs.append(dict(name=e["name"], km=round((b - a) * step / 1000, 3), max_depth_m=round(float(d[a:b].max()), 2),
                                 hazard=int(hz[a:b].max()),
                                 line=np.round(np.c_[lon, lat][sel], 6).tolist() + [[round(float(lon[-1]), 6), round(float(lat[-1]), 6)]]))
    rows = []
    for e in streets.values():
        e["barrios"] = sorted(e["barrios"])
        rows.append({a: (round(x, 3 if a.endswith("_km") or a == "km" else 2) if isinstance(x, float) else x) for a, x in e.items()})
    affected = sorted([r for r in rows if r["cordon_km"] > 0], key=lambda r: (-r["hazard"], -r["cordon_km"]))
    segs.sort(key=lambda s: -s["max_depth_m"])

    # edificios (elementos expuestos) por barrio
    bpts = p.get("exposure_points") or []
    b_sec, b_wet = np.zeros(0, int), np.zeros(0, bool)
    if bpts:
        P = np.asarray(bpts, float)
        x, y = fr.to_xy(P[:, 0], P[:, 1])
        bi = np.clip(np.rint(np.asarray(x) / dx).astype(int), 0, nx - 1)
        bj = np.clip(np.rint(np.asarray(y) / dx).astype(int), 0, ny - 1)
        b_sec, b_wet = lab[bj, bi] - 1, h[bj, bi] > 0.15

    st, sw = net.st, net.sw
    poly_lab = None
    barrios = []
    for k, s in enumerate(U["sectors"]):
        m = lab == k + 1
        a = float(m.sum()) * A
        wet = m & (h > 0.1)
        deep = m & (h > 0.3)
        fl_ha = float(wet.sum()) * A / 1e4
        pct = fl_ha * 1e4 / a * 100 if a else 0
        deep_pct = float(deep.sum()) * A / a * 100 if a else 0
        hmax = float(h[m].max()) if m.any() else 0
        deep_ha = float(deep.sum()) * A / 1e4
        sev = "Alta" if pct >= 25 or deep_pct >= 5 else "Media" if pct >= 5 or deep_ha >= 0.1 \
            else "Baja" if fl_ha > 0 else "Sin afectación"
        hz = hazard_class(h[wet], v[wet], hv[wet]) if wet.any() else np.zeros(0)
        polygon = s["polygon"]
        if polygon is None:
            if poly_lab is None:
                from .hydro import label_polygons
                poly_lab = label_polygons(lab, dx, fr)
            parts = poly_lab.get(k + 1) or []
            polygon = [pp[0] for pp in parts]
        else:
            polygon = [polygon]
        tf = lambda d: None if np.isnan(d["t_full"][k]) else round(float(d["t_full"][k]) / 3600, 2)
        ss = sorted(sec_streets[k].items(), key=lambda t: -t[1])
        barrios.append(dict(
            name=s["name"], area_ha=round(a / 1e4, 1), flooded_ha=round(fl_ha, 2), flooded_pct=round(pct, 1),
            deep_ha=round(deep_ha, 2), max_depth_m=round(hmax, 2),
            max_speed_m_s=round(float(v[wet].max()), 2) if wet.any() else 0.0,
            hazard=int(hz.max()) if hz.size else 0,
            mean_wet_h=round(float(wt[wet].mean()), 1) if wt is not None and wet.any() else 0.0,
            first_h=round(float(arr[m & (arr >= 0)].min()) / 3600, 2) if arr is not None and (m & (arr >= 0)).any() else None,
            streets_affected=len(ss), streets_km=round(sum(x for _, x in ss), 2), streets=[n for n, _ in ss[:25]],
            sewage_ha=round(float((m & (sew > 0.05) & (h > 0.05)).sum()) * A / 1e4, 2) if sew is not None else 0.0,
            buildings=int((b_sec == k).sum()), buildings_wet=int(((b_sec == k) & b_wet).sum()),
            severity=sev, polygon=polygon,
            storm=dict(exists=bool(net.storm_on[k]), design_mm_h=s["design_mm_h"] if net.storm_on[k] else None,
                       collapse_h=tf(st), full_h=round(float(st["full_s"][k]) / 3600, 2), peak_fill=round(float(st["peak"][k]), 2),
                       captured_m3=round(float(st["captured"][k] + st["direct"][k]), 0),
                       surcharge_m3=round(float(st["surcharge"][k]), 0)),
            sewer=dict(exists=net.sewer, collapse_h=tf(sw), full_h=round(float(sw["full_s"][k]) / 3600, 2),
                       peak_fill=round(float(sw["peak"][k]), 2), inflow_m3=round(float(sw["captured"][k] + sw["direct"][k]), 0),
                       overflow_m3=round(float(sw["surcharge"][k]), 0)),
        ))
    order = {"Alta": 0, "Media": 1, "Baja": 2, "Sin afectación": 3}
    barrios.sort(key=lambda b: (order[b["severity"]], -b["flooded_ha"]))

    overflows = []
    for key, d in (("pluvial", st), ("cloacal", sw)):
        for k, lw in enumerate(net.low):
            for c, vol in zip(lw, d["low_vol"][k]):
                if vol >= 1.0:
                    jj, ii = divmod(int(c), nx)
                    lon, lat = fr.to_lonlat(ii * dx, jj * dx)
                    overflows.append(dict(kind=key, barrio=names[k], volume_m3=round(float(vol), 1),
                                          point=[round(float(lon), 6), round(float(lat), 6)]))
    overflows.sort(key=lambda x: -x["volume_m3"])
    tot = lambda d, k: round(float(d[k].sum()), 0)
    totals = dict(
        area_ha=round(float(U["area"].sum()) * A / 1e4, 1),
        flooded_ha=round(float((U["area"] & (h > 0.1)).sum()) * A / 1e4, 2),
        barrios_affected=sum(1 for b in barrios if b["severity"] != "Sin afectación"),
        streets_affected=len(affected), streets_cordon_km=round(sum(r["cordon_km"] for r in affected), 2),
        streets_autos_km=round(sum(r["autos_km"] for r in affected), 2),
        storm_captured_m3=round(float(st["captured"].sum() + st["direct"].sum()), 0), storm_conveyed_m3=tot(st, "conveyed"),
        storm_surcharge_m3=tot(st, "surcharge"),
        storm_sectors=int(net.storm_on.sum()), storm_collapsed=int(np.isfinite(st["t_full"]).sum()),
        sewer_inflow_m3=round(float(sw["captured"].sum() + sw["direct"].sum()), 0), sewer_overflow_m3=tot(sw, "surcharge"),
        sewer_collapsed=int(np.isfinite(sw["t_full"]).sum()) if net.sewer else 0,
        sewage_ha=round(float((U["area"] & (sew > 0.05) & (h > 0.05)).sum()) * A / 1e4, 2) if sew is not None else 0.0,
        storm_outlet=bool(net.outlet is not None),
    )
    return dict(barrios=barrios, streets=affected[:400], streets_total=len(rows), segments=segs[:800],
                overflows=overflows[:300], totals=totals,
                series=dict(t_h=[round(x / 3600, 3) for x in net.series["t"]], storm=net.series["storm"],
                            sewer=net.series["sewer"], names=names),
                thresholds=[dict(key=k, depth_m=t, name=n) for t, k, n in THRESHOLDS],
                hazard=[dict(k=k, name=n) for k, *_, n in HAZARD],
                criteria="Profundidad máxima sobre la calzada; anegado = h > 0,10 m. Peligrosidad H1–H6 con los máximos "
                         "de h, v y h·v (Smith et al. 2014; Australian Rainfall and Runoff 2019). Las redes se representan "
                         "como depósitos por barrio (capacidad y volumen de conductos), no como una red de caños.")
