#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
printf '\nBackend: http://127.0.0.1:8000\nFrontend: ejecutar en otra terminal: cd frontend && python3 -m http.server 8080\n\n'
uvicorn backend.app:app --port 8000
