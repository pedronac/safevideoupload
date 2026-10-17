"""Tests de l'API d'upload : idempotence, ordre, recollage, GPS, authentification."""

import hashlib
import json
import threading
import urllib.error
import urllib.request

import pytest

import server as api
from registry import Registry, sniff_extension

SID = "a" * 32
WEBM_HEAD = b"\x1a\x45\xdf\xa3" + b"\x00" * 60
MP4_HEAD = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 60


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPTURE_TOKEN", "secret-token-1234567890")
    monkeypatch.setenv("MIN_FREE_GB", "0")
    monkeypatch.setattr(api, "MIN_FREE_BYTES", 0)
    registry = Registry(tmp_path / "storage")
    registry.init()
    httpd = api.make_server("127.0.0.1", 0, registry)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", registry
    httpd.shutdown()


def call(base, method, path, body=None, headers=None, token="secret-token-1234567890"):
    h = dict(headers or {})
    if token:
        h["Authorization"] = f"Bearer {token}"
    data = body
    if isinstance(body, (dict, list)):
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def put_part(base, idx, data, sid=SID, sha=None, **kw):
    sha = sha or hashlib.sha256(data).hexdigest()
    return call(base, "PUT", f"/api/upload/{sid}/part/{idx}", data, {"X-Part-Sha256": sha}, **kw)


def open_session(base, sid=SID, mime="video/webm"):
    return call(base, "POST", "/api/upload/session", {"session": sid, "started_at_ms": 1_790_000_000_000, "mime": mime})


def test_requires_bearer(server):
    base, _ = server
    assert open_session(base)[0] == 200
    assert call(base, "POST", "/api/upload/session", {"session": SID}, token=None)[0] == 401
    assert call(base, "POST", "/api/upload/session", {"session": SID}, token="mauvais")[0] == 401
    assert put_part(base, 0, b"x", token="mauvais")[0] == 401


def test_in_order_upload_concatenates_stream(server):
    base, reg = server
    open_session(base)
    parts = [WEBM_HEAD + b"A" * 1000, b"B" * 2000, b"C" * 3000]
    for i, p in enumerate(parts):
        status, ack = put_part(base, i, p)
        assert status == 200 and ack["next_part"] == i + 1
    stream = reg.stream_path(SID, "webm")
    assert stream.read_bytes() == b"".join(parts)
    assert reg.get_session(SID)["stream_bytes"] == sum(map(len, parts))


def test_out_of_order_parts_wait_then_concat_in_order(server):
    base, reg = server
    open_session(base)
    parts = [WEBM_HEAD + b"0" * 500, b"1" * 600, b"2" * 700, b"3" * 800]
    _, ack = put_part(base, 2, parts[2])
    assert ack["next_part"] == 0
    _, ack = put_part(base, 3, parts[3])
    assert ack["next_part"] == 0
    assert call(base, "GET", f"/api/upload/{SID}/status")[1]["pending_parts"] == [2, 3]
    _, ack = put_part(base, 0, parts[0])
    assert ack["next_part"] == 1
    _, ack = put_part(base, 1, parts[1])
    assert ack["next_part"] == 4
    assert reg.stream_path(SID, "webm").read_bytes() == b"".join(parts)
    assert not list((reg.raw / SID / "pending").glob("*.part"))


def test_upload_is_idempotent(server):
    base, reg = server
    open_session(base)
    data = WEBM_HEAD + b"Z" * 400
    assert put_part(base, 0, data)[1]["duplicate"] is False
    status, ack = put_part(base, 0, data)
    assert status == 200 and ack["duplicate"] is True and ack["next_part"] == 1
    assert reg.stream_path(SID, "webm").read_bytes() == data


def test_conflicting_content_is_rejected(server):
    base, reg = server
    open_session(base)
    put_part(base, 0, WEBM_HEAD + b"a" * 100)
    status, body = put_part(base, 0, WEBM_HEAD + b"b" * 100)
    assert status == 409 and body["error"] == "part_conflict"
    assert reg.stream_path(SID, "webm").read_bytes() == WEBM_HEAD + b"a" * 100


def test_bad_checksum_is_rejected_and_leaves_nothing(server):
    base, reg = server
    open_session(base)
    status, body = put_part(base, 0, WEBM_HEAD + b"a" * 100, sha="0" * 64)
    assert status == 422 and body["error"] == "sha_mismatch"
    assert call(base, "GET", f"/api/upload/{SID}/status")[1]["next_part"] == 0
    assert not list((reg.raw / SID / "incoming").glob("*"))


def test_unknown_session_and_missing_sha(server):
    base, _ = server
    assert put_part(base, 0, b"x", sid="b" * 32)[0] == 404
    open_session(base)
    status, body = call(base, "PUT", f"/api/upload/{SID}/part/0", b"abc")
    assert status == 400 and body["error"] == "bad_sha256"


