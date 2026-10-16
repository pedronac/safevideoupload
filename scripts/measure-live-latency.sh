#!/usr/bin/env bash
# Estime la latence bout-en-bout du direct flouté (ingest → premier segment HLS utilisable).
# À lancer sur le VPS dans le dossier du dépôt pendant un live :
#   ./scripts/measure-live-latency.sh
#   ./scripts/measure-live-latency.sh --log-segments 15
set -euo pipefail

LOG_SEGMENTS=10
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

while [ $# -gt 0 ]; do
  case "$1" in
    --log-segments) LOG_SEGMENTS="$2"; shift 2 ;;
    *) echo "Option inconnue: $1"; exit 1 ;;
  esac
done

section() { printf '\n=== %s ===\n' "$1"; }

api_get() {
  docker compose exec -T blur python -c "
import json, sys, urllib.request
url = sys.argv[1]
with urllib.request.urlopen(url, timeout=8) as r:
    print(r.read().decode())
" "$1" 2>/dev/null
}

pretty() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

section "MediaMTX — chemins live / blurred"
api_get "http://mediamtx:9997/v3/paths/list" | pretty || echo "(API :9997 inaccessible depuis blur)"

section "Fichiers enregistrement brut (storage/raw/live)"
RAW_DIR="storage/raw/live"
if [ -d "$RAW_DIR" ]; then
  newest_raw="$(find "$RAW_DIR" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
  if [ -n "${newest_raw:-}" ]; then
    ls -lh "$newest_raw"
    echo "mtime brut (epoch) : $(stat -c %Y "$newest_raw" 2>/dev/null || stat -f %m "$newest_raw")"
  else
    echo "(aucun fichier)"
  fi
else
  echo "Dossier absent — pas encore de direct enregistré."
fi

section "Segments floutés archivés (storage/blurred/chunks)"
CHUNK_DIR="storage/blurred/chunks"
if [ -d "$CHUNK_DIR" ]; then
  ls -lt "$CHUNK_DIR" | head -8
  newest_blur="$(find "$CHUNK_DIR" -type f -name 'blurred_*.mp4' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1)"
  if [ -n "${newest_blur:-}" ]; then
    blur_epoch="$(echo "$newest_blur" | awk '{print $1}')"
    blur_path="$(echo "$newest_blur" | cut -d' ' -f2-)"
    echo "Dernier chunk : $blur_path"
    if [ -n "${newest_raw:-}" ]; then
      raw_epoch="$(stat -c %Y "$newest_raw" 2>/dev/null || stat -f %m "$newest_raw")"
      python3 - "$raw_epoch" "$blur_epoch" <<'PY'
import sys
raw, blur = float(sys.argv[1]), float(sys.argv[2])
delta = blur - raw
print(f"Écart mtime dernier brut → dernier chunk flouté : {delta:.1f} s")
print("(approx. latence pipeline + BLUR_CHUNK_SECONDS ; pas une mesure frame-accurate)")
PY
    fi
  fi
else
  echo "Dossier absent."
fi

section "HLS blurred (interne MediaMTX :8888)"
docker compose exec -T caddy wget -qO- http://mediamtx:8888/blurred/index.m3u8 2>/dev/null | head -5 \
  || echo "(playlist indisponible — pas de push RTMP ou direct arrêté)"

section "Derniers segments dans les logs blur"
docker compose logs blur --tail 300 2>&1 | grep -E "Segment flouté|x[0-9]+\.[0-9]+ temps réel|Retard" | tail -n "$LOG_SEGMENTS" || true

section "Estimation latence"
cat <<EOF
Composantes typiques (direct marathon portrait) :
  1. WHIP/WebRTC → MediaMTX live        : ~0,5–2 s (réseau + handshake)
  2. Attente fin 1er segment RTSP       : ~BLUR_CHUNK_SECONDS (défaut 6 s)
  3. normalize + deface + push            : voir « x temps réel » (doit rester < 1)
  4. HLS mux (segments 2 s)             : ~2–4 s jusqu'à index.m3u8 stable

Latence perçue viewer ≈ (2) + (3) + (4). Si x temps réel > 1, le retard grossit
même avec buffer : des segments sont abandonnés (logs « Retard de floutage »).

Pour affiner : noter l'heure d'apparition du premier segment dans le viewer et
soustraire l'heure de début d'envoi sur /capture/.
EOF
