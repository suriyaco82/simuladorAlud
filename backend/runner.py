# Copyright (c) 2026 Alfredo Toledo · SuriyacoValley · La Rioja, Argentina
# SPDX-License-Identifier: AGPL-3.0-or-later (con términos adicionales de atribución, ver NOTICE)
"""Simulaciones desacopladas del servidor web, para hosting con Passenger (cPanel).

Passenger puede levantar varios procesos de la aplicación y cerrarlos cuando están inactivos, así que el estado de
una simulación no puede vivir en la memoria del proceso web ni la simulación correr dentro de él. En este modo
(SIMULADOR_JOBS=detached) cada simulación es un proceso propio, `python -m backend.runner <carpeta>`, en otra sesión:
escribe su estado en <carpeta>/status.json, que cualquier proceso web puede leer. Un candado de archivo
(flock) hace que corran de a una, en el orden en que llegan.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATUS = "status.json"


def _write(d: Path, st: dict):
    tmp = d / f".{STATUS}.{os.getpid()}"
    tmp.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, d / STATUS)


def _read(d: Path):
    try:
        return json.loads((d / STATUS).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _mem_mb():
    """Pico de memoria residente de este proceso (MB)."""
    import resource
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(r / (1024 * 1024 if sys.platform == "darwin" else 1024), 0)


def _vm_peak_mb():
    """Pico de memoria virtual reservada (Linux, /proc/self/status VmPeak), en MB; None si no se puede leer."""
    try:
        for line in open("/proc/self/status", encoding="ascii"):
            if line.startswith("VmPeak:"):
                return round(int(line.split()[1]) / 1024)
    except OSError:
        return None
    return None


def _limits():
    """Límites del sistema para este proceso (los que fija el hosting): CPU en s, memoria en MB; None = sin límite."""
    import resource
    out = {}
    for name, key, scale in (("cpu_s", "RLIMIT_CPU", 1), ("address_space_mb", "RLIMIT_AS", 1 << 20),
                             ("data_mb", "RLIMIT_DATA", 1 << 20), ("rss_mb", "RLIMIT_RSS", 1 << 20),
                             ("processes", "RLIMIT_NPROC", 1)):
        if hasattr(resource, key):
            soft, _ = resource.getrlimit(getattr(resource, key))
            out[name] = None if soft == resource.RLIM_INFINITY else round(soft / scale)
    return out


def _limits_txt(lim):
    lab = {"cpu_s": "CPU %s s", "address_space_mb": "memoria virtual %s MB", "data_mb": "datos %s MB",
           "rss_mb": "memoria residente %s MB", "processes": "%s procesos"}
    s = [lab[k] % v for k, v in (lim or {}).items() if v is not None]
    return ", ".join(s) if s else "sin límites por proceso declarados"


class _StatusQueue:
    """Recibe los mensajes de worker.run_job (como la cola de multiprocessing) y los vuelca a status.json."""

    def __init__(self, d: Path, st: dict):
        self.d, self.st, self.last = d, st, 0.0
        self.result = None

    def put(self, msg):
        st = self.st
        if msg["type"] == "progress":
            if "stage" in msg:
                st["stage"] = msg["stage"]
            st.setdefault("progress", {}).update({k: v for k, v in msg.items() if k not in ("type", "stage")})
            if "t" in msg:
                st["stage"] = "Simulando"
            now = time.time()
            if "stage" in msg or now - self.last > 0.5:
                self.last = now
                st["mem_mb"] = _mem_mb()
                st["vm_peak_mb"] = _vm_peak_mb()
                _write(self.d, st)
        else:
            self.result = msg


def main(job_dir: str):
    import fcntl
    if not os.environ.get("HOME"):  # Taichi aborta sin HOME (CGI de Apache no la define)
        import pwd
        os.environ["HOME"] = pwd.getpwuid(os.getuid()).pw_dir
    from .library import Library, read_json
    from .worker import run_job
    d = Path(job_dir)
    st = _read(d) or {}
    st.update(status="queued", stage="En cola", pid=os.getpid())
    _write(d, st)
    with open(d.parent / ".runner.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # espera a que termine la simulación anterior
        if (d / "cancel").exists():
            shutil.rmtree(d, ignore_errors=True)
            return
        st.update(status="running", stage="Iniciando…", started=time.time(), limits=_limits())
        _write(d, st)
        print(f"[runner] pid {os.getpid()} · límites: {_limits_txt(st['limits'])}", flush=True)

        # el hosting avisa con una señal antes de cortar por CPU (SIGXCPU) o al terminar el proceso (SIGTERM, SIGHUP):
        # se deja escrito el motivo antes de salir. Un corte por memoria (SIGKILL) no se puede atrapar.
        import signal as _sig

        def _killed(signum, frame):
            name = _sig.Signals(signum).name
            why = {"SIGXCPU": "superó el límite de tiempo de CPU por proceso del hosting",
                   "SIGTERM": "el servidor terminó el proceso (SIGTERM)",
                   "SIGHUP": "el servidor cerró la sesión del proceso (SIGHUP)"}.get(name, f"recibió la señal {name}")
            el = time.time() - st["started"]
            st.update(status="error", stage="Error", finished=time.time(), signal=name, mem_mb=_mem_mb(),
                      error=f"La simulación se cortó: {why}, a los {el:.0f} s ({st.get('stage')}, memoria {_mem_mb():.0f} MB). "
                            f"Límites del servidor: {_limits_txt(st.get('limits'))}.")
            _write(d, st)
            print(f"[runner] {st['error']}", flush=True)
            os._exit(1)

        for s_ in ("SIGXCPU", "SIGTERM", "SIGHUP"):
            if hasattr(_sig, s_):
                _sig.signal(getattr(_sig, s_), _killed)
        q = _StatusQueue(d, st)
        try:
            run_job(str(d), read_json(d / "params.json"), q)
            msg = q.result or dict(type="error", error="La simulación terminó sin resultado")
        except BaseException as e:  # noqa: BLE001 — el estado tiene que quedar escrito pase lo que pase
            msg = dict(type="error", error=f"{type(e).__name__}: {e}")
        if msg["type"] == "done":
            try:
                Library(d.parent).finalize(d, created=st.get("created"))
            except Exception as e:  # el resultado queda igual disponible
                st["library_error"] = str(e)
            st.update(status="done", stage="Completada", finished=time.time())
        else:
            st.update(status="error", stage="Error", error=msg.get("error"), trace=msg.get("trace"), finished=time.time())
        _write(d, st)


class DetachedJobManager:
    """Misma interfaz que app.JobManager (submit, cancel, public, get, forget), con el estado en disco."""

    def __init__(self, library):
        self.library = library
        self.python = os.environ.get("SIMULADOR_PYTHON") or sys.executable

    def _dir(self, jid):
        if not jid or not jid.isalnum():
            return None
        d = self.library.root / jid
        return d if d.is_dir() else None

    def submit(self, params: dict, ui: dict | None = None) -> str:
        self._cleanup()
        jid = uuid.uuid4().hex[:12]
        d = self.library.root / jid
        d.mkdir(parents=True)
        self.library.save_request(d, params, ui)
        _write(d, dict(id=jid, status="queued", stage="En cola", created=time.time(),
                       duration_s=params["duration_s"], engine=params["engine"], progress={}))
        log = open(d / "runner.log", "ab")
        proc = subprocess.Popen([self.python, "-m", "backend.runner", str(d)], cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        log.close()
        # recoger el proceso al terminar (sin zombis mientras este proceso web siga vivo)
        threading.Thread(target=proc.wait, daemon=True).start()
        return jid

    def get(self, jid):
        d = self._dir(jid)
        st = _read(d) if d else None
        if st and st.get("status") in ("queued", "running") and st.get("pid") and not _alive(st["pid"]):
            el = time.time() - st["started"] if st.get("started") else None
            tail = ""
            try:
                lines = (d / "runner.log").read_text(encoding="utf-8", errors="replace").strip().splitlines()
                tail = " | ".join(x.strip() for x in lines[-4:] if x.strip())[-600:]
            except OSError:
                pass
            crash = any(k in tail for k in ("Traceback", "Error:", "Assertion failure", "terminate called", "Segmentation fault",
                                            "core dumped", "Aborted"))
            if crash:
                st.update(status="error", stage="Error", error=(
                    "El proceso de simulación terminó por un error interno" +
                    (f" a los {el:.0f} s, en la etapa «{st.get('stage')}»" if el is not None else "") +
                    f" (no fue la memoria). Registro: {tail}"))
                _write(d, st)
                return st
            st.update(status="error", stage="Error", error=(
                "El proceso de simulación desapareció sin aviso" +
                (f" a los {el:.0f} s, en la etapa «{st.get('stage')}»" if el is not None else " antes de empezar") +
                (f", con {st['mem_mb']:.0f} MB de memoria usada" if st.get("mem_mb") else "") +
                (f" y {st['vm_peak_mb']} MB de memoria virtual reservada" if st.get("vm_peak_mb") else "") + ". " +
                "Lo más probable es que el hosting lo haya cortado por memoria (un corte por memoria no deja aviso)" +
                (f". Límites del servidor: {_limits_txt(st.get('limits'))}" if st.get("limits") else "") +
                ". Probá con una zona más chica o un dx mayor." + (f" Últimas líneas del registro: {tail}" if tail else "")))
            _write(d, st)
        return st

    def forget(self, jid):
        pass

    def cancel(self, jid):
        d = self._dir(jid)
        st = _read(d) if d else None
        if not st:
            return False
        if st.get("status") in ("queued", "running"):
            (d / "cancel").touch()
            if st.get("pid") and _alive(st["pid"]):
                try:
                    os.killpg(st["pid"], signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
            st.update(status="cancelled", stage="Cancelada")
            _write(d, st)
            shutil.rmtree(d, ignore_errors=True)
        return True

    def public(self, jid):
        from fastapi import HTTPException
        st = self.get(jid)
        if not st:
            if self.library.exists(jid):
                return dict(id=jid, status="done", stage="Completada", error=None, progress={})
            raise HTTPException(404, "Job inexistente")
        out = {k: st.get(k) for k in ("id", "status", "stage", "error", "progress", "duration_s", "engine")}
        out["id"] = jid
        if st.get("started"):
            out["elapsed_s"] = round((st.get("finished") or time.time()) - st["started"], 1)
        return out

    def _cleanup(self, max_age_s=86400):
        """Borra las carpetas de simulaciones con error o canceladas de hace más de un día."""
        now = time.time()
        for d in self.library.root.iterdir():
            if not d.is_dir() or (d / "entry.json").exists():
                continue
            st = _read(d)
            if st and st.get("status") in ("queued", "running") and _alive(st.get("pid")):
                continue
            if now - d.stat().st_mtime > max_age_s:
                shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv[1])