def test_part_too_large_is_refused_before_reading(server, monkeypatch):
    base, _ = server
    monkeypatch.setattr(api, "MAX_PART_BYTES", 100)
    open_session(base)
    assert put_part(base, 0, b"x" * 101)[0] == 413


def test_extension_sniffing(server):
    base, reg = server
    assert sniff_extension(WEBM_HEAD) == "webm"
    assert sniff_extension(MP4_HEAD) == "mp4"
    assert sniff_extension(b"garbage-garbage-") is None
    other = "c" * 32
    open_session(base, sid=other, mime="video/webm")
    put_part(base, 0, MP4_HEAD + b"m" * 50, sid=other)
    assert reg.stream_path(other, "mp4").exists()
    assert reg.get_session(other)["ext"] == "mp4"


def test_close_and_late_part(server):
    base, _ = server
    open_session(base)
    put_part(base, 0, WEBM_HEAD)
    put_part(base, 1, b"tail")
    status, body = call(base, "POST", f"/api/upload/{SID}/close", {"total_parts": 2})
    assert status == 200 and body["status"] == "closed" and body["total_parts"] == 2
    assert call(base, "POST", f"/api/upload/{SID}/close", {"total_parts": 2})[0] == 200
    assert call(base, "POST", f"/api/upload/{SID}/close", {"total_parts": 5})[0] == 409
    status, body = put_part(base, 2, b"late")
    assert status == 409 and body["error"] == "session_closed"
    assert put_part(base, 1, b"tail")[1]["duplicate"] is True


def test_close_before_last_part_arrives(server):
    base, reg = server
    open_session(base)
    put_part(base, 0, WEBM_HEAD)
    assert call(base, "POST", f"/api/upload/{SID}/close", {"total_parts": 3})[0] == 200
    assert put_part(base, 2, b"two")[0] == 200
    assert put_part(base, 1, b"one")[1]["next_part"] == 3
    assert reg.stream_path(SID, "webm").read_bytes() == WEBM_HEAD + b"one" + b"two"


def test_gps_chunks_merged_on_close(server):
    base, reg = server
    open_session(base)
    put_part(base, 0, WEBM_HEAD)
    s1 = [{"t": 2000, "lat": 48.1, "lon": 2.1, "acc": 5}]
    s0 = [{"t": 1000, "lat": 48.0, "lon": 2.0, "acc": 6, "speed": 3.1}]
    assert call(base, "PUT", f"/api/upload/{SID}/gps/1", {"samples": s1})[0] == 200
    assert call(base, "PUT", f"/api/upload/{SID}/gps/0", {"samples": s0})[0] == 200
    assert call(base, "PUT", f"/api/upload/{SID}/gps/0", {"samples": s0})[0] == 200
    call(base, "POST", f"/api/upload/{SID}/close", {"total_parts": 1})
    merged = json.loads((reg.raw / SID / "gps.json").read_text())
    assert [s["t"] for s in merged["samples"]] == [1000, 2000]


def test_public_listing_sorted_and_flag(server, monkeypatch):
    base, reg = server
    for sid, start in (("a" * 32, 1_790_000_000_000), ("b" * 32, 1_780_000_000_000)):
        reg.create_session(sid, started_at_ms=start)
        for idx in (1, 0):
            reg.upsert_segment(sid, idx, idx * 60.0, 60.0, "/x")
            reg.finish_segment(sid, idx, f"/storage/blurred/{sid}/seg_{idx:05d}.mp4", 10, 60.0, 5.0)
    reg.upsert_segment("a" * 32, 2, 120.0, 60.0, "/x")
    _, body = call(base, "GET", "/api/public/videos", token=None)
    starts = [v["start_ms"] for v in body["videos"]]
    assert starts == sorted(starts) and len(starts) == 4
    assert all(v["url"].startswith("/media/") and "raw" not in v["url"] for v in body["videos"])
    assert "gps" not in json.dumps(body)
    monkeypatch.setenv("PUBLIC_PAGE_ENABLED", "false")
    assert call(base, "GET", "/api/public/videos", token=None)[0] == 404


def test_restart_drain_truncates_partial_write(tmp_path):
    reg = Registry(tmp_path / "s")
    reg.init()
    reg.create_session(SID, started_at_ms=1_790_000_000_000)
    stream = reg.stream_path(SID, "webm")
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_bytes(b"junk-from-crashed-write")
    tmp = reg.incoming_dir(SID) / "000000.tmp"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(WEBM_HEAD)
    reg.ingest_part(SID, 0, tmp, len(WEBM_HEAD), hashlib.sha256(WEBM_HEAD).hexdigest())
    assert stream.read_bytes() == WEBM_HEAD
