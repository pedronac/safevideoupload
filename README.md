# safevideoupload — streaming marathon (MVP)

Diffusion en direct depuis un téléphone (**Android Chrome** ou **iPhone Safari**) :

```
téléphone  --WHIP/WebRTC-->  Caddy (HTTPS, Bearer)  -->  MediaMTX 1.9.3  (chemin `live`, enregistrement brut)
                                                              |  RTSP
                                                              v
                                            worker de floutage (deface, par segments)
                                                              |  RTMP (connexion continue)
                                                              v
                       MediaMTX (chemin `blurred`) --HLS--> Caddy /hls/blurred/ --> page viewer
```

- La **page capture** (`/capture/`) est protégée par un **mot de passe** vérifié côté serveur.
- Le **viewer** (`/viewer/`) est public, ne montre que le flux **flouté** et attend tout seul le début du direct.
- Le flux **brut** n'est jamais exposé (`/hls/live/` → 404) ; il est enregistré sous `storage/raw/live/`.
- Sauvegarde locale sur le téléphone (`MediaRecorder`, segments d'~1 min) et push **YouTube** optionnel.

## Mise en route (VPS)

```bash
cp .env.example .env            # puis éditer DOMAIN, ACME_EMAIL
openssl rand -hex 32            # à coller dans CAPTURE_TOKEN (mot de passe de capture)
mkdir -p storage/raw storage/blurred caddy/data caddy/config
docker compose up -d --build
```

Mise à jour d'un VPS existant :

```bash
cd /opt/safevideoupload && git pull --rebase origin cursor/streaming-mvp-marathon
docker compose up -d --build --force-recreate
```

`CAPTURE_TOKEN` est **obligatoire** : `docker compose` refuse de démarrer s'il est vide, et Caddy refuse
tout accès à `/live/*` et `/capture-auth` s'il est vide (fail closed).

### Mot de passe de capture (`CAPTURE_TOKEN`)

- Utiliser une valeur **longue et aléatoire** (`openssl rand -hex 32`) : il n'y a pas de limitation de
  tentatives, un mot de passe court serait devinable.
- On le saisit dans le formulaire de `https://<DOMAIN>/capture/` ; il n'est **jamais** dans une URL, un
  cookie ou un lien. Le navigateur le garde en `sessionStorage` (ou `localStorage` si « Se souvenir de ce
  téléphone » est coché — décoché par défaut).
- Sur le serveur : `POST /capture-auth` répond `204` si `Authorization: Bearer <CAPTURE_TOKEN>` correspond,
  `401` sinon. WHIP (`/live/*`) n'accepte que ce même en-tête Bearer. Changer le mot de passe =
  modifier `.env` puis `docker compose up -d --force-recreate caddy`.

### Pare-feu

Ouvrir **TCP 80, TCP 443, UDP 8189 et TCP 8189** — à la fois dans `ufw` **et** dans le pare-feu du
fournisseur (panneau Ikoula). Le port 8189 est celui du flux WebRTC du téléphone (UDP en priorité, TCP en
repli quand l'opérateur bloque l'UDP). RTSP, RTMP et l'API MediaMTX restent sur le réseau Docker.

Le DNS de `DOMAIN` doit pointer **directement** vers l'IP du VPS (pas de proxy CDN type Cloudflare orange).
`mediamtx/mediamtx.yml` annonce au téléphone le nom de domaine **et** l'IP publique (`webrtcAdditionalHosts`) :
si l'IP du VPS change, la mettre à jour à cet endroit.

## Utiliser la capture

1. Ouvrir `https://<DOMAIN>/capture/`, saisir le mot de passe.
2. Choisir l'orientation (**Auto** suit le téléphone ; Portrait / Paysage au besoin), **Démarrer diffusion**.
3. La page affiche l'état réel : « EN DIRECT » n'apparaît que lorsque la connexion WebRTC est établie
   (`connecté`), avec le chemin réseau (UDP/TCP), le débit et la taille envoyée. Si rien n'aboutit en
   15 s, un message explique quoi vérifier ; la sauvegarde locale continue et la connexion est retentée.
4. L'image est cadrée par la page sans jamais déformer : la sortie est 720x1280 (portrait) ou 1280x720
   (paysage), ou le ratio réel de la caméra. Si la caméra ne sait livrer que du paysage alors que le
   portrait est voulu, l'image est **recadrée au centre** et l'état l'indique (« Caméra 1280x720 → sortie
   720x1280 (recadrage centré…) »).

La latence du direct public vaut environ `BLUR_CHUNK_SECONDS` (30 s par défaut) + le temps de floutage.
Le premier segment flouté n'apparaît donc que 40–60 s après le début du direct.

## Le worker de floutage

Trois étapes en parallèle (`services/blur/blur_worker.py`) :

1. **segmenter** : un seul `ffmpeg` lit `rtsp://mediamtx:8554/live` et écrit des segments bruts (copie,
   Matroska) — il attend tout seul qu'un direct existe et reprend après une coupure.
