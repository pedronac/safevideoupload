#!/usr/bin/env bash
# Diagnostic rapide de la pile hors-ligne : conteneurs, disque, file de floutage, journaux.
#
#   ./scripts/diagnose.sh                 # à lancer dans le dossier du projet sur le VPS
#   BASE_URL=http://localhost:18090 NO_DOCKER=1 ./scripts/diagnose.sh   # sans docker (tests)
#
# ADMIN_TOKEN est lu dans l'environnement ou .env (jamais affiché).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASE_URL="${BASE_URL:-http://localhost}"
NO_DOCKER="${NO_DOCKER:-0}"
CURL=(curl -s --max-time 15)
if [ "$BASE_URL" = "http://localhost" ]; then CURL+=(--resolve localhost:80:127.0.0.1); fi

read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true; }
ADMIN_TOKEN="${ADMIN_TOKEN:-$(read_env ADMIN_TOKEN)}"
warn=0

echo "==> Conteneurs"
if [ "$NO_DOCKER" != "1" ]; then
  docker compose ps || warn=1
  for svc in api blur admin caddy; do
    state="$(docker compose ps --format '{{.State}}' "$svc" 2>/dev/null | head -n1)"
    if [ "$state" != "running" ]; then
      echo "  ATTENTION : $svc n'est pas « running » (état : ${state:-absent})"
      warn=1
    fi
  done
else
  echo "  (ignoré : NO_DOCKER=1)"
fi

echo "==> Disque"
df -h "$ROOT/storage" 2>/dev/null || df -h "$ROOT"
echo "  Taille du stockage :"
du -sh storage/raw storage/blurred storage/work storage/state 2>/dev/null | sed 's/^/    /'

echo "==> Statut applicatif (admin)"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "  ADMIN_TOKEN introuvable : statut applicatif ignoré"
else
  status="$("${CURL[@]}" -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/admin/api/status" || true)"
  if [ -z "$status" ]; then
    echo "  ATTENTION : /admin/api/status ne répond pas (Caddy ou admin arrêtés ?)"
    warn=1
  else
    echo "$status" | python3 -c '
import json, sys
d = json.load(sys.stdin)
disk = d.get("disk", {})
print("  Disque libre : %.1f %% (%.1f Go)" % (disk.get("free_percent", 0), disk.get("free", 0) / 1e9))
if disk.get("low"):
    print("  ATTENTION : espace disque faible")
q = d.get("queue", {})
print("  Sessions :", q.get("sessions"))
print("  Segments :", q.get("segments"))
p = d.get("processor", {})
print("  Floutage : actif=%s, retard=%s segments, vitesse moyenne x%.2f temps réel" % (p.get("alive"), p.get("backlog"), p.get("avg_ratio") or 0))
if not p.get("alive"):
    print("  ATTENTION : le processeur de floutage ne donne plus de signe de vie")
' || warn=1
  fi
fi

if [ "$NO_DOCKER" != "1" ]; then
  echo "==> Derniers journaux (30 lignes chacun)"
  for svc in api blur admin caddy; do
    echo "--- $svc"
    docker compose logs --tail 30 "$svc" 2>&1 | sed 's/^/    /'
  done
  echo "==> Erreurs récentes (blur, api)"
  docker compose logs --since 1h blur api 2>&1 | grep -Ei "error|traceback|échec|failed" | tail -n 20 | sed 's/^/    /' || true
fi

if [ "$warn" -ne 0 ]; then
  echo "==> Diagnostic : points d'attention ci-dessus"
  exit 1
fi
echo "==> Diagnostic OK"
