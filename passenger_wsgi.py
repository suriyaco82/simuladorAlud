"""Entrada para cPanel «Setup Python App» (Phusion Passenger / LiteSpeed, WSGI).

FastAPI es ASGI: a2wsgi lo adapta a WSGI. Las simulaciones corren desacopladas del proceso web (backend/runner.py),
porque Passenger puede levantar varios procesos de la aplicación y cerrarlos cuando están inactivos.
"""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

# Apache no define HOME para los CGI, y Taichi (y otras librerías) la necesitan para su caché: se toma del usuario
if not os.environ.get("HOME"):
    import pwd
    os.environ["HOME"] = pwd.getpwuid(os.getuid()).pw_dir
os.environ.setdefault("SIMULADOR_JOBS", "detached")
# intérprete del entorno virtual para lanzar las simulaciones (con LiteSpeed, sys.executable puede ser el lanzador)
_venv_py = os.path.join(sys.prefix, "bin", "python")
os.environ.setdefault("SIMULADOR_PYTHON", _venv_py if os.path.exists(_venv_py) else sys.executable)

# hosting compartido: tamaños máximos más chicos que en una PC, para no superar la memoria del plan. Se pueden subir
# en backend/.env (p. ej. SIMULADOR_FLOOD_CELLS=450000) si el hosting da más memoria.
# límite de memoria virtual por proceso (4 GB en este hosting): cada hilo reserva memoria por adelantado (hasta
# 64 MB por arena de malloc), y numpy y Taichi abren uno por núcleo del servidor. Se limitan antes de importar numpy.
for _k, _v in (("MALLOC_ARENA_MAX", "2"), ("OMP_NUM_THREADS", "2"), ("OPENBLAS_NUM_THREADS", "2"), ("MKL_NUM_THREADS", "2"),
               ("NUMEXPR_NUM_THREADS", "2"), ("SIMULADOR_THREADS", "2"), ("SIMULADOR_FORCE_CPU", "1"),
               ("TI_MANYLINUX2014_OK", "1")):
    os.environ.setdefault(_k, _v)
from backend import dem as _dem  # noqa: E402,F401  (carga backend/.env antes de fijar los valores por defecto)
for _k, _v in (("SIMULADOR_MPM_NODES", "2000000"), ("SIMULADOR_MAX_PARTICLES", "200000"), ("SIMULADOR_FLOOD_CELLS", "250000")):
    os.environ.setdefault(_k, _v)

from a2wsgi import ASGIMiddleware  # noqa: E402

from backend.app import app  # noqa: E402

application = ASGIMiddleware(app)