2. **processor** : normalise la cadence, applique deface (échelle d'analyse adaptée au portrait), remet
   l'audio Opus en AAC, archive le MP4 dans `storage/blurred/chunks/`.
3. **pusher** : relaie les segments en temps réel vers `rtmp://mediamtx:1935/blurred` (et YouTube si
   `YOUTUBE_RTMP_URL`) avec une connexion RTMP continue.

Les logs indiquent `x<ratio> temps réel` : au-dessus de 1.0 le CPU ne suit pas (le worker abandonne alors les
plus vieux segments pour le direct ; réduire `BLUR_PROCESS_SCALE`, p. ex. `480x270`, ou prendre plus de CPU).

## Diagnostic en cas de problème

Sur le VPS, dans le dossier du dépôt :

```bash
./scripts/diagnose-live.sh
```

Il affiche l'état des conteneurs, les logs WebRTC de MediaMTX, les chemins et sessions de l'API
(`/v3/paths/list`, `/v3/webrtcsessions/list`, accessibles depuis le réseau Docker), l'existence de
`storage/raw/live`, les ports ouverts, les accès HTTP publics et une commande `tcpdump` pour voir arriver les
paquets du téléphone (`sudo tcpdump -ni any 'udp port 8189 or tcp port 8189'`).

Lecture rapide :

| Symptôme | Cause probable |
|----------|----------------|
| MediaMTX : `session ... created` mais jamais `is publishing to path 'live'` | ICE/DTLS n'aboutit pas : pare-feu 8189 (udp+tcp), DNS/IP annoncés, réseau du téléphone |
| `tcpdump` : 0 paquet | rien n'atteint le serveur : pare-feu fournisseur, mauvaise IP annoncée, DNS derrière un proxy |
| `live` publié mais viewer « En attente du direct… » | le floutage n'a pas encore produit son premier segment (30–60 s), ou voir `docker compose logs blur` |
| viewer « Connexion au serveur impossible » | Caddy/MediaMTX arrêté ou erreur HTTP ≠ 404 (le texte indique le code) |

## Tests

```bash
# Tests unitaires du worker (dans l'image Docker, ou en local avec requirements.txt + ffmpeg)
docker compose run --rm --no-deps blur pytest -q

# Smoke test de la pile Docker (build, up, accès, WHIP/HLS, API MediaMTX)
./scripts/smoke-test.sh
# ... ou seulement les contrôles HTTP sur un serveur déjà déployé :
SKIP_DOCKER=1 BASE_URL=https://stream.exemple.fr ./scripts/smoke-test.sh

# Page capture : Playwright + Chromium (caméra factice), portrait/paysage, mot de passe, états ICE
cd tests/e2e && npm install && npx playwright install chromium && npm test
E2E_FAST=1 npm test    # saute le test de timeout ICE (15 s)
```

Le smoke test lit `CAPTURE_TOKEN` dans l'environnement ou dans `.env` (sans l'afficher). Validation de la
configuration Caddy : `caddy validate --adapter caddyfile --config caddy/Caddyfile` avec
`DOMAIN`, `ACME_EMAIL` et `CAPTURE_TOKEN` définis.

Non couvert par les tests automatiques : un vrai téléphone (Android Chrome, iPhone Safari) — l'orientation
réelle des images, les codecs matériels et le réseau mobile se valident sur l'appareil.

## Checklist jour J

1. `docker compose ps` — trois services `running` ; `./scripts/diagnose-live.sh` sans erreur.
2. `/capture/` sur le téléphone : mot de passe, **Démarrer diffusion**, attendre « EN DIRECT ».
3. Enregistrement brut : fichiers sous `storage/raw/live/`.
4. 40–60 s plus tard, `/viewer/` joue le flux flouté (portrait si capture en portrait).
5. **Coupure GSM** : la page retente la connexion toute seule ; la sauvegarde locale continue.
6. **Sauvegarde locale** : bouton « Télécharger sauvegarde » en fin d'épreuve.
7. YouTube : renseigner `YOUTUBE_RTMP_URL` et contrôler le tableau de bord Google.

## Après l'événement

Les enregistrements MediaMTX sont des **fMP4 fragmentés** (segments d'1 h) ; pour assembler :

```bash
ffmpeg -f concat -safe 0 -i liste.txt -c copy sortie_marathon.mp4
```

(`liste.txt` : une ligne `file 'chemin'` par segment.) Prévoir ~14 Go pour 6 h (brut + flouté, 720p ~3 Mbps).

## Développement local

Dans `.env` : `DOMAIN=localhost`, un `CAPTURE_TOKEN` quelconque. Caddy sert alors `http://localhost/viewer/`
et `http://localhost/capture/` (uniquement avec `Host: localhost` ; l'IP nue n'est jamais servie en HTTP).
Pour tester depuis un téléphone sur le LAN, passer `webrtcIPsFromInterfaces: yes` dans
`mediamtx/mediamtx.yml` et utiliser HTTPS (la caméra l'exige hors localhost).
