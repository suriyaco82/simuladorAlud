"""Ejecución de una simulación en un proceso separado (aísla Taichi/GPU y permite cancelar)."""
from __future__ import annotations

import math
import os
import time
import traceback
from pathlib import Path

import numpy as np

NODE_BUDGET = {"gpu": 24_000_000, "auto": 24_000_000, "cpu": 10_000_000}


def _env_int(name):
    try:
        return int(float(os.environ[name]))
    except (KeyError, ValueError):
        return None


def run_job(job_dir: str, p: dict, q):
    from . import dem, scenario

    job_dir = Path(job_dir)
    t_start = time.time()

    def progress(**kw):
        q.put(dict(type="progress", **kw))

    try:
        if p["engine"] == "flood":
            from .flood import run_flood_job
            scenario.write_json(job_dir / "result.json", run_flood_job(job_dir, p, progress))
            q.put(dict(type="done"))
            return
        progress(stage="Cargando DEM…")
        arr, transform, dem_info = dem.load_dem(p["dataset"], p["bbox"], max_dim=900 if p["engine"] == "mpm" else 480,
                                                fallback=p.get("dem_fallback", True),
                                                progress=lambda msg: progress(stage=msg))

        dx = float(p["dx"])
        warnings = [dem_info["warning"]] if dem_info["warning"] else []
        if p["engine"] == "mpm":
            budget = NODE_BUDGET.get(p["device"], NODE_BUDGET["cpu"])
            # hosting compartido: memoria limitada (SIMULADOR_MPM_NODES y SIMULADOR_MAX_PARTICLES, ver api.cgi)
            if _env_int("SIMULADOR_MPM_NODES"):
                budget = min(budget, _env_int("SIMULADOR_MPM_NODES"))
            if _env_int("SIMULADOR_MAX_PARTICLES") and p["max_particles"] > _env_int("SIMULADOR_MAX_PARTICLES"):
                p["max_particles"] = _env_int("SIMULADOR_MAX_PARTICLES")
                warnings.append(f"Partículas limitadas a {p['max_particles']:,} por la memoria del servidor".replace(",", "."))
            for _ in range(6):
                g = scenario.build_grid(arr, transform, p["bbox"], dx)
                nz = scenario.estimate_nz(g["H_pre"], dx, p["erodible_depth_m"] + 2 * p["release_thickness_m"], 10 * dx)
                nodes = g["nx"] * g["ny"] * nz
                if nodes <= budget:
                    break
                dx *= (nodes / budget) ** (1 / 3) * 1.02
            if dx > p["dx"] * 1.01:
                warnings.append(f"dx aumentado de {p['dx']:.1f} a {dx:.1f} m para respetar el presupuesto de "
                                f"memoria ({budget/1e6:.1f} M nodos). Reducí la zona de cálculo para más detalle.")
        g = scenario.build_grid(arr, transform, p["bbox"], dx)
        notes = scenario.condition_terrain(g, p)

        progress(stage="Generando masa de desprendimiento…")
        if p.get("bodies"):
            if p["engine"] != "mpm":
                raise ValueError("Los escenarios con varios cuerpos (agua, hielo) requieren el motor MPM 3D")
            rel = scenario.build_bodies(g, p)
        else:
            rel = scenario.build_release(g, p)
        erod = scenario.build_erodible(g, rel, p)
        rho, lam_eq = scenario.mixture(p)
        prm = dict(p, rho=rho, lam_eq=lam_eq, lam_bed=max(lam_eq, 0.0))
        breach = scenario.build_breach(g, p)
        if breach is not None:
            prm["_breach"] = breach
            notes.append(f"Brecha prescrita: {breach['length_m']:.0f} m de eje, {p['breach']['depth_m']:.0f} m de profundidad inicial, "
                         f"{breach['volume_m3'] / 1e6:.2f} M m³ removidos entre t = {breach['start_s']:.0f} s y "
                         f"{breach['start_s'] + breach['duration_s']:.0f} s")
        if prm.get("pore_ratio_initial") is None:
            prm["pore_ratio_initial"] = lam_eq
        prm["frame_dt"] = max(0.25, float(p["duration_s"]) / float(p["max_frames"]))

        hmean = rel["info"]["mean_thickness_m"]
        if p["engine"] == "mpm" and hmean < dx:
            warnings.append(f"Espesor medio ({hmean:.1f} m) menor que dx ({dx:.1f} m): la masa queda "
                            "sub-resuelta en la vertical. Para 3D real usá dx ≤ espesor/2.")
        if rel["info"]["discretization_error"] > 0.15:
            warnings.append("El volumen discretizado difiere >15% del objetivo; reducí dx.")

        def writer_factory(zmin, zmax, erosion_scale):
            return scenario.ResultWriter(job_dir / "data.bin", g["nx"], g["ny"], dx, zmin, zmax, erosion_scale,
                                         max_frames=int(p["max_frames"]) + 1)

        if p["engine"] == "mpm":
            from .mpm import run_mpm
            writer, fields, info = run_mpm(g, rel, erod, prm, writer_factory, progress)
        else:
            from .particles import run_particles
            writer, fields, info = run_particles(g, rel, prm, writer_factory, progress)

        progress(stage="Escribiendo resultados…")
        H_pre = g["H_pre"]
        fields["net_change"] = fields["bed_final"] + fields["deposit"] - H_pre
        for name in ("deposit", "erosion", "net_change", "max_depth", "max_speed", "max_pore", "arrival"):
            fields[name] = np.asarray(fields[name], np.float32)
        # presión dinámica máxima estimada ρ·v²máx (kPa) e intensidad (clasificación para flujos de detritos)
        wet = fields["max_depth"] > 0.1
        fields["max_pressure"] = np.where(wet, rho * fields["max_speed"] ** 2 / 1000.0, 0).astype(np.float32)
        fields["intensity"] = scenario.intensity_class(fields["max_depth"], fields["max_speed"])
        writer.add_array("terrain_pre", H_pre)
        writer.add_array("terrain_bed0", rel["H_bed"])
        writer.add_array("terrain_final", fields["bed_final"])
        for name in ("deposit", "erosion", "net_change", "max_depth", "max_speed", "max_pore", "arrival",
                     "max_pressure", "intensity"):
            writer.add_array(name, fields[name])
        meta = writer.close()

        summary = scenario.summarize_fields(g, rel, fields, time.time() - t_start)
        exposure = scenario.exposure_report(g, fields, rho, p.get("exposure"), p.get("exposure_points"),
                                           p.get("exposure_heights"))
        v0 = rel["info"]["volume_m3"] + rel["info"].get("water_volume_m3", 0) + summary["eroded_volume_m3"]
        out = float(info.get("outflow_volume_m3") or 0)
        if v0 > 0 and out / v0 > 0.10:
            # borde por donde salió: el más cercano a la envolvente del flujo
            fp = fields["max_depth"] > 0.1
            jj, ii = np.nonzero(fp)
            sides = {"oeste": ii.min(), "este": g["nx"] - 1 - ii.max(), "sur": jj.min(), "norte": g["ny"] - 1 - jj.max()} if ii.size else {}
            near = [k for k, v in sorted(sides.items(), key=lambda kv: kv[1]) if v <= 3]
            where = f" por el borde {', '.join(near)}" if near else ""
            warnings.insert(0, f"El {out / v0 * 100:.0f}% del volumen ({out / 1e6:.2f} M m³) salió de la zona de cálculo{where}: "
                               "ampliá la zona en esa dirección para ver el recorrido y el depósito completos.")
        fr = g["frame"]
        result = dict(
            engine=p["engine"],
            model=("MLS-MPM 3D · Drucker-Prager + presión de poros + erosión" if p["engine"] == "mpm"
                   else "Partículas independientes (exploratorio)"),
            warning="Escenario exploratorio sin calibrar: no usar para alertas, ingeniería ni zonificación.",
            dataset=p["dataset"],
            dem_source=dem_info["source"] + (" · caché" if dem_info["cached"] else ""),
            domain=dict(nx=g["nx"], ny=g["ny"], dx=dx, Lx=(g["nx"] - 1) * dx, Ly=(g["ny"] - 1) * dx,
                        west=fr.west, south=fr.south, east=fr.west + (g["nx"] - 1) * dx / fr.mx,
                        north=fr.south + (g["ny"] - 1) * dx / fr.my, mx=fr.mx, my=fr.my,
                        zmin=float(min(rel["H_bed"].min(), fields["bed_final"].min())), zmax=float(H_pre.max())),
            release=dict(rel["info"], polygon=[list(map(float, fr.to_lonlat(x, y))) for x, y in rel["poly"]]),
            bodies=[dict(name=b["name"], material=b["material"], volume_m3=b["volume_m3"], trigger=b.get("trigger"),
                         polygon=[list(map(float, fr.to_lonlat(x, y))) for x, y in poly])
                    for b, poly in zip(rel["info"].get("bodies", []), rel.get("polys", []))],
            terrain_notes=notes,
            material=dict(rho_mixture=round(rho, 1), lam_hydrostatic=round(lam_eq, 3),
                          **{k: p[k] for k in ("density_solid", "porosity", "friction_angle_deg", "basal_friction_deg",
                                               "viscosity_pa_s", "saturation", "erodible_depth_m")}),
            solver={k: v for k, v in info.items() if k != "gauges"},
            gauges=info.get("gauges", []),
            summary=summary,
            warnings=warnings,
            exposure=exposure,
            scenario_name=p.get("scenario_name"),
            **meta,
        )
        from . import impact
        result["exposure"]["points"] = impact.enrich_points(result["domain"], fields, p.get("exposure_points"),
                                                            p.get("exposure_heights"), exposure.get("points"))
        result["impact"] = impact.impact_zones(result["domain"], fields, exposure.get("points"), p.get("exposure_points"))
        scenario.write_json(job_dir / "result.json", result)
        q.put(dict(type="done"))
    except Exception as e:
        q.put(dict(type="error", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()))
