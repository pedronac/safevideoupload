#!/usr/bin/env python3
"""
Worker de floutage quasi temps réel pour safevideoupload.

Stratégie : enregistrer des segments courts depuis le flux RTSP `live`,
appliquer deface/CenterFace ONNX, puis :
  - archiver le segment flouté sous /storage/blurred/chunks/
  - republier en RTMP vers MediaMTX (chemin `blurred` → HLS public)
  - optionnel : push RTMP vers YouTube Live (YOUTUBE_RTMP_URL)

Latence typique : ~1× BLUR_CHUNK_SECONDS (+ traitement CPU). Réduire BLUR_PROCESS_SCALE
ou augmenter BLUR_CHUNK_SECONDS si le CPU sature (i5 4 cœurs, 720p30).
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from blur_utils import run_deface_on_file

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [blur] %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("blur_worker")

RTSP_URL = os.environ.get("MEDIAMTX_RTSP_URL", "rtsp://mediamtx:8554/live")
RTMP_MTX = os.environ.get("MEDIAMTX_RTMP_URL", "rtmp://mediamtx:1935/blurred")
YOUTUBE_RTMP = os.environ.get("YOUTUBE_RTMP_URL", "").strip()
CHUNK_SECONDS = int(os.environ.get("BLUR_CHUNK_SECONDS", "30"))
SCALE = os.environ.get("BLUR_PROCESS_SCALE", "640x360")
BLURRED_DIR = Path(os.environ.get("BLURRED_DIR", "/storage/blurred/chunks"))
WORK_DIR = Path("/tmp/blur_work")


def wait_for_rtsp(url: str, timeout_s: float = 300.0) -> bool:
    """Attend que ffprobe puisse lire le flux RTSP."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-rtsp_transport",
                "tcp",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                url,
            ],
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            log.info("Flux RTSP disponible : %s", url)
            return True
        time.sleep(3)
    return False


def record_chunk(rtsp_url: str, raw_out: Path, duration: int) -> None:
    raw_out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "warning",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtsp_url,
        "-t",
        str(duration),
        "-c",
        "copy",
        "-f",
        "mp4",
        str(raw_out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg enregistrement : {proc.stderr}")


def push_rtmp(file_path: Path, destinations: list[str]) -> None:
    """Republie un segment en temps réel vers une ou plusieurs destinations RTMP."""
    for dest in destinations:
        cmd = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "warning",
            "-re",
            "-i",
            str(file_path),
            "-c",
            "copy",
            "-f",
            "flv",
            dest,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            log.warning("Push RTMP vers %s : %s", dest, proc.stderr.strip())


def main() -> None:
    BLURRED_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    log.info(
        "Démarrage (chunk=%ss, scale=%s, rtsp=%s)",
        CHUNK_SECONDS,
        SCALE,
        RTSP_URL,
    )

    if not wait_for_rtsp(RTSP_URL):
        log.error("Timeout : aucun flux sur %s", RTSP_URL)
        sys.exit(1)

    index = 0
    rtmp_dests = [RTMP_MTX]
    if YOUTUBE_RTMP:
        rtmp_dests.append(YOUTUBE_RTMP)
        log.info("Push YouTube activé")

    while True:
        index += 1
        ts = time.strftime("%Y%m%d_%H%M%S")
        raw_chunk = WORK_DIR / f"raw_{ts}.mp4"
        blurred_chunk = BLURRED_DIR / f"blurred_{ts}.mp4"

        try:
            record_chunk(RTSP_URL, raw_chunk, CHUNK_SECONDS)
            log.info("Segment brut %s enregistré", raw_chunk.name)
            run_deface_on_file(raw_chunk, blurred_chunk, scale=SCALE)
            log.info("Segment flouté : %s", blurred_chunk)
            push_rtmp(blurred_chunk, rtmp_dests)
        except Exception as exc:
            log.exception("Erreur segment %s : %s", index, exc)
            time.sleep(5)
            if not wait_for_rtsp(RTSP_URL, timeout_s=120):
                log.warning("Flux perdu, nouvelle attente...")
                wait_for_rtsp(RTSP_URL, timeout_s=600)
            continue
        finally:
            if raw_chunk.exists():
                raw_chunk.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
