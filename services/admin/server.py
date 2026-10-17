#!/usr/bin/env python3
"""API d'administration safevideoupload (stdlib HTTP)."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))

from registry import Registry, RegistryError  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [admin] %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("admin")

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
PROJECT_DIR = Path(os.environ.get("PROJECT_DIR", "/project"))
ENV_FILE = Path(os.environ.get("ENV_FILE", str(PROJECT_DIR / ".env")))
COMPOSE_FILE = Path(os.environ.get("COMPOSE_FILE", str(PROJECT_DIR / "docker-compose.yml")))
STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", "/storage"))
STORAGE_RAW = Path(os.environ.get("STORAGE_RAW", str(STORAGE_DIR / "raw")))
STORAGE_BLURRED = Path(os.environ.get("STORAGE_BLURRED", str(STORAGE_DIR / "blurred")))
DISK_WARN_FREE_PERCENT = float(os.environ.get("DISK_WARN_FREE_PERCENT", "15"))
DOWNLOAD_LINK_TTL_S = 900
MIN_CAPTURE_TOKEN_LEN = 16
MAX_CAPTURE_TOKEN_LEN = 256
CAPTURE_TOKEN_RE = re.compile(r"^[\x20-\x7e]+$")

BUCKETS = {
    "raw": STORAGE_RAW,
    "blurred": STORAGE_BLURRED,
}


def authorized(header: str | None) -> bool:
    if not ADMIN_TOKEN:
        return False
    if not header or not header.startswith("Bearer "):
        return False
    return header[7:].strip() == ADMIN_TOKEN


def list_recordings() -> list[dict]:
    items: list[dict] = []
    for bucket, root in BUCKETS.items():
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            try:
                rel = path.relative_to(root).as_posix()
            except ValueError:
                continue
            stat = path.stat()
            items.append(
                {
                    "bucket": bucket,
                    "path": rel,
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                    "download": f"/storage-download/{bucket}/{rel}",
                }
            )
    items.sort(key=lambda x: (x["bucket"], -x["mtime"], x["path"]))
    return items


def registry() -> Registry:
    return Registry(STORAGE_DIR)


def dir_size(root: Path) -> int:
    total = 0
    if not root.is_dir():
        return 0
    for base, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


_usage_cache: dict = {"at": 0.0, "value": None}


def storage_status() -> dict:
    """Espace disque (partition de /storage) et volumes raw/blurred ; alerte sous le seuil libre."""
    target = STORAGE_DIR if STORAGE_DIR.exists() else Path("/")
    usage = shutil.disk_usage(target)
    free_percent = usage.free / usage.total * 100 if usage.total else 0.0
    if time.time() - _usage_cache["at"] > 30:
        _usage_cache["value"] = {"raw": dir_size(STORAGE_RAW), "blurred": dir_size(STORAGE_BLURRED)}
        _usage_cache["at"] = time.time()
    return {
        "total": usage.total,
        "free": usage.free,
        "used": usage.used,
        "free_percent": round(free_percent, 1),
        "warn_percent": DISK_WARN_FREE_PERCENT,
        "low": free_percent < DISK_WARN_FREE_PERCENT,
        **_usage_cache["value"],
    }


def processor_status() -> dict:
    try:
        beat = json.loads(registry().kv_get("processor", "{}") or "{}")
    except (json.JSONDecodeError, OSError):
        beat = {}
    if beat:
        beat["age_s"] = round(time.time() - beat.get("ts", 0), 1)
        beat["alive"] = beat["age_s"] < 30
    return beat


def system_status() -> dict:
    reg = registry()
    counts = reg.counts()
    return {
        "disk": storage_status(),
        "processor": processor_status(),
        "queue": counts,
        "now": int(time.time()),
    }


def sessions_view() -> list[dict]:
    out = []
    for s in registry().list_sessions():
        sid = s["id"]
        raw_rel = f"{sid}/stream.{s['ext']}" if s["ext"] else None
        segs = s["segments"]
        out.append(
            {
                "id": sid,
                "group": s["grp"],
                "started_at_ms": s["started_at_ms"],
                "status": s["status"],
                "mime": s["mime"],
                "size": f"{s['width']}x{s['height']}",
                "device": s["device"],
                "parts": s["next_part"],
                "total_parts": s["total_parts"],
                "raw_bytes": s["stream_bytes"],
                "raw": raw_rel,
                "gps": f"{sid}/gps.json" if (STORAGE_RAW / sid / "gps.json").exists() else None,
                "seg_state": s["seg_state"],
                "assembled": f"{sid}/session.mp4" if (STORAGE_BLURRED / sid / "session.mp4").exists() else None,
                "last_error": s["last_error"],
                "last_part_at": s["last_part_at"],
                "segments": [
                    {
                        "idx": g["idx"],
                        "status": g["status"],
                        "duration": round(g["duration"], 1),
                        "start_s": round(g["start_s"], 1),
                        "file": f"{sid}/seg_{g['idx']:05d}.mp4" if g["status"] == "blurred" else None,
                        "error": g["error"],
                        "blur_seconds": round(g["blur_seconds"], 1),
                    }
                    for g in segs
                ],
            }
        )
    return out


def sign_download(bucket: str, rel: str, ttl: int = DOWNLOAD_LINK_TTL_S) -> str:
    exp = int(time.time()) + ttl
    sig = hmac.new(ADMIN_TOKEN.encode(), f"{exp}:{bucket}/{rel}".encode(), hashlib.sha256).hexdigest()[:40]
    return f"/admin/api/dl/{exp}.{sig}/{bucket}/{quote(rel)}"


def resolve_download(bucket: str, rel: str) -> Path | None:
    root = BUCKETS.get(bucket)
    if root is None or ".." in Path(rel).parts or rel.startswith("/"):
        return None
    path = (root / rel).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def read_env_lines() -> list[str]:
    if not ENV_FILE.is_file():
        return []
    return ENV_FILE.read_text(encoding="utf-8").splitlines()


def write_capture_token(token: str) -> None:
    lines = read_env_lines()
    key = "CAPTURE_TOKEN"
    out: list[str] = []
    replaced = False
    for line in lines:
        if line.startswith(f"{key}="):
            out.append(f"{key}={token}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{key}={token}")
    ENV_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")


def recreate_caddy() -> None:
    cmd = [
        "docker",
        "compose",
        "-f",
        str(COMPOSE_FILE),
        "up",
        "-d",
        "--force-recreate",
        "caddy",
    ]
    log.info("Exécution : %s", " ".join(cmd))
    proc = subprocess.run(
        cmd,
        cwd=str(PROJECT_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"code {proc.returncode}")


class Handler(BaseHTTPRequestHandler):
    server_version = "safevideoupload-admin/1.0"

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict | None:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def _require_auth(self) -> bool:
        if authorized(self.headers.get("Authorization")):
            return True
        self._send_json(401, {"error": "Authentification requise"})
        return False

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/dl/"):
            self._download(path)
            return
        if path == "/api/recordings":
            if not self._require_auth():
                return
            self._send_json(200, {"recordings": list_recordings()})
            return
        if path == "/api/status":
            if not self._require_auth():
                return
            self._send_json(200, system_status())
            return
        if path == "/api/sessions":
            if not self._require_auth():
                return
            self._send_json(200, {"sessions": sessions_view()})
            return
        self._send_json(404, {"error": "introuvable"})

    def _download(self, path: str) -> None:
        """Téléchargement par lien signé à durée limitée (gros fichiers, sans passer par un blob JS)."""
        try:
            _, _, _, token, bucket, rel = path.split("/", 5)
            exp_s, sig = token.split(".", 1)
            exp = int(exp_s)
        except ValueError:
            self._send_json(400, {"error": "lien invalide"})
            return
        rel = unquote(rel)
        expected = hmac.new(ADMIN_TOKEN.encode(), f"{exp}:{bucket}/{rel}".encode(), hashlib.sha256).hexdigest()[:40]
        if exp < time.time() or not hmac.compare_digest(sig, expected):
            self._send_json(401, {"error": "lien expiré ou invalide"})
            return
        target = resolve_download(bucket, rel)
        if target is None:
            self._send_json(404, {"error": "fichier introuvable"})
            return
        size = target.stat().st_size
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range", "")
        m = re.match(r"^bytes=(\d*)-(\d*)$", rng)
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Disposition", f'attachment; filename="{target.parent.name[:8]}-{target.name}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(target, "rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/sign":
            if not self._require_auth():
                return
            data = self._read_json() or {}
            bucket, rel = str(data.get("bucket", "")), str(data.get("path", ""))
            if resolve_download(bucket, rel) is None:
                self._send_json(404, {"error": "fichier introuvable"})
                return
            self._send_json(200, {"url": sign_download(bucket, rel)})
            return
        if path == "/api/finalize":
            if not self._require_auth():
                return
            data = self._read_json() or {}
            try:
                result = registry().finalize_session(str(data.get("session", "")))
            except RegistryError as err:
                self._send_json(err.status, {"error": err.message})
                return
            self._send_json(200, result)
            return
        if path == "/api/retry-failed":
            if not self._require_auth():
                return
            self._send_json(200, {"retried": registry().retry_failed()})
            return
        if path == "/api/capture-token":
            if not self._require_auth():
                return
            data = self._read_json()
            if data is None:
                self._send_json(400, {"error": "JSON invalide"})
                return
            token = str(data.get("token", "")).strip()
            if len(token) < MIN_CAPTURE_TOKEN_LEN or len(token) > MAX_CAPTURE_TOKEN_LEN:
                self._send_json(
                    400,
                    {
                        "error": f"Le mot de passe doit faire entre {MIN_CAPTURE_TOKEN_LEN} "
                        f"et {MAX_CAPTURE_TOKEN_LEN} caractères.",
                    },
                )
                return
            if not CAPTURE_TOKEN_RE.match(token):
                self._send_json(400, {"error": "Caractères non pris en charge."})
                return
            try:
                write_capture_token(token)
                recreate_caddy()
            except OSError as err:
                log.exception("écriture .env")
                self._send_json(500, {"error": f"Impossible de mettre à jour .env : {err}"})
                return
            except RuntimeError as err:
                log.error("recreate caddy : %s", err)
                self._send_json(502, {"error": f"Caddy non recréé : {err}"})
                return
            self._send_json(200, {"ok": True, "updatedAt": int(time.time())})
            return
        self._send_json(404, {"error": "introuvable"})


def main() -> None:
    if not ADMIN_TOKEN:
        log.error("ADMIN_TOKEN est vide — service refusé")
        sys.exit(1)
    registry().init()
    host = os.environ.get("ADMIN_BIND", "0.0.0.0")
    port = int(os.environ.get("ADMIN_PORT", "8080"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    log.info("Écoute sur %s:%s (projet %s)", host, port, PROJECT_DIR)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
