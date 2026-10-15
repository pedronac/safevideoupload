# safevideoupload — streaming marathon (MVP)

Diffusion live depuis un **iPhone 7 (iOS 15, Safari)** vers un **serveur portable** (Docker sur laptop), avec :

- ingest **WebRTC / WHIP** (MediaMTX)
- enregistrement **brut** fMP4 (`/storage/raw/`)
- floutage visages **deface / CenterFace ONNX** (CPU) → segments floutés + republication RTMP
- visionnage public **HLS** (hls.js) derrière **Caddy** (TLS Let's Encrypt en prod)
- push **YouTube Live** optionnel (ffmpeg RTMP, clé dans `.env`)
- **sauvegarde locale** sur l’iPhone via `MediaRecorder` (segments ~1 min)

## Prérequis

- Docker + Docker Compose v2 sur le laptop (8 Go RAM conseillés)
- Tailscale (réseau privé iPhone ↔ laptop)
- Nom de domaine `stream.domaine.com` pointant vers le laptop ou Tailscale Funnel (voir doc déploiement dans le store projet)
- iPhone : Safari, autorisation caméra/micro/GPS

## Démarrage rapide (test local)

```bash
cp .env.example .env
mkdir -p storage/raw storage/blurred caddy/data caddy/config
docker compose up --build -d
```

- **Viewer HLS** : [http://127.0.0.1/viewer/](http://127.0.0.1/viewer/) (manifeste public **flouté** uniquement : `/hls/blurred/`)
- **Capture** : [http://127.0.0.1/capture/](http://127.0.0.1/capture/)  
  En local sans `CAPTURE_TOKEN`, WHIP via Caddy : `http://127.0.0.1/live/whip`

Sur **iPhone en production**, utiliser **HTTPS** (Caddy + domaine) avec un secret :

1. Dans `.env` : `CAPTURE_TOKEN=$(openssl rand -hex 32)` puis `docker compose up -d`
2. Ouvrir la page capture avec le token :  
   `https://stream.domaine.com/capture/?token=VOTRE_TOKEN`
3. L’URL WHIP par défaut devient `https://stream.domaine.com/live/whip?token=…` (en-tête `Authorization: Bearer` envoyé aussi par Safari).

Le flux **brut** (`/hls/live/`) n’est **pas** exposé publiquement (404 au edge).

## Architecture

```
[iPhone Safari] getUserMedia + overlay canvas (GPS/heure)
  ├─ MediaRecorder → sauvegarde locale (~6 h, ~7–11 Go)
  └─ WebRTC WHIP 720p30 ~3 Mbps → HTTPS → Caddy /live/whip (token)

[Docker]
  MediaMTX — enregistre brut (interne), HLS public seulement sur `blurred`
  blur     — segments RTSP → deface → RTMP mediamtx + YouTube (optionnel)
  Caddy    — /viewer, /capture, HLS flouté, WHIP authentifié
```

## Variables d’environnement

Voir `.env.example` :

| Variable | Rôle |
|----------|------|
| `DOMAIN` | Nom pour Let's Encrypt (Caddy) |
| `CAPTURE_TOKEN` | **Obligatoire en prod** — Bearer WHIP + `?token=` page capture |
| `ACME_EMAIL` | E-mail Let's Encrypt |
| `YOUTUBE_RTMP_URL` | `rtmp://a.rtmp.youtube.com/live2/<clé>` ou vide |
| `BLUR_CHUNK_SECONDS` | Latence / charge CPU (défaut 30 s) |
| `BLUR_PROCESS_SCALE` | Résolution analyse deface (défaut `640x360`) |

### Pare-feu VPS (recommandé)

Ouvrir uniquement **TCP 80**, **TCP 443** et **UDP 8189** (ICE WebRTC). Ne pas publier RTSP/RTMP/API MediaMTX sur l’hôte — le `docker-compose.yml` n’expose plus ces ports.

## Checklist test jour J

1. `docker compose ps` — les 3 services `healthy` / `running`
2. Ouvrir `/capture/` sur l’iPhone, WHIP HTTPS, **Démarrer diffusion**
3. Vérifier enregistrement brut : fichiers sous `storage/raw/live/`
4. Après ~30–60 s, viewer `/viewer/` affiche le flux flouté
5. **Coupure GSM** : arrêter/redémarrer la capture ; vérifier reconnexion WHIP
6. **Sauvegarde locale** : bouton téléchargement ou récupération des blobs en fin d’épreuve
7. YouTube : renseigner `YOUTUBE_RTMP_URL`, contrôler le live dashboard Google

## Reprise / concat post-événement

Les enregistrements MediaMTX sont des **fMP4 fragmentés** par segment d’1 h. Pour assembler :

```bash
# Exemple segments floutés (ajuster les chemins)
ffmpeg -f concat -safe 0 -i liste.txt -c copy sortie_marathon.mp4
```

(`liste.txt` : une ligne `file 'chemin' ` par segment.)

## Tests automatiques

```bash
chmod +x scripts/smoke-test.sh
./scripts/smoke-test.sh
```

Tests manuels recommandés : publication WHIP depuis Safari réel, latence HLS, charge CPU du service `blur`.

## Fallback si WHIP impossible

Si une version Safari ne publie pas en WHIP (codec / TLS / ICE) :

1. Vérifier **HTTPS**, **UDP 8189** (ICE) et `CAPTURE_TOKEN` sur l’URL capture
2. Forcer proximité réseau Tailscale ; renseigner `webrtcAdditionalHosts` dans `mediamtx/mediamtx.yml`
3. **Repli documenté** (hors MVP live) : envoi de segments en HTTP (non implémenté ici) — privilégier la correction WebRTC

## Stockage disque serveur

Prévoir ~**14 Go** pour 6 h (brut + flouté, 720p ~3 Mbps) ; surveiller `storage/`.
