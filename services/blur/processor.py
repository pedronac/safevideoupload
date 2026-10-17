#!/usr/bin/env python3
"""Processeur hors-ligne safevideoupload : découpe les flux bruts puis floute chaque segment.

  1. Segmenteur (un ffmpeg par session active) : lit `raw/<session>/stream.<ext>` au fur et à
     mesure que les parties arrivent (copie des paquets, aucune image perdue) et la découpe en
     segments MKV d'~SEGMENT_SECONDS, coupés sur image clé.
  2. Floutage : BLUR_PROCESSOR_WORKERS threads prennent les segments dans l'ordre chronologique,
     appliquent deface et écrivent `blurred/<session>/seg_NNNNN.mp4` (H.264 + AAC, faststart).
  3. Quand une session est fermée et entièrement floutée, assemblage optionnel `session.mp4`.

Reprise après redémarrage : l'état est dans SQLite. Le segmenteur relit le flux brut depuis le
début (copie, rapide) et ignore les segments déjà floutés ; un segment « en cours » repasse à
l'état « à flouter ». Le traitement n'est pas contraint par le temps réel : on journalise
le rapport durée-vidéo / durée-calcul et la file d'attente.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))

from blur_utils import blur_segment, concat_copy, configure_inference_threads, probe_media  # noqa: E402
from registry import Registry  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [blur] %(levelname)s %(message)s", stream=sys.stdout)
log = logging.getLogger("processor")

SEGMENT_SECONDS = int(os.environ.get("SEGMENT_SECONDS", "60"))
SCALE = os.environ.get("BLUR_PROCESS_SCALE", "480x270")
WORKERS = max(1, int(os.environ.get("BLUR_PROCESSOR_WORKERS", "2")))
ASSEMBLE = os.environ.get("BLUR_ASSEMBLE_SESSION", "true").strip().lower() in ("1", "true", "yes", "on")
AUTOCLOSE_S = float(os.environ.get("SESSION_AUTOCLOSE_S", "21600"))
SEGMENTER_RETRY_S = 20.0
FEED_CHUNK = 1024 * 1024

STOP = threading.Event()


def segment_command(gen_dir: Path, segment_seconds: int | None = None) -> list[str]:
    segment_seconds = segment_seconds or SEGMENT_SECONDS
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts+discardcorrupt",
        "-i", "pipe:0",
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c", "copy",
        "-f", "segment", "-segment_time", str(segment_seconds), "-segment_format", "matroska",
        "-reset_timestamps", "1",
        "-segment_list", str(gen_dir / "list.csv"), "-segment_list_type", "csv",
        str(gen_dir / "seg_%05d.mkv"),
    ]


def parse_segment_list(text: str) -> list[tuple[int, float, float]]:
    """Lignes `seg_00003.mkv,start,end` -> (index, début, fin). Ignore la dernière ligne incomplète."""
    out = []
    for line in text.split("\n")[:-1]:
        parts = line.strip().split(",")
        if len(parts) != 3 or not parts[0].startswith("seg_"):
            continue
        try:
            out.append((int(parts[0][4:9]), float(parts[1]), float(parts[2])))
        except ValueError:
            continue
    return out


class Segmenter(threading.Thread):
    """Alimente un ffmpeg de découpe avec le flux brut d'une session, jusqu'à sa clôture."""

    def __init__(self, reg: Registry, session: str):
        super().__init__(name=f"seg-{session[:8]}", daemon=True)
        self.reg = reg
        self.session = session
        self.finished = False
        self.failed_at = 0.0
        self._harvested = 0
        self._origin: float | None = None

    def run(self) -> None:
        try:
            self._run()
        except Exception as err:  # noqa: BLE001
            log.exception("segmenteur %s", self.session[:8])
            self.reg.update_session(self.session, last_error=f"segmenteur : {err}"[:300])
            self.failed_at = time.monotonic()
        finally:
            self.finished = True

    def _stream_file(self) -> Path | None:
        s = self.reg.get_session(self.session)
        if not s or not s["ext"]:
            return None
        p = self.reg.stream_path(self.session, s["ext"])
        return p if p.exists() else None

    def _run(self) -> None:
        sid = self.session
        session_work = self.reg.work / sid
        gen_dir = session_work / f"gen-{int(time.time())}"
        gen_dir.mkdir(parents=True, exist_ok=True)
        stream = self._stream_file()
        if stream is None:
            return
        log.info("segmentation de %s démarrée", sid[:8])
        proc = subprocess.Popen(
            segment_command(gen_dir), stdin=subprocess.PIPE, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL
        )
        stderr_lines: list[bytes] = []
        threading.Thread(target=lambda: stderr_lines.extend(proc.stderr), daemon=True).start()  # type: ignore[arg-type]
        fed = 0
        last_harvest = 0.0
        completed = False
        try:
            with open(stream, "rb") as fh:
                while not STOP.is_set():
                    s = self.reg.get_session(sid)
                    if s is None:
                        return
                    available = s["stream_bytes"]
                    if fed < available:
                        fh.seek(fed)
                        data = fh.read(min(FEED_CHUNK, available - fed))
                        if not data:
                            time.sleep(0.2)
                            continue
                        try:
                            proc.stdin.write(data)  # type: ignore[union-attr]
                            proc.stdin.flush()  # type: ignore[union-attr]
                        except (BrokenPipeError, OSError):
                            break
                        fed += len(data)
                        if time.monotonic() - last_harvest > 2:
                            self._harvest(gen_dir)
                            last_harvest = time.monotonic()
                        continue
                    if s["status"] == "closed" and s["next_part"] == s["total_parts"]:
                        completed = True
                        break
                    self._harvest(gen_dir)
                    last_harvest = time.monotonic()
                    STOP.wait(1.0)
        finally:
            try:
                proc.stdin.close()  # type: ignore[union-attr]
            except OSError:
                pass
        if not completed:
            proc.terminate()
            proc.wait()
            return
        rc = proc.wait()
        self._harvest(gen_dir)
        if rc != 0:
            msg = b"".join(stderr_lines).decode("utf-8", "replace").strip()[-300:]
            raise RuntimeError(f"ffmpeg code {rc} : {msg}")
        self.reg.update_session(sid, seg_state="done", last_error="")
        shutil.rmtree(gen_dir, ignore_errors=True)
        log.info("segmentation de %s terminée (%d segments)", sid[:8], self._harvested)

    def _harvest(self, gen_dir: Path) -> None:
        listing = gen_dir / "list.csv"
        if not listing.exists():
            return
        entries = parse_segment_list(listing.read_text(encoding="utf-8", errors="replace"))
        for idx, start, end in entries:
            if self._origin is None:
                self._origin = start
            gen_file = gen_dir / f"seg_{idx:05d}.mkv"
            if not gen_file.exists():
                continue
            existing = self.reg.get_segment(self.session, idx)
            final = self.reg.work / self.session / f"seg_{idx:05d}.mkv"
            keep_existing = existing is not None and (
                existing["status"] == "blurred" or Path(existing["raw_path"]).exists()
            )
            if keep_existing:
                gen_file.unlink(missing_ok=True)
            else:
                os.replace(gen_file, final)
                self.reg.upsert_segment(self.session, idx, max(0.0, start - self._origin), max(0.0, end - start), str(final))
                log.info("segment %s #%d prêt (%.1f s)", self.session[:8], idx, end - start)
            self._harvested = max(self._harvested, idx + 1)


class Processor:
    def __init__(self, reg: Registry):
        self.reg = reg
        self.segmenters: dict[str, Segmenter] = {}
        self.busy = 0
        self.busy_lock = threading.Lock()
        self.ratio_ema: float | None = None
        self.last_ratio: float | None = None
        self.done_count = 0

    # ---------------------------------------------------------------- floutage

    def blur_loop(self, worker_id: int) -> None:
        while not STOP.is_set():
            row = self.reg.claim_segment()
            if not row:
                STOP.wait(1.0)
                continue
            with self.busy_lock:
                self.busy += 1
            try:
                self.blur_one(row, worker_id)
            finally:
                with self.busy_lock:
                    self.busy -= 1

    def blur_one(self, row: dict, worker_id: int) -> None:
        sid, idx = row["session"], row["idx"]
        raw = Path(row["raw_path"])
        out_dir = self.reg.blurred / sid
        out_dir.mkdir(parents=True, exist_ok=True)
        final = out_dir / f"seg_{idx:05d}.mp4"
        tmp = self.reg.work / sid / f"blur-{idx:05d}.mp4"
        t0 = time.monotonic()
        try:
            if not raw.exists():
                raise RuntimeError("segment brut introuvable")
            blur_segment(raw, tmp, scale=SCALE)
            info = probe_media(tmp)
            os.replace(tmp, final)
        except Exception as err:  # noqa: BLE001
            log.error("floutage %s #%d échoué : %s", sid[:8], idx, err)
            tmp.unlink(missing_ok=True)
            self.reg.fail_segment(sid, idx, str(err))
            return
        elapsed = time.monotonic() - t0
        duration = info["duration"] or row["duration"]
        self.reg.finish_segment(sid, idx, str(final), final.stat().st_size, duration, elapsed)
        raw.unlink(missing_ok=True)
        ratio = duration / elapsed if elapsed > 0 else 0.0
        self.last_ratio = ratio
        self.ratio_ema = ratio if self.ratio_ema is None else 0.7 * self.ratio_ema + 0.3 * ratio
        self.done_count += 1
        log.info(
            "segment %s #%d flouté : %.1f s de vidéo en %.1f s (x%.2f temps réel, worker %d) — file : %d",
            sid[:8], idx, duration, elapsed, ratio, worker_id, self.backlog(),
        )

    def backlog(self) -> int:
        seg = self.reg.counts()["segments"]
        return seg.get("cut", 0) + seg.get("blurring", 0)

    # ---------------------------------------------------------------- supervision

    def scan(self) -> None:
        for sid, seg in list(self.segmenters.items()):
            if seg.finished and not seg.is_alive():
                s = self.reg.get_session(sid)
                retry_ok = time.monotonic() - seg.failed_at > SEGMENTER_RETRY_S
                if s and s["seg_state"] == "done":
                    del self.segmenters[sid]
                elif seg.failed_at and retry_ok:
                    del self.segmenters[sid]
                elif not seg.failed_at:
                    del self.segmenters[sid]
        for s in self.reg.sessions_needing_segmenter():
            if s["id"] not in self.segmenters:
                seg = Segmenter(self.reg, s["id"])
                self.segmenters[s["id"]] = seg
                seg.start()
        if ASSEMBLE:
            self.assemble_finished()

    def assemble_finished(self) -> None:
        with self.reg.conn() as c:
            rows = [
                dict(r)
                for r in c.execute("SELECT * FROM sessions WHERE seg_state='done' AND assembled=0")
            ]
        for s in rows:
            sid = s["id"]
            if not self.reg.all_blurred(sid):
                continue
            with self.reg.conn() as c:
                segs = [
                    Path(r["out_path"])
                    for r in c.execute(
                        "SELECT out_path FROM segments WHERE session=? AND status='blurred' ORDER BY idx", (sid,)
                    )
                ]
            if not segs:
                self.reg.update_session(sid, assembled=1)
                continue
            out = self.reg.blurred / sid / "session.mp4"
            tmp = self.reg.work / sid / "session.assembling.mp4"
            try:
                concat_copy(segs, tmp)
                os.replace(tmp, out)
                self.reg.update_session(sid, assembled=1)
                log.info("session %s assemblée : %s", sid[:8], out)
            except Exception as err:  # noqa: BLE001
                tmp.unlink(missing_ok=True)
                log.error("assemblage %s : %s", sid[:8], err)
                self.reg.update_session(sid, assembled=1, last_error=f"assemblage : {err}"[:300])

    def heartbeat(self) -> None:
        counts = self.reg.counts()
        seg = counts["segments"]
        self.reg.kv_set(
            "processor",
            json.dumps(
                {
                    "ts": time.time(),
                    "workers": WORKERS,
                    "busy": self.busy,
                    "scale": SCALE,
                    "last_ratio": self.last_ratio,
                    "avg_ratio": self.ratio_ema,
                    "segments_done_since_start": self.done_count,
                    "backlog": seg.get("cut", 0) + seg.get("blurring", 0),
                    "failed": seg.get("failed", 0),
                }
            ),
        )

    def run(self) -> None:
        applied = configure_inference_threads()
        log.info(
            "démarrage : %d worker(s), échelle d'inférence %s, segments %d s, threads %s",
            WORKERS, SCALE, SEGMENT_SECONDS, applied or "défaut",
        )
        reset = self.reg.reset_blurring()
        if reset:
            log.info("%d segment(s) interrompu(s) remis en file", reset)
        for i in range(WORKERS):
            threading.Thread(target=self.blur_loop, args=(i + 1,), name=f"blur-{i + 1}", daemon=True).start()
        last_backlog_log = 0.0
        last_autoclose = 0.0
        while not STOP.is_set():
            try:
                self.scan()
                self.heartbeat()
                now = time.monotonic()
                if now - last_autoclose > 60:
                    last_autoclose = now
                    closed = self.reg.autoclose_idle(AUTOCLOSE_S)
                    if closed:
                        log.warning("sessions inactives fermées automatiquement : %s", [c[:8] for c in closed])
                if now - last_backlog_log > 30:
                    last_backlog_log = now
                    b = self.backlog()
                    if b:
                        log.info("file d'attente : %d segment(s) à flouter (%d worker(s) occupé(s))", b, self.busy)
            except Exception:  # noqa: BLE001
                log.exception("boucle de supervision")
            STOP.wait(2.0)


def main() -> None:
    reg = Registry()
    reg.init()
    Processor(reg).run()


if __name__ == "__main__":
    main()
