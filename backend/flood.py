# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Inundación por lluvia en cuencas (2D, aguas someras) con flujos de barro y detritos, bloques de roca y árboles.

Modelo (todo sobre la grilla de columnas del escenario, celdas de lado dx):
- Lluvia sobre la grilla (rain-on-grid): hietograma de la tormenta × reducción areal; pérdidas por infiltración con
  SCS-CN celda a celda (CN corregido por pendiente y humedad antecedente; zonas urbanas impermeables).
- Hidrodinámica: ecuaciones de aguas someras con la aproximación inercial local (Bates et al. 2010) y el esquema
  θ de de Almeida et al. (2012); caudales por cara, limitador de volumen y de número de Froude.
- Reología de la mezcla agua-sedimento (modelo cuadrático de O'Brien y Julien 1988, como FLO-2D): tensión de
  fluencia τy(Cv) y viscosidad η(Cv) crecen exponencialmente con la concentración volumétrica Cv, más Manning.
  La mezcla se detiene donde ρ g h sen θ < τy: así se forman los depósitos de barro en los abanicos.
- Sedimento: Cv se transporta con el flujo. El lecho se erosiona donde Cv < Cv_eq (equilibrio de Takahashi según la
  pendiente) y se deposita donde Cv > Cv_eq: en quebradas empinadas el agua se carga hasta volverse un flujo de
  detritos (alud) y en el abanico lo descarga.
- Deslizamientos superficiales: cada celda de ladera falla cuando la lluvia acumulada supera su lluvia crítica
  (SHALSTAB + talud infinito) y su suelo saturado entra al flujo.
- Bloques de roca y árboles: trazadores lagrangianos. Un bloque se mueve si el tirante y la velocidad superan los
  umbrales de Costa (1983), reducidos por la flotación de la matriz en flujos densos. Un árbol de la ribera se
  arranca por erosión, deslizamiento o arrastre, y el tronco flota mientras el tirante supera su calado.
"""
from __future__ import annotations

import math
import os
import time

import numpy as np

from . import dem, hydro, landcover, roads, scenario, urbanflood

G = 9.81
RHO_W = 1000.0
RHO_S = 2650.0
CV_MAX = 0.6
# parámetros de Green-Ampt por textura (Rawls, Brakensiek y Miller 1983): Ks (mm/h), succión del frente ψ (mm),
# porosidad efectiva θe
SOIL_TEXTURES = {
    "arena": dict(name="Arena", ks_mm_h=117.8, suction_mm=49.5, porosity=0.417),
    "arenoso_franco": dict(name="Arenoso franco", ks_mm_h=29.9, suction_mm=61.3, porosity=0.401),
    "franco_arenoso": dict(name="Franco arenoso", ks_mm_h=10.9, suction_mm=110.1, porosity=0.412),
    "franco": dict(name="Franco", ks_mm_h=3.4, suction_mm=88.9, porosity=0.434),
    "franco_limoso": dict(name="Franco limoso", ks_mm_h=6.5, suction_mm=166.8, porosity=0.486),
    "franco_arcillo_arenoso": dict(name="Franco arcillo arenoso", ks_mm_h=1.5, suction_mm=218.5, porosity=0.330),
    "franco_arcilloso": dict(name="Franco arcilloso", ks_mm_h=1.0, suction_mm=208.8, porosity=0.309),
    "franco_arcillo_limoso": dict(name="Franco arcillo limoso", ks_mm_h=1.0, suction_mm=273.0, porosity=0.432),
    "arcillo_arenoso": dict(name="Arcillo arenoso", ks_mm_h=0.6, suction_mm=239.0, porosity=0.321),
    "arcillo_limoso": dict(name="Arcillo limoso", ks_mm_h=0.5, suction_mm=292.2, porosity=0.423),
    "arcilla": dict(name="Arcilla", ks_mm_h=0.3, suction_mm=316.3, porosity=0.385),
}


def _rheology_lut(p, n=256):
    """Tablas de τy/ρm (m²/s²) y K·η/(8ρm) (m²/s) en función de Cv (O'Brien y Julien 1988; τy en dyn/cm², η en poise)."""
    cv = np.linspace(0, CV_MAX, n)
    a1, b1 = float(p.get("visc_alpha", 0.036)), float(p.get("visc_beta", 22.1))
    a2, b2 = float(p.get("yield_alpha", 0.181)), float(p.get("yield_beta", 25.7))
    K = float(p.get("laminar_k", 2285.0))
    rho = RHO_W + cv * (RHO_S - RHO_W)
    ty = a2 * np.exp(b2 * cv) * 0.1  # Pa
    eta = np.maximum(a1 * np.exp(b1 * cv) * 0.1, 1e-3)  # Pa·s
    # el agua clara no tiene fluencia ni resistencia laminar (en FLO-2D el modelo cuadrático es solo para barro):
    # la fluencia se activa por encima de Cv ≈ 0,15 (hiperconcentrado) y la viscosidad, desde Cv ≈ 0,05
    ty *= np.clip((cv - 0.15) / 0.1, 0, 1)
    eta *= np.clip((cv - 0.05) / 0.1, 0, 1)
    return (ty / rho).astype(np.float64), (K * eta / (8 * rho)).astype(np.float64), cv


def _section_cells(p0, p1, dx, nx, ny):
    L = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    n = max(2, int(L / (dx / 2)) + 1)
    xs = np.linspace(p0[0], p1[0], n)
    ys = np.linspace(p0[1], p1[1], n)
    i = np.clip(np.rint(xs / dx).astype(int), 0, nx - 1)
    j = np.clip(np.rint(ys / dx).astype(int), 0, ny - 1)
    k = np.unique(j * nx + i)
    return k


def flood_dx(p):
    """dx efectivo: el pedido, aumentado si la grilla supera el presupuesto de celdas. Devuelve (dx, aviso | None)."""
    fl = {k: v for k, v in (p.get("flood") or {}).items() if v is not None}
    dx = float(p["dx"])
    fr = dem.LocalFrame(p["bbox"])
    budget = int(fl.get("max_cells") or os.environ.get("SIMULADOR_FLOOD_CELLS") or 450_000)
    cells = (fr.Lx / dx + 1) * (fr.Ly / dx + 1)
    if cells <= budget:
        return dx, None
    dx1 = math.ceil(dx * math.sqrt(cells / budget))
    return dx1, (f"dx aumentado de {dx:.0f} a {dx1:.0f} m para no superar {budget / 1e3:.0f} mil celdas. "
                 "Achicá la zona para más detalle.")


def prepare_terrain(p, progress):
    """DEM → grilla acondicionada → análisis hidrológico del terreno. Devuelve (g, T, dem_info, notas, avisos)."""
    warnings = []
    progress(stage="Cargando DEM…")
    arr, transform, dem_info = dem.load_dem(p["dataset"], p["bbox"], max_dim=2000, fallback=p.get("dem_fallback", True),
                                            progress=lambda msg: progress(stage=msg))
    if dem_info["warning"]:
        warnings.append(dem_info["warning"])
    dx, w = flood_dx(p)
    if w:
        warnings.append(w)
    g = scenario.build_grid(arr, transform, p["bbox"], dx)
    notes = scenario.condition_terrain(g, p)
    rnotes, g["roads_geo"] = roads.apply_embankments(g, p.get("roads"))
    notes += rnotes
    unotes, uw = urbanflood.apply_streets(g, p)
    notes += unotes
    warnings += uw
    fl = {k: v for k, v in (p.get("flood") or {}).items() if v is not None}
    pits = fl.get("depressions", "carve")
    progress(stage="Analizando el terreno: direcciones de flujo y cuencas…")
    T = hydro.terrain(g["H_pre"], dx, pit_mode={"carve": "carve", "keep": "keep", "shallow": "pits"}.get(pits, "carve"),
                      pit_depth_m=float(fl.get("pit_depth_m", 0.5)))
    if pits == "keep":
        notes.append("Depresiones del terreno conservadas (bajos y lagunas almacenan agua)")
    elif pits == "shallow":
        notes.append(f"Depresiones de menos de {float(fl.get('pit_depth_m', 0.5)):g} m rellenadas (artefactos del DEM); "
                     "las más profundas se conservan")
    return g, T, dem_info, notes, warnings


def basin_options(p):
    """Opciones de delineación; en modo 'target' sin polígono propio se usa la primera zona expuesta."""
    bopt = {k: v for k, v in (p.get("basins") or {}).items() if v is not None}
    if bopt.get("mode") == "target" and not bopt.get("target_polygon"):
        z0 = next((z for z in p.get("exposure") or [] if len(z.get("polygon") or []) >= 3), None)
        if z0:
            bopt.update(target_polygon=z0["polygon"], target_name=z0.get("name"))
        else:
            bopt["mode"] = "edge"
    return bopt


def select_basins(T, D, opts, frame):
    """Cuencas principales elegidas para simular, por la posición de su salida ([lon, lat] de la vista previa).

    Sin selección se usan todas. Devuelve (ids, máscara (ny, nx) de las celdas que drenan a ellas, avisos)."""
    mains = [b for b in D["info"] if b["down"] == 0]
    warnings = []
    sel = opts.get("selected")
    if sel:
        ids = []
        for lon, lat in sel:
            x, y = frame.to_xy(lon, lat)
            dist = [(math.hypot(x - (b["outlet"] % T["nx"]) * T["dx"], y - (b["outlet"] // T["nx"]) * T["dx"]), b) for b in mains]
            d, b = min(dist, key=lambda t: t[0]) if dist else (math.inf, None)
            if b is None or d > 3 * T["dx"]:
                warnings.append(f"Una cuenca elegida ({lon:.4f}, {lat:.4f}) no coincide con la delineación actual: "
                                "volvé a delinear las cuencas")
            elif b["id"] not in ids:
                ids.append(b["id"])
    else:
        ids = [b["id"] for b in mains]
    if not ids:
        raise ValueError("Las cuencas elegidas no coinciden con la delineación actual: volvé a delinear y elegí al menos una"
                         if sel else "No hay cuencas para simular en la zona: ampliala o bajá el área mínima de cuenca")
    main_of = np.zeros(len(D["info"]) + 1, np.int32)
    for b in D["info"]:
        main_of[b["id"]] = b["main"]
    return ids, np.isin(main_of[D["lab"]], ids), warnings


def basins_preview(g, T, p, with_storm=True):
    """Cuencas, cauces e hidrología SCS de la tormenta, sin la simulación 2D (para el mapa del frontend)."""
    D = hydro.delineate(T, g["frame"], basin_options(p))
    out = hydro.basins_payload(T, D, g["frame"])
    if with_storm:
        HY = hydro.hydrology(T, D, dict(p.get("storm") or {}), dict(p.get("soil") or {}), dict(p.get("debris") or {}),
                             g["frame"])
        for b in out["basins"]:
            b["storm"] = HY["basins"][b["id"]]
        out["hydrology"] = {k: v for k, v in HY.items() if k != "basins"}
    return out


def run_flood_job(job_dir, p, progress):
    """Simulación completa: DEM → cuencas → tormenta → 2D. Devuelve el dict result.json (y escribe data.bin)."""
    t_wall = time.time()
    fl = {k: v for k, v in (p.get("flood") or {}).items() if v is not None}
    g, T, dem_info, notes, warnings = prepare_terrain(p, progress)
    dx = g["dx"]
    fr = g["frame"]
    bopt = basin_options(p)
    D = hydro.delineate(T, g["frame"], bopt)
    warnings += D["warnings"]
    plain = bool(fl.get("rain_outside") or p.get("inflows"))
    try:
        sel_ids, active, w = select_basins(T, D, bopt, g["frame"])
    except ValueError:
        if not plain:
            raise
        # llanura: sin cuencas delineables (terreno plano) se llueve en toda la zona y entran los caudales de borde
        sel_ids, active, w = [], np.ones((g["ny"], g["nx"]), bool), []
    warnings += w
    # el aviso de cuencas cortadas por el borde, solo para las que se simulan
    warnings = [x for x in warnings if "toca el borde" not in x]
    cut = [b["name"] for b in D["info"] if b["id"] in sel_ids and b.get("touches_border")]
    if cut and not fl.get("rain_outside"):
        warnings.append(f"{', '.join(cut)}: la cuenca toca el borde de la zona de cálculo y probablemente sigue afuera; "
                        "ampliá la zona para incluirla completa (la lluvia que cae afuera no se simula)")
    if fl.get("rain_outside"):
        active = np.ones_like(active)
    storm = dict(p.get("storm") or {})
    soil = dict(p.get("soil") or {})
    debris = dict(p.get("debris") or {})
    progress(stage="Hidrología de la tormenta (SCS) y propensión a aludes…")
    HY = hydro.hydrology(T, D, storm, soil, debris, g["frame"])

    writer_holder = {}

    def writer_factory(zmin, zmax, erosion_scale):
        w = scenario.ResultWriter(job_dir / "data.bin", g["nx"], g["ny"], dx, zmin, zmax, erosion_scale,
                                  max_frames=int(p["max_frames"]) + 1)
        writer_holder["w"] = w
        return w

    lu = landcover.grid(g, p.get("landuse"), progress=lambda msg: progress(stage=msg))
    if lu is not None:
        notes += lu["notes"]
        warnings += lu["warnings"]
    U = urbanflood.grid(g, p)
    if U is not None:
        notes += U["notes"]
        warnings += U["warnings"]
    sim = FloodSim(g, T, D, HY, p, fl, storm, soil, debris, progress, sel_ids, active, landuse=lu, urban_grid=U)
    warnings += sim.culvert_warnings
    if sim.culverts:
        notes.append(f"{len(sim.culverts)} alcantarilla{'s' if len(sim.culverts) > 1 else ''} bajo los terraplenes")
    for q in sim.inflows:
        notes.append(f"Entrada de caudal «{q['name']}»: pico {q['Q'].max():.0f} m³/s")
    writer, fields, info = sim.run(writer_factory)

    progress(stage="Escribiendo resultados…")
    H_pre = g["H_pre"]
    for k in ("terrain_pre", "terrain_bed0", "terrain_final"):
        writer.add_array(k, {"terrain_pre": H_pre, "terrain_bed0": sim.z0.astype(np.float32),
                             "terrain_final": fields["bed_final"]}[k])
    for name in ("deposit", "erosion", "net_change", "max_depth", "max_speed", "max_pore", "arrival", "max_pressure",
                 "intensity", "max_cv", "max_hv", "runoff_total", "wet_time", "max_sewage"):
        if name not in fields:
            continue
        # la duración del anegamiento se guarda en horas (en `fields` queda en segundos para los informes)
        writer.add_array(name, fields[name] / 3600 if name == "wet_time" else fields[name])
    meta = writer.close()
    meta["grid_frames"] = sim.grid_meta

    rho_mix = RHO_W + 0.3 * (RHO_S - RHO_W)
    exposure = scenario.exposure_report(g, fields, rho_mix, p.get("exposure"), p.get("exposure_points"),
                                        p.get("exposure_heights"))
    A = dx * dx
    footprint = fields["max_depth"] > 0.1
    mains = [b for b in D["info"] if b["id"] in sel_ids]
    cx, cy = (np.mean([b["outlet"] % g["nx"] for b in mains]) * dx, np.mean([b["outlet"] // g["nx"] for b in mains]) * dx) \
        if mains else (fr.Lx / 2, fr.Ly / 2)
    clon, clat = g["frame"].to_lonlat(cx, cy)
    biggest = max(mains, key=lambda b: b["area_up_km2"]) if mains else None
    poly_xy = [(0, 0), ((g["nx"] - 1) * dx, 0), ((g["nx"] - 1) * dx, (g["ny"] - 1) * dx), (0, (g["ny"] - 1) * dx)]
    rel_poly = [list(map(float, g["frame"].to_lonlat(x, y))) for x, y in poly_xy]
    if biggest is not None:
        # contorno de las cuencas simuladas (el mayor, si son varias separadas)
        polys = hydro.label_polygons(active.astype(np.int32), dx, g["frame"])
        if polys.get(1):
            rel_poly = polys[1][0][0]
    geo = hydro.basins_payload(T, D, g["frame"])
    geo["basins"] = [b for b in geo["basins"] if b["main"] in sel_ids]
    keep = {b["id"] for b in geo["basins"]}
    for b in geo["basins"]:
        b["storm"] = {k: HY["basins"][b["id"]].get(k) for k in (
            "q_peak", "t_peak_h", "flow_formation", "flow", "q_peak_bulked", "trigger_channel_km", "debris_deposited_m3",
            "landslide_m3", "v_water_m3")}
    tot = info["totals"]
    summary = dict(
        deposit_volume_m3=round(float(fields["deposit"].sum() * A), 0),
        eroded_volume_m3=round(float(fields["erosion"].sum() * A), 0),
        affected_area_m2=round(float(footprint.sum() * A), 0),
        runout_m=round(float(info.get("flood_reach_m", 0.0)), 0), H_over_L=None,
        max_depth_m=round(float(fields["max_depth"].max()), 2),
        max_speed_m_s=round(float(fields["max_speed"].max()), 2),
        max_speed_km_h=round(float(fields["max_speed"].max()) * 3.6, 1),
        max_pore_ratio=0.0, max_cv=round(float(fields["max_cv"].max()), 3),
        wall_time_s=round(time.time() - t_wall, 1),
    )
    v0 = tot["runoff_m3"] + tot["landslide_m3"]
    if v0 > 0 and info["outflow_volume_m3"] / v0 > 0.25:
        warnings.append(f"El {info['outflow_volume_m3'] / v0 * 100:.0f}% del volumen escurrido salió por los bordes de la zona "
                        "(normal si las cuencas desaguan fuera de ella).")
    d = g
    result = dict(
        engine="flood",
        model="Inundación 2D por lluvia · inercial local + reología de barro (O'Brien-Julien) + Takahashi + SHALSTAB",
        warning="Escenario exploratorio sin calibrar: no usar para alertas, ingeniería ni zonificación.",
        dataset=p["dataset"],
        dem_source=dem_info["source"] + (" · caché" if dem_info["cached"] else ""),
        domain=dict(nx=d["nx"], ny=d["ny"], dx=dx, Lx=(d["nx"] - 1) * dx, Ly=(d["ny"] - 1) * dx,
                    west=fr.west, south=fr.south, east=fr.west + (d["nx"] - 1) * dx / fr.mx,
                    north=fr.south + (d["ny"] - 1) * dx / fr.my, mx=fr.mx, my=fr.my,
                    zmin=float(min(sim.z0.min(), fields["bed_final"].min())), zmax=float(H_pre.max())),
        release=dict(kind="lluvia", polygon=rel_poly, volume_m3=round(tot["runoff_m3"], 0), water_volume_m3=0,
                     area_m2=round(float(active.sum()) * A, 0), mean_thickness_m=0, max_thickness_m=0,
                     particles=int(info["tracers"]), spacing_m=round(dx * 0.6, 2),
                     centroid_lon=round(float(clon), 6), centroid_lat=round(float(clat), 6),
                     top_z=float(H_pre.max())),
        bodies=[],
        terrain_notes=notes,
        material=dict(rho_mixture=round(rho_mix, 1), lam_hydrostatic=0, density_solid=RHO_S, porosity=sim.nb,
                      friction_angle_deg=None, basal_friction_deg=None, viscosity_pa_s=None, saturation=1.0,
                      erodible_depth_m=sim.bed_depth),
        solver={k: v for k, v in info.items() if k not in ("gauges", "totals")},
        gauges=info["gauges"],
        summary=summary,
        warnings=warnings,
        exposure=exposure,
        scenario_name=p.get("scenario_name"),
        flood=dict(storm=HY["storm"], hyetograph=HY["hyetograph"], totals=tot,
                   basins=[dict(id=b["id"], name=b["name"], code=b.get("code"), is_main=b["down"] == 0,
                                area_km2=round(b["area_up_km2"], 2), melton=round(b["melton"], 3),
                                propensity=b["propensity"], outlet=b["outlet_lonlat"],
                                **{k: HY["basins"][b["id"]].get(k) for k in (
                                    "q_peak", "t_peak_h", "flow_formation", "flow", "q_peak_bulked",
                                    "trigger_channel_km", "debris_deposited_m3", "landslide_m3")})
                           for b in D["info"] if b["id"] in keep],
                   selected=sel_ids, geo=geo),
        **meta,
    )
    from . import impact
    result["exposure"]["points"] = impact.enrich_points(result["domain"], fields, p.get("exposure_points"),
                                                        p.get("exposure_heights"), exposure.get("points"))
    result["impact"] = impact.impact_zones(result["domain"], fields, exposure.get("points"), p.get("exposure_points"))
    result["roads"] = roads.report(g, g.get("roads_geo"), fields, p.get("roads"))
    result["landuse"] = landcover.report(lu, fields, dx)
    if U is not None:
        result["urban"] = urbanflood.report(g, U, sim.net, fields, p)
    if sim.ga:
        result["flood"]["infiltration"] = sim.ga_info
    if sim.inflows:
        result["flood"]["inflows"] = [dict(name=q["name"], volume_m3=round(q["vol"], 0), q_peak=round(float(q["Q"].max()), 1),
                                           t_h=np.round(q["t"] / 3600, 3).tolist(), Q=np.round(q["Q"], 2).tolist(),
                                           section=p["inflows"][k]["section"])
                                      for k, q in enumerate(sim.inflows)]
    return result


class FloodSim:
    def __init__(self, g, T, D, HY, p, fl, storm, soil, debris, progress, sel_ids=None, active=None, landuse=None,
                 urban_grid=None):
        self.g, self.T, self.D, self.HY, self.p, self.fl = g, T, D, HY, p, fl
        self.lu = landuse
        self.U = urban_grid
        self.sel_ids = set(sel_ids or [b["id"] for b in D["info"] if b["down"] == 0])
        # celdas donde llueve: las cuencas elegidas (fuera de ellas el agua solo llega desde aguas arriba)
        self.active = np.ones((g["ny"], g["nx"]), bool) if active is None else active
        self.progress = progress
        dx = self.dx = g["dx"]
        ny, nx = self.ny, self.nx = g["ny"], g["nx"]
        self.z0 = T["Hc"].astype(np.float64)
        self.z = self.z0.copy()
        st = {k: v for k, v in storm.items() if v is not None}
        self.P = float(st.get("rain_mm", 60.0))
        self.Dh = float(st.get("duration_h", 3.0))
        self.duration = float(p["duration_s"])
        db = {k: v for k, v in debris.items() if v is not None}
        so = {k: v for k, v in soil.items() if v is not None}
        self.nb = float(db.get("bed_porosity", 0.35))
        self.bed_depth = float(db.get("channel_erodible_m", 1.0))
        self.Es = float(fl.get("entrainment_coeff", 0.004))
        self.u_c = float(fl.get("critical_velocity", 1.0))
        self.theta = float(fl.get("theta", 0.8))
        self.fr_max = float(fl.get("froude_max", 1.5))
        tan_phi = math.tan(math.radians(float(db.get("debris_friction_deg", 35.0))))
        A_ch = float(db.get("channel_area_km2", 0.5)) * 1e6
        acc = T["acc"].reshape(ny, nx)
        slope = T["slope"]
        self.channel = acc >= A_ch

        # rugosidad de Manning: cauces, laderas y zonas urbanas
        n = np.full((ny, nx), float(fl.get("manning_hillslope", 0.06)))
        if landuse is not None:
            n = landcover.per_cell(landuse, "manning", n)
        n[self.channel] = float(fl.get("manning_channel", 0.045))
        urban = np.zeros((ny, nx), bool)
        for z in p.get("exposure") or []:
            if len(z.get("polygon") or []) >= 3:
                urban |= scenario.zone_mask(g, z["polygon"])
        if self.U is not None:
            urban |= self.U["area"]
        n[urban] = float(fl.get("manning_urban", 0.03))
        if self.U is not None:
            # calzadas lisas bajo el cordón y manzanas rugosas por las edificaciones
            urbanflood.apply_surface(self.U, n=n)
        self.urban = urban
        self.n2x = (0.5 * (n[:, :-1] + n[:, 1:])) ** 2
        self.n2y = (0.5 * (n[:-1, :] + n[1:, :])) ** 2
        # cauce de subgrilla: el agua corre concentrada en un ancho w < dx (cauce por geometría hidráulica; surcos en
        # laderas). Con todo el caudal en el ancho w, la fricción equivalente por cara es la de Manning con
        # n·(w/dx)^(2/3); cuando el tirante supera la altura de las márgenes, el agua se abre a toda la celda.
        w = np.where(self.channel, hydro.channel_width(acc / 1e6), float(fl.get("rill_fraction", 0.3)) * dx)
        w = np.minimum(w, dx)
        db = np.where(self.channel, np.clip(0.25 * w ** 0.6, 0.5, 3.0), float(fl.get("rill_depth_m", 0.05)))
        if not fl.get("subgrid_channels", True):
            w[:] = dx
        self.wx, self.dbx = np.maximum(w[:, :-1], w[:, 1:]) / dx, np.maximum(db[:, :-1], db[:, 1:])
        self.wy, self.dby = np.maximum(w[:-1, :], w[1:, :]) / dx, np.maximum(db[:-1, :], db[1:, :])

        # CN por celda (pendiente + humedad antecedente); urbano casi impermeable; roca desnuda (muy empinada) alto
        CN2 = float(st.get("cn", 80.0))
        if landuse is not None:
            CN2 = landcover.per_cell(landuse, "cn", CN2)
        CN = hydro.cn_slope(hydro.cn_amc(CN2, st.get("amc", "II")), slope)
        CN = np.where(slope > math.radians(float(so.get("max_slope_deg", hydro.SOIL_DEFAULTS["max_slope_deg"]))),
                      np.maximum(CN, 92.0), CN)
        CN[urban] = float(fl.get("cn_urban", 92.0))
        if self.U is not None:
            urbanflood.apply_surface(self.U, CN=CN)
        self.S_ret = 25400.0 / CN - 254.0
        self.ia = float(st.get("ia_ratio", 0.2))
        self._init_infiltration(urban)
        self._init_inflows()
        mains = [b for b in D["info"] if b["id"] in self.sel_ids]
        self.arf = hydro.areal_reduction(max((b["area_up_km2"] for b in mains), default=1.0)) \
            if st.get("areal_reduction", True) else 1.0
        dt_h = HY["hyetograph"]["dt_h"]
        inc = np.asarray(HY["hyetograph"]["mm"], float)
        self.rain_t = np.r_[0, np.arange(1, inc.size + 1) * dt_h * 3600]
        self.rain_c = np.r_[0, np.cumsum(inc)] * self.arf

        # lecho erosionable: cauces con bed_depth; laderas, una capa delgada; urbano y roca, nada
        E = np.full((ny, nx), float(fl.get("hillslope_erodible_m", 0.02)))
        E[self.channel] = self.bed_depth
        E[urban] = 0.0
        E[slope > math.radians(55)] = 0.0
        self.E = E
        s_al = hydro.along_slope(T).reshape(ny, nx)
        self.cv_eq = hydro.takahashi_cv(s_al, tan_phi)
        self.s_al = s_al

        # deslizamientos: lluvia crítica por celda (con la reducción areal ya aplicada a la lluvia)
        self.landslides = bool(fl.get("landslides", True))
        _, Pc, cand = hydro.soil_failure(T, soil, self.P, self.Dh)
        self.Pc = np.where(cand & self.active, Pc, np.inf)
        self.zs = float(so.get("soil_depth_m", hydro.SOIL_DEFAULTS["soil_depth_m"]))
        self.n_soil = float(so.get("porosity", hydro.SOIL_DEFAULTS["porosity"]))
        self.failed = np.zeros((ny, nx), bool)

        self.ty_lut, self.km_lut, _ = _rheology_lut(fl)
        self.rng = np.random.default_rng(int(p.get("random_seed", 42)))

        # bordes: salida libre con pendiente del terreno hacia afuera (mínimo 0,5 %)
        z = self.z0
        self.sw = np.maximum((z[:, 1] - z[:, 0]) / dx, 0.005)
        self.se = np.maximum((z[:, -2] - z[:, -1]) / dx, 0.005)
        self.ss = np.maximum((z[1, :] - z[0, :]) / dx, 0.005)
        self.sn = np.maximum((z[-2, :] - z[-1, :]) / dx, 0.005)
        self.n_w, self.n_e = np.sqrt(self.n2x[:, 0]), np.sqrt(self.n2x[:, -1])
        self.n_s, self.n_n = np.sqrt(self.n2y[0, :]), np.sqrt(self.n2y[-1, :])
        self._init_tracers(db, so)
        self._init_gauges()
        self.culvert_warnings = self._init_culverts()
        self.net = urbanflood.UrbanNet(self.U, dx, g["frame"], nx) if self.U is not None else None

    # ───────────────────────── infiltración continua (Green-Ampt), entradas de caudal y alcantarillas
    def _init_infiltration(self, urban):
        """Green-Ampt (Mein y Larson 1973) celda a celda sobre el agua en superficie, de lluvia o llegada de otro lado.

        El suelo se satura cuando lo infiltrado llena los poros libres hasta la napa: ahí deja de infiltrar (exceso
        por saturación). Sin infiltración continua se usa SCS-CN sobre la lluvia, como antes."""
        inf = {k: v for k, v in (self.p.get("infiltration") or {}).items() if v is not None}
        self.ga = inf.get("method", "scs") == "green_ampt"
        self.evap = float(inf.get("evaporation_mm_day", 0.0)) / 1000 / 86400  # m/s
        if not self.ga:
            return
        tex = SOIL_TEXTURES.get(inf.get("texture", "franco"), SOIL_TEXTURES["franco"])
        ks = float(inf.get("ks_mm_h", tex["ks_mm_h"])) / 1000 / 3600  # m/s
        psi = float(inf.get("suction_mm", tex["suction_mm"])) / 1000
        theta_e = float(inf.get("porosity", tex["porosity"]))
        se0 = float(inf.get("initial_saturation", 0.5))
        dtheta = max(theta_e * (1 - se0), 1e-3)
        wt = inf.get("water_table_m")
        Ks = np.full((self.ny, self.nx), ks)
        if self.lu is not None:
            Ks *= landcover.per_cell(self.lu, "ks_factor", 1.0)
        if self.U is not None:
            Ks *= urbanflood.ks_factor(self.U)
        else:
            Ks[urban] *= 0.05
        self.Ks, self.psi_dt = Ks, psi * dtheta
        # capacidad hasta la napa (m de agua); sin napa, sin límite
        self.F_cap = np.full((self.ny, self.nx), dtheta * float(wt) if wt is not None else np.inf)
        self.F = np.zeros((self.ny, self.nx))
        self.ga_info = dict(texture=inf.get("texture", "franco"), ks_mm_h=round(ks * 3.6e6, 2), suction_mm=round(psi * 1000, 1),
                            porosity=theta_e, initial_saturation=se0, water_table_m=wt,
                            storage_mm=round(dtheta * float(wt) * 1000, 0) if wt is not None else None)

    def _infiltrate(self, h, dt):
        """Infiltración del paso (m de agua por celda); modifica h in situ."""
        F = self.F
        rate = self.Ks * (1 + self.psi_dt / np.maximum(F, 1e-3))
        dF = np.minimum(np.minimum(rate * dt, h), np.maximum(self.F_cap - F, 0))
        h -= dF
        F += dF
        return dF

    def _init_inflows(self):
        """Hidrogramas de entrada Q(t) (m³/s) en una sección (crecida que llega de aguas arriba de la zona)."""
        fr, dx = self.g["frame"], self.dx
        self.inflows = []
        for k, q in enumerate(self.p.get("inflows") or []):
            (lo0, la0), (lo1, la1) = q["section"][0], q["section"][-1]
            x0, y0 = fr.to_xy(lo0, la0)
            x1, y1 = fr.to_xy(lo1, la1)
            cells = _section_cells((float(x0), float(y0)), (float(x1), float(y1)), dx, self.nx, self.ny)
            zc = self.z0.ravel()[cells]
            # el caudal entra concentrado en las celdas más bajas de la sección (el cauce)
            w = (zc.max() - zc + 0.1) ** 2
            hy = np.asarray(q["hydrograph"], float)
            hy = hy[np.argsort(hy[:, 0])]
            self.inflows.append(dict(name=q.get("name") or f"Entrada {k + 1}", cells=cells, w=w / w.sum(),
                                     t=hy[:, 0] * 3600, Q=np.maximum(hy[:, 1], 0), vol=0.0,
                                     cv=float(q.get("cv") or 0.0)))

    def _init_culverts(self):
        links, w = roads.culvert_links(self.g, self.g.get("roads_geo"), (self.p.get("roads") or {}).get("culverts"))
        self.culverts = links
        return w

    # ───────────────────────── trazadores: bloques de roca y árboles
    def _init_tracers(self, db, so):
        ny, nx, dx = self.ny, self.nx, self.dx
        rng = self.rng
        nbl = int(self.fl.get("boulders", 1500))
        dmax = float(self.fl.get("boulder_dmax_m", 3.0))
        dmin = float(self.fl.get("boulder_dmin_m", 0.4))
        # bloques en el lecho de los cauces empinados (> 4°) y una reserva que nace con los deslizamientos
        cand = np.nonzero((self.channel & (self.s_al > 0.07) & (self.E > 0) & self.active).ravel())[0]
        n_bed = min(nbl if not self.landslides else int(nbl * 0.65), cand.size)
        sel = rng.choice(cand, n_bed, replace=False) if n_bed else np.zeros(0, int)
        self.n_bl_reserve = nbl - n_bed if self.landslides else 0
        jj, ii = np.divmod(sel, nx)
        n_all = n_bed + self.n_bl_reserve
        self.bx = np.full(n_all, np.nan)
        self.by = np.full(n_all, np.nan)
        self.bx[:n_bed] = (ii + rng.random(n_bed) - 0.5) * dx
        self.by[:n_bed] = (jj + rng.random(n_bed) - 0.5) * dx
        self.bd = dmin + (dmax - dmin) * rng.random(n_all) ** 2.5
        self.b_on = np.zeros(n_all, bool)
        self.b_on[:n_bed] = True
        self.b_next = n_bed
        self.b_x0, self.b_y0 = self.bx.copy(), self.by.copy()
        self.b_moved = np.zeros(n_all, bool)

        # árboles: en la ribera de los cauces (cauce + celdas vecinas), según la densidad dada
        dens = float(self.fl.get("trees_per_km", 40.0))  # árboles por km de cauce
        rip = self.channel.copy()
        rip[1:, :] |= self.channel[:-1, :]
        rip[:-1, :] |= self.channel[1:, :]
        rip[:, 1:] |= self.channel[:, :-1]
        rip[:, :-1] |= self.channel[:, 1:]
        rip &= ~self.urban & self.active
        ch_km = (self.channel & self.active).sum() * dx / 1000
        ntr = int(min(float(self.fl.get("max_trees", 2500)), dens * ch_km))
        cand = np.nonzero(rip.ravel())[0]
        ntr = min(ntr, cand.size)
        sel = rng.choice(cand, ntr, replace=False) if ntr else np.zeros(0, int)
        jj, ii = np.divmod(sel, nx)
        self.tx = (ii + rng.random(ntr) - 0.5) * dx
        self.ty = (jj + rng.random(ntr) - 0.5) * dx
        self.t_state = np.zeros(ntr, np.int8)  # 0 en pie · 1 tronco arrastrado · 2 tronco varado
        self.t_len = 3 + 7 * rng.random(ntr)
        self.t_diam = 0.15 + 0.35 * rng.random(ntr)
        self.t_x0, self.t_y0 = self.tx.copy(), self.ty.copy()

    def _cell(self, x, y):
        i = np.clip(np.rint(x / self.dx).astype(int), 0, self.nx - 1)
        j = np.clip(np.rint(y / self.dx).astype(int), 0, self.ny - 1)
        return j, i

    def _move_tracers(self, h, u, v, cv, dt):
        # bloques: umbral de Costa (1983) v_c = 0,18·d_mm^0,487; la matriz densa los sostiene (flotación)
        on = self.b_on
        if on.any():
            j, i = self._cell(self.bx[on], self.by[on])
            hh, uu, vv, cc = h[j, i], u[j, i], v[j, i], cv[j, i]
            sp = np.hypot(uu, vv)
            d = self.bd[on]
            sup = np.clip(1 - cc / 0.5, 0.25, 1.0)
            mob = (hh > 0.6 * d * sup) & (sp > 0.18 * (d * 1000) ** 0.487 * sup)
            f = np.where(mob, 0.75, 0.0) * dt
            bx, by = self.bx[on], self.by[on]
            self.bx[on] = np.clip(bx + uu * f, 0, (self.nx - 1) * self.dx)
            self.by[on] = np.clip(by + vv * f, 0, (self.ny - 1) * self.dx)
            idx = np.nonzero(on)[0]
            self.b_moved[idx[mob]] = True
        # árboles
        st = self.t_state
        if st.size:
            j, i = self._cell(self.tx, self.ty)
            hh, uu, vv = h[j, i], u[j, i], v[j, i]
            sp = np.hypot(uu, vv)
            ero = self.z0[j, i] - self.z[j, i]
            uproot = (st == 0) & ((ero > 0.4) | (self.failed[j, i]) | ((hh > 1.2) & (sp > 2.5)))
            st[uproot] = 1
            draft = 0.6 * self.t_diam + 0.1
            float_ = (st >= 1) & (hh > draft)
            st[(st >= 1) & ~float_] = 2
            st[float_] = 1
            f = np.where(float_, dt, 0.0)
            self.tx = np.clip(self.tx + uu * f, 0, (self.nx - 1) * self.dx)
            self.ty = np.clip(self.ty + vv * f, 0, (self.ny - 1) * self.dx)

    def _spawn_boulders(self, cells_flat):
        """Bloques que nacen con un deslizamiento (roca del suelo/coluvio que se desprende)."""
        free = self.b_on.size - self.b_next
        k = min(free, max(1, cells_flat.size // 3)) if cells_flat.size else 0
        if k <= 0:
            return
        sel = self.rng.choice(cells_flat, k, replace=cells_flat.size < k)
        jj, ii = np.divmod(sel, self.nx)
        a, b = self.b_next, self.b_next + k
        self.bx[a:b] = (ii + self.rng.random(k) - 0.5) * self.dx
        self.by[a:b] = (jj + self.rng.random(k) - 0.5) * self.dx
        self.b_x0[a:b], self.b_y0[a:b] = self.bx[a:b], self.by[a:b]
        self.b_on[a:b] = True
        self.b_next = b

    # ───────────────────────── estaciones de aforo
    def _init_gauges(self):
        g, T, D = self.g, self.T, self.D
        dx, nx, ny = self.dx, self.nx, self.ny
        fr = g["frame"]
        self.gauges = []
        for gg in self.p.get("gauges") or []:
            (lo0, la0), (lo1, la1) = gg["section"]
            x0, y0 = fr.to_xy(lo0, la0)
            x1, y1 = fr.to_xy(lo1, la1)
            ks = _section_cells((float(x0), float(y0)), (float(x1), float(y1)), dx, nx, ny)
            tx, ty = float(x1 - x0), float(y1 - y0)
            L = math.hypot(tx, ty) or 1.0
            nrm = np.array([-ty / L, tx / L])
            # orientar la normal aguas abajo (dirección D8 en la celda de mayor área)
            c = ks[np.argmax(T["acc"][ks])]
            r = T["rec"][c]
            if r >= 0:
                fdir = np.array([(r % nx) - (c % nx), (r // nx) - (c // nx)], float)
                if fdir @ nrm < 0:
                    nrm = -nrm
            self.gauges.append(dict(name=gg["name"], cells=ks, n=nrm, auto=False))
        # salidas de las cuencas elegidas y de sus subcuencas (de mayor a menor)
        mains = sorted([b for b in D["info"] if b["id"] in self.sel_ids], key=lambda b: -b["area_up_km2"])
        mains += sorted([b for b in D["info"] if b["down"] != 0 and b["main"] in self.sel_ids], key=lambda b: -b["area_up_km2"])
        # caudal = flujo neto que sale del área de aporte de la salida (la cuenca o subcuenca y todo lo que drena a ella)
        # por todas sus caras, incluido el borde de la zona: no depende de por dónde corra el agua en el 2D (lámina
        # ancha, cauce junto al borde, dos cauces que llegan juntos), a diferencia de una sección transversal
        kids = {}
        for x in D["info"]:
            kids.setdefault(x["down"], []).append(x["id"])
        lab = D["lab"]
        for b in mains[:int(self.fl.get("auto_gauges", 16))]:
            ids, stack = [], [b["id"]]
            while stack:
                k = stack.pop()
                ids.append(k)
                stack += kids.get(k, [])
            M = np.isin(lab, ids)
            Mx = np.pad(M, ((0, 0), (1, 1)))
            Lx, Rx = Mx[:, :-1], Mx[:, 1:]  # celda a la izquierda / derecha de cada cara x (ny, nx + 1)
            My = np.pad(M, ((1, 1), (0, 0)))
            By, Ty = My[:-1, :], My[1:, :]  # celda abajo / arriba de cada cara y (ny + 1, nx)
            sx = (Lx & ~Rx).astype(np.int8) - (~Lx & Rx)
            sy = (By & ~Ty).astype(np.int8) - (~By & Ty)
            fx, fy = np.nonzero(sx.ravel())[0], np.nonzero(sy.ravel())[0]
            c = b["outlet"]
            j0, i0 = divmod(c, nx)
            near = [(j0 + dj) * nx + i0 + di for dj in (-1, 0, 1) for di in (-1, 0, 1) if 0 <= j0 + dj < ny and 0 <= i0 + di < nx]
            self.gauges.append(dict(name=f"{b['name']} (salida)" if b["down"] == 0 else b["name"], cells=np.asarray(near),
                                    fx=fx, sx=sx.ravel()[fx].astype(float), fy=fy, sy=sy.ravel()[fy].astype(float),
                                    auto=True, basin=b["id"], code=b.get("code")))
        for gg in self.gauges:
            gg.update(t=[], Q=[], h=[], v=[], cv=[])

    def _record_gauges(self, t, h, qcx, qcy, cv, qx, qy):
        qxf, qyf = qx.ravel(), qy.ravel()
        for gg in self.gauges:
            k = gg["cells"]
            hh = h.ravel()[k]
            if "fx" in gg:
                Q = float((qxf[gg["fx"]] @ gg["sx"] + qyf[gg["fy"]] @ gg["sy"]) * self.dx)
            else:
                qn = qcx.ravel()[k] * gg["n"][0] + qcy.ravel()[k] * gg["n"][1]
                Q = float(qn.sum() * self.dx)
            gg["t"].append(round(t, 1))
            gg["Q"].append(round(max(Q, 0.0), 2))
            gg["h"].append(round(float(hh.max()), 2))
            sp = np.hypot(qcx.ravel()[k], qcy.ravel()[k]) / np.maximum(hh, 0.01)
            gg["v"].append(round(float(np.where(hh > 0.05, sp, 0).max()), 2))
            gg["cv"].append(round(float(cv.ravel()[k][np.argmax(hh)]), 3))

    # ───────────────────────── bucle principal
    def run(self, writer_factory):
        p, fl = self.p, self.fl
        ny, nx, dx = self.ny, self.nx, self.dx
        g_dx = G / dx
        h = np.zeros((ny, nx))
        hs = np.zeros((ny, nx))
        # agua mezclada con líquido cloacal (desbordes de la red cloacal), transportada como trazador pasivo
        hc = np.zeros((ny, nx)) if self.net is not None and self.net.sewer else None
        max_sew = np.zeros((ny, nx), np.float32) if hc is not None else None
        qx = np.zeros((ny, nx + 1))
        qy = np.zeros((ny + 1, nx))
        pe_prev = np.zeros((ny, nx))
        rain_prev = 0.0
        z = self.z
        A = dx * dx
        max_h = np.zeros((ny, nx), np.float32)
        max_v = np.zeros((ny, nx), np.float32)
        max_cv = np.zeros((ny, nx), np.float32)
        max_hv = np.zeros((ny, nx), np.float32)
        max_pd = np.zeros((ny, nx), np.float32)
        inten = np.zeros((ny, nx), np.float32)
        arrival = np.full((ny, nx), -1.0, np.float32)
        outflow = 0.0
        infil_vol = evap_vol = culv_vol = 0.0
        wet_time = np.zeros((ny, nx), np.float32)
        dt_max = float(fl.get("dt_max", 10.0))
        ls_vol = 0.0
        ls_cells = 0
        h_arr = float(fl.get("arrival_depth_m", 0.15))

        zmin = float(z.min()) - self.bed_depth - self.zs - 2
        zmax = float(z.max()) + 30
        writer = writer_factory(zmin, zmax, erosion_scale=max(self.bed_depth, self.zs, 1.0) * 1.5)
        frame_dt = max(5.0, self.duration / float(p["max_frames"]))
        n_cells = nx * ny
        s = max(1, int(math.ceil(math.sqrt(n_cells / float(fl.get("display_cells", 160_000))))))
        gnx, gny = (nx - 1) // s + 1, (ny - 1) // s + 1
        self.grid_meta = dict(stride=s, nx=gnx, ny=gny, h_scale=20.0, cv_scale=CV_MAX)
        gauge_dt = max(10.0, min(60.0, frame_dt / 3))
        t = 0.0
        next_frame = 0.0
        next_gauge = 0.0
        next_ls = 0.0
        steps = 0
        last_prog = 0.0
        stopped_early = False
        theta = self.theta
        fr_max = self.fr_max

        def cell_velocity(h, qx, qy):
            qcx = 0.5 * (qx[:, :-1] + qx[:, 1:])
            qcy = 0.5 * (qy[:-1, :] + qy[1:, :])
            hh = np.maximum(h, 0.01)
            return qcx, qcy, qcx / hh, qcy / hh

        def write_frame(t, h, hs, qcx, qcy, u, v, cv):
            # índice fijo por trazador (el visor interpola por índice): los bloques que todavía no nacieron
            # van como inactivos (bandera −1)
            on = self.b_on
            bx, by = np.where(on, self.bx, 0.0), np.where(on, self.by, 0.0)
            jb, ib = self._cell(bx, by)
            sp_b = np.where(on, np.hypot(u[jb, ib], v[jb, ib]) * 0.75, 0)
            tj, ti = self._cell(self.tx, self.ty)
            x = np.r_[bx, self.tx]
            y = np.r_[by, self.ty]
            zz = np.r_[np.where(on, z[jb, ib] + 0.3 * self.bd, zmin), z[tj, ti] + np.where(self.t_state > 0, h[tj, ti], 0)]
            spd = np.r_[sp_b, np.where(self.t_state == 1, np.hypot(u[tj, ti], v[tj, ti]), 0)]
            lam = np.r_[np.clip(self.bd / 4.0, 0, 1), np.clip(self.t_len / 12.0, 0, 1)]
            flag = np.r_[np.where(on, 4, -1).astype(np.int32), np.where(self.t_state == 0, 5, 3).astype(np.int32)]
            ero = np.maximum(self.z0 - z, 0).astype(np.float32)
            hd = h[::s, ::s]
            hq = np.clip(np.rint(np.sqrt(np.clip(hd, 0, 20.0) / 20.0) * 255), 0, 255).astype(np.uint8)
            cq = np.clip(np.rint(cv[::s, ::s] / CV_MAX * 255), 0, 255).astype(np.uint8)
            writer.add_frame(t, x, y, zz, spd, lam, flag, erosion=ero)
            fr = writer.frames[-1]
            fr["grid_offset"] = writer._write(hq.tobytes())
            fr["cv_offset"] = writer._write(cq.tobytes())

        progress = self.progress
        progress(stage="Simulando la tormenta y la crecida…", t=0.0, particles=int(self.b_on.sum() + self.t_state.size), vmax=0.0)
        wall0 = time.time()
        while t < self.duration - 1e-9:
            # ── paso de tiempo (CFL de la onda de gravedad + advección)
            hmax = float(h.max())
            qcx, qcy, u, v = cell_velocity(h, qx, qy)
            vmax = float(np.sqrt(u * u + v * v)[h > 0.01].max()) if (h > 0.01).any() else 0.0
            dt = 0.7 * dx / (math.sqrt(G * max(hmax, 0.01)) + vmax)
            dt = min(dt, dt_max, next_frame - t if next_frame > t else dt_max, self.duration - t)
            dt = max(dt, 0.02)

            # ── salida de cuadros y aforos (estado al comienzo del paso)
            cv = np.where(h > 1e-3, hs / np.maximum(h, 1e-9), 0.0)
            if t >= next_frame - 1e-6:
                write_frame(t, h, hs, qcx, qcy, u, v, cv)
                next_frame += frame_dt
            if t >= next_gauge - 1e-6:
                self._record_gauges(t, h, qcx, qcy, cv, qx, qy)
                if self.net is not None:
                    self.net.record(t)
                next_gauge += gauge_dt
                # intensidad: crecida (Cv < 0,2) por profundidad y h·v; barro/detritos por h y v (Hürlimann)
                sp = np.hypot(u, v)
                hv = h * sp
                water = np.zeros_like(h, dtype=np.float32)
                wet = h > 0.1
                water[wet] = 1
                water[wet & ((h > 0.5) | (hv > 0.5))] = 2
                water[wet & ((h > 2.0) | (hv > 2.0))] = 3
                deb = scenario.intensity_class(h, sp)
                cls = np.where(cv >= 0.2, deb, water)
                np.maximum(inten, cls, out=inten)

            # ── deslizamientos que dispara la lluvia acumulada
            if self.landslides and t >= next_ls - 1e-6:
                Pnow = float(np.interp(t, self.rain_t, self.rain_c))
                new = ~self.failed & (self.Pc <= Pnow)
                if new.any():
                    self.failed |= new
                    hz = self.zs
                    z[new] -= hz
                    h[new] += hz
                    hs[new] += (1 - self.n_soil) * hz
                    self.E[new] = 0.0
                    ls_vol += float(new.sum()) * hz * A
                    ls_cells += int(new.sum())
                    self._spawn_boulders(np.nonzero(new.ravel())[0])
                next_ls += 30.0

            eta = z + h
            cv = np.where(h > 1e-3, hs / np.maximum(h, 1e-9), 0.0)
            sc = np.where(h > 1e-3, hc / np.maximum(h, 1e-9), 0.0) if hc is not None else None
            ci = np.clip((cv * (255 / CV_MAX)).astype(np.int32), 0, 255)

            # ── caras x interiores
            eL, eR = eta[:, :-1], eta[:, 1:]
            hf = np.maximum(np.maximum(eL, eR) - np.maximum(z[:, :-1], z[:, 1:]), 0.0)
            q = qx[:, 1:-1]
            if theta < 1:
                qt = q.copy()
                qt[:, 1:-1] = theta * q[:, 1:-1] + (1 - theta) * 0.5 * (q[:, :-2] + q[:, 2:])
            else:
                qt = q
            Sx = (eR - eL) / dx
            up = np.where(eL >= eR, ci[:, :-1], ci[:, 1:])
            qn = qt - G * hf * dt * Sx
            Y = dt * self.ty_lut[up]
            qn = np.sign(qn) * np.maximum(np.abs(qn) - Y, 0.0)
            hfc = np.maximum(hf, 1e-6)
            fw = np.clip(hf / self.dbx, self.wx, 1.0) ** (4 / 3)  # (w_ef/dx)^(4/3)
            den = 1 + G * dt * self.n2x * fw * np.abs(q) / hfc ** (7 / 3) + dt * self.km_lut[up] / hfc ** 2
            qn = qn / den
            cap = hf * np.minimum(fr_max * np.sqrt(G * hf), 25.0)
            qn = np.clip(qn, -cap, cap)
            qn[hf < 1e-6] = 0.0
            qx[:, 1:-1] = qn
            # ── caras y interiores
            eB, eT = eta[:-1, :], eta[1:, :]
            hf = np.maximum(np.maximum(eB, eT) - np.maximum(z[:-1, :], z[1:, :]), 0.0)
            q = qy[1:-1, :]
            if theta < 1:
                qt = q.copy()
                qt[1:-1, :] = theta * q[1:-1, :] + (1 - theta) * 0.5 * (q[:-2, :] + q[2:, :])
            else:
                qt = q
            Sy = (eT - eB) / dx
            up = np.where(eB >= eT, ci[:-1, :], ci[1:, :])
            qn = qt - G * hf * dt * Sy
            Y = dt * self.ty_lut[up]
            qn = np.sign(qn) * np.maximum(np.abs(qn) - Y, 0.0)
            hfc = np.maximum(hf, 1e-6)
            fw = np.clip(hf / self.dby, self.wy, 1.0) ** (4 / 3)
            den = 1 + G * dt * self.n2y * fw * np.abs(q) / hfc ** (7 / 3) + dt * self.km_lut[up] / hfc ** 2
            qn = qn / den
            cap = hf * np.minimum(fr_max * np.sqrt(G * hf), 25.0)
            qn = np.clip(qn, -cap, cap)
            qn[hf < 1e-6] = 0.0
            qy[1:-1, :] = qn
            # ── bordes: salida libre con flujo normal de Manning (solo hacia afuera)
            mf = lambda hb, S, n: np.minimum(hb ** (5 / 3) * np.sqrt(S) / n, hb * np.sqrt(G * hb))
            qx[:, 0] = -mf(h[:, 0], self.sw, self.n_w)
            qx[:, -1] = mf(h[:, -1], self.se, self.n_e)
            qy[0, :] = -mf(h[0, :], self.ss, self.n_s)
            qy[-1, :] = mf(h[-1, :], self.sn, self.n_n)

            # ── limitador de volumen: lo que sale de una celda en el paso no supera lo que tiene
            out = (np.maximum(qx[:, 1:], 0) + np.maximum(-qx[:, :-1], 0) +
                   np.maximum(qy[1:, :], 0) + np.maximum(-qy[:-1, :], 0)) * (dt / dx)
            f = np.where(out > h, h / np.maximum(out, 1e-12), 1.0)
            if (f < 1).any():
                # cada cara se escala con el factor de su celda de aguas arriba
                qx[:, 1:-1] *= np.where(qx[:, 1:-1] > 0, f[:, :-1], f[:, 1:])
                qx[:, 0] *= f[:, 0]
                qx[:, -1] *= f[:, -1]
                qy[1:-1, :] *= np.where(qy[1:-1, :] > 0, f[:-1, :], f[1:, :])
                qy[0, :] *= f[0, :]
                qy[-1, :] *= f[-1, :]

            # ── masa de mezcla y de sedimento (upwind)
            cvx = np.empty((ny, nx + 1))
            cvx[:, 1:-1] = np.where(qx[:, 1:-1] > 0, cv[:, :-1], cv[:, 1:])
            cvx[:, 0], cvx[:, -1] = cv[:, 0], cv[:, -1]
            cvy = np.empty((ny + 1, nx))
            cvy[1:-1, :] = np.where(qy[1:-1, :] > 0, cv[:-1, :], cv[1:, :])
            cvy[0, :], cvy[-1, :] = cv[0, :], cv[-1, :]
            k = dt / dx
            dh = k * (qx[:, :-1] - qx[:, 1:] + qy[:-1, :] - qy[1:, :])
            dhs = k * (qx[:, :-1] * cvx[:, :-1] - qx[:, 1:] * cvx[:, 1:] + qy[:-1, :] * cvy[:-1, :] - qy[1:, :] * cvy[1:, :])
            if hc is not None:
                scx = np.empty((ny, nx + 1))
                scx[:, 1:-1] = np.where(qx[:, 1:-1] > 0, sc[:, :-1], sc[:, 1:])
                scx[:, 0], scx[:, -1] = sc[:, 0], sc[:, -1]
                scy = np.empty((ny + 1, nx))
                scy[1:-1, :] = np.where(qy[1:-1, :] > 0, sc[:-1, :], sc[1:, :])
                scy[0, :], scy[-1, :] = sc[0, :], sc[-1, :]
                hc += k * (qx[:, :-1] * scx[:, :-1] - qx[:, 1:] * scx[:, 1:] + qy[:-1, :] * scy[:-1, :] - qy[1:, :] * scy[1:, :])
            outflow += float((-qx[:, 0].sum() + qx[:, -1].sum() - qy[0, :].sum() + qy[-1, :].sum()) * dt * dx)
            h += dh
            hs += dhs
            np.maximum(h, 0, out=h)
            np.clip(hs, 0, CV_MAX * h, out=hs)

            # ── lluvia: efectiva por SCS-CN, o total con infiltración continua (Green-Ampt)
            dP = 0.0
            if t < self.rain_t[-1]:
                Pn = float(np.interp(t + dt, self.rain_t, self.rain_c))
                if Pn > rain_prev:
                    dP = Pn - rain_prev
                    if self.ga:
                        h[self.active] += (Pn - rain_prev) / 1000.0
                    else:
                        Ia = self.ia * self.S_ret
                        pe = np.where(self.active & (Pn > Ia), (Pn - Ia) ** 2 / (Pn - Ia + self.S_ret), 0.0)
                        h += (pe - pe_prev) / 1000.0
                        pe_prev = pe
                    rain_prev = Pn
            # ── caudales que entran por las secciones de borde
            for q in self.inflows:
                Qn = float(np.interp(t + dt / 2, q["t"], q["Q"]))
                if Qn > 0:
                    V = Qn * dt
                    hf, sf = h.ravel(), hs.ravel()
                    hf[q["cells"]] += V * q["w"] / A
                    if q["cv"] > 0:
                        sf[q["cells"]] += q["cv"] * V * q["w"] / A
                    q["vol"] += V
            # ── infiltración del agua en superficie, evaporación y alcantarillas
            if self.ga:
                infil_vol += float(self._infiltrate(h, dt).sum()) * A
            if self.evap > 0:
                e = np.minimum(h, self.evap * dt)
                h -= e
                evap_vol += float(e.sum()) * A
            if self.culverts:
                culv_vol += roads.culvert_step(h.ravel(), z.ravel(), self.culverts, dt, A)
            if self.net is not None:
                self.net.step(h, hc, dP, dt, t)
            if self.ga or self.evap > 0 or self.net is not None:
                np.clip(hs, 0, CV_MAX * h, out=hs)
            if hc is not None:
                np.clip(hc, 0, h, out=hc)

            # ── erosión y depósito (equilibrio de Takahashi)
            qcx, qcy, u, v = cell_velocity(h, qx, qy)
            sp = np.hypot(u, v)
            cv = np.where(h > 1e-3, hs / np.maximum(h, 1e-9), 0.0)
            ceq = self.cv_eq
            act = (h > 0.05) & (sp > self.u_c) & (self.E > 0) & (cv < ceq)
            if act.any():
                qm = sp[act] * h[act]
                e = self.Es * qm * (1 - cv[act] / np.maximum(ceq[act], 1e-6)) * dt
                lim = np.maximum(ceq[act] * h[act] - hs[act], 0) / np.maximum((1 - self.nb) - ceq[act], 0.05)
                e = np.minimum(np.minimum(e, lim), self.E[act])
                z[act] -= e
                self.E[act] -= e
                h[act] += e
                hs[act] += (1 - self.nb) * e
            dep = (h > 1e-3) & (cv > ceq + 0.01)
            if dep.any():
                tdep = np.where(sp[dep] < 0.3, 20.0, 120.0)
                ds = (hs[dep] - ceq[dep] * h[dep]) * np.minimum(1.0, dt / tdep)
                dz = np.minimum(ds / (1 - self.nb), 0.9 * h[dep])
                ds = dz * (1 - self.nb)
                z[dep] += dz
                hs[dep] -= ds
                h[dep] -= dz
                self.E[dep] += dz  # lo depositado puede volver a erosionarse

            # ── trazadores, máximos y tiempo
            cv = np.where(h > 1e-3, hs / np.maximum(h, 1e-9), 0.0)
            self._move_tracers(h, u, v, cv, dt)
            t += dt
            steps += 1
            np.maximum(max_h, h, out=max_h, casting="unsafe")
            wet = h > 0.05
            spw = np.where(wet, sp, 0)
            np.maximum(max_v, spw, out=max_v, casting="unsafe")
            np.maximum(max_cv, np.where(wet, cv, 0), out=max_cv, casting="unsafe")
            np.maximum(max_hv, h * spw, out=max_hv, casting="unsafe")
            np.maximum(max_pd, (RHO_W + cv * (RHO_S - RHO_W)) * spw ** 2 / 1000, out=max_pd, casting="unsafe")
            wet_time[h > 0.1] += dt
            if hc is not None:
                np.maximum(max_sew, np.where(h > 0.05, hc / np.maximum(h, 1e-9), 0), out=max_sew, casting="unsafe")
            newly = (arrival < 0) & (h > h_arr)
            arrival[newly] = t
            now = time.time()
            if now - last_prog > 1.0:
                last_prog = now
                progress(t=round(t, 1), particles=int(self.b_on.sum() + self.t_state.size), vmax=round(vmax, 2),
                         steps=steps, dt=round(dt, 3))

        # cuadro final
        qcx, qcy, u, v = cell_velocity(h, qx, qy)
        cv = np.where(h > 1e-3, hs / np.maximum(h, 1e-9), 0.0)
        write_frame(t, h, hs, qcx, qcy, u, v, cv)
        self._record_gauges(t, h, qcx, qcy, cv, qx, qy)

        self.h_end, self.hs_end, self.qx_end, self.qy_end = h, hs, qx, qy
        # el sedimento que sigue en suspensión al final se considera depositado donde está
        deposit = np.maximum(z - self.z0, 0) + hs / (1 - self.nb)
        erosion = np.maximum(self.z0 - z, 0)
        rain_total = np.interp(self.duration, self.rain_t, self.rain_c)
        if self.ga:
            runoff_total = np.maximum(np.where(self.active, rain_prev, 0.0) - self.F * 1000, 0)
        else:
            runoff_total = pe_prev
        fields = dict(
            deposit=deposit.astype(np.float32), erosion=erosion.astype(np.float32),
            net_change=(z + hs / (1 - self.nb) - self.z0).astype(np.float32),
            max_depth=max_h, max_speed=max_v, max_pore=np.zeros_like(max_h), arrival=arrival,
            max_pressure=max_pd, intensity=inten, max_cv=max_cv, max_hv=max_hv,
            runoff_total=runoff_total.astype(np.float32),
            wet_time=wet_time,
            bed_final=z.astype(np.float32),
        )
        if max_sew is not None:
            fields["max_sewage"] = max_sew
        # trazadores: resumen
        b_mob = int(self.b_moved.sum())
        b_dist = np.hypot(self.bx - self.b_x0, self.by - self.b_y0)
        tr_up = int((self.t_state > 0).sum())
        t_dist = np.hypot(self.tx - self.t_x0, self.ty - self.t_y0)
        logs_urban = 0
        if self.t_state.size and self.urban.any():
            j, i = self._cell(self.tx, self.ty)
            logs_urban = int(((self.t_state > 0) & self.urban[j, i]).sum())
        boulders_urban = 0
        if self.b_on.any() and self.urban.any():
            j, i = self._cell(self.bx[self.b_on], self.by[self.b_on])
            boulders_urban = int((self.urban[j, i] & self.b_moved[self.b_on]).sum())
        rain_vol = float(rain_total) / 1000 * float(self.active.sum()) * A
        inflow_vol = float(sum(q["vol"] for q in self.inflows))
        if self.ga:
            # escurrimiento neto: lo que no se infiltró ni evaporó (incluye el agua que entró por los bordes)
            runoff_vol = max(rain_vol + inflow_vol - infil_vol - evap_vol, 0.0)
        else:
            runoff_vol = float(pe_prev.sum()) / 1000 * A
        net = self.net
        drained = 0.0
        if net is not None:
            # lo que las redes llevaron fuera de la zona (la pluvial con desagüe marcado lo devuelve a la superficie)
            drained = float(net.sw["conveyed"].sum()) + (float(net.st["conveyed"].sum()) if net.outlet is None else 0.0)
        fp = max_h > 0.1
        reach = 0.0
        totals = dict(
            rain_mm=round(float(rain_total), 1), rain_m3=round(rain_vol, 0), runoff_m3=round(runoff_vol, 0),
            infiltration_m3=round(infil_vol if self.ga else rain_vol - runoff_vol, 0),
            runoff_coeff=round(min(runoff_vol / (rain_vol + inflow_vol), 1.0), 3) if rain_vol + inflow_vol > 0 else 0,
            inflow_m3=round(inflow_vol, 0), evaporation_m3=round(evap_vol, 0), culvert_m3=round(culv_vol, 0),
            drained_m3=round(drained, 0),
            infiltration_method="green_ampt" if self.ga else "scs",
            saturated_area_km2=round(float((self.F >= self.F_cap - 1e-6).sum()) * A / 1e6, 2) if self.ga else None,
            flooded_24h_km2=round(float((wet_time >= 86400).sum()) * A / 1e6, 2),
            outflow_m3=round(outflow, 0), stored_m3=round(float(h.sum()) * A, 0),
            landslide_cells=ls_cells, landslide_m3=round(ls_vol, 0),
            eroded_m3=round(float(erosion.sum()) * A, 0), deposited_m3=round(float(deposit.sum()) * A, 0),
            flooded_area_km2=round(float(fp.sum()) * A / 1e6, 2),
            boulders=int(self.b_on.sum()), boulders_moved=b_mob,
            boulder_max_travel_m=round(float(np.nanmax(b_dist)) if self.b_on.any() else 0.0, 0),
            boulders_in_urban=boulders_urban,
            trees=int(self.t_state.size), trees_uprooted=tr_up,
            log_max_travel_m=round(float(t_dist.max()) if t_dist.size else 0.0, 0), logs_in_urban=logs_urban,
            areal_reduction=round(self.arf, 3),
        )
        gauges = []
        hy = self.HY["basins"]
        for gg in self.gauges:
            e = dict(name=gg["name"], t=gg["t"], Q=gg["Q"], h=gg["h"], v=gg["v"], cv=gg["cv"])
            if gg.get("auto"):
                # hidrograma del método SCS en la misma salida, para comparar
                hq = hy.get(gg["basin"], {}).get("hydrograph")
                if hq:
                    th = np.asarray(self.HY["t_h"]) * 3600
                    e["Q_scs"] = np.round(np.interp(gg["t"], th, hq, right=0), 2).tolist()
            gauges.append(e)
        info = dict(device="cpu (numpy)", grid=[nx, ny], dx=dx, steps=steps, t_end=round(t, 1),
                    particles_final=int(self.b_on.sum() + self.t_state.size), stopped_early=stopped_early,
                    outflow_volume_m3=round(outflow, 0), tracers=int(self.b_on.size + self.t_state.size),
                    wall_solver_s=round(time.time() - wall0, 1), flood_reach_m=reach,
                    gauges=gauges, totals=totals)
        return writer, fields, info
