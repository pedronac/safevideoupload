#!/usr/bin/env bash
# Smoke test de la pile safevideoupload.
#
#   ./scripts/smoke-test.sh                       # build + up + tests sur http://localhost
#   SKIP_DOCKER=1 BASE_URL=https://stream.exemple.fr ./scripts/smoke-test.sh   # tests HTTP seuls
#
# CAPTURE_TOKEN est lu dans l'environnement, sinon dans .env (jamais affiché).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE_URL="${BASE_URL:-http://localhost}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"
CURL=(curl -s --max-time 15)
if [ "$BASE_URL" = "http://localhost" ]; then
  # Le bloc HTTP de dev de Caddy ne répond qu'à Host: localhost.
  CURL+=(--resolve localhost:80:127.0.0.1)
fi

if [ -z "${CAPTURE_TOKEN:-}" ] && [ -f .env ]; then
  CAPTURE_TOKEN="$(grep -E '^CAPTURE_TOKEN=' .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
fi
if [ -z "${CAPTURE_TOKEN:-}" ]; then
  echo "ERREUR : CAPTURE_TOKEN introuvable (variable d'environnement ou .env)"
  exit 1
fi
if [ -z "${ADMIN_TOKEN:-}" ] && [ -f .env ]; then
  ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
fi
if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ERREUR : ADMIN_TOKEN introuvable (variable d'environnement ou .env)"
  exit 1
fi

fail=0
check() { # check "description" attendu obtenu
  if [ "$2" = "$3" ]; then
    echo "  OK   $1 (HTTP $3)"
  else
    echo "  ECHEC $1 : attendu HTTP $2, obtenu $3"
    fail=1
  fi
}
code() { "${CURL[@]}" -o /dev/null -w "%{http_code}" "$@" || true; }

if [ "$SKIP_DOCKER" != "1" ]; then
  echo "==> docker compose build + up"
  docker compose build
  docker compose up -d

  echo "==> Attente de Caddy"
  for i in $(seq 1 30); do
    if [ "$(code "$BASE_URL/viewer/")" = "200" ]; then break; fi
    if [ "$i" -eq 30 ]; then
      echo "ERREUR : Caddy ne répond pas après 60 s"
      docker compose logs caddy --tail 40
      exit 1
    fi
    sleep 2
  done

  echo "==> API MediaMTX (depuis le conteneur caddy : le réseau Docker est autorisé)"
  api_ok=0
  for i in $(seq 1 20); do
    if docker compose exec -T caddy wget -qO- http://mediamtx:9997/v3/paths/list >/tmp/mtx-paths.json 2>/dev/null; then
      api_ok=1
      break
    fi
    sleep 2
  done
  if [ "$api_ok" = "1" ]; then
    echo "  OK   API MediaMTX /v3/paths/list"
    head -c 300 /tmp/mtx-paths.json
    echo
  else
    echo "  ECHEC API MediaMTX inaccessible (voir authInternalUsers dans mediamtx/mediamtx.yml)"
    docker compose logs mediamtx --tail 40
    fail=1
  fi
fi

echo "==> Viewer"
html="$("${CURL[@]}" "$BASE_URL/viewer/" || true)"
check "viewer renvoie une page" 200 "$(code "$BASE_URL/viewer/")"
if echo "$html" | grep -qi "<html"; then
  echo "  OK   viewer renvoie du HTML"
else
  echo "  ECHEC viewer ne renvoie pas du HTML"
  fail=1
fi
if echo "$html" | grep -qiE "href=[\"'][^\"']*capture"; then
  echo "  ECHEC le viewer contient un lien vers la page capture"
  fail=1
else
  echo "  OK   aucun lien vers la page capture dans le viewer"
fi

echo "==> Accès capture (/capture-auth)"
check "sans mot de passe" 401 "$(code -X POST "$BASE_URL/capture-auth")"
check "mauvais mot de passe" 401 "$(code -X POST -H "Authorization: Bearer mauvais-$$" "$BASE_URL/capture-auth")"
check "bon mot de passe" 204 "$(code -X POST -H "Authorization: Bearer $CAPTURE_TOKEN" "$BASE_URL/capture-auth")"
check "jeton dans l'URL refusé" 401 "$(code -X POST "$BASE_URL/capture-auth?token=$CAPTURE_TOKEN")"

echo "==> HLS / WHIP"
check "HLS brut /hls/live bloqué" 404 "$(code "$BASE_URL/hls/live/index.m3u8")"
check "WHIP sans Bearer" 401 "$(code -X POST -H "Content-Type: application/sdp" --data "v=0" "$BASE_URL/live/whip")"
check "WHIP avec ?token= refusé" 401 "$(code -X POST -H "Content-Type: application/sdp" --data "v=0" "$BASE_URL/live/whip?token=$CAPTURE_TOKEN")"
bearer_code="$(code -X POST -H "Content-Type: application/sdp" -H "Authorization: Bearer $CAPTURE_TOKEN" --data "v=0" "$BASE_URL/live/whip")"
if [ "$bearer_code" = "401" ] || [ "$bearer_code" = "502" ] || [ "$bearer_code" = "000" ]; then
  echo "  ECHEC WHIP avec Bearer valide : HTTP $bearer_code (Caddy n'atteint pas MediaMTX ?)"
  fail=1
else
  echo "  OK   WHIP avec Bearer atteint MediaMTX (HTTP $bearer_code : SDP volontairement invalide)"
fi
hls_code="$(code "$BASE_URL/hls/blurred/index.m3u8")"
if [ "$hls_code" = "200" ] || [ "$hls_code" = "404" ]; then
  echo "  OK   /hls/blurred répond HTTP $hls_code (404 = aucun direct en cours)"
else
  echo "  ECHEC /hls/blurred : HTTP $hls_code"
  fail=1
fi

echo "==> Administration (/admin-auth)"
check "admin sans jeton" 401 "$(code -X POST "$BASE_URL/admin-auth")"
check "admin mauvais jeton" 401 "$(code -X POST -H "Authorization: Bearer mauvais-$$" "$BASE_URL/admin-auth")"
check "admin bon jeton" 204 "$(code -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin-auth")"
check "page admin" 200 "$(code "$BASE_URL/admin/")"
admin_api_code="$(code -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin/api/recordings")"
if [ "$admin_api_code" = "200" ]; then
  echo "  OK   GET /admin/api/recordings (HTTP 200)"
else
  echo "  ECHEC GET /admin/api/recordings : HTTP $admin_api_code"
  fail=1
fi

if [ "$SKIP_DOCKER" != "1" ]; then
  echo "==> Tests unitaires blur (dans l'image)"
  docker compose run --rm --no-deps blur pytest -q
fi

if [ "$fail" -ne 0 ]; then
  echo "==> Smoke : ECHEC"
  exit 1
fi
echo "==> Smoke OK"
