#!/usr/bin/env bash
# Arma dist/simulador-cpanel.zip con lo necesario para subir la aplicación a cPanel
# (sin entorno virtual, caché, claves ni archivos compilados).
set -e
cd "$(dirname "$0")/.."
rm -rf dist/simulador && mkdir -p dist/simulador
cp -R backend frontend docs dist/simulador/
cp passenger_wsgi.py api.cgi diagnostico_cpanel.py requirements-cpanel.txt README.md DEPLOY_CPANEL.md dist/simulador/
cp deploy/htaccess dist/simulador/.htaccess
chmod 755 dist/simulador/api.cgi
find dist/simulador -name '__pycache__' -type d -prune -exec rm -rf {} +
find dist/simulador \( -name '*.pyc' -o -name '.DS_Store' -o -name '.env' \) -delete
mkdir -p dist/simulador/tmp
(cd dist/simulador && rm -f ../simulador-cpanel.zip && zip -qr ../simulador-cpanel.zip .)
rm -rf dist/simulador
echo "Listo: dist/simulador-cpanel.zip ($(du -h dist/simulador-cpanel.zip | cut -f1))"
