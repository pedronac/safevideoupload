# safevideoupload — capture hors ligne (sans direct)

Un téléphone (**iPhone Safari** ou **Android Chrome**) filme en continu en portrait 1080×1920 (~8 Mbit/s, avec le
micro). Le téléphone **garde tout** dans son stockage local et envoie la vidéo par morceaux de 10 s dès qu'il y a du
réseau. Le serveur recolle les morceaux, floute les visages (deface) et publie des segments floutés sur une page
publique. Il n'y a **plus de direct** : ni MediaMTX, ni WebRTC, ni HLS, ni port 8189.

```
téléphone ── MediaRecorder (1 enregistrement continu, jamais redémarré) ── parties de 10 s ── IndexedDB
                                                                                   │ PUT /api/upload/… (Bearer, HTTPS)
                                                                                   ▼
                                Caddy ──► api (Python) ── raw/<session>/stream.{mp4,webm} (+ gps.json)
                                                                                   │
                                            blur (processor.py) : découpe sur images clés (ffmpeg -c copy) ─► deface
                                                                                   ▼
                             Caddy /  /videos/  /media/*  ◄── blurred/<session>/seg_NNNNN.mp4 (+ session.mp4)
```

## Ce que fait chaque page

| Page | Accès | Rôle |
| --- | --- | --- |
| `/capture/` | mot de passe `CAPTURE_TOKEN` | enregistre, bufferise hors ligne, envoie, alerte |
| `/` ou `/videos/` | publique (désactivable) | vidéos **floutées** par date puis heure, lecture enchaînée |
| `/admin/` | `ADMIN_TOKEN` | disque libre, file de floutage, sessions, téléchargements (brut + flouté), mot de passe de capture |

### Téléphone (`/capture/`)

- Mot de passe vérifié côté serveur (en-tête `Bearer`, jamais dans l'URL). « Se souvenir » est décoché par défaut.
- Gros bouton **Démarrer / Arrêter** ; l'arrêt demande confirmation.
- **Image gravée** dans la vidéo : latitude, longitude, précision, date et heure (Europe/Paris, avec secondes).
  En parallèle, une trace GPS JSON (~1 point par seconde) est envoyée avec la session.
- Aucune coupure entre morceaux : c'est **un seul enregistrement** `MediaRecorder` découpé en parties (`timeslice`),
  recollées dans l'ordre par le serveur.
- Hors ligne : les parties s'accumulent dans IndexedDB (`storage.persist()` demandé), l'envoi reprend tout seul avec
  attente croissante. Chaque partie est envoyée avec sa somme SHA-256 : renvoi sans risque (idempotent), suppression
  locale seulement après l'accusé du serveur.
- Écran maintenu allumé (Wake Lock, vidéo NoSleep en repli). Alertes visuelles + bip WebAudio + vibration : page
  masquée, caméra ou micro coupés, stockage presque plein, envoi bloqué. Reprise automatique dans une nouvelle session
  si l'enregistreur s'arrête (3 fois max sur 10 minutes).
- Panneau d'état (réseau, parties en attente, Mo à envoyer, espace libre) et bouton **Télécharger tout** (secours si
  le serveur est inaccessible).
- Format : Chromium → WebM (VP8 + Opus) ; Safari/iOS → MP4 (H.264 + AAC). Un sélecteur dans « Réglages » permet de
  forcer MP4 ou WebM si un chemin pose problème. Si 1080p ne démarre pas, repli automatique en 720p.

## Mise en route (VPS)

Seuls les ports **80 et 443** sont à ouvrir.

```bash
cp .env.example .env            # éditer DOMAIN, ACME_EMAIL
openssl rand -hex 32            # à lancer deux fois : CAPTURE_TOKEN puis ADMIN_TOKEN
mkdir -p storage/raw storage/blurred caddy/data caddy/config
docker compose up -d --build
```

`scripts/bootstrap-ikoula-vps.sh` automatise Docker, le dépôt et le `.env` sur un VPS vierge (variable `BRANCH`).

