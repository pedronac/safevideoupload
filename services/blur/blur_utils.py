"""Utilitaires de floutage (deface / CenterFace ONNX) pour segments courts."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def run_deface_on_file(
    input_path: Path,
    output_path: Path,
    scale: str = "640x360",
    replacewith: str = "blur",
) -> None:
    """Applique deface (backend ONNX) sur un fichier vidéo."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    deface_bin = shutil.which("deface") or "deface"
    cmd = [
        deface_bin,
        str(input_path),
        "--output",
        str(output_path),
        "--backend",
        "onnxrt",
        "--scale",
        scale,
        "--replacewith",
        replacewith,
        "--keep-audio",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"deface a échoué (code {proc.returncode}): {proc.stderr or proc.stdout}"
        )


def has_video_stream(path: Path) -> bool:
    """Vérifie qu'un fichier contient au moins une piste vidéo (ffprobe)."""
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0 and "video" in proc.stdout
