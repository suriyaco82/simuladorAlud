"""Biblioteca de análisis: cada simulación terminada queda guardada con nombre y proyecto, para volver a abrirla
sin recalcular y para compararla con otras.

Cada análisis es una carpeta cache/library/<id>/ con params.json (lo que se simuló), ui.json (el escenario del
frontend: edificios, vista), result.json, data.bin y entry.json (nombre, proyecto e indicadores para el listado).
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import numpy as np


def read_json(path):
    """JSON en UTF-8; los guardados antes en Windows con la codificación del sistema (cp1252) también se leen."""
    raw = Path(path).read_bytes()
    try:
        return json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError:
        return json.loads(raw.decode("cp1252"))

ENGINES = {"mpm": "MPM 3D", "particles": "Partículas", "flood": "Inundación por lluvia"}
LEGACY_PROJECT = "Análisis anteriores"


class Library:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    # ── rutas
    def dir(self, aid: str) -> Path:
        if not aid.isalnum():
            raise KeyError(aid)
        return self.root / aid

    def exists(self, aid):
        try:
            return (self.dir(aid) / "entry.json").exists()
        except KeyError:
            return False

    # ── escritura
    def save_request(self, d: Path, params: dict, ui: dict | None):
        (d / "params.json").write_text(json.dumps(params, ensure_ascii=False), encoding="utf-8")
        if ui:
            (d / "ui.json").write_text(json.dumps(ui, ensure_ascii=False), encoding="utf-8")

    def finalize(self, d: Path, created: float | None = None, project: str | None = None, name: str | None = None):
        """Escribe entry.json a partir de result.json (al terminar una simulación o al importar)."""
        res = read_json((d / "result.json"))
        params = self._json(d / "params.json") or {}
        created = created or (d / "result.json").stat().st_mtime
        name = name or params.get("analysis_name") or res.get("scenario_name") or \
            f"{ENGINES.get(res.get('engine'), res.get('engine'))} · {time.strftime('%d/%m/%Y %H:%M', time.localtime(created))}"
        entry = dict(id=d.name, name=name, project=(project or params.get("project") or "Sin proyecto").strip(),
                     notes=params.get("analysis_notes") or "", created=created, engine=res.get("engine"),
                     scenario=res.get("scenario_name"), dataset=res.get("dataset"), dem_source=res.get("dem_source"),
                     bbox=params.get("bbox") or {k: res["domain"][k] for k in ("west", "south", "east", "north")},
                     kpis=kpis(res))
        (d / "entry.json").write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
        return entry

    def import_legacy(self, jobs_dir: Path):
        """Resultados que quedaron en cache/jobs de versiones anteriores: se pasan a la biblioteca."""
        if not jobs_dir.exists():
            return 0
        n = 0
        for d in sorted(jobs_dir.iterdir(), key=lambda p: p.stat().st_mtime):
            if not d.is_dir():
                continue
            if not ((d / "result.json").exists() and (d / "data.bin").exists()):
                shutil.rmtree(d, ignore_errors=True)
                continue
            dest = self.root / d.name
            if dest.exists():
                continue
            created = (d / "result.json").stat().st_mtime
            shutil.move(str(d), dest)
            try:
                self.finalize(dest, created=created, project=LEGACY_PROJECT)
                n += 1
            except Exception:  # resultado de un formato viejo que no se puede leer
                shutil.rmtree(dest, ignore_errors=True)
        return n

    # ── lectura
    @staticmethod
    def _json(p: Path):
        return read_json(p) if p.exists() else None

    def entries(self):
        out = []
        for d in self.root.iterdir():
            e = self._json(d / "entry.json") if d.is_dir() else None
            if e:
                out.append(e)
        return sorted(out, key=lambda e: -e["created"])

    def get(self, aid):
        d = self.dir(aid)
        e = self._json(d / "entry.json")
        if not e:
            raise KeyError(aid)
        return dict(e, params=self._json(d / "params.json"), ui=self._json(d / "ui.json"))

    def update(self, aid, **kw):
        d = self.dir(aid)
        e = self._json(d / "entry.json")
        if not e:
            raise KeyError(aid)
        for k in ("name", "project", "notes"):
            if kw.get(k) is not None:
                e[k] = str(kw[k]).strip() or e[k]
        (d / "entry.json").write_text(json.dumps(e, ensure_ascii=False), encoding="utf-8")
        return e

    def delete(self, aid):
        d = self.dir(aid)
        if not d.exists():
            raise KeyError(aid)
        shutil.rmtree(d, ignore_errors=True)

    def fields(self, aid, names=None):
        """Campos float32 (ny × nx) guardados en data.bin."""
        d = self.dir(aid)
        res = read_json((d / "result.json"))
        arrays = res["arrays"]
        out = {}
        with open(d / "data.bin", "rb") as f:
            for k in names or arrays:
                a = arrays.get(k)
                if not a:
                    continue
                f.seek(a["offset"])
                out[k] = np.frombuffer(f.read(a["length"] * 4), "<f4")
        return res, out

    def field_bytes(self, aid, name):
        _, F = self.fields(aid, [name])
        if name not in F:
            raise KeyError(name)
        return F[name].tobytes()

    def ensure_impact(self, aid):
        """Agrega las zonas de afectación y el grado de daño a un resultado guardado antes de que existieran."""
        from . import impact
        d = self.dir(aid)
        res = read_json((d / "result.json"))
        if "impact" in res:
            return False
        _, F = self.fields(aid, ["intensity", "max_depth", "max_speed", "max_pressure", "arrival", "deposit", "max_cv"])
        dom = res["domain"]
        F = {k: v.reshape(dom["ny"], dom["nx"]) for k, v in F.items()}
        params = self._json(d / "params.json") or {}
        ex = res.get("exposure") or {}
        pts = ex.get("points")
        epts = params.get("exposure_points")
        if pts and epts and len(epts) == len(pts["intensity"]):
            impact.enrich_points(dom, F, epts, params.get("exposure_heights"), pts)
        else:
            epts = None
        res["impact"] = impact.impact_zones(dom, F, pts, epts)
        from .scenario import write_json
        write_json(d / "result.json", res)
        e = self._json(d / "entry.json")
        if e:
            e["kpis"] = kpis(res)
            (d / "entry.json").write_text(json.dumps(e, ensure_ascii=False), encoding="utf-8")
        return True


def kpis(res: dict) -> dict:
    """Indicadores principales de un resultado, para el listado y las comparaciones."""
    s = res.get("summary") or {}
    rel = res.get("release") or {}
    k = dict(affected_area_m2=s.get("affected_area_m2"), max_depth_m=s.get("max_depth_m"),
             max_speed_m_s=s.get("max_speed_m_s"), runout_m=s.get("runout_m"),
             deposit_volume_m3=s.get("deposit_volume_m3"), eroded_volume_m3=s.get("eroded_volume_m3"),
             release_volume_m3=rel.get("volume_m3"), wall_time_s=s.get("wall_time_s"),
             max_cv=s.get("max_cv"), dx=(res.get("domain") or {}).get("dx"))
    fl = res.get("flood")
    if fl:
        t = fl.get("totals") or {}
        st = fl.get("storm") or {}
        k.update(rain_mm=st.get("rain_mm"), duration_h=st.get("duration_h"), runoff_m3=t.get("runoff_m3"),
                 flooded_area_km2=t.get("flooded_area_km2"))
    pts = (res.get("exposure") or {}).get("points")
    if pts:
        k.update(buildings_total=pts.get("total"), buildings_affected=pts.get("affected"),
                 buildings_by_intensity=pts.get("counts"), buildings_by_damage=pts.get("damage_counts"),
                 first_building_arrival_s=pts.get("first_arrival_s"), buildings_overtopped=pts.get("overtopped"))
    zones = (res.get("exposure") or {}).get("zones") or []
    if zones:
        z = zones[0]
        k.update(urban_zone=z.get("name"), urban_affected_area_m2=z.get("affected_area_m2"),
                 urban_first_arrival_s=z.get("first_arrival_s"))
    imp = res.get("impact")
    if imp:
        zs = imp.get("zones") or []
        k.update(zones=len(zs), zones_critical=sum(z["criticality"] == "Crítica" for z in zs),
                 zones_high=sum(z["criticality"] == "Alta" for z in zs), area_by_level_m2=imp.get("area_by_level_m2"))
    return k
