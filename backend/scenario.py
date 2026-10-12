"""Construcción del escenario: grilla de columnas, masa de desprendimiento, lecho erosionable y salida binaria.

Convención de arreglos 2D: shape (ny, nx), índice [j, i]; el nodo (i, j) está en x = i*dx, y = j*dx
(metros, origen en la esquina SO del BBox). Se aplanan fila por fila (j*nx + i).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from .dem import LocalFrame, sample_dem

RHO_W = 1000.0


def estimate_nz(H, dx, extra_depth, headroom):
    return int(math.ceil((float(H.max()) - float(H.min()) + extra_depth + headroom) / dx)) + 8


def build_grid(arr, transform, bbox, dx):
    fr = LocalFrame(bbox)
    nx = max(8, int(fr.Lx // dx) + 1)
    ny = max(8, int(fr.Ly // dx) + 1)
    xs = np.arange(nx) * dx
    ys = np.arange(ny) * dx
    X, Y = np.meshgrid(xs, ys)
    lon, lat = fr.to_lonlat(X, Y)
    H = sample_dem(arr, transform, lon, lat).astype(np.float32)
    return dict(frame=fr, nx=nx, ny=ny, dx=float(dx), H_pre=H)


def bilinear(A, dx, x, y):
    ny, nx = A.shape
    fx = np.clip(np.asarray(x) / dx, 0, nx - 1.000001)
    fy = np.clip(np.asarray(y) / dx, 0, ny - 1.000001)
    i0 = np.floor(fx).astype(int)
    j0 = np.floor(fy).astype(int)
    tx = fx - i0
    ty = fy - j0
    a = A[j0, i0] * (1 - tx) + A[j0, i0 + 1] * tx
    b = A[j0 + 1, i0] * (1 - tx) + A[j0 + 1, i0 + 1] * tx
    return a * (1 - ty) + b * ty


def points_in_polygon(px, py, poly):
    inside = np.zeros(px.shape, bool)
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        cond = ((yi > py) != (yj > py)) & (px < (xj - xi) * (py - yi) / (yj - yi + 1e-30) + xi)
        inside ^= cond
        j = i
    return inside


def distance_to_boundary(px, py, poly):
    d = np.full(px.shape, np.inf)
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy + 1e-30
        t = np.clip(((px - ax) * vx + (py - ay) * vy) / L2, 0, 1)
        d = np.minimum(d, np.hypot(px - (ax + t * vx), py - (ay + t * vy)))
    return d


def default_source(g):
    """Ladera alta y empinada, lejos de los bordes."""
    H = g["H_pre"]
    ny, nx = H.shape
    gy, gx = np.gradient(H, g["dx"])
    slope = np.hypot(gx, gy)
    interior = np.zeros_like(H, bool)
    interior[int(ny * 0.2):int(ny * 0.8), int(nx * 0.2):int(nx * 0.8)] = True
    score = np.where(interior & (H >= np.percentile(H[interior], 60)), slope, -1)
    j, i = np.unravel_index(np.argmax(score), score.shape)
    return i * g["dx"], j * g["dx"]


def release_polygon_xy(g, p):
    fr = g["frame"]
    poly = p.get("release_polygon")
    if poly and len(poly) >= 3:
        x, y = fr.to_xy([q[0] for q in poly], [q[1] for q in poly])
        return list(zip(x.tolist(), y.tolist())), "polígono"
    if p.get("source_lon") is not None and p.get("source_lat") is not None:
        cx, cy = fr.to_xy(p["source_lon"], p["source_lat"])
        cx, cy = float(cx), float(cy)
    else:
        cx, cy = default_source(g)
    r = float(p.get("release_radius_m", 200.0))
    a = np.linspace(0, 2 * np.pi, 64, endpoint=False)
    return list(zip((cx + r * np.cos(a)).tolist(), (cy + r * np.sin(a)).tolist())), "círculo"


def build_release(g, p, H_surf=None):
    """Masa de desprendimiento con espesor espacialmente variable.

    El DEM pre-evento contiene la masa: la superficie de rotura (lecho) es H_pre - h.
    Las partículas llenan el espacio entre el lecho y la superficie original, por lo que
    el volumen es real (no se apila material encima del terreno).
    """
    dx = g["dx"]
    ppc = int(p.get("ppc", 3))
    s = dx / ppc
    poly, kind = release_polygon_xy(g, p)
    h_given = p.get("_h_node")  # espesor ya calculado por nodo (p. ej. celdas que fallan por lluvia)
    P = np.array(poly)
    x0, y0 = P.min(0)
    x1, y1 = P.max(0)
    Lx, Ly = (g["nx"] - 1) * dx, (g["ny"] - 1) * dx
    if x1 < 0 or y1 < 0 or x0 > Lx or y0 > Ly:
        raise ValueError("El área de desprendimiento está fuera de la zona de cálculo")

    sx = np.arange(x0 + s / 2, x1, s)
    sy = np.arange(y0 + s / 2, y1, s)
    SX, SY = np.meshgrid(sx, sy)
    SX, SY = SX.ravel(), SY.ravel()
    inside = points_in_polygon(SX, SY, poly)
    SX, SY = SX[inside], SY[inside]
    if SX.size == 0:
        raise ValueError("El área de desprendimiento es menor que el espaciado de partículas; reducí dx o agrandá el área")
    if h_given is not None:
        # solo las partículas sobre celdas que se desprenden (con un margen de media celda)
        on = bilinear(np.asarray(h_given, np.float32), dx, SX, SY) > 0
        SX, SY = SX[on], SY[on]
    area = SX.size * s * s

    profile = p.get("thickness_profile", "dome")

    def shape(px, py):
        if profile == "uniform":
            return np.ones(px.shape)
        d = distance_to_boundary(px, py, poly)
        dmax = max(float(distance_to_boundary(SX, SY, poly).max()), 1e-6)
        u = np.clip(d / dmax, 0, 1)
        return 1 - (1 - u) ** 2  # domo: 0 en el borde, máximo en el centro

    H0 = g["H_pre"] if H_surf is None else H_surf
    ny, nx = H0.shape
    if h_given is not None:
        h_node = np.asarray(h_given, np.float32)
        target_V = float(h_node.sum() * dx * dx)
        area = float((h_node > 0).sum() * dx * dx)
    else:
        f_pts = shape(SX, SY)
        if p.get("release_mode") == "volume" and p.get("release_volume_m3"):
            target_V = float(p["release_volume_m3"])
        else:
            target_V = float(p.get("release_thickness_m", 20.0)) * area
        k = target_V / max(1e-9, f_pts.sum() * s * s)

        # espesor en nodos de columna -> superficie de rotura
        NX, NY = np.meshgrid(np.arange(nx) * dx, np.arange(ny) * dx)
        h_node = np.zeros((ny, nx), np.float32)
        m = (NX >= x0 - dx) & (NX <= x1 + dx) & (NY >= y0 - dx) & (NY <= y1 + dx)
        sel = points_in_polygon(NX[m], NY[m], poly)
        vals = np.zeros(sel.shape)
        vals[sel] = k * shape(NX[m][sel], NY[m][sel])
        h_node[m] = vals
    H_bed = (H0 - h_node).astype(np.float32)

    top = bilinear(H0, dx, SX, SY)
    bot = bilinear(H_bed, dx, SX, SY)
    hh = top - bot
    keep = hh > 0.05 * s
    SX, SY, top, bot, hh = SX[keep], SY[keep], top[keep], bot[keep], hh[keep]
    nL = np.maximum(1, np.rint(hh / s)).astype(int)
    rep = np.repeat(np.arange(SX.size), nL)
    layer = np.concatenate([np.arange(n) for n in nL]) if nL.size else np.zeros(0, int)
    rng = np.random.default_rng(int(p.get("random_seed", 42)))
    jit = (rng.random((rep.size, 2)) - 0.5) * 0.3 * s
    px = SX[rep] + jit[:, 0]
    py = SY[rep] + jit[:, 1]
    pz = bot[rep] + (layer + 0.5) * hh[rep] / nL[rep]
    vol = s * s * hh[rep] / nL[rep]

    fr = g["frame"]
    cx, cy = float(P[:, 0].mean()), float(P[:, 1].mean())
    clon, clat = fr.to_lonlat(cx, cy)
    info = dict(kind=kind, area_m2=round(area, 1), target_volume_m3=round(target_V, 1),
                volume_m3=round(float(vol.sum()), 1),
                mean_thickness_m=round(float(vol.sum()) / max(area, 1e-9), 2),
                max_thickness_m=round(float(h_node.max()), 2),
                particles=int(px.size), spacing_m=round(s, 3),
                centroid_lon=round(float(clon), 6), centroid_lat=round(float(clat), 6),
                top_z=round(float(top.max()), 1))
    dev = abs(info["volume_m3"] - target_V) / max(target_V, 1e-9)
    info["discretization_error"] = round(dev, 3)
    return dict(x=px.astype(np.float32), y=py.astype(np.float32), z=pz.astype(np.float32),
                vol=vol.astype(np.float32), h_node=h_node, H_bed=H_bed, poly=poly,
                centroid=(cx, cy), info=info)


def _line_xy(g, line):
    fr = g["frame"]
    x, y = fr.to_xy([q[0] for q in line], [q[1] for q in line])
    return np.asarray(x), np.asarray(y)


def condition_terrain(g, p):
    """Acondiciona el DEM pre-evento: nivela lagos y graba cauces (stream burning).

    - lakes: [{polygon, level_m}] → la superficie del lago queda plana a level_m (espejo de agua).
    - burn_channels: [{line: [[lon, lat], ...] (aguas abajo), width_m, depth_m}] → el perfil del cauce
      se vuelve monótono decreciente (se eliminan diques falsos del DEM en angosturas no resueltas)
      y se profundiza depth_m en un ancho width_m.
    """
    H = g["H_pre"].copy()
    dx = g["dx"]
    ny, nx = H.shape
    notes = []
    for lk in p.get("lakes") or []:
        m = zone_mask(g, lk["polygon"])
        lvl = float(lk["level_m"])
        H[m] = lvl
        notes.append(f"Lago nivelado a {lvl:.0f} m ({m.sum() * dx * dx / 1e6:.2f} km²)")
    X, Y = np.meshgrid(np.arange(nx) * dx, np.arange(ny) * dx)
    for ch in p.get("burn_channels") or []:
        lx, ly = _line_xy(g, ch["line"])
        # densificar la polilínea a ~dx/2
        seg = np.hypot(np.diff(lx), np.diff(ly))
        s = np.r_[0, np.cumsum(seg)]
        ss = np.arange(0, s[-1], dx / 2)
        px, py = np.interp(ss, s, lx), np.interp(ss, s, ly)
        inside = (px >= 0) & (py >= 0) & (px <= (nx - 1) * dx) & (py <= (ny - 1) * dx)
        px, py = px[inside], py[inside]
        if px.size < 2:
            continue
        z = bilinear(H, dx, px, py)
        zc = np.minimum.accumulate(z) - float(ch.get("depth_m", 0.0))
        half = float(ch.get("width_m", 2 * dx)) / 2
        r = int(np.ceil(half / dx)) + 1
        lowered = 0
        for x0, y0, zz in zip(px, py, zc):
            i0, j0 = int(round(x0 / dx)), int(round(y0 / dx))
            sl = (slice(max(0, j0 - r), min(ny, j0 + r + 1)), slice(max(0, i0 - r), min(nx, i0 + r + 1)))
            d = np.hypot(X[sl] - x0, Y[sl] - y0)
            m = (d <= half) & (H[sl] > zz)
            lowered += int(m.sum())
            H[sl][m] = zz
        notes.append(f"Cauce grabado: {s[-1] / 1000:.1f} km, ancho {2 * half:.0f} m ({lowered} celdas corregidas)")
    # presas: el DEM de ~30 m no resuelve un muro de hormigón; se construye a la cota de coronamiento
    for dm in p.get("dams") or []:
        lx, ly = _line_xy(g, dm["line"])
        seg = np.hypot(np.diff(lx), np.diff(ly))
        s = np.r_[0, np.cumsum(seg)]
        ss = np.arange(0, s[-1] + dx / 4, dx / 4)
        px, py = np.interp(ss, s, lx), np.interp(ss, s, ly)
        crest = np.full(px.shape, float(dm["crest_m"]))
        for sp in dm.get("spillways") or []:  # tramos más bajos (vertedero), dados como fracción [desde, hasta] del eje
            m = (ss >= sp["from_frac"] * s[-1]) & (ss <= sp["to_frac"] * s[-1])
            crest[m] = float(sp["crest_m"])
        half = float(dm.get("width_m", 2 * dx)) / 2
        r = int(np.ceil(half / dx)) + 1
        raised = 0
        for x0, y0, zc in zip(px, py, crest):
            i0, j0 = int(round(x0 / dx)), int(round(y0 / dx))
            sl = (slice(max(0, j0 - r), min(ny, j0 + r + 1)), slice(max(0, i0 - r), min(nx, i0 + r + 1)))
            d = np.hypot(X[sl] - x0, Y[sl] - y0)
            m = (d <= half) & (H[sl] < zc)
            raised += int(m.sum())
            H[sl][m] = zc
        notes.append(f"Paredón construido: coronamiento {float(dm['crest_m']):.0f} m, {s[-1]:.0f} m de eje, ancho {2 * half:.0f} m"
                     + (f", vertedero a {dm['spillways'][0]['crest_m']:.0f} m" if dm.get("spillways") else "") + f" ({raised} celdas)")
    g["H_pre"] = H.astype(np.float32)
    return notes


def build_bodies(g, p):
    """Varios cuerpos iniciales (p. ej. hielo/roca de la pared + agua del lago), tallados en orden sobre el DEM.

    Cada cuerpo: {name, kind: "granular"|"water", polygon, release_mode, thickness_m, volume_m3, profile,
    density, friction_angle_deg, basal_friction_deg, pore_ratio_initial}. Devuelve un dict compatible con
    build_release, con propiedades por partícula.
    """
    import math as _m
    H = g["H_pre"]
    keys = ("x", "y", "z", "vol", "mat", "rho", "tphi", "tdelta", "lam0", "flag", "J0", "ixi")
    acc = {k: [] for k in keys}
    h_tot = np.zeros_like(H)
    h_solid = np.zeros_like(H)  # solo cuerpos granulares: el lecho bajo un lago sí puede erosionarse
    infos, polys = [], []
    K = float(p.get("water_bulk_modulus", 4e6))
    rho_mix, lam_eq = mixture(p)
    for b in p["bodies"]:
        b = {k: v for k, v in b.items() if v is not None}  # opcionales vacíos → valores globales
        q = dict(p, release_polygon=b["polygon"], release_mode=b.get("release_mode", "thickness"),
                 release_thickness_m=b.get("thickness_m", 10.0), release_volume_m3=b.get("volume_m3"),
                 thickness_profile=b.get("profile", "dome"))
        trig = None
        if b.get("rain") and b.get("kind") != "water":
            # deslizamiento disparado por lluvia: la zona es de búsqueda; se desprende lo que falla
            trig = rain_failure(g, H, b["polygon"], b["rain"], p)
            if not trig["fails"]:
                raise ValueError(trig["message"])
            q["_h_node"] = trig["h_node"]
            b.setdefault("density", trig["rho"])
            b.setdefault("pore_ratio_initial", trig["lam0"])
        rel = build_release(g, q, H_surf=H)
        H = rel["H_bed"]
        h_tot += rel["h_node"]
        n = rel["x"].size
        water = b.get("kind") == "water"
        if not water:
            h_solid += rel["h_node"]
        top = bilinear(H + rel["h_node"], g["dx"], rel["x"], rel["y"])
        acc["x"].append(rel["x"]); acc["y"].append(rel["y"]); acc["z"].append(rel["z"]); acc["vol"].append(rel["vol"])
        acc["mat"].append(np.full(n, 1 if water else 0, np.int32))
        rho_b = 1000.0 if water else float(b.get("density", rho_mix))
        acc["rho"].append(np.full(n, rho_b, np.float32))
        acc["tphi"].append(np.full(n, _m.tan(_m.radians(b.get("friction_angle_deg", p["friction_angle_deg"]))), np.float32))
        acc["tdelta"].append(np.full(n, _m.tan(_m.radians(b.get("basal_friction_deg", p["basal_friction_deg"]))), np.float32))
        lam0 = b.get("pore_ratio_initial")
        acc["lam0"].append(np.full(n, 0.0 if water else (lam_eq if lam0 is None else float(lam0)), np.float32))
        acc["flag"].append(np.full(n, 2 if water else 0, np.int32))
        J0 = 1.0 - 1000.0 * 9.81 * np.maximum(top - rel["z"], 0) / K if water else np.ones(n)
        acc["J0"].append(np.clip(J0, 0.7, 1.0).astype(np.float32))
        xi = float(b.get("turbulence_xi", p.get("turbulence_xi", 0.0)) or 0.0)
        acc["ixi"].append(np.full(n, 1.0 / xi if xi > 0 else 0.0, np.float32))
        infos.append(dict(rel["info"], name=b.get("name", "Cuerpo"), material="agua" if water else "granular",
                          density=rho_b, **({"trigger": trig["info"]} if trig else {})))
        polys.append(rel["poly"])
    out = {k: np.concatenate(v) for k, v in acc.items()}
    first = next((i for i, b in enumerate(p["bodies"]) if b.get("kind") != "water"), 0)
    fi = infos[first]
    info = dict(fi, kind="cuerpos", volume_m3=round(sum(i["volume_m3"] for i in infos if i["material"] != "agua"), 1),
                water_volume_m3=round(sum(i["volume_m3"] for i in infos if i["material"] == "agua"), 1),
                particles=int(out["x"].size), top_z=max(i["top_z"] for i in infos),
                max_thickness_m=max(i["max_thickness_m"] for i in infos), bodies=infos)
    fr = g["frame"]
    cx, cy = fr.to_xy(fi["centroid_lon"], fi["centroid_lat"])
    out.update(h_node=h_tot, h_solid=h_solid, H_bed=H, poly=polys[first], polys=polys, centroid=(float(cx), float(cy)), info=info)
    return out


G = 9.81


def contributing_area(H, dx):
    """Área de aporte (m²) por celda con flujo multidireccional (Quinn et al. 1991; MFD, exponente 1.1).

    Se procesan las celdas de mayor a menor cota y cada una reparte su área entre los vecinos más bajos
    en proporción a la pendiente. Incluye el área de la propia celda."""
    ny, nx = H.shape
    Hp = np.pad(H.astype(np.float64), 1, mode="edge")
    offs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    W = np.zeros((8, ny, nx))
    for k, (dj, di) in enumerate(offs):
        L = dx * (math.sqrt(2) if dj and di else 1.0)
        drop = (H - Hp[1 + dj:1 + dj + ny, 1 + di:1 + di + nx]) / L
        W[k] = np.where(drop > 0, np.maximum(drop, 0) ** 1.1 * (0.354 if dj and di else 0.5) * dx, 0)
    tot = W.sum(0)
    W = np.where(tot > 0, W / np.where(tot > 0, tot, 1), 0).reshape(8, -1)
    acc = np.full(ny * nx, dx * dx)
    nb = [dj * nx + di for dj, di in offs]
    jj, ii = np.divmod(np.arange(ny * nx), nx)
    order = np.argsort(-H.ravel(), kind="stable")
    valid = [((jj + dj >= 0) & (jj + dj < ny) & (ii + di >= 0) & (ii + di < nx)) for dj, di in offs]
    for c in order:
        a = acc[c]
        for k in range(8):
            w = W[k, c]
            if w > 0 and valid[k][c]:
                acc[c + nb[k]] += a * w
    return acc.reshape(ny, nx)


def _clusters(mask, min_cells):
    """Quita grupos de celdas conectadas (8 vecinos) con menos de min_cells celdas."""
    try:
        from scipy import ndimage
        lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
        if n == 0:
            return mask, 0
        sizes = np.bincount(lab.ravel())
        keep = sizes >= min_cells
        keep[0] = False
        return keep[lab], int(keep.sum())
    except ImportError:
        return mask, -1


def rain_failure(g, H, polygon_lonlat, rain, p):
    """Deslizamiento superficial disparado por lluvia acumulada (modelo de talud infinito + SHALSTAB).

    Montgomery y Dietrich (1994): la lluvia que se infiltra (más el deshielo) fluye ladera abajo por el suelo
    con transmisividad T. En régimen estacionario, la fracción saturada del espesor de suelo es
        W = min(1, q·a / (T·b·sen β)),   q = (lluvia + deshielo)·f_inf / días
    con a el área de aporte y b el ancho de celda: las hondonadas, que reciben agua de más superficie, se saturan antes.
    Factor de seguridad del talud infinito (suelo de espesor vertical z, nivel freático a W·z sobre la rotura):
        FS = c' / (γ z cos β sen β) + (1 − W γw/γ) tan φ' / tan β
    Fallan las celdas de la zona con FS < 1. El volumen resulta de la lluvia, el relieve y el suelo.
    """
    dx = g["dx"]
    r = {k: v for k, v in rain.items() if v is not None}
    P = float(r.get("rain_mm", 150.0))
    melt = float(r.get("melt_mm", 0.0))
    days = max(0.1, float(r.get("days", 3.0)))
    finf = float(r.get("infiltration", 0.7))
    z = float(r.get("soil_depth_m", 6.0))
    T = float(r.get("transmissivity_m2_day", 20.0))
    c = float(r.get("cohesion_kpa", 5.0)) * 1000.0
    phi = math.radians(float(r.get("friction_angle_deg", 35.0)))
    S0 = float(r.get("initial_saturation", 0.3))
    smin, smax = float(r.get("min_slope_deg", 15.0)), float(r.get("max_slope_deg", 50.0))
    n = float(r.get("porosity", p.get("porosity", 0.35)))
    rho_s = float(p.get("density_solid", 2650.0))

    zone = zone_mask(g, polygon_lonlat)
    if not zone.any():
        raise ValueError("La zona de búsqueda del deslizamiento está fuera de la zona de cálculo")
    gy, gx = np.gradient(H.astype(np.float64), dx)
    beta = np.arctan(np.hypot(gx, gy))
    a = contributing_area(H, dx)
    q = (P + melt) / 1000.0 * finf / days                       # recarga efectiva (m/día)
    sinb, cosb, tanb = np.sin(beta), np.cos(beta), np.tan(beta)
    Wt = np.clip(q * a / (T * dx * np.maximum(sinb, 1e-3)), 0, 1)  # fracción saturada
    rho_wet = lambda W: rho_s * (1 - n) + RHO_W * n * (W + (1 - W) * S0)
    gam = G * rho_wet(Wt)
    with np.errstate(divide="ignore", invalid="ignore"):
        C = c / (gam * z * cosb * sinb)
        B = math.tan(phi) / tanb
        FS = C + (1 - Wt * RHO_W * G / gam) * B
        # fracción saturada y lluvia que harían FS = 1 (lluvia crítica)
        gam1 = G * rho_wet(1.0)
        Wc = (c / (gam1 * z * cosb * sinb) + B - 1) / (RHO_W * G / gam1 * B)
        Pc = Wc * T * dx * sinb / a * days / finf * 1000.0 - melt
    slope_ok = (beta >= math.radians(smin)) & (beta <= math.radians(smax))
    # cauces: con mucha área de aporte el agua corre en superficie sobre roca o grava, no es ladera con suelo
    channel = a > float(r.get("channel_area_m2", 20000.0))
    cand = zone & slope_ok & ~channel
    fail_raw = cand & (FS < 1.0)
    fail, nclus = _clusters(fail_raw, int(r.get("min_cells", 3)))
    unconditional = cand & (Wc <= 0)
    stable_always = cand & (Wc > 1)
    h_node = np.where(fail, z, 0.0).astype(np.float32)
    A = dx * dx
    Wf = Wt[fail] if fail.any() else np.array([0.0])
    rho_f = float(rho_wet(Wf.mean()))
    info = dict(
        rain_mm=P, melt_mm=melt, days=days, infiltration=finf, recharge_mm_day=round(q * 1000, 1),
        soil_depth_m=z, transmissivity_m2_day=T, cohesion_kpa=c / 1000, friction_angle_deg=math.degrees(phi),
        zone_area_m2=round(float(zone.sum() * A), 0), candidate_area_m2=round(float(cand.sum() * A), 0),
        channel_area_m2=round(float((zone & channel).sum() * A), 0),
        failed_area_m2=round(float(fail.sum() * A), 0), volume_m3=round(float(h_node.sum() * A), 0),
        clusters=nclus, saturated_fraction_mean=round(float(Wf.mean()), 3),
        fs_min=round(float(FS[cand].min()), 3) if cand.any() else None,
        fs_median=round(float(np.median(FS[cand])), 3) if cand.any() else None,
        unstable_without_rain_area_m2=round(float(unconditional.sum() * A), 0),
        never_fails_area_m2=round(float(stable_always.sum() * A), 0),
        density=round(rho_f, 1),
    )
    pc = Pc[cand & ~unconditional & ~stable_always]
    if pc.size:
        info.update(critical_rain_min_mm=round(float(max(0.0, pc.min())), 0),
                    critical_rain_p10_mm=round(float(max(0.0, np.percentile(pc, 10))), 0),
                    critical_rain_p50_mm=round(float(max(0.0, np.percentile(pc, 50))), 0))
    lam0 = float(np.clip(Wf.mean() * RHO_W / rho_f, 0, 0.95))
    info["pore_ratio_initial"] = round(lam0, 3)
    if fail.any():
        msg = (f"Lluvia {P:.0f} mm en {days:g} días" + (f" + deshielo {melt:.0f} mm" if melt else "") +
               f": fallan {info['failed_area_m2'] / 1e4:.1f} ha → {info['volume_m3'] / 1e6:.2f} M m³.")
    else:
        isolated = bool(fail_raw.any())
        msg = (f"Con {P:.0f} mm en {days:g} días" + (f" + {melt:.0f} mm de deshielo" if melt else "") +
               (f" solo fallan celdas aisladas (menos de {int(r.get('min_cells', 3))} conectadas): no hay deslizamiento."
                if isolated else f" la ladera es estable (FS mínimo {info['fs_min']:.2f})."))
        if info.get("critical_rain_p10_mm") is not None:
            msg += (f" El 10 % más débil de la ladera falla con ~{info['critical_rain_p10_mm']:.0f} mm en {days:g} días"
                    + (" (además del deshielo)." if melt else "."))
    info["message"] = msg
    return dict(fails=bool(fail.any()), h_node=h_node, rho=rho_f, lam0=lam0, info=info, message=msg,
                fail=fail, FS=FS, cand=cand)


def build_breach(g, p):
    """Brecha prescrita a lo largo de un eje (p. ej. el desagüe del lago): profundidad depth_m en el
    inicio del eje, que disminuye linealmente hasta 0 al final (el fondo de la brecha queda con pendiente
    hacia aguas abajo). Devuelve {target (ny,nx) con NaN fuera, depth, start_s, duration_s} o None."""
    br = p.get("breach")
    if not br:
        return None
    dx = g["dx"]
    H = g["H_pre"]
    ny, nx = H.shape
    lx, ly = _line_xy(g, br["line"])
    s = np.r_[0, np.cumsum(np.hypot(np.diff(lx), np.diff(ly)))]
    L = s[-1]
    X, Y = np.meshgrid(np.arange(nx) * dx, np.arange(ny) * dx)
    best_d = np.full(H.shape, np.inf)
    best_s = np.zeros(H.shape)
    for k in range(len(lx) - 1):
        ax, ay, bx, by = lx[k], ly[k], lx[k + 1], ly[k + 1]
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy + 1e-9
        t = np.clip(((X - ax) * vx + (Y - ay) * vy) / L2, 0, 1)
        d = np.hypot(X - (ax + t * vx), Y - (ay + t * vy))
        m = d < best_d
        best_d[m] = d[m]
        best_s[m] = s[k] + t[m] * np.sqrt(L2)
    half = float(br.get("width_m", 100)) / 2
    depth0 = float(br["depth_m"])
    # sección trapezoidal: profundidad plena en el eje, taludes 1:1 hacia los bordes
    depth = depth0 * (1 - best_s / max(L, 1e-6)) - np.maximum(0, best_d - half)
    inside = (best_d <= half + depth0) & (depth > 0)
    # cota objetivo monótona a lo largo del eje: nunca por encima de la del inicio de la brecha
    z_start = float(bilinear(H, dx, lx[:1], ly[:1])[0]) - depth0
    target = np.where(inside, np.minimum(H - depth, z_start), np.nan)
    if br.get("target_m") is not None:
        # rotura de un muro: el corredor de la brecha baja de golpe a una cota absoluta (el pie del paredón)
        inside = best_d <= half
        target = np.where(inside & (H > float(br["target_m"])), float(br["target_m"]), np.nan)
    dep = np.where(inside, H - target, np.nan)
    return dict(target=target.astype(np.float32), depth=dep.astype(np.float32),
                start_s=float(br.get("start_s", 0)), duration_s=float(br.get("duration_s", 600)),
                volume_m3=float(np.nansum(dep) * dx * dx), length_m=float(L))


def zone_mask(g, polygon_lonlat):
    """Máscara (ny, nx) de los nodos de columna dentro de un polígono [[lon, lat], ...]."""
    fr, dx = g["frame"], g["dx"]
    ny, nx = g["H_pre"].shape
    x, y = fr.to_xy([q[0] for q in polygon_lonlat], [q[1] for q in polygon_lonlat])
    poly = list(zip(x.tolist(), y.tolist()))
    X, Y = np.meshgrid(np.arange(nx) * dx, np.arange(ny) * dx)
    return points_in_polygon(X.ravel(), Y.ravel(), poly).reshape(ny, nx)


def build_erodible(g, rel, p):
    d = float(p.get("erodible_depth_m", 0.0))
    ny, nx = g["H_pre"].shape
    E = np.full((ny, nx), d, np.float32)
    h_solid = rel.get("h_solid", rel["h_node"])
    E[h_solid > 0] = 0.0
    # zonas con espesor erosionable propio (morenas, cauces, sedimento acumulado en un embalse)
    for z in p.get("erodible_zones") or []:
        if len(z.get("polygon") or []) >= 3:
            m = zone_mask(g, z["polygon"]) & (h_solid <= 0)
            E[m] = np.maximum(E[m], float(z["depth_m"]))
    E[:3, :] = E[-3:, :] = 0.0
    E[:, :3] = E[:, -3:] = 0.0
    # zonas urbanas: suelo compactado/pavimentado, sin erosión
    for z in p.get("exposure") or []:
        if not z.get("erodible", False) and len(z.get("polygon") or []) >= 3:
            E[zone_mask(g, z["polygon"])] = 0.0
    E[:3, :] = E[-3:, :] = 0.0
    E[:, :3] = E[:, -3:] = 0.0
    return E


def mixture(p):
    rho_s = float(p.get("density_solid", 2650.0))
    n = float(p.get("porosity", 0.35))
    Sr = float(p.get("saturation", 0.5))
    rho = rho_s * (1 - n) + RHO_W * n * Sr
    lam_eq = Sr * RHO_W / rho  # presión de poros hidrostática relativa (nivel freático ~ Sr·h)
    return rho, lam_eq


class ResultWriter:
    """Archivo binario: cuadros de partículas (cuantizados) + snapshots de erosión + campos float32.

    Cuadro: x,y,z uint16 · pad4 · velocidad,λ,origen uint8 · pad4.
    """

    SPEED_MAX = 127.5  # m/s -> uint8 (0.5 m/s de resolución)

    def __init__(self, path: Path, nx, ny, dx, zmin, zmax, erosion_scale, max_frames=200):
        self.f = open(path, "wb")
        self.pos = 0
        self.nx, self.ny, self.dx = nx, ny, dx
        self.Lx = (nx - 1) * dx
        self.Ly = (ny - 1) * dx
        self.zmin, self.zmax = float(zmin), float(zmax)
        self.erosion_scale = float(erosion_scale)
        # snapshots de erosión espaciados para no superar ~4 MB
        self.erosion_every = max(1, math.ceil(nx * ny * max_frames / 4e6))
        self.frames = []
        self.arrays = {}

    def _write(self, b: bytes):
        off = self.pos
        self.f.write(b)
        self.pos += len(b)
        pad = (-self.pos) % 4
        if pad:
            self.f.write(b"\0" * pad)
            self.pos += pad
        return off

    def add_frame(self, t, x, y, z, speed, lam, flag, erosion=None):
        q = lambda a, lo, hi: np.clip(np.rint((a - lo) / max(hi - lo, 1e-9) * 65535), 0, 65535).astype("<u2")
        n = int(x.size)
        off = self._write(q(x, 0, self.Lx).tobytes() + q(y, 0, self.Ly).tobytes() + q(z, self.zmin, self.zmax).tobytes())
        sp = np.clip(np.rint(speed / self.SPEED_MAX * 255), 0, 255).astype(np.uint8)
        la = np.clip(np.rint(lam * 255), 0, 255).astype(np.uint8)
        fl = np.where(flag < 0, 255, flag).astype(np.uint8)
        self._write(sp.tobytes() + la.tobytes() + fl.tobytes())
        fr = dict(t=round(float(t), 3), offset=off, count=n)
        if erosion is not None and self.erosion_scale > 0 and len(self.frames) % self.erosion_every == 0:
            e = np.clip(np.rint(erosion / self.erosion_scale * 255), 0, 255).astype(np.uint8)
            fr["erosion_offset"] = self._write(e.tobytes())
        self.frames.append(fr)

    def add_array(self, name, a):
        a = np.ascontiguousarray(a, dtype="<f4")
        self.arrays[name] = dict(offset=self._write(a.tobytes()), length=int(a.size))

    def close(self):
        self.f.close()
        return dict(frames=self.frames, arrays=self.arrays,
                    frame_format=dict(Lx=self.Lx, Ly=self.Ly, zmin=self.zmin, zmax=self.zmax,
                                      speed_max=self.SPEED_MAX, erosion_scale=self.erosion_scale))


INTENSITY = {1: "baja", 2: "media", 3: "alta"}


def intensity_class(h, v):
    """Intensidad de flujo de detritos (Hürlimann et al., 2008; recomendaciones suizas BUWAL):
    alta: h ≥ 1 m y v ≥ 1 m/s · media: una de las dos · baja: resto de la zona afectada (h > 0,1 m)."""
    c = np.zeros(h.shape, np.float32)
    aff = h > 0.1
    deep, fast = h >= 1.0, v >= 1.0
    c[aff] = 1
    c[aff & (deep ^ fast)] = 2
    c[aff & deep & fast] = 3
    return c


def exposure_report(g, fields, rho, zones, points, heights=None):
    """Impacto sobre zonas expuestas (polígonos) y elementos puntuales (edificios)."""
    dx = g["dx"]
    A = dx * dx
    h, v = fields["max_depth"], fields["max_speed"]
    P = fields["max_pressure"]
    cls, arr, dep = fields["intensity"], fields["arrival"], fields["deposit"]
    out = dict(zones=[], points=None)
    for z in zones or []:
        if len(z.get("polygon") or []) < 3:
            continue
        m = zone_mask(g, z["polygon"])
        if not m.any():
            continue
        aff = m & (h > 0.1)
        t = arr[aff & (arr >= 0)]
        out["zones"].append(dict(
            name=z.get("name", "Zona"), area_m2=round(float(m.sum() * A), 0),
            affected_area_m2=round(float(aff.sum() * A), 0),
            affected_fraction=round(float(aff.sum() / m.sum()), 3),
            area_by_intensity_m2={INTENSITY[k]: round(float((m & (cls == k)).sum() * A), 0) for k in (1, 2, 3)},
            max_depth_m=round(float(h[m].max()), 2), max_speed_m_s=round(float(v[m].max()), 2),
            max_pressure_kPa=round(float(P[m].max()), 1),
            depth_p50_p90_m=[round(float(q), 2) for q in np.percentile(h[aff], [50, 90])] if aff.any() else None,
            speed_p50_p90_m_s=[round(float(q), 2) for q in np.percentile(v[aff], [50, 90])] if aff.any() else None,
            pressure_p50_p90_kPa=[round(float(q), 1) for q in np.percentile(P[aff], [50, 90])] if aff.any() else None,
            first_arrival_s=round(float(t.min()), 1) if t.size else None,
            deposit_volume_m3=round(float(dep[m].sum() * A), 0),
        ))
    if points:
        fr = g["frame"]
        ny, nx = h.shape
        lon = np.array([q[0] for q in points], float)
        lat = np.array([q[1] for q in points], float)
        x, y = fr.to_xy(lon, lat)
        i = np.clip(np.rint(x / dx).astype(int), 0, nx - 1)
        j = np.clip(np.rint(y / dx).astype(int), 0, ny - 1)
        inside = (x >= 0) & (y >= 0) & (x <= (nx - 1) * dx) & (y <= (ny - 1) * dx)
        c = np.where(inside, cls[j, i], 0).astype(int)
        ta = np.where(inside & (c > 0), arr[j, i], -1)
        out["points"] = dict(
            total=int(len(points)),
            counts={INTENSITY[k]: int((c == k).sum()) for k in (1, 2, 3)},
            affected=int((c > 0).sum()),
            intensity=c.tolist(),
            arrival_s=np.round(ta, 1).tolist(),
            depth_m=np.round(np.where(inside, h[j, i], 0), 2).tolist(),
            first_arrival_s=round(float(ta[ta >= 0].min()), 1) if (ta >= 0).any() else None,
        )
        if heights is not None and len(heights) == len(points):
            # edificios con altura conocida (datos de campo o GBA) que el flujo supera
            hb = np.array([np.nan if q is None else q for q in heights], float)
            known = np.isfinite(hb) & (hb > 0)
            hd = np.where(inside, h[j, i], 0)
            out["points"].update(with_height=int(known.sum()),
                                 overtopped=int((known & (hd >= hb)).sum()),
                                 half_height=int((known & (hd >= 0.5 * hb)).sum()))
    return out


def summarize_fields(g, rel, fields, wall_s):
    """Métricas: volumen depositado, erosionado, alcance (runout) y coeficiente H/L."""
    dx = g["dx"]
    A = dx * dx
    dep = fields["deposit"]
    ero = fields["erosion"]
    footprint = fields["max_depth"] > 0.1
    cx, cy = rel["centroid"]
    ny, nx = dep.shape
    X, Y = np.meshgrid(np.arange(nx) * dx, np.arange(ny) * dx)
    runout = 0.0
    hl = None
    if footprint.any():
        d = np.hypot(X - cx, Y - cy)
        d[~footprint] = -1
        j, i = np.unravel_index(np.argmax(d), d.shape)
        runout = float(d[j, i])
        drop = rel["info"]["top_z"] - float(g["H_pre"][j, i])
        if runout > 0:
            hl = round(drop / runout, 3)
    return dict(deposit_volume_m3=round(float(dep.sum() * A), 1),
                eroded_volume_m3=round(float(ero.sum() * A), 1),
                affected_area_m2=round(float(footprint.sum() * A), 1),
                runout_m=round(runout, 1), H_over_L=hl,
                max_depth_m=round(float(fields["max_depth"].max()), 2),
                max_speed_m_s=round(float(fields["max_speed"].max()), 2),
                max_speed_km_h=round(float(fields["max_speed"].max()) * 3.6, 1),
                max_pore_ratio=round(float(fields["max_pore"].max()), 3),
                wall_time_s=round(wall_s, 1))


def _json_default(o):
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"{type(o).__name__} no serializable")


def write_json(path: Path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default))
