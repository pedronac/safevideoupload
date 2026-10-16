"""Utilitaires de floutage (deface / CenterFace ONNX) pour segments courts."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

# Image clé toutes les ~1 s : segments HLS courts et exigence YouTube (<= 4 s).
DEFACE_FFMPEG_CONFIG = {
    "codec": "libx264",
    "macro_block_size": 1,
    "output_params": ["-g", "30", "-preset", "veryfast"],
}


def parse_scale(scale: str) -> tuple[int, int]:
    """'640x360' -> (640, 360)."""
    w, h = scale.lower().split("x", 1)
    return int(w), int(h)


def oriented_scale(scale: str, width: int, height: int) -> str:
    """Adapte l'échelle d'inférence deface à l'orientation de la vidéo.

    BLUR_PROCESS_SCALE est écrit en paysage (ex. 640x360). Pour une vidéo
    portrait (720x1280) on l'inverse en 360x640 : sinon l'image serait écrasée
    avant détection et les visages mal repérés.
    """
    sw, sh = parse_scale(scale)
    long_side, short_side = max(sw, sh), min(sw, sh)
    if height > width:
        return f"{short_side}x{long_side}"
    return f"{long_side}x{short_side}"


TARGET_FPS = 30


def normalize_to_cfr(raw_path: Path, output_path: Path, fps: int = TARGET_FPS) -> None:
    """Réencode la vidéo d'un segment WebRTC en cadence constante (sans audio).

    Les segments issus du WebRTC sont à cadence variable et ffmpeg y annonce
    1000 i/s (30000 i/s moyens) : deface en déduirait une sortie absurde, très lente.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(raw_path),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        f"fps={fps}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-g",
        str(fps),
        "-pix_fmt",
        "yuv420p",
        str(output_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"normalisation cadence : {proc.stderr.strip()}")


def run_deface_on_file(
    input_path: Path,
    output_path: Path,
    scale: str = "640x360",
    replacewith: str = "blur",
    keep_audio: bool = False,
) -> None:
    """Applique deface (backend ONNX) sur un fichier vidéo.

    Par défaut la sortie est sans audio : deface recopie l'audio tel quel, or
    le WebRTC fournit de l'Opus, que ni MP4 ni FLV (RTMP) ne savent porter.
    L'audio est remis en AAC par `blur_segment`.
    """
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
        "--ffmpeg-config",
        json.dumps(DEFACE_FFMPEG_CONFIG),
    ]
    if keep_audio:
        cmd.append("--keep-audio")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"deface a échoué (code {proc.returncode}): {proc.stderr or proc.stdout}"
        )


def probe_media(path: Path) -> dict:
    """Retourne width/height/duration/has_audio (valeurs 0/False si illisible)."""
    info = {"width": 0, "height": 0, "duration": 0.0, "has_audio": False}
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height:format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return info
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return info
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video" and not info["width"]:
            info["width"] = int(stream.get("width") or 0)
            info["height"] = int(stream.get("height") or 0)
        elif stream.get("codec_type") == "audio":
            info["has_audio"] = True
    try:
        info["duration"] = float(data.get("format", {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        pass
    return info


def blur_segment(
    raw_path: Path,
    output_path: Path,
    scale: str = "640x360",
    replacewith: str = "blur",
) -> dict:
    """Floute un segment brut (n'importe quel codec) -> MP4 H.264 + AAC.

    Retourne les infos ffprobe du segment brut.
    """
    info = probe_media(raw_path)
    if not info["width"] or not info["height"]:
        raise RuntimeError(f"segment illisible : {raw_path}")

    video_only = output_path.with_suffix(".video.mp4")
    normalized = output_path.with_suffix(".cfr.mp4")
    try:
        normalize_to_cfr(raw_path, normalized)
        run_deface_on_file(
            normalized,
            video_only,
            scale=oriented_scale(scale, info["width"], info["height"]),
            replacewith=replacewith,
        )
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_only)]
        if info["has_audio"]:
            cmd += ["-i", str(raw_path), "-map", "0:v:0", "-map", "1:a:0"]
            cmd += ["-c:a", "aac", "-b:a", "96k"]
        cmd += ["-c:v", "copy", "-avoid_negative_ts", "make_zero"]
        cmd += ["-movflags", "+faststart", str(output_path)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"assemblage audio/vidéo : {proc.stderr.strip()}")
    finally:
        video_only.unlink(missing_ok=True)
        normalized.unlink(missing_ok=True)
    return info


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
