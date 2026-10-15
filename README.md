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

- **Viewer HLS** : [http://127.0.0.1/viewer/](http://127.0.0.1/viewer/) (flux `blurred` une fois la capture + worker actifs)
- **Capture** : [http://127.0.0.1/capture/](http://127.0.0.1/capture/)  
  En local sans TLS : URL WHIP directe MediaMTX  
  `http://<ip-laptop>:8889/live/whip`

Sur **iPhone en production**, utiliser **HTTPS** (Caddy + domaine ou Tailscale Funnel) :

`https://stream.domaine.com/live/live/whip`

## Architecture

```
[iPhone Safari] getUserMedia + overlay canvas (GPS/heure)
  ├─ MediaRecorder → sauvegarde locale (~6 h, ~7–11 Go)
  └─ WebRTC WHIP 720p30 ~3 Mbps → Tailscale → laptop:8889/live

[Docker]
  MediaMTX — enregistre brut, HLS sur chemin blurred
  blur     — segments RTSP → deface → RTMP mediamtx + YouTube (optionnel)
  Caddy    — /viewer, /capture, proxy /hls et /live
```

## Variables d’environnement

Voir `.env.example` :

| Variable | Rôle |
|----------|------|
| `DOMAIN` | Nom pour Let's Encrypt (Caddy) |
| `YOUTUBE_RTMP_URL` | `rtmp://a.rtmp.youtube.com/live2/<clé>` ou vide |
| `BLUR_CHUNK_SECONDS` | Latence / charge CPU (défaut 30 s) |
| `BLUR_PROCESS_SCALE` | Résolution analyse deface (défaut `640x360`) |

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

1. Vérifier **HTTPS**, ports **UDP 8189** et **TCP 8889** (ou Funnel)
2. Forcer proximité réseau Tailscale ; renseigner `webrtcAdditionalHosts` dans `mediamtx/mediamtx.yml`
3. **Repli documenté** (hors MVP live) : envoi de segments en HTTP (non implémenté ici) — privilégier la correction WebRTC

## Stockage disque serveur

Prévoir ~**14 Go** pour 6 h (brut + flouté, 720p ~3 Mbps) ; surveiller `storage/`.
