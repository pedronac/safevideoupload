#!/usr/bin/env python3
"""
Benchmark du floutage deface (même pipeline que blur_utils.blur_segment).

Usage typique sur le VPS (dans le conteneur blur, avec le dépôt monté) :

  docker compose exec blur python /project/scripts/benchmark-blur.py synthetic -o /tmp/bench-clips
  docker compose exec blur python /project/scripts/benchmark-blur.py run -i /tmp/bench-clips -o /tmp/bench-out
  docker compose exec blur python /project/scripts/benchmark-blur.py faces-sweep -i /tmp/bench-clips -o /tmp/bench-sweep

Depuis la machine de dev (ffmpeg + dépendances blur installées) :

  PYTHONPATH=services/blur python scripts/benchmark-blur.py ...
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BLUR_PKG = REPO_ROOT / "services" / "blur"
if str(BLUR_PKG) not in sys.path:
    sys.path.insert(0, str(BLUR_PKG))

from blur_utils import (  # noqa: E402
    blur_segment,
    configure_inference_threads,
    normalize_to_cfr,
    probe_media,
    run_deface_on_file,
    oriented_scale,
)

PORTRAIT = "720x1280"
DURATION_S = 6
FPS = 30


def run_ffmpeg(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout or "ffmpeg failed")


def ensure_face_tile(path: Path, size: int = 96) -> None:
    """Petit visage synthétique (ellipse) — détection CenterFace non garantie."""
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color=c=#c8a882:s={size}x{size}",
                "-vf",
                f"drawbox=x={size//4}:y={size//6}:w={size//2}:h={size//3}:color=black@0.35:t=fill,"
                f"drawbox=x={size//4}:y={size//3}:w={size//2}:h={size//2}:color=#8b6914@0.6:t=fill",
                str(path),
            ]
        )
        return
    img = np.full((size, size, 3), (200, 168, 140), dtype=np.uint8)
    cv2.ellipse(img, (size // 2, size // 2 + 8), (size // 3, size // 2), 0, 0, 360, (139, 105, 80), -1)
    cv2.ellipse(img, (size // 2 - 18, size // 2 - 10), (8, 12), 0, 0, 360, (40, 30, 25), -1)
    cv2.ellipse(img, (size // 2 + 18, size // 2 - 10), (8, 12), 0, 0, 360, (40, 30, 25), -1)
    cv2.ellipse(img, (size // 2, size // 2 + 18), (22, 10), 0, 0, 360, (80, 50, 50), -1)
    cv2.imwrite(str(path), img)


def overlay_positions(count: int, w: int, h: int, tile: int) -> list[tuple[int, int]]:
    if count <= 0:
        return []
    cols = max(1, int(count**0.5 + 0.999))
    rows = (count + cols - 1) // cols
    margin_x = max(8, (w - cols * tile) // (cols + 1))
    margin_y = max(8, (h - rows * tile) // (rows + 1))
    out: list[tuple[int, int]] = []
    for i in range(count):
        row, col = divmod(i, cols)
        x = margin_x + col * (tile + margin_x)
        y = margin_y + row * (tile + margin_y)
        out.append((x, y))
    return out


def make_clip(
    output: Path,
    face_count: int,
    duration: float = DURATION_S,
    size: str = PORTRAIT,
) -> None:
    w, h = (int(p) for p in size.split("x"))
    base = output.with_suffix(".base.mkv")
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size={size}:rate={FPS}",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440",
            "-t",
            str(duration),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "libopus",
            "-f",
            "matroska",
            str(base),
        ]
    )
    if face_count == 0:
        base.rename(output)
        return

    tile_path = output.parent / "_face_tile.png"
    ensure_face_tile(tile_path)
    tile = 96
    positions = overlay_positions(face_count, w, h, tile)
    vf_parts = []
    inputs = ["-i", str(base), "-i", str(tile_path)]
    last = "[0:v]"
    for idx, (x, y) in enumerate(positions):
        out_label = f"[v{idx}]"
        vf_parts.append(f"{last}[1:v]overlay={x}:{y}{out_label}")
        last = out_label
    vf = ",".join(vf_parts)
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            *inputs,
            "-filter_complex",
            vf,
            "-map",
            last,
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-f",
            "matroska",
            str(output),
        ]
    )
    base.unlink(missing_ok=True)
    tile_path.unlink(missing_ok=True)


@dataclass
class RunResult:
    clip: str
    face_count: int
    scale: str
    duration_s: float
    normalize_s: float
    deface_s: float
    mux_s: float
    total_s: float
    realtime_ratio: float


def timed_blur_phases(raw: Path, out: Path, scale: str) -> RunResult:
    info = probe_media(raw)
    if not info["width"]:
        raise RuntimeError(f"illisible : {raw}")
    video_only = out.with_suffix(".video.mp4")
    normalized = out.with_suffix(".cfr.mp4")
    deface_scale = oriented_scale(scale, info["width"], info["height"])

    t0 = time.monotonic()
    normalize_to_cfr(raw, normalized)
    normalize_s = time.monotonic() - t0

    t1 = time.monotonic()
    run_deface_on_file(normalized, video_only, scale=deface_scale)
    deface_s = time.monotonic() - t1

    t2 = time.monotonic()
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_only)]
    if info["has_audio"]:
        cmd += ["-i", str(raw), "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "96k"]
    cmd += ["-c:v", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip())
    mux_s = time.monotonic() - t2

    video_only.unlink(missing_ok=True)
    normalized.unlink(missing_ok=True)

    duration = info["duration"] or DURATION_S
    total = normalize_s + deface_s + mux_s
    return RunResult(
        clip=raw.name,
        face_count=_face_count_from_name(raw.name),
        scale=scale,
        duration_s=duration,
        normalize_s=normalize_s,
        deface_s=deface_s,
        mux_s=mux_s,
        total_s=total,
        realtime_ratio=total / duration if duration else 0.0,
    )


def _face_count_from_name(name: str) -> int:
    if name.startswith("faces_"):
        try:
            return int(name.split("_")[1].split(".")[0])
        except (IndexError, ValueError):
            pass
    return -1


def cmd_synthetic(args: argparse.Namespace) -> None:
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    variants = args.faces if args.faces else [0, 1, 5, 10]
    manifest = []
    for n in variants:
        path = out_dir / f"faces_{n}.mkv"
        print(f"Génération {path.name} ({PORTRAIT}, {DURATION_S}s, {n} visage(s) simulé(s))...")
        make_clip(path, n, duration=args.duration, size=args.size)
        manifest.append({"file": path.name, "face_count": n, "path": str(path)})
    meta = out_dir / "manifest.json"
    meta.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Manifeste : {meta}")
    print(
        "Note : les visages sont des tuiles synthétiques ; CenterFace peut ne pas les détecter.\n"
        "       Pour un test réaliste, filmer des photos imprimées (protocole Pedro) ou utiliser\n"
        "       une photo réelle en overlay manuel avant benchmark."
    )


def write_results(out_dir: Path, rows: list[RunResult], label: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{label}.json"
    csv_path = out_dir / f"{label}.csv"
    data = [asdict(r) for r in rows]
    json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        if rows:
            writer = csv.DictWriter(fh, fieldnames=list(asdict(rows[0]).keys()))
            writer.writeheader()
            writer.writerows(data)
    print(f"\nRésultats : {json_path}\n          {csv_path}\n")
    print_table(rows)


def print_table(rows: list[RunResult]) -> None:
    hdr = (
        f"{'clip':<16} {'faces':>5} {'scale':<10} {'vid_s':>6} "
        f"{'norm_s':>7} {'deface_s':>8} {'mux_s':>6} {'total_s':>8} {'xRT':>6}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r.clip:<16} {r.face_count:>5} {r.scale:<10} {r.duration_s:>6.1f} "
            f"{r.normalize_s:>7.2f} {r.deface_s:>8.2f} {r.mux_s:>6.2f} "
            f"{r.total_s:>8.2f} {r.realtime_ratio:>6.2f}"
        )


def collect_clips(input_dir: Path) -> list[Path]:
    clips = sorted(input_dir.glob("faces_*.mkv"))
    if not clips:
        clips = sorted(input_dir.glob("*.mkv"))
    return clips


def cmd_run(args: argparse.Namespace) -> None:
    configure_inference_threads()
    scale = args.scale or os.environ.get("BLUR_PROCESS_SCALE", "640x360")
    clips = collect_clips(Path(args.input))
    if not clips:
        raise SystemExit(f"Aucun clip dans {args.input}")
    out_dir = Path(args.output)
    rows: list[RunResult] = []
    for clip in clips:
        out = out_dir / f"blurred_{clip.stem}.mp4"
        print(f"Benchmark {clip.name} (scale={scale})...")
        if args.full_only:
            t0 = time.monotonic()
            info = blur_segment(clip, out, scale=scale)
            total = time.monotonic() - t0
            dur = info["duration"] or DURATION_S
            rows.append(
                RunResult(
                    clip=clip.name,
                    face_count=_face_count_from_name(clip.name),
                    scale=scale,
                    duration_s=dur,
                    normalize_s=0.0,
                    deface_s=0.0,
                    mux_s=0.0,
                    total_s=total,
                    realtime_ratio=total / dur if dur else 0.0,
                )
            )
        else:
            rows.append(timed_blur_phases(clip, out, scale=scale))
    write_results(out_dir, rows, args.label or "run")


def cmd_faces_sweep(args: argparse.Namespace) -> None:
    scales = args.scales or ["480x270", "640x360"]
    clips = collect_clips(Path(args.input))
    if not clips:
        raise SystemExit(f"Aucun clip dans {args.input}")
    out_dir = Path(args.output)
    all_rows: list[RunResult] = []
    for scale in scales:
        for clip in clips:
            out = out_dir / f"blurred_{clip.stem}_{scale.replace('x', '_')}.mp4"
            print(f"Sweep {clip.name} @ {scale}...")
            all_rows.append(timed_blur_phases(clip, out, scale=scale))
    write_results(out_dir, all_rows, args.label or "faces-sweep")


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark floutage marathon (deface/ONNX)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_syn = sub.add_parser("synthetic", help="Génère des clips H.264 portrait 6s")
    p_syn.add_argument("-o", "--output", required=True, help="Dossier de sortie")
    p_syn.add_argument("--faces", type=int, nargs="+", help="Variantes (défaut: 0 1 5 10)")
    p_syn.add_argument("--duration", type=float, default=DURATION_S)
    p_syn.add_argument("--size", default=PORTRAIT)
    p_syn.set_defaults(func=cmd_synthetic)

    p_run = sub.add_parser("run", help="Mesure les phases normalize / deface / mux")
    p_run.add_argument("-i", "--input", required=True)
    p_run.add_argument("-o", "--output", required=True)
    p_run.add_argument("--scale", help="BLUR_PROCESS_SCALE (défaut env ou 640x360)")
    p_run.add_argument("--label", help="Préfixe fichiers JSON/CSV")
    p_run.add_argument(
        "--full-only",
        action="store_true",
        help="Temps global blur_segment uniquement (sans détail des phases)",
    )
    p_run.set_defaults(func=cmd_run)

    p_sweep = sub.add_parser("faces-sweep", help="Grille d'échelles BLUR_PROCESS_SCALE")
    p_sweep.add_argument("-i", "--input", required=True)
    p_sweep.add_argument("-o", "--output", required=True)
    p_sweep.add_argument("--scales", nargs="+", help="Défaut: 480x270 640x360")
    p_sweep.add_argument("--label", help="Préfixe fichiers JSON/CSV")
    p_sweep.set_defaults(func=cmd_faces_sweep)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
