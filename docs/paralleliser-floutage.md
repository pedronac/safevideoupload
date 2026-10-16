# Paralléliser et accélérer le floutage live

Options classées du **plus simple** au plus coûteux, pour un VPS Ikoula **4 vCPU** sans GPU.

## 1. Réduire `BLUR_PROCESS_SCALE` (gain rapide)

Défaut : `640x360` (paysage logique ; en portrait 720×1280 → inférence **360×640**).

| Valeur | Effet |
|--------|--------|
| `480x270` | Moins de pixels pour CenterFace → souvent **−20 à 40 %** de temps deface, risque léger sur petits visages lointains |
| `640x360` | Meilleure détection, plus de CPU |

Test A/B : `benchmark-blur.py faces-sweep` ou bascule dans `.env` puis `docker compose up -d blur`.

## 2. Limiter les threads ONNX / OpenMP

Quand `BLUR_PROCESSOR_WORKERS=1`, laisser ONNX utiliser **2 threads** peut aider sur un seul gros cœur ; avec **plusieurs workers**, réduire les threads pour éviter la sur-souscription (4 workers × 4 threads = contention).

Variables (dans `.env`, reprises par `docker-compose` pour le service `blur`) :

```env
OMP_NUM_THREADS=2
ONNXRUNTIME_INTRA_OP_NUM_THREADS=2
ONNXRUNTIME_INTER_OP_NUM_THREADS=1
```

Le worker logue les valeurs actives au démarrage (`threads={...}`).

## 3. Plusieurs workers processor (`BLUR_PROCESSOR_WORKERS`)

Chaque worker consomme un segment brut distinct sur la **même** `raw_queue`. Utile si **plusieurs cœurs** sont libres et que chaque segment prend ~1 cœur.

```env
BLUR_PROCESSOR_WORKERS=2
```

Sur **4 vCPU** : commencer par `2`, surveiller `docker stats` et les ratios xRT. Au-delà de 2–3, le segmenter et le disque peuvent devenir limitants.

Implémentation : threads `processor-0`, `processor-1`, … dans `blur_worker.py` ; compteur de segments thread-safe.

## 4. Durée des chunks (`BLUR_CHUNK_SECONDS`)

| Plus court (ex. 4 s) | Plus long (ex. 8 s) |
|----------------------|---------------------|
| Moins de latence perçue | Moins d’appels deface par minute |
| Plus de segments/min → plus de CPU | Latence initiale plus haute |

Compromis actuel marathon : **6 s**.

## 5. GPU / autre machine

Le VPS Ikoula cible est **CPU-only** (onnxruntime CPU). Un GPU NVIDIA (autre hébergeur ou machine dédiée) avec `onnxruntime-gpu` et un build deface adapté est hors scope actuel mais reste l’option ultime si le direct doit tenir avec beaucoup de visages en 720p.

## Ordre de mise en prod recommandé

1. Mesurer baseline : `analyze-blur-logs.sh` + test photos Pedro.
2. Passer à `BLUR_PROCESS_SCALE=480x270` si xRT &gt; 1.
3. Ajuster `OMP_NUM_THREADS` / `ONNXRUNTIME_INTRA_OP_NUM_THREADS`.
4. Si xRT reste &gt; 1 et CPU &lt; 2 cœurs utilisés : `BLUR_PROCESSOR_WORKERS=2`.
5. Re-mesurer latence : `measure-live-latency.sh`.

Après chaque changement : `docker compose up -d blur` et vérifier les logs `Démarrage (chunk=..., workers=..., ...)`.
