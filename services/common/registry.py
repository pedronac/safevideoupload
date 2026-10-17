"""Registre des sessions de capture (SQLite) et logique d'ingestion des parties.

Partagé par l'API d'upload, le processeur de floutage et l'admin (même volume /storage).

Modèle : une *session* = un enregistrement MediaRecorder continu côté téléphone, découpé en
*parties* indexées (0, 1, 2…). Le serveur recolle les parties dans l'ordre (concaténation
d'octets) dans `raw/<session>/stream.<ext>` ; le processeur découpe ensuite ce flux en
segments d'~60 s qu'il floute.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

SESSION_ID_RE = re.compile(r"^[a-f0-9]{32}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
MAX_PART_INDEX = 200_000


def storage_dir() -> Path:
    return Path(os.environ.get("STORAGE_DIR", "/storage"))


class RegistryError(Exception):
    """Erreur métier mappée en code HTTP par l'API."""

    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(message or code)
        self.status = status
        self.code = code
        self.message = message or code


SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  grp TEXT NOT NULL,
  created_at REAL NOT NULL,
  started_at_ms INTEGER NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  device TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  total_parts INTEGER,
  next_part INTEGER NOT NULL DEFAULT 0,
  stream_bytes INTEGER NOT NULL DEFAULT 0,
  last_part_at REAL,
  seg_state TEXT NOT NULL DEFAULT 'pending',
  assembled INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS parts (
  session TEXT NOT NULL,
  idx INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  received_at REAL NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (session, idx)
);
CREATE TABLE IF NOT EXISTS segments (
  session TEXT NOT NULL,
  idx INTEGER NOT NULL,
  start_s REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  raw_path TEXT NOT NULL DEFAULT '',
  out_path TEXT NOT NULL DEFAULT '',
  out_size INTEGER NOT NULL DEFAULT 0,
  blur_seconds REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  PRIMARY KEY (session, idx)
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def sniff_extension(head: bytes) -> str | None:
    """Reconnaît le conteneur à partir des premiers octets de la partie 0."""
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if head[4:8] == b"ftyp":
        return "mp4"
    return None


class Registry:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root else storage_dir()
        self.raw = self.root / "raw"
        self.blurred = self.root / "blurred"
        self.work = self.root / "work"
        self.state = self.root / "state"
        self.db_path = self.state / "registry.db"
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # ------------------------------------------------------------------ infrastructure

    def init(self) -> None:
        for d in (self.raw, self.blurred, self.work, self.state):
            d.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self):
        # Plusieurs conteneurs partagent le fichier : journal classique + attente de verrou.
        c = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout=30000")
        try:
            yield c
        finally:
            c.close()

    def _lock(self, session: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(session, threading.Lock())

    def session_raw_dir(self, session: str) -> Path:
        return self.raw / session

    def stream_path(self, session: str, ext: str) -> Path:
        return self.raw / session / f"stream.{ext}"

    # ------------------------------------------------------------------ sessions

    def get_session(self, session: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
        return dict(row) if row else None

    def create_session(
        self,
        session: str,
        *,
        started_at_ms: int,
        mime: str = "",
        width: int = 0,
        height: int = 0,
        device: str = "",
        group: str | None = None,
    ) -> dict:
        if not SESSION_ID_RE.match(session):
            raise RegistryError(400, "bad_session_id", "identifiant de session invalide")
        if group is not None and not SESSION_ID_RE.match(group):
            raise RegistryError(400, "bad_group_id", "identifiant de série invalide")
        started_at_ms = int(started_at_ms)
        now_ms = int(time.time() * 1000)
        if not (1_500_000_000_000 < started_at_ms < now_ms + 86_400_000):
            started_at_ms = now_ms
        with self._lock(session), self.conn() as c:
            c.execute(
                "INSERT OR IGNORE INTO sessions (id, grp, created_at, started_at_ms, mime, width, height, device)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (session, group or session, time.time(), started_at_ms, mime[:120], int(width), int(height), device[:200]),
            )
        self.session_raw_dir(session).mkdir(parents=True, exist_ok=True)
        return self.get_session(session)  # type: ignore[return-value]

    def session_status(self, session: str) -> dict:
        s = self.get_session(session)
        if not s:
            raise RegistryError(404, "unknown_session", "session inconnue")
        with self.conn() as c:
            pending = [
                r["idx"]
                for r in c.execute(
                    "SELECT idx FROM parts WHERE session=? AND state='pending' ORDER BY idx", (session,)
                )
            ]
        return {
            "session": session,
            "status": s["status"],
            "next_part": s["next_part"],
            "pending_parts": pending,
            "total_parts": s["total_parts"],
            "stream_bytes": s["stream_bytes"],
        }

    def close_session(self, session: str, total_parts: int) -> dict:
        with self._lock(session), self.conn() as c:
            s = c.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
            if not s:
                raise RegistryError(404, "unknown_session", "session inconnue")
            highest = c.execute("SELECT MAX(idx) AS m FROM parts WHERE session=?", (session,)).fetchone()["m"]
            if total_parts < 0 or (highest is not None and total_parts <= highest):
                raise RegistryError(409, "bad_total", "total_parts incohérent avec les parties reçues")
            if s["status"] == "closed" and s["total_parts"] != total_parts:
                raise RegistryError(409, "already_closed", "session déjà fermée avec un autre total")
            c.execute(
                "UPDATE sessions SET status='closed', total_parts=? WHERE id=?",
                (total_parts, session),
            )
        self._maybe_merge_gps(session)
        return self.session_status(session)

    def finalize_session(self, session: str) -> dict:
        """Ferme de force une session (admin / inactivité) : total = parties déjà recollées."""
        s = self.get_session(session)
        if not s:
            raise RegistryError(404, "unknown_session", "session inconnue")
        if s["status"] == "closed":
            return self.session_status(session)
        with self._lock(session), self.conn() as c:
            c.execute(
                "UPDATE sessions SET status='closed', total_parts=next_part WHERE id=? AND status='open'",
                (session,),
            )
        self._maybe_merge_gps(session)
        return self.session_status(session)

    def autoclose_idle(self, idle_seconds: float) -> list[str]:
        cutoff = time.time() - idle_seconds
        with self.conn() as c:
            ids = [
                r["id"]
                for r in c.execute(
                    "SELECT id FROM sessions WHERE status='open' AND COALESCE(last_part_at, created_at) < ?",
                    (cutoff,),
                )
            ]
        for sid in ids:
            self.finalize_session(sid)
        return ids

    # ------------------------------------------------------------------ parties

    def pending_path(self, session: str, idx: int) -> Path:
        return self.raw / session / "pending" / f"{idx:06d}.part"

    def incoming_dir(self, session: str) -> Path:
        return self.raw / session / "incoming"

    def ingest_part(self, session: str, idx: int, tmp_path: Path, size: int, sha256: str) -> dict:
        """Enregistre une partie déjà écrite sur disque et vérifiée (taille + sha256).

        Idempotent : renvoyer la même partie (même sha256/taille) répond OK sans rien refaire.
        Les parties arrivées hors ordre attendent dans `pending/`, puis sont recollées dans
        l'ordre dès que la précédente est là.
        """
        if not (0 <= idx < MAX_PART_INDEX):
            raise RegistryError(400, "bad_index", "index de partie invalide")
        with self._lock(session):
            with self.conn() as c:
                s = c.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
                if not s:
                    raise RegistryError(404, "unknown_session", "session inconnue")
                existing = c.execute(
                    "SELECT size, sha256 FROM parts WHERE session=? AND idx=?", (session, idx)
                ).fetchone()
                if existing:
                    if existing["sha256"] == sha256 and existing["size"] == size:
                        tmp_path.unlink(missing_ok=True)
                        return {"duplicate": True, **self._ack(c, session)}
                    tmp_path.unlink(missing_ok=True)
                    raise RegistryError(409, "part_conflict", "cette partie existe déjà avec un contenu différent")
                if s["status"] == "closed" and (s["total_parts"] is None or idx >= s["total_parts"]):
                    tmp_path.unlink(missing_ok=True)
                    raise RegistryError(409, "session_closed", "session fermée")
                dest = self.pending_path(session, idx)
                dest.parent.mkdir(parents=True, exist_ok=True)
                os.replace(tmp_path, dest)
                c.execute(
                    "INSERT INTO parts (session, idx, size, sha256, received_at, state) VALUES (?,?,?,?,?, 'pending')",
                    (session, idx, size, sha256, time.time()),
                )
                c.execute("UPDATE sessions SET last_part_at=? WHERE id=?", (time.time(), session))
            self._drain(session)
            with self.conn() as c:
                return {"duplicate": False, **self._ack(c, session)}

    def _ack(self, c: sqlite3.Connection, session: str) -> dict:
        s = c.execute("SELECT next_part, status, total_parts FROM sessions WHERE id=?", (session,)).fetchone()
        return {"next_part": s["next_part"], "status": s["status"], "total_parts": s["total_parts"]}

    def _drain(self, session: str) -> None:
        """Recolle dans stream.<ext> toutes les parties contiguës disponibles (verrou session tenu)."""
        while True:
            with self.conn() as c:
                s = c.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
                part = c.execute(
                    "SELECT * FROM parts WHERE session=? AND idx=? AND state='pending'",
                    (session, s["next_part"]),
                ).fetchone()
            if not part:
                return
            src = self.pending_path(session, part["idx"])
            ext = s["ext"]
            if not ext:
                with open(src, "rb") as fh:
                    head = fh.read(16)
                ext = sniff_extension(head)
                if not ext:
                    ext = "webm" if "webm" in (s["mime"] or "") else "mp4"
            stream = self.stream_path(session, ext)
            stream.parent.mkdir(parents=True, exist_ok=True)
            # On repart toujours de la taille enregistrée : une écriture interrompue par un
            # crash est tronquée, puis rejouée (reprise sans doublon).
            mode = "r+b" if stream.exists() else "wb"
            with open(stream, mode) as out:
                out.truncate(s["stream_bytes"])
                out.seek(s["stream_bytes"])
                with open(src, "rb") as inp:
                    shutil.copyfileobj(inp, out, 1024 * 1024)
                out.flush()
                os.fsync(out.fileno())
            with self.conn() as c:
                c.execute("BEGIN IMMEDIATE")
                c.execute(
                    "UPDATE sessions SET ext=?, next_part=next_part+1, stream_bytes=stream_bytes+?,"
                    " last_part_at=? WHERE id=?",
                    (ext, part["size"], time.time(), session),
                )
                c.execute("UPDATE parts SET state='appended' WHERE session=? AND idx=?", (session, part["idx"]))
                c.execute("COMMIT")
            src.unlink(missing_ok=True)

    # ------------------------------------------------------------------ GPS

    def save_gps(self, session: str, idx: int, samples: list) -> None:
        if not self.get_session(session):
            raise RegistryError(404, "unknown_session", "session inconnue")
        if not (0 <= idx < MAX_PART_INDEX):
            raise RegistryError(400, "bad_index", "index invalide")
        d = self.raw / session / "gps"
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f".{idx:06d}.tmp"
        tmp.write_text(json.dumps(samples, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, d / f"{idx:06d}.json")

    def merge_gps(self, session: str) -> Path | None:
        d = self.raw / session / "gps"
        if not d.is_dir():
            return None
        samples: list = []
        for f in sorted(d.glob("[0-9]*.json")):
            try:
                samples.extend(json.loads(f.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        samples.sort(key=lambda s: s.get("t", 0))
        s = self.get_session(session) or {}
        out = self.raw / session / "gps.json"
        tmp = out.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"session": session, "started_at_ms": s.get("started_at_ms"), "samples": samples}),
            encoding="utf-8",
        )
        os.replace(tmp, out)
        return out

    def _maybe_merge_gps(self, session: str) -> None:
        try:
            self.merge_gps(session)
        except OSError:
            pass

    # ------------------------------------------------------------------ segments (processeur)

    def upsert_segment(self, session: str, idx: int, start_s: float, duration: float, raw_path: str) -> None:
        now = time.time()
        with self.conn() as c:
            c.execute(
                "INSERT INTO segments (session, idx, start_s, duration, status, raw_path, created_at, updated_at)"
                " VALUES (?,?,?,?, 'cut', ?,?,?)"
                " ON CONFLICT(session, idx) DO UPDATE SET start_s=excluded.start_s, duration=excluded.duration,"
                " raw_path=excluded.raw_path, status=CASE WHEN segments.status='blurred' THEN 'blurred' ELSE 'cut' END,"
                " updated_at=excluded.updated_at",
                (session, idx, start_s, duration, raw_path, now, now),
            )

    def get_segment(self, session: str, idx: int) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM segments WHERE session=? AND idx=?", (session, idx)).fetchone()
        return dict(row) if row else None

    def reset_blurring(self) -> int:
        with self.conn() as c:
            return c.execute(
                "UPDATE segments SET status='cut', updated_at=? WHERE status='blurring'", (time.time(),)
            ).rowcount

    def claim_segment(self) -> dict | None:
        """Prend le plus ancien segment à flouter (ordre chronologique des sessions, puis index)."""
        with self.conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute(
                "SELECT g.* FROM segments g JOIN sessions s ON s.id=g.session WHERE g.status='cut'"
                " ORDER BY s.started_at_ms, g.session, g.idx LIMIT 1"
            ).fetchone()
            if row:
                c.execute(
                    "UPDATE segments SET status='blurring', attempts=attempts+1, updated_at=? WHERE session=? AND idx=?",
                    (time.time(), row["session"], row["idx"]),
                )
            c.execute("COMMIT")
        return dict(row) if row else None

    def finish_segment(self, session: str, idx: int, out_path: str, out_size: int, duration: float, blur_seconds: float) -> None:
        with self.conn() as c:
            c.execute(
                "UPDATE segments SET status='blurred', out_path=?, out_size=?, duration=?, blur_seconds=?, error='',"
                " updated_at=? WHERE session=? AND idx=?",
                (out_path, out_size, duration, blur_seconds, time.time(), session, idx),
            )

    def fail_segment(self, session: str, idx: int, error: str, max_attempts: int = 3) -> None:
        with self.conn() as c:
            row = c.execute("SELECT attempts FROM segments WHERE session=? AND idx=?", (session, idx)).fetchone()
            status = "failed" if row and row["attempts"] >= max_attempts else "cut"
            c.execute(
                "UPDATE segments SET status=?, error=?, updated_at=? WHERE session=? AND idx=?",
                (status, error[:500], time.time(), session, idx),
            )

    def retry_failed(self) -> int:
        with self.conn() as c:
            return c.execute(
                "UPDATE segments SET status='cut', attempts=0, error='', updated_at=? WHERE status='failed'",
                (time.time(),),
            ).rowcount

    def update_session(self, session: str, **fields) -> None:
        allowed = {"seg_state", "assembled", "last_error"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if not cols:
            return
        sets = ", ".join(f"{k}=?" for k in cols)
        with self.conn() as c:
            c.execute(f"UPDATE sessions SET {sets} WHERE id=?", (*cols.values(), session))

    def sessions_needing_segmenter(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM sessions WHERE seg_state!='done' AND stream_bytes>0 ORDER BY started_at_ms"
            ).fetchall()
        return [dict(r) for r in rows]

    def all_blurred(self, session: str) -> bool:
        with self.conn() as c:
            n = c.execute(
                "SELECT COUNT(*) AS n FROM segments WHERE session=? AND status!='blurred'", (session,)
            ).fetchone()["n"]
        return n == 0

    # ------------------------------------------------------------------ lecture (public / admin)

    def public_videos(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT g.session, g.idx, g.start_s, g.duration, g.out_path, g.out_size, s.started_at_ms"
                " FROM segments g JOIN sessions s ON s.id=g.session WHERE g.status='blurred'"
            ).fetchall()
        videos = []
        for r in rows:
            rel = Path(r["out_path"]).name
            videos.append(
                {
                    "id": f"{r['session']}-{r['idx']:05d}",
                    "start_ms": int(r["started_at_ms"] + r["start_s"] * 1000),
                    "duration": round(r["duration"], 2),
                    "size": r["out_size"],
                    "url": f"/media/{r['session']}/{rel}",
                }
            )
        videos.sort(key=lambda v: (v["start_ms"], v["id"]))
        return videos

    def counts(self) -> dict:
        with self.conn() as c:
            seg = {r["status"]: r["n"] for r in c.execute("SELECT status, COUNT(*) AS n FROM segments GROUP BY status")}
            ses = {r["status"]: r["n"] for r in c.execute("SELECT status, COUNT(*) AS n FROM sessions GROUP BY status")}
            part_pending = c.execute("SELECT COUNT(*) AS n FROM parts WHERE state='pending'").fetchone()["n"]
        return {"segments": seg, "sessions": ses, "parts_waiting": part_pending}

    def list_sessions(self) -> list[dict]:
        with self.conn() as c:
            sessions = [dict(r) for r in c.execute("SELECT * FROM sessions ORDER BY started_at_ms DESC")]
            segs = [dict(r) for r in c.execute("SELECT * FROM segments ORDER BY session, idx")]
        by_session: dict[str, list[dict]] = {}
        for g in segs:
            by_session.setdefault(g["session"], []).append(g)
        for s in sessions:
            s["segments"] = by_session.get(s["id"], [])
        return sessions

    def kv_get(self, key: str, default: str = "") -> str:
        with self.conn() as c:
            row = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def kv_set(self, key: str, value: str) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
