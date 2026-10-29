# Sécurité

## Ne jamais committer de secrets

- **`.env`** contient `CAPTURE_TOKEN`, `ADMIN_TOKEN`, `DOMAIN`, `ACME_EMAIL` et d'autres réglages sensibles. Il est listé dans `.gitignore` et ne doit **jamais** apparaître dans Git, les captures d'écran ou les issues publiques.
- Générez les jetons avec `openssl rand -hex 32` (deux valeurs distinctes pour capture et admin).
- Ne mettez **jamais** `CAPTURE_TOKEN` dans une URL (query string, liens partagés). La page `/capture/` n'utilise que l'en-tête `Authorization: Bearer …` après saisie du mot de passe.

## Modèle d'accès

| Zone | Protection |
| --- | --- |
| `/capture/`, `/api/upload/*` | `CAPTURE_TOKEN` (Bearer) |
| `/admin/`, téléchargements brut/GPS | `ADMIN_TOKEN` (Bearer + liens signés à durée limitée) |
| `/`, `/videos/`, segments floutés | Public si `PUBLIC_PAGE_ENABLED=true` |

Le floutage masque les **visages**, pas la **position GPS ni l'heure** incrustées dans l'image. Pour couper toute exposition publique : `PUBLIC_PAGE_ENABLED=false`.

## Signaler une vulnérabilité

Pour une faille de sécurité, contactez le mainteneur en privé (pas d'issue publique avec des jetons ou des journaux de production).

## Contributions

Les pull requests ne doivent pas contenir de `.env` réel, clés SSH, mots de passe VPS ou adresses de déploiement privées. Utilisez les placeholders de `.env.example`.
