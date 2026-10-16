#!/usr/bin/env python3
"""
Worker de floutage quasi temps réel pour safevideoupload.

Pipeline (3 étages en parallèle, aucun trou de capture) :

  1. segmenter : un seul ffmpeg lit RTSP `live` et écrit des segments bruts
     (copie, sans ré-encodage) de BLUR_CHUNK_SECONDS en Matroska (accepte VP8,
     VP9, H.264, Opus... contrairement au MP4).
  2. processor : deface floute chaque segment fini, remet l'audio en AAC et
     archive le MP4 dans BLURRED_DIR.
  3. pusher : relaie les segments floutés, en temps réel, vers des ffmpeg
     persistants (une connexion RTMP continue par destination) : MediaMTX
     `blurred` (-> HLS public) et, en option, YouTube.

Latence : environ 1x BLUR_CHUNK_SECONDS + temps de floutage. Si le floutage est
plus lent que le temps réel (CPU), le retard s'accumule : le worker le signale
dans les logs et saute les plus vieux segments pour le direct (l'archive
floutée et le brut MediaMTX restent complets).
"""

from __future__ import annotations

import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from blur_utils import blur_segment

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
WORK_DIR = Path(os.environ.get("BLUR_WORK_DIR", "/tmp/blur_work"))
MAX_PUSH_BACKLOG = int(os.environ.get("BLUR_MAX_PUSH_BACKLOG", "4"))
PUSH_IDLE_CLOSE_S = float(os.environ.get("BLUR_PUSH_IDLE_CLOSE_S", "20"))
MIN_SEGMENT_BYTES = 2048
# Marge entre segments : évite les DTS audio non monotones à la jonction.
CHUNK_GAP_S = 0.1

SEGMENT_GLOB = "seg_*.mkv"
STOP = threading.Event()


@dataclass
class PushItem:
    path: Path
    duration: float


def segment_pattern(run_id: str) -> str:
    return f"seg_{run_id}_%05d.mkv"


def list_segments(work_dir: Path, run_id: str) -> list[Path]:
    return sorted(work_dir.glob(f"seg_{run_id}_*.mkv"))


def completed_segments(segments: list[Path], process_exited: bool) -> list[Path]:
    """Un segment est fini quand le suivant existe (ou quand ffmpeg est terminé)."""
    if process_exited:
        return list(segments)
    return list(segments[:-1])


def rtsp_readable(url: str) -> bool:
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-rtsp_transport",
                "tcp",
                "-show_entries",
                "stream=codec_type,codec_name",
                "-of",
                "csv=p=0",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        return False
    return proc.returncode == 0 and proc.stdout.strip() != ""


def wait_for_rtsp(url: str) -> None:
    """Attend (indéfiniment) qu'un flux soit publié sur le chemin RTSP."""
    last_log = 0.0
    while not STOP.is_set():
        if rtsp_readable(url):
            log.info("Flux RTSP disponible : %s", url)
            return
        now = time.monotonic()
        if now - last_log > 60:
            log.info("En attente d'un direct sur %s ...", url)
            last_log = now
        STOP.wait(3)


def segmenter_loop(raw_queue: "queue.Queue[Path]") -> None:
    """Enregistre le flux RTSP en segments bruts, sans trou, avec reprise auto."""
    run_counter = 0
    while not STOP.is_set():
        wait_for_rtsp(RTSP_URL)
        if STOP.is_set():
            return
        run_counter += 1
        run_id = f"{time.strftime('%Y%m%d_%H%M%S')}_{run_counter}"
        cmd = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "warning",
            "-rtsp_transport",
            "tcp",
            "-timeout",
            "15000000",
            "-i",
            RTSP_URL,
            "-map",
            "0",
            "-c",
            "copy",
            "-f",
            "segment",
            "-segment_time",
            str(CHUNK_SECONDS),
            "-segment_format",
            "matroska",
            "-reset_timestamps",
            "1",
            str(WORK_DIR / segment_pattern(run_id)),
        ]
        log.info("Enregistrement des segments (%ss) -> %s", CHUNK_SECONDS, WORK_DIR)
        proc = subprocess.Popen(cmd)
        handed: set[Path] = set()
        while True:
            exited = proc.poll() is not None
            for seg in completed_segments(list_segments(WORK_DIR, run_id), exited):
                if seg in handed:
                    continue
                handed.add(seg)
                if seg.stat().st_size < MIN_SEGMENT_BYTES:
                    seg.unlink(missing_ok=True)
                    continue
                raw_queue.put(seg)
            if exited:
                break
            if STOP.wait(0.5):
                proc.terminate()
                return
        log.warning("ffmpeg segmenter terminé (code %s) : flux coupé ?", proc.returncode)
        STOP.wait(2)


