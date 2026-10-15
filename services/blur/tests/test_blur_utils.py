"""Tests unitaires légers (sans gros fichier vidéo)."""

import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

from blur_utils import has_video_stream, run_deface_on_file


def test_deface_module_importable():
    import deface  # noqa: F401


def test_has_video_stream_false_on_missing(tmp_path: Path):
    assert has_video_stream(tmp_path / "nope.mp4") is False


def test_deface_on_synthetic_video(tmp_path: Path):
    """Crée une vidéo 1 s sans visage ; deface doit produire un fichier valide."""
    input_mp4 = tmp_path / "in.mp4"
    output_mp4 = tmp_path / "out.mp4"

    # Image 320x240 une frame
    frame = np.zeros((240, 320, 3), dtype=np.uint8)
    cv2.putText(
        frame,
        "test",
        (40, 120),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (255, 255, 255),
        2,
    )
    writer = cv2.VideoWriter(
        str(input_mp4),
        cv2.VideoWriter_fourcc(*"mp4v"),
        5.0,
        (320, 240),
    )
    for _ in range(5):
        writer.write(frame)
    writer.release()

    # Ré-encoder en H.264 pour compatibilité deface/ffmpeg
    h264_in = tmp_path / "in_h264.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_mp4),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(h264_in),
        ],
        check=True,
        capture_output=True,
    )

    run_deface_on_file(h264_in, output_mp4, scale="320x240")
    assert output_mp4.exists()
    assert output_mp4.stat().st_size > 0
    assert has_video_stream(output_mp4)
