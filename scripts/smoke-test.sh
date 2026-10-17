#!/usr/bin/env bash
# Smoke test de la pile safevideoupload (version hors-ligne, sans direct).
#
#   ./scripts/smoke-test.sh                          # build + up + tests sur http://localhost
#   SKIP_DOCKER=1 BASE_URL=https://stream.exemple.fr ./scripts/smoke-test.sh   # tests HTTP seuls
#   SMOKE_UPLOAD=1 ...                               # envoie aussi un clip de test de 4 s (voir plus bas)
#
# CAPTURE_TOKEN et ADMIN_TOKEN sont lus dans l'environnement, sinon dans .env (jamais affichés).
# Avec SMOKE_UPLOAD=1, un clip synthétique (mire + bip) est envoyé comme vraie session : il sera flouté
# et apparaîtra sur la page publique (il se reconnaît à l'appareil « smoke-test »). Les ffmpeg/ffprobe du
# conteneur blur servent à le fabriquer et à le vérifier (rien à installer sur l'hôte).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE_URL="${BASE_URL:-http://localhost}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"
SMOKE_UPLOAD="${SMOKE_UPLOAD:-0}"
CURL=(curl -s --max-time 30)
if [ "$BASE_URL" = "http://localhost" ]; then
  # Le bloc HTTP de dev de Caddy ne répond qu'à Host: localhost.
  CURL+=(--resolve localhost:80:127.0.0.1)
fi

read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true; }
if [ -z "${CAPTURE_TOKEN:-}" ] && [ -f .env ]; then CAPTURE_TOKEN="$(read_env CAPTURE_TOKEN)"; fi
if [ -z "${ADMIN_TOKEN:-}" ] && [ -f .env ]; then ADMIN_TOKEN="$(read_env ADMIN_TOKEN)"; fi
if [ -z "${PUBLIC_PAGE_ENABLED:-}" ] && [ -f .env ]; then PUBLIC_PAGE_ENABLED="$(read_env PUBLIC_PAGE_ENABLED)"; fi
PUBLIC_PAGE_ENABLED="${PUBLIC_PAGE_ENABLED:-true}"
for v in CAPTURE_TOKEN ADMIN_TOKEN; do
  if [ -z "${!v:-}" ]; then
    echo "ERREUR : $v introuvable (variable d'environnement ou .env)"
    exit 1
  fi
done

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
    if [ "$(code "$BASE_URL/capture/")" = "200" ]; then break; fi
    if [ "$i" -eq 30 ]; then
      echo "ERREUR : Caddy ne répond pas après 60 s"
      docker compose logs caddy --tail 40
      exit 1
    fi
    sleep 2
  done
fi

echo "==> Page de capture"
check "page /capture/" 200 "$(code "$BASE_URL/capture/")"
check "service worker" 200 "$(code "$BASE_URL/capture/sw.js")"
html="$("${CURL[@]}" "$BASE_URL/capture/" || true)"
if echo "$html" | grep -q "$CAPTURE_TOKEN"; then
  echo "  ECHEC le jeton de capture apparaît dans la page"
  fail=1
else
  echo "  OK   le jeton n'apparaît pas dans la page"
fi

echo "==> Mot de passe de capture"
check "sans mot de passe" 401 "$(code -X POST "$BASE_URL/capture-auth")"
check "mauvais mot de passe" 401 "$(code -X POST -H "Authorization: Bearer mauvais-$$" "$BASE_URL/capture-auth")"
check "bon mot de passe" 204 "$(code -X POST -H "Authorization: Bearer $CAPTURE_TOKEN" "$BASE_URL/capture-auth")"
check "jeton dans l'URL refusé" 401 "$(code -X POST "$BASE_URL/capture-auth?token=$CAPTURE_TOKEN")"

echo "==> API d'envoi (/api/upload/*)"
check "création de session sans jeton" 401 "$(code -X POST -H 'Content-Type: application/json' --data '{}' "$BASE_URL/api/upload/session")"
check "envoi de partie sans jeton" 401 "$(code -X PUT --data x "$BASE_URL/api/upload/$(printf '%032d' 0)/part/0")"
check "jeton dans l'URL refusé" 401 "$(code -X POST -H 'Content-Type: application/json' --data '{}' "$BASE_URL/api/upload/session?token=$CAPTURE_TOKEN")"

echo "==> Page publique (PUBLIC_PAGE_ENABLED=$PUBLIC_PAGE_ENABLED)"
if [ "$PUBLIC_PAGE_ENABLED" = "true" ]; then
  check "accueil" 200 "$(code "$BASE_URL/")"
  check "/videos/" 200 "$(code "$BASE_URL/videos/")"
  check "liste publique" 200 "$(code "$BASE_URL/api/public/videos")"
  if "${CURL[@]}" -D - -o /dev/null "$BASE_URL/videos/" | grep -qi '^x-robots-tag:.*noindex'; then
    echo "  OK   noindex"
  else
    echo "  ECHEC en-tête X-Robots-Tag noindex absent"
    fail=1
  fi
