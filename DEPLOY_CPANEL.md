# Instalación en cPanel (simulador.suriyaco.ar)

La aplicación es un backend Python (FastAPI) que también sirve el frontend. En cPanel corre con **Setup Python App**
(Phusion Passenger o LiteSpeed). El archivo de entrada es `passenger_wsgi.py`.

## Antes de empezar

- El cPanel tiene que tener **Setup Python App**, con **Python 3.11 o 3.12**. Con 3.10 o anterior no instala
  (scipy y numpy lo exigen).
- Conviene tener **Terminal** o SSH en el cPanel para instalar las dependencias.
- **Memoria**: una inundación de 200–450 mil celdas usa 1–2 GB. Con un plan compartido de 1 GB, usá zonas chicas o
  un dx mayor.
- **Salida a Internet** desde el servidor (HTTPS) hacia OpenTopography, AWS (Terrain Tiles y ESA WorldCover),
  OpenStreetMap (Overpass) y Source Cooperative (edificios). Algunos hostings la bloquean: si no hay salida, solo
  funcionan el DEM sintético y los DEM propios.
- **Motor MPM 3D**: se instala Taichi 1.7.1 (la 1.7.2 no tiene versión para servidores con glibc 2.17). Corre en
  CPU: en un plan compartido, usá zonas chicas y dx grandes, o el hosting puede cortar la simulación por CPU o memoria.

## 1. Armar el paquete

En la computadora donde está el proyecto:

```bash
./scripts/build_cpanel.sh
```

Genera `dist/simulador-cpanel.zip` sin el entorno virtual, la caché ni las claves.

## 2. Crear el subdominio

cPanel → **Dominios** → **Crear un nuevo dominio** → `simulador.suriyaco.ar`. La raíz de documentos que propone no se
usa: la aplicación vive en su propia carpeta.

## 3. Subir los archivos

cPanel → **Administrador de archivos** → crear la carpeta `/home/USUARIO/simulador`. Subí ahí `simulador-cpanel.zip` y
extraelo. Tienen que quedar `passenger_wsgi.py`, `backend/`, `frontend/` y el resto directamente dentro de `simulador/`.

## 4. Crear la aplicación Python

cPanel → **Setup Python App** → **Create Application**:

| Campo | Valor |
|---|---|
| Python version | 3.12 (o 3.11) |
| Application root | `simulador` |
| Application URL | `simulador.suriyaco.ar` |
| Application startup file | `passenger_wsgi.py` |
| Application Entry point | `application` |

En **Environment variables** podés agregar `OPENTOPOGRAPHY_API_KEY` con tu clave, para COP30, ANADEM y el resto de
OpenTopography. Sin ella funcionan AWS_TERRAIN y los DEM propios. También se puede subir a mano un archivo
`backend/.env` con la línea `OPENTOPOGRAPHY_API_KEY=...`.

Tocá **Create**.

## 5. Instalar las dependencias

La página de la aplicación muestra el comando para entrar a su entorno virtual. En **Terminal**:

```bash
source /home/USUARIO/virtualenv/simulador/3.12/bin/activate
cd ~/simulador
pip install --upgrade pip
pip install -r requirements-cpanel.txt
```

También se puede hacer desde **Setup Python App** → la aplicación → *Configuration files* → agregar
`requirements-cpanel.txt` → **Run Pip Install**. Tarda varios minutos: rasterio, pyproj y pyarrow son paquetes
grandes.

## 6. Reiniciar y probar

En **Setup Python App** → **Restart**. Después:

- `https://simulador.suriyaco.ar/api/health` tiene que responder `{"ok":true,...}`.
- `https://simulador.suriyaco.ar/` abre la aplicación.

Para HTTPS: cPanel → **SSL/TLS Status** → **Run AutoSSL**, si el certificado del subdominio no se generó solo.

## Dos modos: Passenger o CGI

El `.htaccess` del paquete elige el modo solo:

- **Con Passenger** (`mod_passenger` cargado en el servidor): la aplicación (`passenger_wsgi.py`) atiende todo.
- **Sin Passenger**: Apache entrega el frontend como archivos estáticos y la API corre como CGI (`api.cgi`). Cada
  consulta a la API tarda ~1 s más, porque arranca Python en cada pedido. Las simulaciones corren igual.

Si en el log de errores (cPanel → Errores) aparece `Invalid command 'PassengerAppRoot'`, el servidor no tiene
Passenger y se usa el modo CGI. Cuando el hosting lo active, pasa a Passenger sin cambiar nada.

Para el modo CGI hacen falta tres cosas:

1. Que `api.cgi` tenga permisos **755** (Administrador de archivos → Permisos).
2. Que su primera línea sea el Python del entorno virtual de la aplicación. Viene configurada para esta cuenta:
   `#!/home/suriyaco/virtualenv/public_html/simulador.suriyaco.ar/3.11/bin/python`.
3. Que la clave de OpenTopography esté en **`backend/.env`** (una línea `OPENTOPOGRAPHY_API_KEY=...`): en modo CGI
   las variables de entorno de Setup Python App no llegan a la aplicación. El `.htaccess` impide descargar ese archivo.
4. Que la aplicación de Setup Python App **siga existiendo**: el entorno virtual con las dependencias es el suyo. No
   hace falta tocar RESTART en este modo.

El `.htaccess` del paquete reemplaza al que genera cPanel. Incluye el mismo bloque de Passenger dentro de
`<IfModule mod_passenger.c>` y la protección de los archivos internos (código, caché, claves y logs dan 404).

## Actualizar a una versión nueva

1. Generá un zip nuevo con `./scripts/build_cpanel.sh`.
2. Subilo a `~/simulador` y extraelo encima, sobrescribiendo. No borres `cache/`: ahí están la biblioteca de análisis y
   los DEM propios.
3. Si cambió `requirements-cpanel.txt`, repetí el `pip install`.
4. **Restart** en Setup Python App, o `touch ~/simulador/tmp/restart.txt`.

## Cómo corren las simulaciones en cPanel

Passenger puede abrir varios procesos de la aplicación y cerrarlos cuando no reciben visitas. Por eso, en cPanel
(`SIMULADOR_JOBS=detached`, lo fija `passenger_wsgi.py`) cada simulación corre como un proceso propio. Escribe su
estado en `cache/library/<id>/status.json` y corren de a una, en orden de llegada. Si el hosting corta el proceso
por memoria o por tiempo de CPU, la aplicación lo detecta y lo informa como error.

## Problemas frecuentes

| Síntoma | Qué revisar |
|---|---|
| Error 500 / «Incomplete response» al abrir | `~/simulador/stderr.log` (log de Passenger). Casi siempre falta instalar dependencias o la versión de Python es menor a 3.11. |
| La simulación termina con «el proceso terminó inesperadamente» | Límite de memoria o CPU del plan. Achicá la zona, subí el dx o pedí más recursos al hosting. Detalle en `cache/library/<id>/runner.log`. |
| No descarga DEM, caminos ni WorldCover | El hosting no permite conexiones salientes: consultá con el proveedor. |
| Falla la carga de un LAZ o GeoTIFF grande | Límite de tamaño de subida del servidor web. Recortá el archivo, o convertilo a GeoTIFF (más liviano) antes de subirlo. |
| Caracteres raros o `UnicodeEncodeError` | Ya está resuelto en el código (todo se guarda en UTF-8). Si aparece, verificá que subiste la versión actual. |

## Uso local (sin cPanel)

Sigue igual: `uvicorn backend.app:app --port 8000` y `requirements.txt`, que incluye Taichi para MPM 3D. En ese modo
las simulaciones corren dentro del servidor, como antes.
