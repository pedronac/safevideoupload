"""Tests du pipeline de floutage : échelle portrait, segments, audio, files d'attente."""

import json
import queue
import subprocess
from pathlib import Path

import pytest

import blur_worker
from blur_utils import blur_segment, has_video_stream, oriented_scale, probe_media


def test_oriented_scale_landscape_keeps_scale():
    assert oriented_scale("640x360", 1280, 720) == "640x360"


def test_oriented_scale_portrait_swaps_scale():
    assert oriented_scale("640x360", 720, 1280) == "360x640"


def test_oriented_scale_accepts_portrait_setting_for_landscape_video():
    assert oriented_scale("360x640", 1280, 720) == "640x360"


def test_completed_segments_keeps_last_until_ffmpeg_exits(tmp_path: Path):
    segs = [tmp_path / f"seg_{i}.mkv" for i in range(3)]
    assert blur_worker.completed_segments(segs, process_exited=False) == segs[:2]
    assert blur_worker.completed_segments(segs, process_exited=True) == segs
    assert blur_worker.completed_segments([], process_exited=False) == []


def test_trim_backlog_drops_oldest():
    q: "queue.Queue[int]" = queue.Queue()
    for i in range(6):
        q.put(i)
    assert blur_worker.trim_backlog(q, 2) == [0, 1, 2, 3]
    assert q.qsize() == 2
    assert q.get_nowait() == 4


def _make_av_video(path: Path, size: str, codec: str, audio: bool = True) -> None:
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=15"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440"]
    cmd += ["-t", "2", "-c:v", codec]
    if codec == "libx264":
        cmd += ["-pix_fmt", "yuv420p"]
    if audio:
        cmd += ["-c:a", "libopus"]
    cmd += ["-f", "matroska", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)


@pytest.mark.parametrize("codec", ["libx264", "libvpx"])
def test_blur_segment_portrait_opus_to_h264_aac(tmp_path: Path, codec: str):
    """Segment brut WebRTC (VP8 ou H.264 + Opus, portrait) -> MP4 H.264 + AAC, même taille."""
    raw = tmp_path / "raw.mkv"
    out = tmp_path / "out.mp4"
    _make_av_video(raw, "360x640", codec)

    info = blur_segment(raw, out, scale="640x360")

    assert info["width"] == 360 and info["height"] == 640 and info["has_audio"]
    assert out.exists() and has_video_stream(out)
    assert not out.with_suffix(".video.mp4").exists()
    streams = json.loads(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", str(out)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )["streams"]
    by_codec = {s["codec_name"]: s for s in streams}
    assert set(by_codec) == {"h264", "aac"}
    assert (by_codec["h264"]["width"], by_codec["h264"]["height"]) == (360, 640)


def test_normalize_to_cfr_fixes_webrtc_style_frame_rate(tmp_path: Path):
    """Cadence variable (r_frame_rate absurde en MKV) -> cadence constante 30 i/s."""
    from blur_utils import normalize_to_cfr

    raw = tmp_path / "vfr.mkv"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
            "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-bsf:v", "setts=ts=N*40/1000*1000/1000",
            "-f", "matroska", str(raw),
        ],
        check=True,
        capture_output=True,
    )
    out = tmp_path / "cfr.mp4"
    normalize_to_cfr(raw, out)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(out)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert probe.stdout.strip() == "30/1"


def test_blur_segment_without_audio(tmp_path: Path):
    raw = tmp_path / "raw.mkv"
    out = tmp_path / "out.mp4"
    _make_av_video(raw, "320x240", "libx264", audio=False)
    info = blur_segment(raw, out, scale="320x240")
    assert not info["has_audio"]
    assert probe_media(out)["has_audio"] is False
    assert has_video_stream(out)


def test_blur_segment_rejects_unreadable_file(tmp_path: Path):
    bad = tmp_path / "bad.mkv"
    bad.write_bytes(b"not a video")
    with pytest.raises(RuntimeError):
        blur_segment(bad, tmp_path / "out.mp4")
