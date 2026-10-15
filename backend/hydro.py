# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Cuencas y subcuencas sobre el DEM, hidrología de tormenta y propensión a flujos de detritos.

Convención de grilla: la de scenario (shape (ny, nx), índice [j, i], x = i·dx, y = j·dx desde la esquina SO).

1. Terreno (`terrain`): relleno de depresiones con Priority-Flood + ε (Barnes et al. 2014), dirección de flujo D8
   por máxima pendiente, área acumulada, pendiente y área de aporte multidireccional (para SHALSTAB).
2. Cuencas (`delineate`): red de drenaje con orden de Strahler, cuencas que drenan a puntos de salida
   (borde de la zona, puntos marcados o entradas de cauces a la zona urbana) y subcuencas en cada confluencia de
   cauces importantes. Estadísticas morfométricas, tiempo de concentración y número de Melton.
3. Tormenta (`hydrology`): hietograma, lluvia efectiva SCS-CN, hidrograma unitario adimensional SCS, tránsito de
   Muskingum entre subcuencas, deslizamientos superficiales (SHALSTAB) y concentración de sedimento de equilibrio
   (Takahashi): define si la crecida es de agua, hiperconcentrada o un flujo de detritos (alud).
"""
from __future__ import annotations

import heapq
import math

import numpy as np

G = 9.81
RHO_W = 1000.0
SQ2 = math.sqrt(2.0)
OFFS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]  # (dj, di)

FLOW_TYPES = {
    "agua": "Crecida (agua con sedimento)",
    "hiper": "Flujo hiperconcentrado / de barro",
    "detritos": "Flujo de detritos (alud)",
}


# ───────────────────────────────────────────── terreno

def priority_flood(H, eps=1e-4, conn=8):
    """Relleno de depresiones con pendiente mínima ε (Priority-Flood + ε, Barnes et al. 2014).

    Devuelve Z (float64): toda celda interior tiene un vecino estrictamente más bajo, así que el agua
    siempre llega a un borde. Las depresiones quedan llenas hasta su cota de desborde."""
    ny, nx = H.shape
    W = nx + 2
    Zp = np.full((ny + 2) * W, np.inf)
    Zp.reshape(ny + 2, W)[1:-1, 1:-1] = H
    closed = np.ones((ny + 2) * W, bool)
    closed.reshape(ny + 2, W)[1:-1, 1:-1] = False
    heap = []
    for j in range(ny):
        for i in ((0, nx - 1) if 0 < j < ny - 1 else range(nx)):
            c = (j + 1) * W + i + 1
            heap.append((Zp[c], c))
            closed[c] = True
    heapq.heapify(heap)
    Zl = Zp.tolist()
    cl = closed.tolist()
    offs = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1] if conn == 8 else [-W, -1, 1, W]
    pop, push = heapq.heappop, heapq.heappush
    while heap:
        z, c = pop(heap)
        for o in offs:
            n = c + o
            if cl[n]:
                continue
            cl[n] = True
            zn = Zl[n]
            if zn <= z:
                zn = z + eps
                Zl[n] = zn
            push(heap, (zn, n))
    return np.asarray(Zl).reshape(ny + 2, W)[1:-1, 1:-1].copy()


def d8(Z, dx, offs=OFFS):
    """Receptor D8 (o D4) por máxima pendiente (índice plano, −1 = salida por el borde) y largo del paso."""
    ny, nx = Z.shape
    Zp = np.pad(Z, 1, constant_values=np.inf)
    best = np.zeros((ny, nx))
    kbest = np.full((ny, nx), -1, np.int8)
    for k, (dj, di) in enumerate(offs):
        L = dx * (SQ2 if dj and di else 1.0)
        s = (Z - Zp[1 + dj:1 + dj + ny, 1 + di:1 + di + nx]) / L
        m = s > best
        best[m] = s[m]
        kbest[m] = k
    idx = np.arange(ny * nx).reshape(ny, nx)
    rec = np.full((ny, nx), -1, np.int64)
    step = np.zeros((ny, nx))
    for k, (dj, di) in enumerate(offs):
        m = kbest == k
        rec[m] = idx[m] + dj * nx + di
        step[m] = dx * (SQ2 if dj and di else 1.0)
    return rec.ravel(), step.ravel()


def fill_spurious_pits(H, Z, max_depth):
    """Rellena solo las depresiones poco profundas (artefactos del DEM): conserva embalses y lagunas reales."""
    D = Z - H
    pit = D > 0.01
    if not pit.any():
        return H.copy()
    from scipy import ndimage
    lab, n = ndimage.label(pit, structure=np.ones((3, 3)))
    dmax = np.asarray(ndimage.maximum(D, lab, index=np.arange(1, n + 1)))
    shallow = np.r_[False, dmax <= max_depth]
    return np.where(shallow[lab], Z, H)


def carve_barriers(H, rec, order, step, drop=1e-3):
    """Apertura completa de depresiones (breaching): a lo largo de cada camino de flujo D8 el lecho baja de forma
    monótona, así que las barreras falsas del DEM (gargantas angostas que el DEM no resuelve) se excavan con un
    canal de una celda en lugar de llenar un lago artificial detrás de ellas (Lindsay 2016; Soille 2004)."""
    Hl = H.ravel().astype(np.float64).tolist()
    recl, stl = rec.tolist(), step.tolist()
    for c in order.tolist():
        r = recl[c]
        if r >= 0:
            m = Hl[c] - drop * stl[c]
            if Hl[r] > m:
                Hl[r] = m
    return np.asarray(Hl).reshape(H.shape)


def terrain(H, dx, pit_mode="carve", pit_depth_m=3.0):
    """Análisis hidrológico del DEM, independiente de umbrales y de la tormenta (se guarda en caché)."""
    from .scenario import contributing_area
    H = np.asarray(H, np.float64)
    ny, nx = H.shape
    Z = priority_flood(H)
    rec, step = d8(Z, dx)
    order = np.argsort(-Z.ravel(), kind="stable")  # aguas arriba primero
    acc = np.full(ny * nx, dx * dx)
    recl, accl = rec.tolist(), acc.tolist()
    for c in order.tolist():
        r = recl[c]
        if r >= 0:
            accl[r] += accl[c]
    acc = np.asarray(accl)
    gy, gx = np.gradient(H, dx)
    slope = np.arctan(np.hypot(gx, gy))
    # donante principal (mayor área) de cada celda: para recorrer el cauce principal aguas arriba
    idx = np.arange(ny * nx).reshape(ny, nx)
    accp = np.pad(acc.reshape(ny, nx), 1, constant_values=-1)
    recp = np.pad(rec.reshape(ny, nx), 1, constant_values=-2)
    idxp = np.pad(idx, 1, constant_values=-1)
    main_don = np.full((ny, nx), -1, np.int64)
    mx = np.zeros((ny, nx))
    for dj, di in OFFS:
        sl = (slice(1 + dj, 1 + dj + ny), slice(1 + di, 1 + di + nx))
        m = (recp[sl] == idx) & (accp[sl] > mx)
        mx[m] = accp[sl][m]
        main_don[m] = idxp[sl][m]
    if pit_mode == "carve":
        # el modelo 2D intercambia agua solo por las caras de las celdas: la apertura se hace con caminos D4,
        # así toda celda tiene un vecino de cara más bajo (un cauce en diagonal no queda como escalones aislados)
        Z4 = priority_flood(H, conn=4)
        rec4, step4 = d8(Z4, dx, offs=[(-1, 0), (0, -1), (0, 1), (1, 0)])
        Hc = carve_barriers(H, rec4, np.argsort(-Z4.ravel(), kind="stable"), step4)
    elif pit_mode == "fill":
        Hc = Z.copy()
    elif pit_mode == "keep":
        # llanura: los bajos, lagunas y cañadas sin salida se conservan y el 2D los llena (almacenamiento real)
        Hc = H.copy()
    else:
        Hc = fill_spurious_pits(H, Z, pit_depth_m)
    return dict(H=H, Z=Z, Hc=Hc, rec=rec, step=step, order=order, acc=acc, slope=slope,
                main_don=main_don.ravel(), mfd_area=contributing_area(Hc, dx), dx=float(dx), ny=ny, nx=nx)


# ───────────────────────────────────────────── red de drenaje y cuencas

def strahler(T, stream):
    rec, order = T["rec"], T["order"]
    n = rec.size
    so = np.zeros(n, np.int16)
    mx = np.zeros(n, np.int16)
    cnt = np.zeros(n, np.int16)
    st, recl = stream.tolist(), rec.tolist()
    sol, mxl, cntl = so.tolist(), mx.tolist(), cnt.tolist()
    for c in order.tolist():
        if not st[c]:
            continue
        o = 1 if mxl[c] == 0 else (mxl[c] + 1 if cntl[c] >= 2 else mxl[c])
        sol[c] = o
        r = recl[c]
        if r >= 0:
            if o > mxl[r]:
                mxl[r], cntl[r] = o, 1
            elif o == mxl[r]:
                cntl[r] += 1
    return np.asarray(sol, np.int16)


def snap_outlet(T, x, y, radius_m):
    """Celda de mayor área acumulada a menos de radius_m del punto (el cauce más cercano)."""
    dx, ny, nx = T["dx"], T["ny"], T["nx"]
    i0, j0 = int(round(x / dx)), int(round(y / dx))
    r = max(1, int(math.ceil(radius_m / dx)))
    j1, j2 = max(0, j0 - r), min(ny, j0 + r + 1)
    i1, i2 = max(0, i0 - r), min(nx, i0 + r + 1)
    if j1 >= j2 or i1 >= i2:
        return None
    A = T["acc"].reshape(ny, nx)[j1:j2, i1:i2]
    jj, ii = np.unravel_index(np.argmax(A), A.shape)
    return (j1 + jj) * nx + (i1 + ii)


def delineate(T, frame, opts):
    """Cuencas principales y subcuencas.

    opts: stream_area_km2 (cauces dibujados), subbasin_area_km2 (umbral de subcuenca: confluencias de dos
    cauces mayores que este umbral), min_basin_area_km2, mode ('edge' | 'outlets' | 'target'),
    outlets [{lon, lat, name}], target_polygon [[lon, lat], ...] (zona urbana), target_name.
    """
    from .scenario import zone_mask
    dx, ny, nx = T["dx"], T["ny"], T["nx"]
    N = ny * nx
    rec, order, acc, step, H = T["rec"], T["order"], T["acc"], T["step"], T["H"].ravel()
    A_sub = float(opts.get("subbasin_area_km2", 5.0)) * 1e6
    A_min = float(opts.get("min_basin_area_km2", 2.0)) * 1e6
    A_str = float(opts.get("stream_area_km2", 0.5)) * 1e6
    mode = opts.get("mode", "edge")
    warnings = []

    # salidas principales
    main_out = {}  # celda -> nombre
    if mode == "outlets" and opts.get("outlets"):
        for k, o in enumerate(opts["outlets"]):
            x, y = frame.to_xy(o["lon"], o["lat"])
            c = snap_outlet(T, float(x), float(y), float(opts.get("snap_radius_m", 300.0)))
            if c is None:
                warnings.append(f"La salida «{o.get('name') or k + 1}» está fuera de la zona de cálculo")
                continue
            main_out[int(c)] = o.get("name") or f"Salida {k + 1}"
    elif mode == "target" and opts.get("target_polygon") and len(opts["target_polygon"]) >= 3:
        g = dict(frame=frame, dx=dx, H_pre=T["H"])
        inside = zone_mask(g, opts["target_polygon"]).ravel()
        if not inside.any():
            raise ValueError("La zona urbana está fuera de la zona de cálculo")
        ent = np.nonzero(~inside & (rec >= 0) & (acc >= A_min))[0]
        ent = ent[inside[rec[ent]]]
        tname = opts.get("target_name") or "la zona urbana"
        for c in ent[np.argsort(-acc[ent])]:
            main_out[int(c)] = None
        if not main_out:
            warnings.append(f"Ningún cauce con más de {A_min / 1e6:g} km² entra a {tname}: se usan las salidas al borde")
            mode = "edge"
    if not main_out:
        border = np.zeros((ny, nx), bool)
        border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
        outs = np.nonzero((rec < 0) & (acc >= A_min) & border.ravel())[0]
        for c in outs[np.argsort(-acc[outs])]:
            main_out[int(c)] = None

    # subcuencas: confluencias de dos cauces con área ≥ A_sub
    for _ in range(6):
        big = acc >= A_sub
        ndon = np.bincount(rec[big & (rec >= 0)], minlength=N)
        sub_out = big & (rec >= 0)
        sub_out[sub_out] = ndon[rec[sub_out]] >= 2
        lab, info = _label(T, main_out, sub_out)
        if len(info) <= 120:
            break
        A_sub *= 2
        warnings.append(f"Demasiadas subcuencas: el umbral de subcuenca se aumentó a {A_sub / 1e6:g} km²")
    nb = len(info)
    labr = lab.reshape(ny, nx)

    # longitudes de flujo: local (dentro de la subcuenca) y total (toda el área de aporte)
    ul = np.zeros(N)
    zh = H.copy()
    ut = np.zeros(N)
    zt = H.copy()
    hm = H.copy()  # cota máxima aguas arriba
    labl, recl, stepl = lab.tolist(), rec.tolist(), step.tolist()
    ull, zhl, utl, ztl, hml = ul.tolist(), zh.tolist(), ut.tolist(), zt.tolist(), hm.tolist()
    for c in order.tolist():
        r = recl[c]
        if r < 0 or labl[c] == 0:
            continue
        s = stepl[c]
        L = utl[c] + s
        if L > utl[r]:
            utl[r], ztl[r] = L, ztl[c]
        if hml[c] > hml[r]:
            hml[r] = hml[c]
        if labl[r] == labl[c]:
            L = ull[c] + s
            if L > ull[r]:
                ull[r], zhl[r] = L, zhl[c]
    ul, zh, ut, zt, hm = map(np.asarray, (ull, zhl, utl, ztl, hml))
    # distancia de cada celda a la salida de su subcuenca (para el tránsito entre subcuencas)
    dl = np.zeros(N)
    is_out = np.zeros(N, bool)
    for b in info:
        is_out[b["outlet"]] = True
    dll = dl.tolist()
    iol = is_out.tolist()
    for c in order[::-1].tolist():
        if labl[c] == 0 or iol[c]:
            continue
        r = recl[c]
        dll[c] = dll[r] + stepl[c]
    dl = np.asarray(dll)

    # estadísticas por subcuenca
    labs = lab
    n1 = nb + 1
    cnt = np.bincount(labs, minlength=n1).astype(float)
    sumH = np.bincount(labs, weights=H, minlength=n1)
    sumS = np.bincount(labs, weights=np.degrees(T["slope"].ravel()), minlength=n1)
    maxH = np.full(n1, -np.inf)
    np.maximum.at(maxH, labs, H)
    A_cell = dx * dx
    border = np.zeros((ny, nx), bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    bl = labs[border.ravel()]
    bcells = np.nonzero(border.ravel())[0]

    def main_stem_slope(o, Lr=1000.0):
        """Pendiente del cauce principal en el último tramo (≤ Lr) antes de la salida."""
        c, L = o, 0.0
        md = T["main_don"]
        while L < Lr:
            u = md[c]
            if u < 0 or lab[u] != lab[o]:
                break
            L += step[u]
            c = u
        return (H[c] - H[o]) / L if L > 0 else 0.0, L

    for b in info:
        k, o = b["id"], b["outlet"]
        A_loc = cnt[k] * A_cell
        L_loc = max(ul[o], dx)
        S_loc = max((zh[o] - H[o]) / L_loc, 1e-4)
        L_tot = max(ut[o], dx)
        S_tot = max((zt[o] - H[o]) / L_tot, 1e-4)
        A_up = acc[o]
        relief = hm[o] - H[o]
        S_ch, L_ch = main_stem_slope(o)
        if L_ch < dx:
            S_ch = S_loc
        jo, io = divmod(o, nx)
        lon, lat = frame.to_lonlat(io * dx, jo * dx)
        # ¿la subcuenca toca el borde de la zona lejos de su salida? → se extiende fuera del DEM
        bo = bcells[bl == k]
        far = (np.hypot(bo // nx - jo, bo % nx - io) > 3).sum() if bo.size else 0
        b.update(
            area_km2=A_loc / 1e6, area_up_km2=A_up / 1e6,
            z_outlet=float(H[o]), z_max=float(maxH[k]), z_mean=float(sumH[k] / max(cnt[k], 1)),
            z_max_up=float(hm[o]), relief_up_m=float(relief),
            slope_mean_deg=float(sumS[k] / max(cnt[k], 1)),
            length_km=L_loc / 1000, channel_slope=float(S_loc),
            length_up_km=L_tot / 1000, channel_slope_up=float(S_tot),
            outlet_slope=float(max(S_ch, 1e-4)),
            melton=float(relief / 1000 / math.sqrt(max(A_up / 1e6, 1e-6))),
            tc_h=kirpich_h(L_loc, S_loc), tc_up_h=kirpich_h(L_tot, S_tot), tc_temez_up_h=temez_h(L_tot, S_tot),
            outlet_lonlat=[round(float(lon), 6), round(float(lat), 6)],
            reach_m=float(dl[rec[o]] + step[o]) if rec[o] >= 0 and lab[rec[o]] > 0 else 0.0,
            touches_border=bool(far > 0),
        )
        b["propensity"] = melton_class(b["melton"], b["length_up_km"])

    # nombres: cuencas principales por área, subcuencas numeradas dentro de cada una
    mains = sorted([b for b in info if b["down"] == 0], key=lambda b: -b["area_up_km2"])
    for r, m in enumerate(mains, 1):
        m["main_rank"] = r
        if not m.get("name"):
            m["name"] = f"Cuenca {r}"
    rank = {m["id"]: m["main_rank"] for m in mains}
    by_main = {}
    for b in sorted(info, key=lambda b: -b["area_up_km2"]):
        by_main.setdefault(b["main"], []).append(b)
    for mid, lst in by_main.items():
        for s, b in enumerate(lst, 1):
            b["code"] = f"{rank[mid]}.{s}"
            if b["down"] != 0:
                b["name"] = f"Subcuenca {b['code']}"

    # orden topológico (aguas arriba primero) por cota de la salida
    Zf = T["Z"].ravel()
    topo = sorted(info, key=lambda b: -Zf[b["outlet"]])
    stream = acc >= A_str
    so = strahler(T, stream)
    if any(b["touches_border"] for b in mains):
        names = ", ".join(m["name"] for m in mains if m["touches_border"])
        warnings.append(f"{names}: la cuenca toca el borde de la zona de cálculo y probablemente sigue afuera; "
                        "ampliá la zona para incluirla completa")
    return dict(lab=labr, info=info, topo=[b["id"] for b in topo], mains=[m["id"] for m in mains],
                stream=stream, strahler=so, A_sub_km2=A_sub / 1e6, mode=mode, warnings=warnings)


def _label(T, main_out, sub_out):
    """Etiqueta cada celda con la subcuenca a la que drena (0 = fuera de las cuencas de interés)."""
    rec, order = T["rec"], T["order"]
    N = rec.size
    lab = [0] * N
    recl = rec.tolist()
    sol = sub_out.tolist()
    info = []
    for c in order[::-1].tolist():  # aguas abajo primero
        r = recl[c]
        L = lab[r] if r >= 0 else 0
        if c in main_out:
            k = len(info) + 1
            info.append(dict(id=k, outlet=c, down=L, main=k if L == 0 else info[L - 1]["main"],
                             name=main_out[c], user_outlet=True))
            lab[c] = k
        elif L and sol[c]:
            k = len(info) + 1
            info.append(dict(id=k, outlet=c, down=L, main=info[L - 1]["main"], name=None, user_outlet=False))
            lab[c] = k
        else:
            lab[c] = L
    return np.asarray(lab, np.int32), info


def kirpich_h(L_m, S):
    """Tiempo de concentración de Kirpich (1940) en horas: tc[min] = 0,0195·L^0,77·S^−0,385."""
    return max(0.0195 * L_m ** 0.77 * max(S, 1e-4) ** -0.385 / 60.0, 5 / 60)


def temez_h(L_m, S):
    """Témez (1978): tc[h] = 0,3·(L/S^0,25)^0,76, L en km."""
    return 0.3 * (L_m / 1000 / max(S, 1e-4) ** 0.25) ** 0.76


def melton_class(R, L_km):
    """Propensión según Wilford et al. (2004): número de Melton R y largo de la cuenca."""
    if R > 0.6 and L_km < 2.7:
        return "detritos"
    if R >= 0.3:
        return "hiper"
    return "agua"


# ───────────────────────────────────────────── geometría para el mapa

def douglas_peucker(P, tol):
    n = len(P)
    if n < 4:
        return P
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        A, B = P[a], P[b]
        d = B - A
        L = math.hypot(*d)
        seg = P[a + 1:b] - A
        dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L if L > 0 else np.hypot(seg[:, 0], seg[:, 1])
        k = int(np.argmax(dist))
        if dist[k] > tol:
            keep[a + 1 + k] = True
            stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return P[keep]


def label_polygons(lab, dx, frame, simplify=0.6):
    """Contornos (anillos lon/lat) de cada etiqueta > 0 de una grilla: {etiqueta: [[anillo exterior, huecos...], ...]}."""
    ny, nx = lab.shape
    L = np.pad(lab, 1)
    C = L[1:-1, 1:-1]
    W = nx + 1
    starts, ends, labs = [], [], []
    for nb, (s0, s1) in (
            (L[:-2, 1:-1], ((0, 0), (1, 0))),   # abajo: (i, j) → (i+1, j)
            (L[2:, 1:-1], ((1, 1), (0, 1))),    # arriba: (i+1, j+1) → (i, j+1)
            (L[1:-1, :-2], ((0, 1), (0, 0))),   # izquierda: (i, j+1) → (i, j)
            (L[1:-1, 2:], ((1, 0), (1, 1)))):   # derecha: (i+1, j) → (i+1, j+1)
        jj, ii = np.nonzero((C > 0) & (C != nb))
        starts.append((jj + s0[1]) * W + ii + s0[0])
        ends.append((jj + s1[1]) * W + ii + s1[0])
        labs.append(C[jj, ii])
    starts, ends, labs = np.concatenate(starts), np.concatenate(ends), np.concatenate(labs)
    o = np.argsort(labs, kind="stable")
    starts, ends, labs = starts[o], ends[o], labs[o]
    cuts = np.r_[0, np.nonzero(np.diff(labs))[0] + 1, labs.size]
    out = {}
    for a, b in zip(cuts[:-1], cuts[1:]):
        if a == b:
            continue
        k = int(labs[a])
        nxt = {}
        for s, e in zip(starts[a:b].tolist(), ends[a:b].tolist()):
            nxt.setdefault(s, []).append(e)
        rings = []
        while nxt:
            s0 = next(iter(nxt))
            ring = [s0]
            c = s0
            while True:
                lst = nxt.get(c)
                if not lst:
                    break
                e = lst.pop()
                if not lst:
                    del nxt[c]
                if e == s0:
                    break
                ring.append(e)
                c = e
            if len(ring) >= 4:
                rings.append(ring)
        polys = []
        for ring in rings:
            cj, ci = np.divmod(np.asarray(ring), W)
            P = np.c_[(ci - 0.5) * dx, (cj - 0.5) * dx].astype(float)
            # quitar vértices colineales
            d1 = np.roll(P, -1, 0) - P
            d0 = P - np.roll(P, 1, 0)
            turn = np.abs(d0[:, 0] * d1[:, 1] - d0[:, 1] * d1[:, 0]) > 1e-9
            P = P[turn]
            if len(P) < 3:
                continue
            area = 0.5 * float(np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1]))
            if abs(area) < 3 * dx * dx:
                continue
            P = douglas_peucker(np.vstack([P, P[:1]]), simplify * dx)[:-1]
            lon, lat = frame.to_lonlat(P[:, 0], P[:, 1])
            polys.append((area, np.round(np.c_[lon, lat], 5).tolist()))
        outers = sorted([p for p in polys if p[0] > 0], key=lambda p: -p[0])
        holes = [p[1] for p in polys if p[0] < 0]
        if outers:
            out[k] = [[outers[0][1], *holes]] + [[p[1]] for p in outers[1:]]
    return out


def stream_lines(T, D, frame, simplify=0.5):
    """Tramos de cauce entre confluencias, con su orden de Strahler: [{order, area_km2, coords}]."""
    rec, acc = T["rec"], T["acc"]
    stream, so, lab = D["stream"], D["strahler"], D["lab"].ravel()
    nx, dx = T["nx"], T["dx"]
    N = rec.size
    ndon = np.bincount(rec[stream & (rec >= 0)], minlength=N)
    starts = np.nonzero(stream & (ndon != 1) & ((lab > 0) | (D["mode"] == "edge")))[0]
    recl, stl, ndl = rec.tolist(), stream.tolist(), ndon.tolist()
    out = []
    for s in starts.tolist():
        pts = [s]
        c = recl[s]
        while c >= 0 and stl[c]:
            pts.append(c)
            if ndl[c] != 1:
                break
            c = recl[c]
        if len(pts) < 2:
            continue
        jj, ii = np.divmod(np.asarray(pts), nx)
        P = douglas_peucker(np.c_[ii * dx, jj * dx].astype(float), simplify * dx)
        lon, lat = frame.to_lonlat(P[:, 0], P[:, 1])
        out.append(dict(order=int(so[s]), area_km2=round(float(acc[pts[-1]]) / 1e6, 2),
                        coords=np.round(np.c_[lon, lat], 5).tolist()))
    return out


def main_channel(T, D, b, frame):
    """Cauce principal de una cuenca: desde la salida, aguas arriba por el donante de mayor área."""
    md, lab, nx, dx = T["main_don"], D["lab"].ravel(), T["nx"], T["dx"]
    c, pts = b["outlet"], [b["outlet"]]
    mains = D.get("_main_of")
    while True:
        u = md[c]
        if u < 0 or lab[u] == 0 or (mains is not None and mains[lab[u]] != b["main"]):
            break
        pts.append(u)
        c = u
    jj, ii = np.divmod(np.asarray(pts[::-1]), nx)
    P = douglas_peucker(np.c_[ii * dx, jj * dx].astype(float), 0.5 * dx)
    lon, lat = frame.to_lonlat(P[:, 0], P[:, 1])
    return np.round(np.c_[lon, lat], 5).tolist()


# ───────────────────────────────────────────── tormenta y escorrentía

def hyetograph(P_mm, D_h, pattern, dt_h):
    """Lluvia incremental (mm) por intervalo dt_h. Patrones: uniforme, adelantado, centrado, atrasado, bloques."""
    n = max(1, int(round(D_h / dt_h)))
    t = (np.arange(n) + 0.5) / n
    if pattern == "uniforme":
        w = np.ones(n)
    elif pattern == "bloques":
        # bloques alternos sobre una curva lámina-duración P(d) ∝ d^0,35 (tormenta convectiva de diseño)
        d = (np.arange(1, n + 1) / n) ** 0.35
        inc = np.diff(np.r_[0, d])
        w = np.zeros(n)
        pk = int(round(0.4 * (n - 1)))
        pos = [pk]
        for k in range(1, n):
            cand = pk + ((k + 1) // 2) * (1 if k % 2 else -1)
            if not 0 <= cand < n:
                cand = pk - ((k + 1) // 2) * (1 if k % 2 else -1)
            while cand in pos or not 0 <= cand < n:
                cand = next(x for x in range(n) if x not in pos)
            pos.append(cand)
        w[pos] = inc
    else:
        pk = {"adelantado": 0.3, "centrado": 0.5, "atrasado": 0.7}.get(pattern, 0.3)
        w = np.where(t <= pk, t / pk, (1 - t) / (1 - pk))
        w = np.maximum(w, 0.02)
    return P_mm * w / w.sum()


def cn_amc(CN, amc):
    """Ajuste por humedad antecedente (Chow et al. 1988): I seca, II normal, III húmeda."""
    CN = np.asarray(CN, float)
    if amc == "I":
        return CN / (2.281 - 0.01281 * CN)
    if amc == "III":
        return CN / (0.427 + 0.00573 * CN)
    return CN


def cn_slope(CN2, slope_rad):
    """CN corregido por pendiente (Sharpley y Williams 1990)."""
    CN3 = cn_amc(CN2, "III")
    S = np.tan(slope_rad)
    return np.clip((CN3 - CN2) / 3 * (1 - 2 * np.exp(-13.86 * S)) + CN2, 30, 99)


def scs_excess(P_cum, CN, ia_ratio=0.2):
    """Lluvia efectiva acumulada (mm) del método SCS-CN."""
    S = 25400.0 / np.asarray(CN, float) - 254.0
    Ia = ia_ratio * S
    return np.where(P_cum > Ia, (P_cum - Ia) ** 2 / np.maximum(P_cum - Ia + S, 1e-9), 0.0)


_UH_T = np.array([0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2,
                  2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4, 4.5, 5])
_UH_Q = np.array([0, .03, .1, .19, .31, .47, .66, .82, .93, .99, 1, .99, .93, .86, .78, .68, .56, .46, .39, .33, .28,
                  .207, .147, .107, .077, .055, .04, .029, .021, .015, .011, .005, 0])


def scs_uh(A_km2, tc_h, dt_h):
    """Hidrograma unitario adimensional SCS (m³/s por mm de lluvia efectiva), con volumen exacto A·1 mm."""
    tp = dt_h / 2 + 0.6 * tc_h
    t = np.arange(0, 5 * tp + dt_h, dt_h)
    q = np.interp(t / tp, _UH_T, _UH_Q)
    vol = q.sum() * dt_h * 3600
    return q * (A_km2 * 1e6 * 1e-3) / max(vol, 1e-12)


def muskingum(Q, K_h, X, dt_h):
    if K_h <= 1e-6:
        return Q.copy()
    if dt_h > 2 * K_h * (1 - X) or dt_h < 2 * K_h * X:
        # fuera del rango estable: traslación pura (retardo K)
        s = int(round(K_h / dt_h))
        return np.r_[np.zeros(s), Q[:Q.size - s]] if s else Q.copy()
    D = 2 * K_h * (1 - X) + dt_h
    C0, C1, C2 = (dt_h - 2 * K_h * X) / D, (dt_h + 2 * K_h * X) / D, (2 * K_h * (1 - X) - dt_h) / D
    out = np.zeros_like(Q)
    for k in range(1, Q.size):
        out[k] = C0 * Q[k] + C1 * Q[k - 1] + C2 * out[k - 1]
    return np.maximum(out, 0)


def takahashi_cv(tan_theta, tan_phi=0.7, rho_s=2650.0, cmax=0.6):
    """Concentración volumétrica de equilibrio de un flujo de detritos (Takahashi 1978/1991)."""
    t = np.asarray(tan_theta, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        cv = RHO_W * t / ((rho_s - RHO_W) * (tan_phi - t))
    return np.clip(np.where(t >= tan_phi, cmax, cv), 0, cmax)


def flow_type(cv):
    return "detritos" if cv >= 0.4 else "hiper" if cv >= 0.2 else "agua"


# suelo de ladera por defecto: coluvio delgado y algo cementado de las sierras áridas (calibrar con datos de campo)
SOIL_DEFAULTS = dict(soil_depth_m=1.2, transmissivity_m2_day=30.0, cohesion_kpa=6.0, friction_angle_deg=36.0,
                     infiltration=0.4, porosity=0.38, min_slope_deg=22.0, max_slope_deg=42.0)


def areal_reduction(A_km2):
    """Factor de reducción areal de la lluvia puntual (Témez 1991): 1 − log10(A)/15, para A > 1 km²."""
    return float(np.clip(1 - math.log10(max(A_km2, 1.0)) / 15, 0.5, 1.0))


def rickenmann_qp(M_m3):
    """Caudal pico de un flujo de detritos granular a partir de su volumen (Rickenmann 1999): Qp = 0,1·M^0,833."""
    return 0.1 * max(M_m3, 0.0) ** 0.833


def soil_failure(T, soil, P_mm, D_h):
    """Celdas que fallan con la tormenta (SHALSTAB + talud infinito; ver scenario.rain_failure).

    La recarga es la lluvia infiltrada repartida en el período (mínimo 1 día: SHALSTAB es estacionario).
    Devuelve (falla bool (ny, nx), lluvia crítica mm (ny, nx), candidatas)."""
    dx = T["dx"]
    s = {k: v for k, v in (soil or {}).items() if v is not None}
    z = float(s.get("soil_depth_m", SOIL_DEFAULTS["soil_depth_m"]))
    Tr = float(s.get("transmissivity_m2_day", SOIL_DEFAULTS["transmissivity_m2_day"]))
    c = float(s.get("cohesion_kpa", SOIL_DEFAULTS["cohesion_kpa"])) * 1000
    phi = math.radians(float(s.get("friction_angle_deg", SOIL_DEFAULTS["friction_angle_deg"])))
    finf = float(s.get("infiltration", SOIL_DEFAULTS["infiltration"]))
    n = float(s.get("porosity", SOIL_DEFAULTS["porosity"]))
    smin = float(s.get("min_slope_deg", SOIL_DEFAULTS["min_slope_deg"]))
    smax = float(s.get("max_slope_deg", SOIL_DEFAULTS["max_slope_deg"]))
    beta = T["slope"]
    a = T["mfd_area"]
    sinb, cosb, tanb = np.sin(beta), np.cos(beta), np.tan(beta)
    gam1 = G * (2650 * (1 - n) + RHO_W * n)
    with np.errstate(divide="ignore", invalid="ignore"):
        B = math.tan(phi) / tanb
        Wc = (c / (gam1 * z * cosb * sinb) + B - 1) / (RHO_W * G / gam1 * B)
        days = max(1.0, D_h / 24)
        Pc = Wc * Tr * dx * sinb / a * days / finf * 1000.0
    channel = a > float(s.get("channel_area_m2", 20000.0))
    cand = (beta >= math.radians(smin)) & (beta <= math.radians(smax)) & ~channel & (Wc > 0) & (Wc <= 1)
    fail = cand & (Pc <= P_mm)
    return fail, np.where(cand, Pc, np.inf), cand


def gregoretti_qc(tan_theta, d_m):
    """Caudal unitario crítico (m²/s) para que la escorrentía dispare un flujo de detritos en un cauce empinado
    (Gregoretti y Dalla Fontana 2008): q_c = 0,78·d^1,5 / (tan θ)^1,27, d = diámetro medio del lecho (m)."""
    return 0.78 * d_m ** 1.5 / np.maximum(np.asarray(tan_theta, float), 1e-3) ** 1.27


def along_slope(T, steps=3):
    """Pendiente a lo largo del flujo (tan θ) medida sobre `steps` pasos D8 aguas abajo (menos ruidosa que el gradiente)."""
    rec, step, Hc = T["rec"], T["step"], T["Hc"].ravel()
    tgt = np.arange(rec.size)
    dist = np.zeros(rec.size)
    for _ in range(steps):
        ok = rec[tgt] >= 0
        dist[ok] += step[tgt[ok]]
        tgt = np.where(ok, rec[tgt], tgt)
    with np.errstate(divide="ignore", invalid="ignore"):
        s = np.where(dist > 0, (Hc - Hc[tgt]) / dist, np.tan(T["slope"].ravel()))
    return np.maximum(s, 0)


def debris_flows(T, lab, trig, ls_vol_cell, yield_cell, s_along, s_dep):
    """Propaga los flujos de detritos aguas abajo desde las celdas de disparo (cauce) y los deslizamientos.

    Mientras la pendiente sea ≥ s_dep el flujo erosiona el lecho (yield_cell, m³) y suma volumen; donde la pendiente
    baja de s_dep se detiene y deposita (abanico). Devuelve el volumen que pasa por cada celda y los depósitos."""
    rec, order = T["rec"], T["order"]
    N = rec.size
    act = (trig | (ls_vol_cell > 0)).tolist()
    M = ls_vol_cell.astype(float).tolist()
    recl, yl, sl = rec.tolist(), yield_cell.tolist(), (s_along >= s_dep).tolist()
    dep = {}
    for c in order.tolist():
        if not act[c]:
            continue
        if sl[c]:
            M[c] += yl[c]
            r = recl[c]
            if r >= 0:
                act[r] = True
                M[r] += M[c]
        elif M[c] > 0:
            dep[c] = dep.get(c, 0.0) + M[c]
    return np.asarray(M), dep


def channel_width(A_km2):
    """Ancho de cauce efectivo (m) por geometría hidráulica simple: ~3·A^0,4, entre 3 y 60 m."""
    return np.clip(3.0 * np.asarray(A_km2, float) ** 0.4, 3.0, 60.0)


def hydrology(T, D, storm, soil=None, debris=None, frame=None):
    """Hidrogramas de la tormenta en cada subcuenca y en la salida de cada cuenca principal."""
    dx, ny, nx = T["dx"], T["ny"], T["nx"]
    info = {b["id"]: b for b in D["info"]}
    st = {k: v for k, v in storm.items() if v is not None}
    P = float(st.get("rain_mm", 60.0))
    Dh = float(st.get("duration_h", 3.0))
    pattern = st.get("pattern", "adelantado")
    CN2 = float(st.get("cn", 80.0))
    amc = st.get("amc", "II")
    ia = float(st.get("ia_ratio", 0.2))
    db = {k: v for k, v in (debris or {}).items() if v is not None}
    bed_depth = float(db.get("channel_erodible_m", 1.0))
    celerity = float(db.get("wave_celerity_m_s", 3.0))
    tan_phi = math.tan(math.radians(float(db.get("debris_friction_deg", 35.0))))
    n_bed = float(db.get("bed_porosity", 0.35))
    A_ch = float(db.get("channel_area_km2", 0.5)) * 1e6
    d_m = float(db.get("grain_size_m", 0.1))
    s_dep = math.tan(math.radians(float(db.get("deposition_slope_deg", 10.0))))
    s_trig = math.tan(math.radians(float(db.get("trigger_min_slope_deg", 8.5))))

    lab = D["lab"].ravel()
    n1 = len(info) + 1
    use_arf = bool(st.get("areal_reduction", True))
    CNc = cn_slope(cn_amc(CN2, amc), T["slope"]).ravel()
    CNm = np.bincount(lab, weights=CNc, minlength=n1) / np.maximum(np.bincount(lab, minlength=n1), 1)
    zs = float((soil or {}).get("soil_depth_m") or SOIL_DEFAULTS["soil_depth_m"])
    # lecho erosionable: cauces (área > A_ch) con pendiente > 2°, ancho por geometría hidráulica
    ch = (T["acc"] >= A_ch) & (T["slope"].ravel() > math.radians(2.0))
    bed_vol = np.bincount(lab, weights=ch * channel_width(T["acc"] / 1e6) * dx * bed_depth, minlength=n1)

    tcs = [b["tc_h"] for b in info.values()] or [1.0]
    dt_h = float(np.clip(min(tcs) / 5, 1 / 60, 1 / 6))
    dt_h = round(dt_h * 60) / 60 or 1 / 60
    t_end = Dh + 3 * max(b["tc_up_h"] for b in info.values()) + 1.0 if info else Dh + 1
    t_end = min(t_end, max(96.0, Dh + 24.0))
    nT = int(math.ceil(t_end / dt_h)) + 1
    rain_inc = hyetograph(P, Dh, pattern, dt_h)
    # reducción areal según el área de la cuenca principal (una tormenta convectiva no cubre toda la cuenca)
    arf = {m: areal_reduction(info[m]["area_up_km2"]) if use_arf else 1.0 for m in D["mains"]}
    P_eff = np.zeros(n1)
    for k, b in info.items():
        P_eff[k] = P * arf[b["main"]]
    fail = np.zeros(ny * nx, bool)
    Pc = cand = None
    for f in sorted(set(arf.values())):
        fl, Pc, cand = soil_failure(T, soil, P * f, Dh)
        ks = [k for k, b in info.items() if arf[b["main"]] == f]
        fail |= fl.ravel() & np.isin(lab, ks)
    if Pc is None:
        _, Pc, cand = soil_failure(T, soil, P, Dh)
    ls_vol = np.bincount(lab, weights=fail * zs * dx * dx, minlength=n1)
    ls_area = np.bincount(lab, weights=fail * dx * dx, minlength=n1)

    Qout, Vw, Vs, CVf = {}, {}, {}, {}
    res = {}
    for k in D["topo"]:
        b = info[k]
        cn = float(CNm[k])
        rain_cum = np.cumsum(rain_inc) * (P_eff[k] / P if P > 0 else 1.0)
        pe_cum = scs_excess(rain_cum, cn, ia)
        pe_inc = np.diff(np.r_[0, pe_cum])
        uh = scs_uh(b["area_km2"], b["tc_h"], dt_h)
        q_loc = np.convolve(pe_inc, uh)[:nT]
        q_loc = np.r_[q_loc, np.zeros(nT - q_loc.size)]
        q = q_loc.copy()
        vw = float(pe_cum[-1]) / 1000 * b["area_km2"] * 1e6
        vs_loc = (ls_vol[k] + bed_vol[k]) * (1 - n_bed)
        vs = vs_loc
        cvf_up = 0.0
        for u in [x for x in D["topo"] if info[x]["down"] == k]:
            K = info[u]["reach_m"] / celerity / 3600
            q += muskingum(Qout[u], K, 0.2, dt_h)
            vw += Vw[u]
            vs += Vs[u]
            cvf_up = max(cvf_up, CVf[u])
        cv_sup = vs / (vs + vw) if vs + vw > 0 else 0.0
        # formación: equilibrio de Takahashi en el cauce de la subcuenca (pendiente media de su recorrido),
        # limitado por el sedimento disponible (deslizamientos + lecho); llegada: en el tramo de salida
        cv_eq_f = float(takahashi_cv(b["channel_slope"], tan_phi))
        cv_f = max(min(cv_eq_f, cv_sup), cvf_up)
        cv_eq = float(takahashi_cv(b["outlet_slope"], tan_phi))
        cv = min(cv_eq, cv_sup, cv_f)
        Qout[k], Vw[k], Vs[k], CVf[k] = q, vw, vs, cv_f
        bf = 1 / (1 - cv)
        ipk = int(np.argmax(q))
        r = dict(
            cn=round(cn, 1), rain_mm=round(float(P_eff[k]), 1), arf=round(arf[b["main"]], 3),
            runoff_mm=round(float(pe_cum[-1]), 1),
            runoff_coeff=round(float(pe_cum[-1]) / P_eff[k], 3) if P_eff[k] > 0 else 0.0,
            q_local_peak=round(float(q_loc.max()), 2), q_peak=round(float(q[ipk]), 2),
            t_peak_h=round(ipk * dt_h, 3), v_water_m3=round(vw, 0),
            landslide_area_ha=round(float(ls_area[k]) / 1e4, 2), landslide_m3=round(float(ls_vol[k]), 0),
            bed_m3=round(float(bed_vol[k]), 0), sediment_up_m3=round(vs / (1 - n_bed), 0),
            cv_eq_formation=round(cv_eq_f, 3), cv_formation=round(cv_f, 3), flow_formation=flow_type(cv_f),
            cv_eq=round(cv_eq, 3), cv=round(cv, 3), bulking=round(bf, 2),
            q_peak_bulked=round(float(q[ipk]) * bf, 2), v_total_m3=round(vw * bf, 0),
            flow=flow_type(cv),
        )
        res[k] = r
    # ── flujos de detritos disparados por escorrentía (Gregoretti) y por deslizamientos (SHALSTAB)
    qs = np.zeros(n1)  # caudal pico específico de cada subcuenca (m³/s por m²)
    for k, b in info.items():
        qs[k] = res[k]["q_local_peak"] / max(b["area_km2"] * 1e6, 1.0)
    acc = T["acc"]
    s_al = along_slope(T)
    w = channel_width(acc / 1e6)
    q_unit = qs[lab] * acc / w
    trig = ch & (s_al >= s_trig) & (q_unit >= gregoretti_qc(s_al, d_m)) & (lab > 0)
    yield_cell = ch * w * T["step"] * bed_depth
    M, dep = debris_flows(T, lab, trig, fail * zs * dx * dx, yield_cell, s_al, s_dep)
    trig_len = np.bincount(lab, weights=trig * T["step"], minlength=n1)
    dep_by = {}
    for c, v in dep.items():
        if lab[c] > 0 and v >= 500:
            dep_by.setdefault(int(lab[c]), []).append((c, v))
    for k, b in info.items():
        r = res[k]
        o = b["outlet"]
        r["trigger_channel_km"] = round(float(trig_len[k]) / 1000, 2)
        r["debris_at_outlet_m3"] = round(float(M[o]), 0)
        dlist = sorted(dep_by.get(k, []), key=lambda cv: -cv[1])
        r["debris_deposited_m3"] = round(sum(v for _, v in dlist), 0)
        if r["trigger_channel_km"] > 0 or r["landslide_m3"] > 0:
            r["flow_formation"] = "detritos"
            r["cv_formation"] = max(r["cv_formation"], 0.4)
        if M[o] > 500:
            # el alud llega a la salida
            r.update(flow="detritos", cv=max(r["cv"], 0.45), q_debris_peak=round(rickenmann_qp(M[o]), 1))
        if dlist and frame is not None:
            pts = []
            for c, v in dlist[:6]:
                j, i = divmod(c, nx)
                lon, lat = frame.to_lonlat(i * dx, j * dx)
                pts.append([round(float(lon), 5), round(float(lat), 5), round(v, 0)])
            r["deposits"] = pts
    stride = max(1, int(math.ceil(nT / 240)))
    t_out = np.round(np.arange(0, nT, stride) * dt_h, 4).tolist()
    for k, r in res.items():
        r["hydrograph"] = np.round(Qout[k][::stride], 2).tolist()
    pc = Pc[cand & (D["lab"] > 0)]
    return dict(
        basins=res, t_h=t_out, dt_h=dt_h,
        hyetograph=dict(dt_h=dt_h, mm=np.round(rain_inc, 3).tolist()),
        storm=dict(rain_mm=P, duration_h=Dh, pattern=pattern, cn=CN2, amc=amc, areal_reduction=use_arf,
                   peak_intensity_mm_h=round(float(rain_inc.max() / dt_h), 1)),
        soil={k: (soil or {}).get(k) if (soil or {}).get(k) is not None else v for k, v in SOIL_DEFAULTS.items()},
        landslide_cells=_cells(fail, T, frame, 15000), cell_m=dx,
        debris_trigger_cells=_cells(trig, T, frame, 6000), debris_path_cells=_cells((M > 0) & ~trig & ~fail, T, frame, 15000),
        critical_rain_p10_mm=round(float(np.percentile(pc, 10)), 0) if pc.size else None,
        critical_rain_p50_mm=round(float(np.percentile(pc, 50)), 0) if pc.size else None,
    )


def _cells(mask, T, frame, cap):
    if frame is None:
        return []
    jj, ii = np.divmod(np.nonzero(np.asarray(mask).ravel())[0], T["nx"])
    if not jj.size:
        return []
    sel = np.linspace(0, jj.size - 1, min(jj.size, cap)).astype(int)
    lon, lat = frame.to_lonlat(ii[sel] * T["dx"], jj[sel] * T["dx"])
    return np.round(np.c_[lon, lat], 5).tolist()


# ───────────────────────────────────────────── respuesta completa para el mapa

def basins_payload(T, D, frame, geometry=True):
    info = D["info"]
    main_of = np.zeros(len(info) + 1, np.int32)
    for b in info:
        main_of[b["id"]] = b["main"]
    D["_main_of"] = main_of
    out = dict(dx=T["dx"], nx=T["nx"], ny=T["ny"], mode=D["mode"], subbasin_area_km2=D["A_sub_km2"],
               warnings=D["warnings"])
    keys = ("id", "name", "code", "down", "main", "area_km2", "area_up_km2", "z_outlet", "z_max", "z_mean",
            "z_max_up", "relief_up_m", "slope_mean_deg", "length_km", "channel_slope", "length_up_km",
            "channel_slope_up", "outlet_slope", "melton", "tc_h", "tc_up_h", "tc_temez_up_h", "outlet_lonlat",
            "propensity", "touches_border", "user_outlet")
    bl = []
    for b in info:
        d = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in b.items() if k in keys}
        d["is_main"] = b["down"] == 0
        bl.append(d)
    out["basins"] = bl
    if geometry:
        polys = label_polygons(D["lab"], T["dx"], frame)
        mains = label_polygons(main_of[D["lab"]], T["dx"], frame)
        for d in bl:
            d["polygon"] = polys.get(d["id"], [])
            if d["is_main"]:
                d["main_polygon"] = mains.get(d["id"], [])
                d["main_channel"] = main_channel(T, D, next(b for b in info if b["id"] == d["id"]), frame)
        out["streams"] = stream_lines(T, D, frame)
    return out
