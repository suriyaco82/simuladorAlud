"""Diagnóstico de la instalación en cPanel, para hostings sin acceso por consola.

Correr desde Setup Python App → «Execute python script» con: diagnostico_cpanel.py
Muestra la versión de Python, los paquetes que faltan, si la aplicación arranca (con el error completo si no) y
el final del log de Passenger. El resultado se ve en pantalla y queda en diagnostico.txt, en esta misma carpeta.
"""
import importlib
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.abspath(__file__))
out = []


def p(*a):
    out.append(" ".join(str(x) for x in a))


p("Python:", sys.version.split()[0], "·", sys.executable)
p("Carpeta:", ROOT)
st = os.stat(os.path.join(ROOT, "passenger_wsgi.py"))
p("passenger_wsgi.py:", st.st_size, "bytes", "(OK)" if st.st_size > 500 else "(¡es la plantilla de cPanel, reemplazalo!)")
p("")
for mod in ["fastapi", "a2wsgi", "pydantic", "multipart", "requests", "numpy", "scipy", "rasterio", "pyproj", "laspy",
            "lazrs", "pyarrow", "taichi"]:
    try:
        m = importlib.import_module(mod)
        p(f"  ok   {mod} {getattr(m, '__version__', '')}")
    except Exception as e:
        p(f"  FALTA {mod}: {type(e).__name__}: {e}")
p("")
env_file = os.path.join(ROOT, "backend", ".env")
key_env = bool(os.environ.get("OPENTOPOGRAPHY_API_KEY", "").strip())
key_file = os.path.exists(env_file) and "OPENTOPOGRAPHY_API_KEY" in open(env_file, encoding="utf-8", errors="replace").read()
p("OPENTOPOGRAPHY_API_KEY:", "en backend/.env (sirve en Passenger y CGI)" if key_file else
  "solo como variable de entorno (en modo CGI no llega: creá backend/.env)" if key_env else "no configurada")
p("")
sys.path.insert(0, ROOT)
try:
    from backend.runner import _limits, _limits_txt
    p("Límites por proceso del servidor:", _limits_txt(_limits()))
    p("")
except Exception as e:
    p("No se pudieron leer los límites:", e)
try:
    import passenger_wsgi  # noqa: F401
    p("La aplicación arranca: OK")
    from backend.app import health
    p("health():", health())
except Exception:
    p("La aplicación NO arranca. Error:")
    p(traceback.format_exc())
for log in [os.path.expanduser("~/logs/simulador.log"), os.path.join(ROOT, "passenger.log"), os.path.join(ROOT, "stderr.log")]:
    if os.path.exists(log):
        p("")
        p(f"Últimas líneas de {log}:")
        with open(log, encoding="utf-8", errors="replace") as f:
            p("".join(f.readlines()[-30:]))
text = "\n".join(out)
print(text)
with open(os.path.join(ROOT, "diagnostico.txt"), "w", encoding="utf-8") as f:
    f.write(text)
