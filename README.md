# Offline Capture — marathon hors ligne

**Offline Capture** (dépôt `safevideoupload`, branche `cursor/offline-capture`) permet de filmer un marathon (ou une longue course) avec un **téléphone** — iPhone Safari ou Android Chrome — en portrait **1080×1920**, avec le micro. Le téléphone **enregistre en continu**, garde les morceaux en local si le réseau manque, puis les envoie au serveur dès qu'une connexion est disponible. Le serveur recolle le flux, **floute les visages** (deface / CenterFace), et publie une **galerie publique** de segments floutés triés par date et heure. Il n'y a **pas de direct** : ni MediaMTX, ni WebRTC, ni HLS.

```
téléphone ── MediaRecorder (1 flux continu) ── parties ~10 s ── IndexedDB (hors ligne)
                                      │ PUT /api/upload/… (Bearer HTTPS)
                                      ▼
              Caddy ──► api (Python) ── raw/<session>/stream.{mp4,webm} + gps.json
                                      │
              blur (processor.py) ── segments sur images clés ── deface ── MP4 floutés
                                      ▼
              Caddy : /  /videos/  /media/*  ◄── blurred/<session>/seg_*.mp4 (+ session.mp4)
```

## Architecture

| Composant | Rôle |
| --- | --- |
| **Caddy** | HTTPS (Let's Encrypt), reverse proxy, contrôle des jetons sur `/capture-auth`, `/api/upload/*`, `/admin/*` |
| **api** | Réception des parties, assemblage du brut, registre SQLite, santé disque |
| **blur** | Découpe en segments, floutage deface, assemblage optionnel `session.mp4` |
| **admin** | Interface et API d'administration (sessions, file de floutage, téléchargements) |
| **web** | Pages statiques : `/capture/`, `/admin/`, page publique `/` |

Volumes persistants : `./storage/` (brut, flouté, état). Certificats et config Caddy : `./caddy/data`, `./caddy/config` (voir `.gitignore`).

## Démarrage rapide

Prérequis : Docker Engine + plugin Compose, ports **80** et **443** ouverts, enregistrement DNS **A** vers le VPS (sans proxy CDN — les parties font ~10 Mo).

```bash
git clone https://github.com/pedronac/safevideoupload.git
cd safevideoupload
git checkout cursor/offline-capture   # jusqu'à fusion sur main
cp .env.example .env
# Éditer DOMAIN, ACME_EMAIL ; générer deux jetons :
openssl rand -hex 32   # CAPTURE_TOKEN
openssl rand -hex 32   # ADMIN_TOKEN
mkdir -p storage/raw storage/blurred caddy/data caddy/config
docker compose up -d --build
```

Script d'installation sur VPS Debian/Ubuntu vierge : `sudo bash scripts/bootstrap-ikoula-vps.sh` (variables `REPO_URL`, `BRANCH`, `INSTALL_DIR`).

Contrôles après déploiement :

```bash
./scripts/diagnose.sh
SKIP_DOCKER=1 BASE_URL=https://<DOMAIN> ./scripts/smoke-test.sh
```

## URLs

| Chemin | Accès | Description |
| --- | --- | --- |
| `/capture/` | `CAPTURE_TOKEN` | Enregistrement, buffer hors ligne, upload, alertes |
| `/` et `/videos/` | Public (si activé) | Vidéos **floutées** par horodatage |
| `/admin/` | `ADMIN_TOKEN` | Disque, sessions, floutage, téléchargements brut/flouté, changement du mot de passe capture |
| `/api/upload/*` | Bearer `CAPTURE_TOKEN` | API d'upload (derrière Caddy) |

Désactiver la page publique : `PUBLIC_PAGE_ENABLED=false` dans `.env`.

## Sécurité

- **`CAPTURE_TOKEN`** : mot de passe de `/capture/` et jeton Bearer des uploads. Ne jamais dans l'URL.
- **`ADMIN_TOKEN`** : accès admin et liens de téléchargement signés (durée limitée).
- Le floutage ne masque **pas** le **GPS et l'heure** gravés dans l'image : ils restent visibles sur la page publique si elle est activée.
- Détails et bonnes pratiques : [SECURITY.md](./SECURITY.md). **Ne commitez jamais `.env`.**

## Fonctionnalités capture (téléphone)

- Un seul `MediaRecorder` découpé en parties (`timeslice`) — pas de coupure à l'assemblage côté serveur.
- Incrustation **latitude, longitude, précision, date/heure** (Europe/Paris) + trace `gps.json` (~1 point/s).
- Hors ligne : IndexedDB, reprise d'envoi avec backoff ; SHA-256 par partie (idempotent).
- Wake Lock / NoSleep, alertes (page masquée, capteurs coupés, disque plein), reprise limitée si l'enregistreur s'arrête.
- WebM (Chromium) ou MP4 (Safari) ; repli 720p si 1080p échoue.

## Variables d'environnement

Voir [`.env.example`](./.env.example) pour la liste complète (`SEGMENT_SECONDS`, `BLUR_PROCESS_SCALE`, `BLUR_PROCESSOR_WORKERS`, etc.).

Variables **obsolètes** (ancienne stack direct) : `MEDIAMTX_*`, `YOUTUBE_RTMP_URL`, `BLUR_CHUNK_SECONDS`, `BLUR_PUSH_IDLE_CLOSE_S` — ignorées sur cette branche.

## Stockage

Ordre de grandeur : ~**3,6 Go/h** brut à 8 Mbit/s, ~**2,2 Go/h** flouté. Prévoir **50 Go+** pour une course de plusieurs heures. L'admin alerte sous `DISK_WARN_FREE_PERCENT` ; l'API refuse les envois sous `MIN_FREE_GB`.

## Limites connues

- **Floutage lent** : environ **1× temps réel** sur une machine 4 vCPU (2 workers) ; la galerie publique arrive avec un décalage (durée segment + traitement).
- **Segments ~1 min** : les exports floutés restent découpés ; `session.mp4` unifié existe si `BLUR_ASSEMBLE_SESSION=true` mais la concat finale n'est pas toujours fiable pour tous les cas.
- **CPU** : utilisation perçue ~**1 vCPU** malgré `BLUR_PROCESSOR_WORKERS=2` — goulot deface/ONNX et pipeline segmenter.
- **Navigateur au premier plan** : verrouillage ou changement d'app arrête la caméra (iOS/Android) ; l'app alerte mais ne peut pas filmer en arrière-plan.
- **Filigrane natif Samsung** : utile surtout pour les **photos** ; la vidéo marathon passe par la page web (incrustation GPS/heure).
- **Recadrage** : mode « cover » peut zoomer davantage que souhaité ; pas encore de contrôle zoom utilisateur.
- **Synchronisation Git** : la branche la plus à jour peut d'abord être sur **Cursor origin** ; le miroir **GitHub public** peut être en retard jusqu'à publication explicite (voir roadmap).
- iOS peut purger IndexedDB après longue inactivité ; envoyer régulièrement les parties en attente.
- Détection de visages sur images réduites : visages très petits peuvent échapper au flou (`BLUR_PROCESS_SCALE`).

## Évolutions possibles (roadmap)

- Accélérer le floutage (échelle, preset x264, workers, GPU, fréquence de analyse).
- **Une vidéo floutée unifiée** par session (concat finale fiable + téléchargement admin).
- Mieux utiliser le parallélisme CPU (profilage deface/ONNX).
- Option **720p** par défaut ou choix utilisateur (batterie / perf).
- Contrôle du **zoom / cadrage** (contain vs cover).
- Documenter ou intégrer le filigrane Samsung vs capture web.
- Aligner **GitHub** sur **Cursor origin** et publier les releases open source.

## Tests

```bash
cd services/api   && python -m pytest -q
cd services/admin && python -m pytest -q
cd services/blur  && python -m pytest -q
node --test tests/unit/lib.test.mjs
cd tests/e2e && npm install && npx playwright install chromium && npm test
```

Vérifications manuelles recommandées sur **vrais téléphones** (Safari iOS, Chrome Android) : voir section détaillée dans l'historique Git du README ou exécuter le scénario E2E comme guide.

## Licence

[MIT](./LICENSE) — Copyright (c) Pedro Crescencio.

## Contribuer

Les issues et PR sont les bienvenues. **Aucun secret** dans les commits (voir [SECURITY.md](./SECURITY.md)). Utilisez `.env.example` et des placeholders pour domaines et URLs.

## Mise à jour depuis l'ancienne stack « direct »

```bash
cd /opt/safevideoupload   # ou votre INSTALL_DIR
git fetch origin cursor/offline-capture && git checkout cursor/offline-capture && git pull --ff-only
docker compose down --remove-orphans
docker compose up -d --build --force-recreate
```

Conserver `.env` existant ; fermer le port **8189** au pare-feu s'il était ouvert pour WebRTC. Les données `storage/raw` et `storage/blurred` existantes sont conservées.
