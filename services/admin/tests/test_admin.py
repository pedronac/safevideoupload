"""Tests de l'API admin : état disque/file, sessions, liens de téléchargement signés."""

import json
import threading
import urllib.error
import urllib.request

import pytest

import server as admin
from registry import Registry

TOKEN = "admin-token-for-tests-0123456789"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "storage"
    monkeypatch.setattr(admin, "ADMIN_TOKEN", TOKEN)
    monkeypatch.setattr(admin, "STORAGE_DIR", root)
    monkeypatch.setattr(admin, "STORAGE_RAW", root / "raw")
    monkeypatch.setattr(admin, "STORAGE_BLURRED", root / "blurred")
    monkeypatch.setattr(admin, "BUCKETS", {"raw": root / "raw", "blurred": root / "blurred"})
    reg = Registry(root)
    reg.init()
    httpd = admin.ThreadingHTTPServer(("127.0.0.1", 0), admin.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", reg
    httpd.shutdown()


def get(base, path, headers=None, auth=True):
    h = dict(headers or {})
    if auth:
        h["Authorization"] = f"Bearer {TOKEN}"
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, headers=h), timeout=10) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as err:
        return err.code, err.read(), err.headers


def post(base, path, body):
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def test_status_requires_token_and_reports_disk_and_queue(env):
    base, reg = env
    assert get(base, "/api/status", auth=False)[0] == 401
    status, body, _ = get(base, "/api/status")
    data = json.loads(body)
    assert status == 200
    assert {"total", "free", "free_percent", "low", "raw", "blurred"} <= set(data["disk"])
    assert data["queue"]["segments"] == {}


def test_disk_warning_below_threshold(env, monkeypatch):
    monkeypatch.setattr(admin, "DISK_WARN_FREE_PERCENT", 101.0)
    assert admin.storage_status()["low"] is True
    monkeypatch.setattr(admin, "DISK_WARN_FREE_PERCENT", 0.0)
    assert admin.storage_status()["low"] is False


def test_sessions_listing_and_signed_download_with_range(env):
    base, reg = env
    sid = "e" * 32
    reg.create_session(sid, started_at_ms=1_790_000_000_000)
    stream = reg.stream_path(sid, "webm")
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_bytes(bytes(range(256)) * 4)
    with reg.conn() as c:
        c.execute("UPDATE sessions SET ext='webm', stream_bytes=1024 WHERE id=?", (sid,))
    sessions = json.loads(get(base, "/api/sessions")[1])["sessions"]
    assert sessions[0]["id"] == sid and sessions[0]["raw"] == f"{sid}/stream.webm"

    url = post(base, "/api/sign", {"bucket": "raw", "path": f"{sid}/stream.webm"})["url"]
    assert url.startswith("/admin/api/dl/")
    local = url.replace("/admin", "", 1)
    status, body, _ = get(base, local, auth=False)
    assert status == 200 and len(body) == 1024
    status, body, headers = get(base, local, {"Range": "bytes=10-19"}, auth=False)
    assert status == 206 and body == bytes(range(10, 20))
    assert headers["Content-Range"] == "bytes 10-19/1024"
    assert get(base, local.replace("/raw/", "/blurred/"), auth=False)[0] in (401, 404)


def test_download_rejects_tampering_traversal_and_expiry(env, monkeypatch):
    base, reg = env
    (reg.raw / "x").mkdir(parents=True, exist_ok=True)
    (reg.raw / "x" / "f.bin").write_bytes(b"abc")
    good = admin.sign_download("raw", "x/f.bin").replace("/admin", "", 1)
    assert get(base, good, auth=False)[0] == 200
    assert get(base, good[:-3] + "bad", auth=False)[0] == 401
    expired = admin.sign_download("raw", "x/f.bin", ttl=-5).replace("/admin", "", 1)
    assert get(base, expired, auth=False)[0] == 401
    assert admin.resolve_download("raw", "../blurred/../../etc/passwd") is None
    assert admin.resolve_download("raw", "/etc/passwd") is None
    assert get(base, "/api/dl/x/raw/f.bin", auth=False)[0] in (400, 401)


def test_finalize_session(env):
    base, reg = env
    sid = "f" * 32
    reg.create_session(sid, started_at_ms=1_790_000_000_000)
    out = post(base, "/api/finalize", {"session": sid})
    assert out["status"] == "closed" and out["total_parts"] == 0