### Mise à jour d'un VPS existant (live → hors ligne)

```bash
cd /opt/safevideoupload
git fetch origin cursor/offline-capture && git checkout cursor/offline-capture && git pull --ff-only
docker compose down --remove-orphans      # arrête et supprime mediamtx
docker compose up -d --build --force-recreate
./scripts/diagnose.sh
SKIP_DOCKER=1 BASE_URL=https://<DOMAIN> ./scripts/smoke-test.sh
```

- `.env` : `CAPTURE_TOKEN`, `ADMIN_TOKEN`, `DOMAIN` et `ACME_EMAIL` sont conservés ; les variables du direct
  (voir ci-dessous) peuvent être supprimées, elles sont ignorées.
- Fermer le port **8189** (udp + tcp) chez Ikoula si on veut : il ne sert plus.
- `storage/raw` et `storage/blurred` existants restent en place (le brut du live est un autre arborescence : il reste
  téléchargeable à la main mais n'apparaît plus dans la page admin).

## Variables d'environnement (`.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DOMAIN`, `ACME_EMAIL` | — | HTTPS automatique (Let's Encrypt) |
| `CAPTURE_TOKEN` | **obligatoire** | mot de passe de `/capture/` et jeton `Bearer` de `/api/upload/*` |
| `ADMIN_TOKEN` | **obligatoire** | accès à `/admin/` (inchangé) |
| `PUBLIC_PAGE_ENABLED` | `true` | `false` : `/`, `/videos/`, `/media/*`, `/api/public/*` répondent 404 |
| `MAX_PART_MB` | `256` | taille max d'une partie envoyée |
| `MIN_FREE_GB` | `2` | l'API refuse (507) les envois sous ce seuil d'espace libre |
| `SEGMENT_SECONDS` | `60` | durée visée des segments floutés (coupés sur image clé) |
| `BLUR_PROCESS_SCALE` | `480x270` | échelle d'analyse des visages (paysage ; inversée en portrait) |
| `BLUR_PROCESSOR_WORKERS` | `2` | segments floutés en parallèle |
| `BLUR_X264_PRESET` | `veryfast` | préréglage x264 de la sortie (`ultrafast` = plus rapide, plus gros) |
| `BLUR_ASSEMBLE_SESSION` | `true` | assemble `session.mp4` une fois la session fermée et floutée |
| `SESSION_AUTOCLOSE_S` | `21600` | ferme une session sans nouvelle partie depuis 6 h |
| `DISK_WARN_FREE_PERCENT` | `15` | alerte admin sous ce pourcentage d'espace libre |
| `OMP_NUM_THREADS`, `ONNXRUNTIME_*` | 2 / 2 / 1 | threads par worker de floutage |

**Supprimées** (direct) : `MEDIAMTX_RTSP_URL`, `MEDIAMTX_RTMP_URL`, `YOUTUBE_RTMP_URL`, `BLUR_CHUNK_SECONDS`,
`BLUR_PUSH_IDLE_CLOSE_S`.

## Stockage et disque

```
storage/raw/<session>/stream.{mp4,webm}   flux brut recollé (privé, jamais servi publiquement)
storage/raw/<session>/gps.json            trace GPS
storage/blurred/<session>/seg_NNNNN.mp4   segments floutés publics (+ session.mp4)
storage/state/registry.db                 registre SQLite (sessions, parties, segments)
storage/work/<session>/                   segments bruts temporaires
```

- ~**3,6 Go/h** de brut à 8 Mbit/s et ~**2,2 Go/h** de flouté. Une course de 6 h demande **plus de 50 Go** : prévoir
  large. L'admin affiche l'espace libre et **alerte sous 15 %** ; l'API refuse les envois sous `MIN_FREE_GB`.
- Le floutage tourne à ~**1× temps réel** sur 4 vCPU (mesuré : 20 s de vidéo 1080×1920 en ~20 s par job, 2 jobs en
  parallèle ≈ 0,9×). Il rattrape en direct si le CPU est libre ; sinon `BLUR_X264_PRESET=ultrafast` ou une échelle
  plus petite accélèrent. Redémarrer le conteneur `blur` reprend le travail là où il s'est arrêté.

## Confidentialité

L'image gravée contient la **position GPS et l'heure** : elles sont donc **visibles publiquement** sur la page
publique (le flouté ne masque que les visages). Mettre `PUBLIC_PAGE_ENABLED=false` pour tout couper. Le brut et le
JSON GPS ne sont servis qu'avec `ADMIN_TOKEN` (liens signés à durée limitée depuis `/admin/`).

## Tests

```bash
# Python (venv : pip install -r services/blur/requirements-dev.txt)
cd services/api   && python -m pytest -q
cd services/admin && python -m pytest -q
cd services/blur  && python -m pytest -q       # ~30 s : ffmpeg + deface réels, flux sans trou
# JavaScript
node --test tests/unit/lib.test.mjs
# E2E navigateur (Chromium + caméra factice, géolocalisation simulée, coupure réseau, Caddy réel)
cd tests/e2e && npm install && npx playwright install chromium
PYTHON=$HOME/venv/bin/python npm test           # E2E_SEGMENT_SECONDS=60 E2E_RECORD_SECONDS=140 pour du grandeur nature
# Contrôle HTTP d'un déploiement (+ clip de test avec SMOKE_UPLOAD=1)
SKIP_DOCKER=1 BASE_URL=https://<DOMAIN> ./scripts/smoke-test.sh
./scripts/diagnose.sh
```

## Vérifications manuelles minimales (vrais téléphones)

L'E2E utilise Chromium de bureau : **iOS Safari n'a pas été testé automatiquement**. À faire une fois :

1. **iPhone Safari** : ouvrir `/capture/`, saisir le mot de passe, Démarrer, accepter caméra + micro + position.
   Vérifier le format affiché (MP4), l'écran qui reste allumé, l'heure/GPS gravés dans l'aperçu.
2. Filmer 1 min, passer en mode avion 30 s puis le retirer : les parties en attente doivent partir toutes seules
   (panneau d'état) et la vidéo doit apparaître sur `/` après floutage, sans coupure.
3. Interrupteur silencieux activé : le bip d'alerte peut ne pas sonner sur iPhone (vibration non prise en charge) —
   la bannière rouge doit s'afficher quand on masque la page 2 s.
4. **Android Chrome** : même scénario ; vérifier WebM et l'écran allumé.
5. Garder l'onglet au **premier plan, écran allumé** : verrouiller le téléphone ou changer d'application arrête la
   caméra sur iOS comme sur Android.
6. Télécharger l'enregistrement brut depuis `/admin/` et le lire en entier (son + image).

## Limites connues

- Pas de direct : la page publique se remplit avec un délai (durée d'un segment + temps de floutage).
- Un navigateur ne peut pas filmer écran verrouillé ou onglet en arrière-plan ; l'app alerte mais ne peut pas l'empêcher.
- Sans GPU, Chromium de test perd des images vidéo quand le CPU est saturé ; sur téléphone l'encodage est matériel.
- iOS peut vider IndexedDB d'un site non utilisé pendant des semaines et plafonne le quota : vider les parties
  régulièrement (elles partent seules) et garder de la place libre ; le panneau d'état montre l'espace restant.
- Une session fermée refuse les parties tardives (409) ; « Finaliser » dans l'admin force la clôture.
- Le floutage dépend de la détection de visages sur images réduites : les visages très petits ou lointains peuvent
  passer entre les mailles (augmenter `BLUR_PROCESS_SCALE`).
- `docker compose` n'a pas pu être exécuté dans l'environnement de développement (pas de Docker) : la pile a été
  testée en processus natifs (api, processeur, admin, Caddy 2.8) ; le `Dockerfile`/`docker-compose.yml` doivent être
  validés au premier déploiement (`docker compose config`, `docker compose up -d --build`).
