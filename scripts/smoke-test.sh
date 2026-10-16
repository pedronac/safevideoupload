#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> docker compose build"
docker compose build

echo "==> docker compose up -d"
docker compose up -d

echo "==> Attente API MediaMTX (via réseau Docker — image scratch sans wget)"
for i in $(seq 1 30); do
  if docker compose run --rm --no-deps blur python -c \
    "import urllib.request; urllib.request.urlopen('http://mediamtx:9997/v3/paths/list', timeout=3)" \
    >/dev/null 2>&1; then
    echo "MediaMTX API OK"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERREUR : API MediaMTX inaccessible après 60 s"
    docker compose logs mediamtx --tail 40
    exit 1
  fi
  sleep 2
done

docker compose run --rm --no-deps blur python -c \
  "import urllib.request; print(urllib.request.urlopen('http://mediamtx:9997/v3/paths/list', timeout=5).read()[:200].decode())"
echo ""

echo "==> Page viewer HTTP"
curl -sf -o /dev/null -w "viewer HTTP %{http_code}\n" "http://127.0.0.1/viewer/"

echo "==> HLS brut bloqué au edge"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1/hls/live/index.m3u8" || true)
echo "GET /hls/live/ → HTTP ${code}"
if [ "$code" != "404" ]; then
  echo "ATTENTION : /hls/live devrait renvoyer 404"
  exit 1
fi

echo "==> Tests unitaires blur (dans l'image)"
docker compose run --rm --no-deps blur pytest -q

echo "==> Smoke OK"
