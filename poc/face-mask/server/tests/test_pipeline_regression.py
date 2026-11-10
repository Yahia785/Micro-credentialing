"""Guards for the things that silently make an object detector see nothing:
colour order, letterbox/scale maths, class ids, sampling, and a REAL phone through the whole path."""
import ast
from pathlib import Path

import cv2
import numpy as np
import pytest

from analyzer import config
from analyzer.core import Options, analyze_chunk, iter_samples, merge_flags
from analyzer.model import decode, letterbox, load_detector
from helpers import textured, write_video

MODEL = config.DEFAULT_MODEL_PATH
PHONE_IMG = Path(__file__).resolve().parent.parent / "out" / "coco" / "000000001296.jpg"
needs_model = pytest.mark.skipif(not MODEL.exists(), reason="run scripts/export_model.py first")
needs_phone = pytest.mark.skipif(not PHONE_IMG.exists(), reason="run scripts/fetch_test_image.py first")


# ---- colour order (BGR from OpenCV -> RGB for the model) -----------------------------------------

def test_letterbox_gives_rgb_channels():
    bgr = np.zeros((360, 640, 3), np.uint8)
    bgr[:, :, 0], bgr[:, :, 1], bgr[:, :, 2] = 10, 120, 250      # B, G, R
    blob, _, _ = letterbox(bgr, 640)
    centre = blob[0, :, 320, 320] * 255
    assert centre == pytest.approx([250, 120, 10], abs=1)         # channel 0 must be RED


# ---- scale and padding maths for every aspect ratio -----------------------------------------------

@pytest.mark.parametrize("w,h", [(1280, 720), (720, 1280), (640, 640), (1920, 1080), (320, 240), (800, 300)])
def test_boxes_survive_letterbox_and_decode_for_any_frame_shape(w, h):
    """Put a box in the ORIGINAL frame, map it into the model input the way letterbox does, decode, expect it back."""
    _, ratio, (padx, pady) = letterbox(np.zeros((h, w, 3), np.uint8), 640)
    bx, by, bw, bh = w * 0.30, h * 0.20, w * 0.25, h * 0.40       # x, y, w, h in the original frame
    cx = (bx + bw / 2) * ratio + padx
    cy = (by + bh / 2) * ratio + pady
    out = np.zeros((1, 84, 1), np.float32)
    out[0, 0:4, 0] = (cx, cy, bw * ratio, bh * ratio)
    out[0, 4 + 67, 0] = 0.9
    dets = decode(out, ratio, (padx, pady), (h, w))
    assert [d.label for d in dets] == ["cell phone"]
    assert dets[0].box == pytest.approx((bx, by, bw, bh), abs=2.0)


# ---- class ids must match the model's own class names --------------------------------------------------

@needs_model
def test_reported_class_ids_match_the_model_metadata():
    det = load_detector(str(MODEL))
    names = {int(k): v for k, v in ast.literal_eval(det.session.get_modelmeta().custom_metadata_map["names"]).items()}
    for cid, label in config.CLASSES.items():
        assert names[cid] == label, f"class id {cid} is '{names[cid]}' in the model but '{label}' in config.CLASSES"
    assert det.session.get_outputs()[0].shape[1] == 4 + len(names)


# ---- sampling: about 2 per second whatever the video frame rate -----------------------------------------------

@pytest.mark.parametrize("fps", [10, 25, 30])
def test_sampling_gives_two_frames_per_second(tmp_path, fps):
    p = write_video(tmp_path / "v.avi", lambda t: textured(seed=int(t * 5)), 20, fps=fps)
    ts = [t for t, _ in iter_samples(p)]
    assert 38 <= len(ts) <= 41                                    # 20 s x 2 per second
    gaps = np.diff(ts)
    assert gaps.max() < 0.5 + 1.5 / fps and gaps.min() > 0.5 - 1.5 / fps


# ---- a REAL phone through the whole path (positive control) -----------------------------------------------------

@needs_model
@needs_phone
def test_real_model_sees_a_real_phone_in_the_coco_image():
    det = load_detector(str(MODEL))
    dets = det.detect(cv2.imread(str(PHONE_IMG)), config.OBJECT_CONF)
    assert any(d.label == "cell phone" for d in dets), [(d.label, round(d.score, 2)) for d in dets]


@needs_model
@needs_phone
def test_phone_in_the_video_becomes_a_phone_visible_flag(tmp_path):
    img = cv2.imread(str(PHONE_IMG))
    size = (img.shape[1], img.shape[0])
    p = write_video(tmp_path / "phone.avi", lambda t: img, 6, fps=10, size=size)
    out = merge_flags([analyze_chunk(p, [], 0.0, options=Options(use_objects=True))])
    assert "phone_visible" in [f["type"] for f in out], out
    f = next(f for f in out if f["type"] == "phone_visible")
    assert f["end_s"] - f["start_s"] >= 5.5 and "cell phone box" in f["evidence"]
