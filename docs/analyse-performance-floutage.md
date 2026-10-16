# Analyse performance — pipeline de floutage live marathon

Document pour Pedro et l’équipe ops : pourquoi le VPS Ikoula (4 vCPU) n’affiche qu’~**1,0 CPU** dans les graphiques, comment interpréter les logs `x temps réel`, et comment tester l’impact du nombre de visages.

## Architecture rappel

```
WHIP (téléphone) → MediaMTX `live` → RTSP
  → segmenter (ffmpeg, 1 thread) → segments MKV ~6 s
  → processor (deface / CenterFace ONNX, **1 worker par défaut**) → MP4 flouté
  → pusher (ffmpeg -re) → RTMP `blurred` → HLS public (Caddy)
```

Trois threads Python (segmenter, processor(s), pusher) tournent en parallèle, mais **le goulot est presque toujours le processor** : une seule chaîne deface + ffmpeg par segment à la fois (sauf si `BLUR_PROCESSOR_WORKERS>1`).

## Pourquoi ~1 vCPU sur 4 ?

| Composant | Parallélisme |
|-----------|----------------|
| Segmenter RTSP | 1 processus ffmpeg (copie codec, léger) |
| **Processor** | **1 worker** par défaut : `normalize_to_cfr` (ffmpeg) puis **deface** (ONNX + ffmpeg encodage) — surtout **mono-thread par segment** |
| Pusher | 1 ffmpeg en lecture `-re` (souvent en attente du processor) |

Les graphiques hyperviseur (Ikoula) agrègent souvent **une seule vCPU à ~100 %** quand un cœur est saturé et les autres peu inactifs. Ce n’est pas un bug Docker : c’est le modèle **un segment = une chaîne séquentielle**.

Les logs du worker affichent déjà le ratio :

```text
Segment flouté ... (x1.23 temps réel, ...)
```

- **x &lt; 1** : le segment est traité plus vite que sa durée vidéo → le direct peut suivre.
- **x &gt; 1** : traitement plus lent que le temps réel → **backlog** dans `raw_queue`, puis abandon des plus vieux segments (`Retard de floutage`) et saccades côté HLS malgré un buffer player.

## Impact du nombre de visages

CenterFace détecte les visages **sur chaque image** (à l’échelle `BLUR_PROCESS_SCALE`, inversée automatiquement en portrait). Plus il y a de visages :

- plus de zones à flouter (post-traitement OpenCV) ;
- légère charge ONNX si beaucoup de détections.

En direct marathon, le cas typique est **0–3 visages** (coureur + bénévoles). Un test avec **10 photos** imprimées dans le cadre est un **stress test**, pas la médiane.

## Protocole de test Pedro (photos imprimées)

Objectif : corréler **nombre de visages visibles** et ratio `x temps réel`.

1. Préparer des affiches A4 avec **0, 1, 5 et 10** visages (photos imprimées, bien éclairées).
2. Lancer un direct test depuis `/capture/` (même réglages que le marathon).
3. Pour chaque variante, filmer **~30 s** en gardant les visages dans le cadre portrait.
4. Analyser :
   - **Sur le VPS** : `./scripts/analyze-blur-logs.sh` ou `docker compose logs blur --tail 500 | ./scripts/analyze-blur-logs.sh -`
   - **Latence** : `./scripts/measure-live-latency.sh` pendant le live.
5. Option **hors live** : exporter un segment MKV brut depuis `storage/raw/live`, puis benchmark :

```bash
# Depuis le dossier du dépôt sur le VPS (monter le repo dans le conteneur blur) :
docker compose run --rm -v "$(pwd):/project:ro" -v /tmp/bench:/tmp/bench blur \
  python /project/scripts/benchmark-blur.py synthetic -o /tmp/bench/clips

docker compose run --rm -v "$(pwd):/project:ro" -v /tmp/bench:/tmp/bench blur \
  python /project/scripts/benchmark-blur.py run -i /tmp/bench/clips -o /tmp/bench/out

docker compose run --rm -v "$(pwd):/project:ro" -v /tmp/bench:/tmp/bench blur \
  python /project/scripts/benchmark-blur.py faces-sweep -i /tmp/bench/clips -o /tmp/bench/sweep
```

Les clips `synthetic` utilisent des **tuiles visage synthétiques** : CenterFace peut **ne pas** les détecter ; les chiffres restent utiles pour comparer échelles et charge ffmpeg, mais le test **photos imprimées** reste la référence pour le nombre de visages.

Sorties : `run.json` / `run.csv` (table pour comparaison des phases `normalize`, `deface`, `mux`).

## Pistes de parallélisation

Voir [paralleliser-floutage.md](./paralleliser-floutage.md) pour le classement des options (`BLUR_PROCESS_SCALE`, threads ONNX, `BLUR_PROCESSOR_WORKERS`, durée des chunks, GPU).

## Scripts associés

| Script | Rôle |
|--------|------|
| `scripts/benchmark-blur.py` | Clips synthétiques + mesures xRT |
| `scripts/analyze-blur-logs.sh` | Stats sur les ratios des logs blur |
| `scripts/measure-live-latency.sh` | Corrélation brut / chunks / API MediaMTX |
| `scripts/diagnose-live.sh` | Diagnostic général du direct |
