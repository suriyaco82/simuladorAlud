#!/home/suriyaco/virtualenv/public_html/simulador.suriyaco.ar/3.11/bin/python
"""API del simulador como CGI, para servidores sin Passenger (el .htaccess elige este modo solo si falta mod_passenger).

Apache entrega el frontend como archivos estáticos y manda /api/... a este script. Cada pedido arranca Python, así
que es más lento que Passenger, pero funciona en cualquier hosting con CGI. Las simulaciones corren igual que con
Passenger: un proceso propio por simulación con el estado en disco (backend/runner.py).

La primera línea tiene que ser el Python del entorno virtual de la aplicación (Setup Python App la muestra arriba,
en «Enter to the virtual environment»). Permisos del archivo: 755.
"""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

# Apache no define HOME para los CGI, y Taichi (y otras librerías) la necesitan para su caché: se toma del usuario
if not os.environ.get("HOME"):
    import pwd
    os.environ["HOME"] = pwd.getpwuid(os.getuid()).pw_dir
os.environ.setdefault("SIMULADOR_JOBS", "detached")
_venv_py = os.path.join(sys.prefix, "bin", "python")
os.environ.setdefault("SIMULADOR_PYTHON", _venv_py if os.path.exists(_venv_py) else sys.executable)

# con la reescritura del .htaccess, SCRIPT_NAME y PATH_INFO no reflejan la URL pedida: se rearman desde REQUEST_URI
uri = os.environ.get("REQUEST_URI", "/")
os.environ["SCRIPT_NAME"] = ""
os.environ["PATH_INFO"] = uri.split("?", 1)[0]

try:
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
    from wsgiref.handlers import CGIHandler

    from a2wsgi import ASGIMiddleware

    from backend.app import app

    CGIHandler().run(ASGIMiddleware(app))
except Exception:  # error de arranque: se muestra en texto en lugar de un 500 sin detalle
    import traceback
    sys.stdout.write("Status: 500 Internal Server Error\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n")
    sys.stdout.write("El simulador no pudo arrancar:\n\n" + traceback.format_exc())
