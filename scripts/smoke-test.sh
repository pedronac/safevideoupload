#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> docker compose build"
docker compose build

echo "==> docker compose up -d"
docker compose up -d

echo "==> Attente santé MediaMTX"
for i in $(seq 1 30); do
  if docker compose exec -T mediamtx wget -q -O - "http://127.0.0.1:9997/v3/paths/list" >/dev/null 2>&1; then
    echo "MediaMTX API OK"
    break
  fi
  sleep 2
done

docker compose exec -T mediamtx wget -q -O - "http://127.0.0.1:9997/v3/paths/list" | head -c 200
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
