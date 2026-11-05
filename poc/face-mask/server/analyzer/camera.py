"""Camera covered or blurred. No model: mean brightness and sharpness (variance of the Laplacian)."""
from __future__ import annotations

import cv2
import numpy as np

from . import config


def frame_stats(bgr: np.ndarray) -> tuple[float, float]:
    """(mean brightness 0..255, sharpness) of a frame, measured on a copy scaled to CAMERA_ANALYSIS_WIDTH."""
    h, w = bgr.shape[:2]
    if w > config.CAMERA_ANALYSIS_WIDTH:
        bgr = cv2.resize(bgr, (config.CAMERA_ANALYSIS_WIDTH, max(1, round(h * config.CAMERA_ANALYSIS_WIDTH / w))),
                         interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
    return float(gray.mean()), float(cv2.Laplacian(gray, cv2.CV_64F).var())


def classify(mean: float, sharp: float, min_brightness: float = config.CAMERA_MIN_BRIGHTNESS,
             min_sharpness: float = config.CAMERA_MIN_SHARPNESS) -> tuple[bool, bool]:
    """(too dark, too blurred)."""
    return mean < min_brightness, sharp < min_sharpness