else
  check "accueil désactivé" 404 "$(code "$BASE_URL/")"
  check "liste publique désactivée" 404 "$(code "$BASE_URL/api/public/videos")"
fi
check "brut jamais public (/media/ ne sert que le flouté)" 404 "$(code "$BASE_URL/media/raw/x/stream.webm")"
check "traversée de chemin refusée" 404 "$(code --path-as-is "$BASE_URL/media/../raw/x/stream.webm")"
check "téléchargement brut sans jeton admin" 401 "$(code "$BASE_URL/storage-download/raw/x/stream.webm")"

echo "==> Administration"
check "admin sans jeton" 401 "$(code -X POST "$BASE_URL/admin-auth")"
check "admin mauvais jeton" 401 "$(code -X POST -H "Authorization: Bearer mauvais-$$" "$BASE_URL/admin-auth")"
check "admin bon jeton" 204 "$(code -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin-auth")"
check "page admin" 200 "$(code "$BASE_URL/admin/")"
check "API admin sans jeton" 401 "$(code "$BASE_URL/admin/api/status")"
check "API admin /api/status" 200 "$(code -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin/api/status")"
check "API admin /api/sessions" 200 "$(code -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin/api/sessions")"
status="$("${CURL[@]}" -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin/api/status" || true)"
free_pct="$(echo "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["disk"]["free_percent"])' 2>/dev/null || echo "?")"
echo "  Espace disque libre : ${free_pct} %"

if [ "$SMOKE_UPLOAD" = "1" ]; then
  echo "==> Envoi d'un clip de test (session réelle, 4 s)"
  if ! docker compose ps blur >/dev/null 2>&1; then
    echo "  ECHEC SMOKE_UPLOAD=1 demande docker compose sur cette machine (conteneur blur)"
    fail=1
  else
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    docker compose exec -T blur ffmpeg -loglevel error -f lavfi -i "testsrc2=size=1080x1920:rate=30" \
      -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 4 -c:v libvpx -b:v 3M -c:a libopus -f webm - >"$tmp/clip.webm"
    sid="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    sha="$(sha256sum "$tmp/clip.webm" | cut -d' ' -f1)"
    size="$(stat -c %s "$tmp/clip.webm")"
    auth=(-H "Authorization: Bearer $CAPTURE_TOKEN")
    now_ms="$(($(date +%s) * 1000))"
    check "création de session" 200 "$(code -X POST "${auth[@]}" -H 'Content-Type: application/json' \
      --data "{\"session\":\"$sid\",\"started_at_ms\":$now_ms,\"mime\":\"video/webm\",\"width\":1080,\"height\":1920,\"device\":\"smoke-test\"}" \
      "$BASE_URL/api/upload/session")"
    check "envoi de la partie 0" 200 "$(code -X PUT "${auth[@]}" -H "X-Part-Sha256: $sha" -H "X-Part-Size: $size" \
      -H 'Content-Type: application/octet-stream' --data-binary "@$tmp/clip.webm" "$BASE_URL/api/upload/$sid/part/0")"
    check "renvoi de la même partie (idempotent)" 200 "$(code -X PUT "${auth[@]}" -H "X-Part-Sha256: $sha" -H "X-Part-Size: $size" \
      -H 'Content-Type: application/octet-stream' --data-binary "@$tmp/clip.webm" "$BASE_URL/api/upload/$sid/part/0")"
    check "somme de contrôle fausse refusée" 422 "$(code -X PUT "${auth[@]}" -H "X-Part-Sha256: $(printf '0%.0s' $(seq 64))" \
      -H 'Content-Type: application/octet-stream' --data-binary "@$tmp/clip.webm" "$BASE_URL/api/upload/$sid/part/1")"
    check "fermeture de session" 200 "$(code -X POST "${auth[@]}" -H 'Content-Type: application/json' --data '{"total_parts":1}' "$BASE_URL/api/upload/$sid/close")"
    echo "  Attente du floutage (jusqu'à 3 min)…"
    blurred=0
    for i in $(seq 1 90); do
      s="$("${CURL[@]}" -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin/api/sessions" | python3 -c "
import json,sys
sid='$sid'
d=json.load(sys.stdin)
items=d.get('sessions',d) if isinstance(d,dict) else d
s=next((x for x in items if x['id']==sid),None)
print('1' if s and s.get('segments') and all(g['status']=='blurred' for g in s['segments']) else '0')" 2>/dev/null || echo 0)"
      if [ "$s" = "1" ]; then blurred=1; break; fi
      sleep 2
    done
    if [ "$blurred" = "1" ]; then
      echo "  OK   clip flouté (session $sid)"
    else
      echo "  ECHEC le clip n'a pas été flouté en 3 min (docker compose logs blur)"
      fail=1
    fi
  fi
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
