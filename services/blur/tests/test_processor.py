"""Segmentation + floutage réels (ffmpeg/deface) sur de petites vidéos synthétiques."""

import hashlib
import json
import os
import subprocess
import threading
from pathlib import Path

import pytest

import processor
from blur_utils import concat_copy, probe_media
from registry import Registry

SID = "d" * 32


def make_media(path: Path, kind: str, seconds: int = 14, size: str = "360x640") -> None:
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
    ]
    if kind == "webm":
        cmd += ["-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8", "-g", "30", "-c:a", "libopus", "-f", "webm"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"]
    subprocess.run(cmd + [str(path)], check=True)


def count_video_packets(path: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return int(out.rstrip(","))


def ingest_in_parts(reg: Registry, sid: str, media: Path, n_parts: int, order=None) -> list[bytes]:
    data = media.read_bytes()
    step = len(data) // n_parts + 1
    parts = [data[i : i + step] for i in range(0, len(data), step)]
    reg.create_session(sid, started_at_ms=1_790_000_000_000)
    for idx in order or range(len(parts)):
        tmp = reg.incoming_dir(sid) / f"{idx}.tmp"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(parts[idx])
        reg.ingest_part(sid, idx, tmp, len(parts[idx]), hashlib.sha256(parts[idx]).hexdigest())
    reg.close_session(sid, len(parts))
    return parts


@pytest.fixture()
def reg(tmp_path, monkeypatch):
    monkeypatch.setattr(processor, "SEGMENT_SECONDS", 5)
    monkeypatch.setattr(processor, "STOP", threading.Event())
    r = Registry(tmp_path / "storage")
    r.init()
    return r


@pytest.mark.parametrize("kind", ["webm", "mp4"])
def test_segmenter_is_gap_free_and_blur_outputs_play(reg, tmp_path, kind):
    media = tmp_path / f"in.{kind}"
    make_media(media, kind)
    parts = ingest_in_parts(reg, SID, media, 7, order=[0, 2, 1, 3, 5, 4, 6])
    assert reg.stream_path(SID, kind).read_bytes() == b"".join(parts) == media.read_bytes()

    seg = processor.Segmenter(reg, SID)
    seg.start()
    seg.join(timeout=120)
    assert reg.get_session(SID)["seg_state"] == "done"

    with reg.conn() as c:
        segs = [dict(r) for r in c.execute("SELECT * FROM segments WHERE session=? ORDER BY idx", (SID,))]
    assert len(segs) >= 2
    # Chaque segment commence là où le précédent finit : aucun trou, aucun chevauchement.
    for a, b in zip(segs, segs[1:]):
        assert abs((a["start_s"] + a["duration"]) - b["start_s"]) < 0.05
    assert abs(sum(s["duration"] for s in segs) - probe_media(media)["duration"]) < 0.2
    # Aucune image perdue entre le flux brut et la somme des segments (copie de paquets).
    raw_frames = count_video_packets(media)
    seg_frames = sum(count_video_packets(Path(s["raw_path"])) for s in segs)
    assert seg_frames == raw_frames

    p = processor.Processor(reg)
    while (row := reg.claim_segment()):
        p.blur_one(row, 1)
    outs = sorted((reg.blurred / SID).glob("seg_*.mp4"))
    assert len(outs) == len(segs)
    for out in outs:
        info = probe_media(out)
        assert (info["width"], info["height"], info["has_audio"]) == (360, 640, True)
    blurred_frames = sum(count_video_packets(o) for o in outs)
    assert abs(blurred_frames - raw_frames) <= len(segs)
    assert [v["start_ms"] for v in reg.public_videos()] == sorted(v["start_ms"] for v in reg.public_videos())

    p.assemble_finished()
    assembled = reg.blurred / SID / "session.mp4"
    assert assembled.exists()
    assert abs(probe_media(assembled)["duration"] - sum(probe_media(o)["duration"] for o in outs)) < 0.5


def test_resume_after_restart_skips_blurred_segments(reg, tmp_path):
    media = tmp_path / "in.webm"
    make_media(media, "webm")
    ingest_in_parts(reg, SID, media, 4)
    seg = processor.Segmenter(reg, SID)
    seg.start()
    seg.join(timeout=120)
    p = processor.Processor(reg)
    first = reg.claim_segment()
    p.blur_one(first, 1)
    second = reg.claim_segment()  # « crash » pendant le floutage du suivant
    assert reg.reset_blurring() == 1
    reg.update_session(SID, seg_state="pending")

    seg2 = processor.Segmenter(reg, SID)
    seg2.start()
    seg2.join(timeout=120)
    assert reg.get_segment(SID, first["idx"])["status"] == "blurred"
    assert reg.get_segment(SID, second["idx"])["status"] == "cut"
    assert not (reg.work / SID / f"seg_{first['idx']:05d}.mkv").exists()
    while (row := reg.claim_segment()):
        p.blur_one(row, 1)
    assert reg.counts()["segments"] == {"blurred": len(reg.public_videos())}


def test_parse_segment_list_ignores_partial_line():
    text = "seg_00000.mkv,0.000000,5.033000\nseg_00001.mkv,5.033000,10.1\nseg_00002.mkv,10.1,1"
    assert processor.parse_segment_list(text) == [(0, 0.0, 5.033), (1, 5.033, 10.1)]


def test_concat_copy(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    for p in (a, b):
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x284:rate=30:duration=2",
             "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", str(p)],
            check=True,
        )
    out = tmp_path / "ab.mp4"
    concat_copy([a, b], out)
    assert abs(probe_media(out)["duration"] - 4.0) < 0.2
