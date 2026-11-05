"""Synthetic data for the tests."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from analyzer.model import Detection


def textured(w=160, h=90, seed=0) -> np.ndarray:
    """A sharp, mid-bright frame (random blocks)."""
    rng = np.random.default_rng(seed)
    small = rng.integers(40, 220, size=(h // 6, w // 6, 3), dtype=np.uint8)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)


def dark(w=160, h=90) -> np.ndarray:
    return np.full((h, w, 3), 6, np.uint8)


def blurred(w=160, h=90) -> np.ndarray:
    return cv2.GaussianBlur(textured(w, h), (0, 0), 25)


def write_video(path: Path, frame_for_time, seconds: float, fps: float = 10.0, size=(160, 90)) -> Path:
    """MJPG avi; frame_for_time(t_seconds) -> BGR frame of `size`."""
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
    assert vw.isOpened()
    for i in range(int(seconds * fps)):
        vw.write(frame_for_time(i / fps))
    vw.release()
    return path


def sidecar_frames(seconds: float, fps: float = 10.0, away=(), lost=(), start_s: float = 0.0, blend_base: float = 0.0):
    """Sidecar frame lines. away: (start, end, blendH value); lost: (start, end). yaw is 0 and baseline is 0."""
    out = []
    for i in range(int(seconds * fps)):
        t = start_s + i / fps
        is_lost = any(a <= t < b for a, b in lost)
        blend = blend_base
        for a, b, v in away:
            if a <= t < b:
                blend = v
        out.append({"type": "frame", "t": t * 1000.0, "faces": 0 if is_lost else 1, "lost": is_lost,
                    "yaw": None if is_lost else 0.0, "yawRaw": None if is_lost else 0.0,
                    "gazeH": None if is_lost else 0.0, "gazeHRaw": None if is_lost else 0.0,
                    "blendH": None if is_lost else blend, "blendHRaw": None if is_lost else blend})
    return out


HEADER = {"type": "header", "id": "t_normal_1", "calibration": {"baseline": {"yaw": 0.0, "gazeH": 0.0, "blendH": 0.0}}}


class FakeDetector:
    """Returns scripted detections: script maps the index of the sampled frame to a list of labels."""

    def __init__(self, script: dict[int, list[str]], score: float = 0.8):
        self.script = script
        self.score = score
        self.calls = 0

    def detect(self, frame, conf=0.4):
        labels = self.script.get(self.calls, [])
        self.calls += 1
        return [Detection(label, self.score, (0.0, 0.0, 10.0, 10.0)) for label in labels]
