"""All thresholds in one place. Change them here; the flags file records the values that were used."""
from __future__ import annotations

from pathlib import Path

ANALYZER_VERSION = "0.1.0"

SERVER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_MODEL_PATH = SERVER_DIR / "models" / "yolo11n.onnx"

# ---- sampling and chunking ---------------------------------------------------------
SAMPLE_FPS = 2.0             # frames per second used for the object and camera checks
CHUNK_S = 60.0               # the CLI splits a recording into chunks of this length
CHUNK_FRAME_LONG_SIDE = 640  # sampled frames written to temp chunk files are scaled to this long side
EDGE_TOL_S = 0.5             # a detection this close to the first/last sample of a chunk may continue in the next chunk

# ---- objects (YOLO11 nano, ONNX, CPU) ----------------------------------------------
MODEL_INPUT = 640
OBJECT_CONF = 0.40           # detection confidence threshold (0..1)
NMS_IOU = 0.45
CLASSES = {0: "person", 63: "laptop", 67: "cell phone", 73: "book"}  # COCO ids we report

# ---- camera blocked or blurred (no model) --------------------------------------------
CAMERA_ANALYSIS_WIDTH = 320  # frames are scaled to this width first, so the numbers do not depend on resolution
CAMERA_MIN_BRIGHTNESS = 25.0  # mean grey level (0..255): below this = covered or dark
CAMERA_MIN_SHARPNESS = 40.0   # variance of the Laplacian: below this = blurred or featureless. Real normal clips measured 400-800; a Gaussian blur of sigma 8 gives about 10, sigma 3 about 115

# ---- minimum duration before a detection becomes a flag, and join gaps -------------------
# (seconds). Looking-away durations come from analysis/common.py (head 1.0 s, eyes 1.5 s).
MIN_DURATION_S = {
    "phone_visible": 1.5,
    "book_visible": 2.0,
    "extra_laptop": 2.0,
    "second_person": 2.0,
    "camera_blocked": 2.0,
    "tracking_lost": 2.0,
}
# Detections of the same type closer together than this are joined into one flag.
JOIN_GAP_S = {
    "phone_visible": 1.5,
    "book_visible": 1.5,
    "extra_laptop": 1.5,
    "second_person": 1.5,
    "camera_blocked": 1.0,
    "looking_away": 0.5,
    "off_screen_look": 0.5,
    "looking_away_while_typing": 0.5,
    "tracking_lost": 0.5,
}

VIDEO_FLAG_TYPES = ["phone_visible", "book_visible", "extra_laptop", "second_person", "camera_blocked"]
SIDECAR_FLAG_TYPES = ["looking_away", "looking_away_while_typing", "off_screen_look", "copy_pattern", "tracking_lost"]

# Key presses (time and category) are needed this long around a chunk: the copy-pattern rule looks 3 s after a look
# ends and measures typing over the next 10 s.
KEY_MARGIN_S = 13.0

# How much a flag should worry a reviewer. copy_pattern is the main flag. phone_visible is minor: real cheating
# is reading from a phone that is NOT shown to the camera. Change here.
SEVERITY = {
    "copy_pattern": "major",
    "second_person": "major",
    "off_screen_look": "moderate",
    "looking_away_while_typing": "moderate",
    "camera_blocked": "moderate",
    "extra_laptop": "moderate",
    "book_visible": "minor",
    "phone_visible": "minor",
    "looking_away": "minor",
    "tracking_lost": "info",
}