def processor_loop(raw_queue: "queue.Queue[Path]", push_queue: "queue.Queue[PushItem]") -> None:
    index = 0
    while not STOP.is_set():
        try:
            raw = raw_queue.get(timeout=1)
        except queue.Empty:
            continue
        index += 1
        blurred = BLURRED_DIR / f"blurred_{time.strftime('%Y%m%d_%H%M%S')}_{index:05d}.mp4"
        started = time.monotonic()
        try:
            info = blur_segment(raw, blurred, scale=SCALE)
            elapsed = time.monotonic() - started
            duration = info["duration"] or float(CHUNK_SECONDS)
            ratio = elapsed / duration if duration else 0.0
            log.info(
                "Segment flouté %s (%dx%d, %.1fs de vidéo en %.1fs, x%.2f temps réel, audio=%s)",
                blurred.name,
                info["width"],
                info["height"],
                duration,
                elapsed,
                ratio,
                info["has_audio"],
            )
            if ratio > 1.0:
                log.warning(
                    "Floutage plus lent que le temps réel (x%.2f) : réduire BLUR_PROCESS_SCALE "
                    "ou prévoir plus de CPU, sinon le retard s'accumule.",
                    ratio,
                )
            push_queue.put(PushItem(blurred, duration))
        except Exception as exc:  # noqa: BLE001 - le worker doit survivre à un segment défaillant
            log.error("Erreur floutage %s : %s", raw.name, exc)
        finally:
            raw.unlink(missing_ok=True)


class Pusher:
    """ffmpeg persistant : MPEG-TS sur stdin -> RTMP (une connexion continue)."""

    def __init__(self, name: str, url: str) -> None:
        self.name = name
        self.url = url
        self.proc: subprocess.Popen | None = None

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        cmd = [
            "ffmpeg",
            "-loglevel",
            "warning",
            "-probesize",
            "1000000",
            "-analyzeduration",
            "2000000",
            "-f",
            "mpegts",
            "-i",
            "pipe:0",
            "-c",
            "copy",
            "-f",
            "flv",
            self.url,
        ]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        log.info("Push RTMP démarré -> %s", self.name)

    def write(self, data: bytes) -> bool:
        if not self.alive():
            return False
        try:
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError, ValueError):
            return False

    def stop(self) -> None:
        if self.proc is None:
            return
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc = None
        log.info("Push RTMP arrêté -> %s", self.name)


def stream_chunk(item: PushItem, ts_offset: float, pushers: list[Pusher]) -> None:
    """Relaie un segment en temps réel (-re) vers tous les pushers vivants."""
    cmd = [
        "ffmpeg",
        "-loglevel",
        "error",
        "-re",
        "-i",
        str(item.path),
        "-c",
        "copy",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-output_ts_offset",
        f"{ts_offset:.3f}",
        "-f",
        "mpegts",
        "pipe:1",
    ]
    prod = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    assert prod.stdout
    try:
        while True:
            data = prod.stdout.read(65536)
            if not data:
                break
            for pusher in pushers:
                if not pusher.write(data):
                    log.warning("Push %s interrompu (ffmpeg arrêté)", pusher.name)
    finally:
        prod.stdout.close()
        prod.wait()


def pusher_loop(push_queue: "queue.Queue[PushItem]") -> None:
    pushers = [Pusher("mediamtx", RTMP_MTX)]
    if YOUTUBE_RTMP:
        pushers.append(Pusher("youtube", YOUTUBE_RTMP))
        log.info("Push YouTube activé")

    ts_offset = 0.0
    last_end = time.monotonic()
    connected = False
    while not STOP.is_set():
        try:
            item = push_queue.get(timeout=1)
        except queue.Empty:
            # Plus de segment : on ferme les connexions RTMP pour que `blurred`
            # repasse hors ligne (le viewer affiche alors "En attente du direct").
            if connected and time.monotonic() - last_end > PUSH_IDLE_CLOSE_S:
                for pusher in pushers:
                    pusher.stop()
                connected = False
                ts_offset = 0.0
            continue

        while push_queue.qsize() >= MAX_PUSH_BACKLOG:
            try:
                skipped = push_queue.get_nowait()
            except queue.Empty:
                break
            log.warning("Retard direct : segment %s sauté pour le push", skipped.path.name)

        for pusher in pushers:
            if not pusher.alive():
                pusher.stop()
                pusher.start()
        connected = True

        stream_chunk(item, ts_offset, pushers)
        ts_offset += item.duration + CHUNK_GAP_S
        last_end = time.monotonic()

    for pusher in pushers:
        pusher.stop()


def main() -> None:
    BLURRED_DIR.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(WORK_DIR, ignore_errors=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    log.info(
        "Démarrage (chunk=%ss, scale=%s, rtsp=%s, rtmp=%s, youtube=%s)",
        CHUNK_SECONDS,
        SCALE,
        RTSP_URL,
        RTMP_MTX,
        "oui" if YOUTUBE_RTMP else "non",
    )

    raw_queue: "queue.Queue[Path]" = queue.Queue()
    push_queue: "queue.Queue[PushItem]" = queue.Queue()
    threads = [
        threading.Thread(target=segmenter_loop, args=(raw_queue,), name="segmenter", daemon=True),
        threading.Thread(
            target=processor_loop, args=(raw_queue, push_queue), name="processor", daemon=True
        ),
        threading.Thread(target=pusher_loop, args=(push_queue,), name="pusher", daemon=True),
    ]
    for t in threads:
        t.start()

    try:
        while all(t.is_alive() for t in threads):
            time.sleep(1)
        log.error("Un thread s'est arrêté : sortie pour redémarrage par Docker")
        sys.exit(1)
    except KeyboardInterrupt:
        STOP.set()


if __name__ == "__main__":
    main()
