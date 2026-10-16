#!/usr/bin/env python3
"""API d'administration safevideoupload (stdlib HTTP)."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

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
STORAGE_RAW = Path(os.environ.get("STORAGE_RAW", "/storage/raw"))
STORAGE_BLURRED = Path(os.environ.get("STORAGE_BLURRED", "/storage/blurred"))
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
        if path == "/api/recordings":
            if not self._require_auth():
                return
            self._send_json(200, {"recordings": list_recordings()})
            return
        self._send_json(404, {"error": "introuvable"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
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
    host = os.environ.get("ADMIN_BIND", "0.0.0.0")
    port = int(os.environ.get("ADMIN_PORT", "8080"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    log.info("Écoute sur %s:%s (projet %s)", host, port, PROJECT_DIR)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
