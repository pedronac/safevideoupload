#!/usr/bin/env bash
# Diagnostic du direct (à lancer sur le VPS, dans le dossier du dépôt) :
#   ./scripts/diagnose-live.sh
# Le jeton CAPTURE_TOKEN est lu dans .env pour les tests HTTP mais jamais affiché.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

section() { printf '\n==================== %s ====================\n' "$1"; }

env_value() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

# Appel HTTP interne (réseau Docker) : l'image mediamtx n'a pas de shell, on passe par
# Caddy (busybox wget) ; les droits « api » du réseau Docker sont dans mediamtx.yml.
internal_get() {
  docker compose exec -T caddy wget -qO- "$1" 2>/dev/null \
    || docker compose exec -T blur python -c "import sys,urllib.request;print(urllib.request.urlopen(sys.argv[1],timeout=5).read().decode())" "$1" 2>/dev/null
}

pretty() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

DOMAIN="$(env_value DOMAIN)"
TOKEN="$(env_value CAPTURE_TOKEN)"

section "1. Conteneurs"
docker compose ps

section "2. MediaMTX : logs WebRTC / publication / enregistrement (80 dernières lignes utiles)"
docker compose logs mediamtx --tail 400 2>&1 | grep -iE "webrtc|publishing|record|error|warn|ICE|candidate" | tail -80
echo
echo "Lecture : on veut voir « is publishing to path 'live' ». Si seul « created by ... » apparaît"
echo "puis « closed: deadline exceeded », le WebRTC (ICE/UDP-TCP 8189) n'aboutit pas."

section "3. API MediaMTX : chemins (live doit être ready=true pendant un direct)"
internal_get http://mediamtx:9997/v3/paths/list | pretty \
  || echo "ECHEC : API inaccessible (vérifier authInternalUsers dans mediamtx/mediamtx.yml, puis docker compose up -d --force-recreate mediamtx)"

section "4. API MediaMTX : sessions WebRTC (peerConnectionEstablished doit passer à true)"
internal_get http://mediamtx:9997/v3/webrtcsessions/list | pretty || echo "ECHEC : API inaccessible"

section "5. HLS flouté (depuis le réseau Docker) : 404 = rien publié sur 'blurred'"
docker compose exec -T caddy wget -S --spider -q http://mediamtx:8888/blurred/index.m3u8 2>&1 | head -5 \
  || echo "(erreur HTTP ci-dessus : 404 normal sans direct flouté)"

section "6. Worker de floutage : 60 dernières lignes"
docker compose logs blur --tail 60 2>&1 | grep -v "it/s"
echo
echo "Lecture : « Segment flouté ... x<ratio> temps réel » doit rester < 1.0 ; « Push RTMP démarré -> mediamtx »"
echo "confirme la publication sur 'blurred'. Le premier segment flouté arrive ~BLUR_CHUNK_SECONDS + temps de calcul après le début du direct."

section "7. Enregistrements sur disque"
if [ -d storage/raw/live ]; then
  echo "storage/raw/live existe :"
  ls -lh storage/raw/live | tail -5
else
  echo "storage/raw/live ABSENT : MediaMTX n'a jamais reçu de flux sur 'live'."
fi
[ -d storage/blurred/blurred ] && ls -lh storage/blurred/blurred | tail -3
[ -d storage/blurred/chunks ] && ls -lh storage/blurred/chunks | tail -3
df -h . | tail -1

section "8. Ports ouverts sur l'hôte (8189 doit écouter en UDP et en TCP)"
(ss -lunp 2>/dev/null; ss -ltnp 2>/dev/null) | grep -E ':(8189|80|443)\b' || echo "(ss indisponible ou aucun port trouvé)"
if command -v ufw >/dev/null 2>&1; then
  echo; ufw status 2>/dev/null | head -15
fi
echo
echo "Rappel : ouvrir 80/tcp, 443/tcp, 8189/udp ET 8189/tcp aussi dans le pare-feu du FOURNISSEUR (panneau Ikoula), pas seulement ufw."

section "9. Accès HTTP public"
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ]; then
  base="https://$DOMAIN"
  echo "viewer          : $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/viewer/")"
  echo "capture-auth    : sans mot de passe $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$base/capture-auth") (attendu 401)"
  if [ -n "$TOKEN" ]; then
    echo "capture-auth    : avec mot de passe $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H "Authorization: Bearer $TOKEN" "$base/capture-auth") (attendu 204)"
  fi
  echo "hls/blurred     : $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/hls/blurred/index.m3u8") (404 sans direct flouté, 200 sinon)"
  echo "hls/live (brut) : $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/hls/live/index.m3u8") (attendu 404)"
  echo "DNS $DOMAIN      : $(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)  (doit être l'IP publique du VPS, sans proxy CDN)"
else
  echo "DOMAIN absent ou localhost dans .env : tests HTTP publics ignorés."
fi

section "10. Pour voir si les paquets du téléphone arrivent (pendant une tentative de direct)"
cat <<'EOF'
  sudo tcpdump -ni any 'udp port 8189 or tcp port 8189' -c 40

  - Aucun paquet : le pare-feu (VPS ou fournisseur) ou l'opérateur bloque 8189.
  - Paquets entrants mais pas de réponse : problème de routage Docker / webrtcAdditionalHosts.
  - Paquets dans les deux sens mais « closed: deadline exceeded » : vérifier DTLS / codecs dans les logs mediamtx.
  Sur le téléphone, la page /capture/ affiche l'état ICE, le chemin réseau et les candidats du serveur.
EOF
