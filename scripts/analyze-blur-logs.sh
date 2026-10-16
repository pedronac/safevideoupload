#!/usr/bin/env bash
# Extrait les ratios « x temps réel » des logs du worker blur (VPS ou local).
# Usage :
#   ./scripts/analyze-blur-logs.sh
#   ./scripts/analyze-blur-logs.sh --tail 200 blur.log
#   docker compose logs blur --tail 500 | ./scripts/analyze-blur-logs.sh -
set -euo pipefail

TAIL=400
INPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tail) TAIL="$2"; shift 2 ;;
    -) INPUT="-"; shift ;;
    *) INPUT="$1"; shift ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "$INPUT" ]; then
  LOG="$(docker compose logs blur --tail "$TAIL" 2>&1 || true)"
elif [ "$INPUT" = "-" ]; then
  LOG="$(cat)"
else
  LOG="$(cat "$INPUT")"
fi

# Ligne type : ... x1.23 temps réel ...
mapfile -t RATIOS < <(echo "$LOG" | grep -oE 'x[0-9]+\.[0-9]+ temps réel' | sed 's/x//;s/ temps réel//' || true)

if [ "${#RATIOS[@]}" -eq 0 ]; then
  echo "Aucun ratio trouvé (chercher « x%.2f temps réel » dans les logs blur)."
  exit 0
fi

python3 - "$TAIL" "${RATIOS[@]}" <<'PY'
import sys
ratios = [float(x) for x in sys.argv[2:]]
n = len(ratios)
over = sum(1 for r in ratios if r > 1.0)
print(f"Segments analysés : {n} (derniers ~{sys.argv[1]} lignes de logs)")
print(f"  min xRT   : {min(ratios):.2f}")
print(f"  max xRT   : {max(ratios):.2f}")
print(f"  moyenne   : {sum(ratios)/n:.2f}")
print(f"  > 1.0     : {over} ({100*over/n:.0f}%) — backlog / saccades probables")
print("\nDerniers ratios :", " ".join(f"{r:.2f}" for r in ratios[-12:]))
PY
