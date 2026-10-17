#!/usr/bin/env python3
"""API d'upload safevideoupload (stdlib, sans dépendance).

Derrière Caddy, qui vérifie déjà le Bearer CAPTURE_TOKEN sur /api/upload/*. Si CAPTURE_TOKEN est
défini dans l'environnement de ce service (tests, usage hors Caddy), il est vérifié ici aussi.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))

from registry import SHA256_RE, SESSION_ID_RE, Registry, RegistryError  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [api] %(levelname)s %(message)s", stream=sys.stdout)
log = logging.getLogger("api")

MAX_PART_BYTES = int(os.environ.get("MAX_PART_MB", "256")) * 1024 * 1024
MIN_FREE_BYTES = int(float(os.environ.get("MIN_FREE_GB", "2")) * 1024**3)
MAX_JSON_BYTES = 2 * 1024 * 1024
SOCKET_TIMEOUT_S = 120
CHUNK = 1024 * 1024

ROUTE_PART = re.compile(r"^/api/upload/([a-f0-9]{32})/part/(\d{1,6})$")
ROUTE_GPS = re.compile(r"^/api/upload/([a-f0-9]{32})/gps/(\d{1,6})$")
ROUTE_STATUS = re.compile(r"^/api/upload/([a-f0-9]{32})/status$")
ROUTE_CLOSE = re.compile(r"^/api/upload/([a-f0-9]{32})/close$")


def public_page_enabled() -> bool:
    return os.environ.get("PUBLIC_PAGE_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")


class Handler(BaseHTTPRequestHandler):
    server_version = "safevideoupload-api/1.0"
    timeout = SOCKET_TIMEOUT_S
    registry: Registry

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)

    # ---------------------------------------------------------------- helpers

    def _json(self, status: int, payload: dict | list) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _error(self, status: int, code: str, message: str = "") -> None:
        self._json(status, {"error": code, "message": message or code})

    def _authorized(self) -> bool:
        expected = os.environ.get("CAPTURE_TOKEN", "").strip()
        if not expected:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].strip().encode(), expected.encode())

    def _read_json(self) -> dict | list | None:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_JSON_BYTES:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    # ---------------------------------------------------------------- routes

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json(200, {"ok": True})
            return
        if path == "/api/public/videos":
            if not public_page_enabled():
                self._error(404, "disabled", "page publique désactivée")
                return
            self._json(200, {"videos": self.registry.public_videos()})
            return
        m = ROUTE_STATUS.match(path)
        if m:
            if not self._authorized():
                self._error(401, "unauthorized", "mot de passe refusé")
                return
            try:
                self._json(200, self.registry.session_status(m.group(1)))
            except RegistryError as err:
                self._error(err.status, err.code, err.message)
            return
        self._error(404, "not_found")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not path.startswith("/api/upload/"):
            self._error(404, "not_found")
            return
        if not self._authorized():
            self._error(401, "unauthorized", "mot de passe refusé")
            return
        try:
            if path == "/api/upload/session":
                self._create_session()
                return
            m = ROUTE_CLOSE.match(path)
            if m:
                data = self._read_json()
                if not isinstance(data, dict) or not isinstance(data.get("total_parts"), int):
                    self._error(400, "bad_request", "total_parts requis")
                    return
                self._json(200, self.registry.close_session(m.group(1), data["total_parts"]))
                return
        except RegistryError as err:
            self._error(err.status, err.code, err.message)
            return
        self._error(404, "not_found")

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if not self._authorized():
            self._error(401, "unauthorized", "mot de passe refusé")
            return
        try:
            m = ROUTE_PART.match(path)
            if m:
                self._put_part(m.group(1), int(m.group(2)))
                return
            m = ROUTE_GPS.match(path)
            if m:
                data = self._read_json()
                samples = data.get("samples") if isinstance(data, dict) else data
                if not isinstance(samples, list):
                    self._error(400, "bad_request", "liste d'échantillons GPS attendue")
                    return
                self.registry.save_gps(m.group(1), int(m.group(2)), samples[:5000])
                self._json(200, {"ok": True})
                return
        except RegistryError as err:
            self._error(err.status, err.code, err.message)
            return
        self._error(404, "not_found")

    def _create_session(self) -> None:
        data = self._read_json()
        if not isinstance(data, dict):
            self._error(400, "bad_request", "JSON attendu")
            return
        sid = str(data.get("session", ""))
        if not SESSION_ID_RE.match(sid):
            self._error(400, "bad_session_id", "identifiant de session invalide")
            return
        session = self.registry.create_session(
            sid,
            started_at_ms=int(data.get("started_at_ms") or 0),
            mime=str(data.get("mime", "")),
            width=int(data.get("width") or 0),
            height=int(data.get("height") or 0),
            device=str(data.get("device", "")),
            group=str(data["group"]) if data.get("group") else None,
        )
        self._json(200, {**self.registry.session_status(session["id"]), "created": True})

    def _put_part(self, session: str, idx: int) -> None:
        if not self.registry.get_session(session):
            self._error(404, "unknown_session", "session inconnue")
            return
        sha = (self.headers.get("X-Part-Sha256") or "").strip().lower()
        if not SHA256_RE.match(sha):
            self._error(400, "bad_sha256", "en-tête X-Part-Sha256 requis")
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._error(411, "length_required", "Content-Length requis")
            return
        if length <= 0:
            self._error(400, "empty_part", "partie vide")
            return
        if length > MAX_PART_BYTES:
            self._error(413, "too_large", f"partie trop grosse (max {MAX_PART_BYTES // 1024 // 1024} Mo)")
            return
        declared = self.headers.get("X-Part-Size")
        if declared and declared.isdigit() and int(declared) != length:
            self._error(400, "size_mismatch", "X-Part-Size différent de Content-Length")
            return
        free = shutil.disk_usage(self.registry.root).free
        if free - length < MIN_FREE_BYTES:
            self._error(507, "disk_full", "espace disque serveur insuffisant")
            return

        incoming = self.registry.incoming_dir(session)
        incoming.mkdir(parents=True, exist_ok=True)
        tmp = incoming / f"{idx:06d}.{uuid.uuid4().hex[:8]}.tmp"
        digest = hashlib.sha256()
        received = 0
        try:
            with open(tmp, "wb") as out:
                while received < length:
                    chunk = self.rfile.read(min(CHUNK, length - received))
                    if not chunk:
                        break
                    out.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
            if received != length:
                tmp.unlink(missing_ok=True)
                self._error(400, "truncated", "corps incomplet")
                return
            if digest.hexdigest() != sha:
                tmp.unlink(missing_ok=True)
                self._error(422, "sha_mismatch", "somme de contrôle incorrecte, renvoyer la partie")
                return
            ack = self.registry.ingest_part(session, idx, tmp, length, sha)
        except (TimeoutError, ConnectionError, OSError) as err:
            tmp.unlink(missing_ok=True)
            log.warning("upload interrompu session=%s part=%s : %s", session[:8], idx, err)
            self.close_connection = True
            return
        except RegistryError:
            tmp.unlink(missing_ok=True)
            raise
        if not ack["duplicate"]:
            log.info("partie reçue session=%s idx=%s taille=%.1f Mo prochaine=%s", session[:8], idx, length / 1e6, ack["next_part"])
        self._json(200, {"ok": True, "session": session, "idx": idx, **ack})


def make_server(host: str, port: int, registry: Registry) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"registry": registry})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd


def cleanup_incoming(registry: Registry) -> None:
    """Supprime les envois interrompus (fichiers .tmp) restés après un redémarrage."""
    for tmp in registry.raw.glob("*/incoming/*.tmp"):
        tmp.unlink(missing_ok=True)


def main() -> None:
    registry = Registry()
    registry.init()
    cleanup_incoming(registry)
    host = os.environ.get("API_BIND", "0.0.0.0")
    port = int(os.environ.get("API_PORT", "8000"))
    httpd = make_server(host, port, registry)
    log.info("Écoute sur %s:%s (stockage %s, partie max %s Mo)", host, port, registry.root, MAX_PART_BYTES // 1024 // 1024)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
