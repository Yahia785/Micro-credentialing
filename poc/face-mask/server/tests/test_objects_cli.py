import json
import sys
from pathlib import Path

import numpy as np
import pytest

from analyzer import config
from analyzer.cli import main as cli_main
from analyzer.core import Options, analyze_chunk, merge_flags
from analyzer.model import decode, letterbox
from helpers import FakeDetector, HEADER, sidecar_frames, textured, write_video

MODEL = config.DEFAULT_MODEL_PATH


# ---- letterbox and decode (pure, no model) -------------------------------------------------------

def test_letterbox_shape_and_padding():
    blob, ratio, (px, py) = letterbox(np.full((720, 1280, 3), 200, np.uint8), 640)
    assert blob.shape == (1, 3, 640, 640) and blob.dtype == np.float32
    assert ratio == 0.5 and px == 0 and py == 140
    assert blob[0, 0, 0, 0] == pytest.approx(114 / 255)       # grey padding at the top
    assert blob[0, 0, 320, 320] == pytest.approx(200 / 255)


def fake_output(rows):
    """YOLO11 output (1, 84, n): rows = (cx, cy, w, h, class_id, score) in 640x640 input pixels."""
    out = np.zeros((1, 84, len(rows)), np.float32)
    for i, (cx, cy, w, h, cid, sc) in enumerate(rows):
        out[0, 0:4, i] = (cx, cy, w, h)
        out[0, 4 + cid, i] = sc
    return out


def test_decode_maps_boxes_back_filters_classes_and_applies_nms():
    # frame 1280x720 -> ratio 0.5, pad (0, 140). A phone at input (320,320) size 100x200 -> original box.
    out = fake_output([
        (320, 320, 100, 200, 67, 0.9),     # cell phone
        (322, 322, 100, 200, 67, 0.8),     # duplicate of the same phone: removed by NMS
        (100, 300, 80, 160, 0, 0.7),       # person
        (500, 300, 80, 160, 0, 0.3),       # below the confidence threshold
        (200, 200, 50, 50, 2, 0.95),       # a car: not a reported class
    ])
    dets = decode(out, 0.5, (0.0, 140.0), (720, 1280))
    labels = sorted(d.label for d in dets)
    assert labels == ["cell phone", "person"]
    phone = next(d for d in dets if d.label == "cell phone")
    x, y, w, h = phone.box
    assert (x, y, w, h) == pytest.approx((540.0, 160.0, 200.0, 400.0))
    assert phone.score == pytest.approx(0.9)


# ---- analyze_chunk with a fake detector -------------------------------------------------------------

def run_fake(tmp_path, script, seconds=12, chunk_start=0.0, name="v.avi"):
    p = write_video(tmp_path / name, lambda t: textured(seed=int(t * 7)), seconds)
    det = FakeDetector(script)
    return analyze_chunk(p, [], chunk_start, options=Options(detector=det))


def test_phone_flag_with_evidence_counts(tmp_path):
    # samples every 0.5 s; phone in samples 6..13 except sample 9 (a miss): 8 samples, 7 hits
    script = {i: ["cell phone"] for i in range(6, 14) if i != 9}
    out = merge_flags([run_fake(tmp_path, script, 12)])
    assert [f["type"] for f in out] == ["phone_visible"]
    f = out[0]
    assert f["start_s"] == pytest.approx(3.0) and f["end_s"] == pytest.approx(7.0)
    assert f["evidence"] == "cell phone box in 7 of 8 sampled frames"
    assert f["confidence"] == pytest.approx(0.8)


def test_second_person_needs_more_than_one_person_box(tmp_path):
    one = merge_flags([run_fake(tmp_path, {i: ["person"] for i in range(0, 20)}, 12)])
    assert one == []
    two = merge_flags([run_fake(tmp_path, {i: ["person", "person"] for i in range(4, 12)}, 12, name="w.avi")])
    assert [f["type"] for f in two] == ["second_person"]


def test_book_and_extra_laptop_have_their_own_types_and_minimums(tmp_path):
    script = {i: ["book", "laptop"] for i in range(2, 9)}      # 3.5 s each
    out = merge_flags([run_fake(tmp_path, script, 12)])
    assert sorted(f["type"] for f in out) == ["book_visible", "extra_laptop"]
    short = {i: ["book"] for i in range(2, 4)}                 # 1.0 s < 2.0 s
    assert merge_flags([run_fake(tmp_path, short, 12, name="s.avi")]) == []


def test_object_flag_crossing_two_chunks(tmp_path):
    # phone visible in the last 1.0 s of chunk 0 and the first 1.0 s of chunk 1 (each alone < 1.5 s)
    a = run_fake(tmp_path, {i: ["cell phone"] for i in range(18, 20)}, 10, 0.0, "a.avi")
    b = run_fake(tmp_path, {i: ["cell phone"] for i in range(0, 2)}, 10, 10.0, "b.avi")
    assert merge_flags([a]) == [] and merge_flags([b]) == []
    both = merge_flags([a, b])
    assert len(both) == 1 and both[0]["start_s"] == pytest.approx(9.0) and both[0]["end_s"] == pytest.approx(11.0)


def test_flags_file_content_has_no_images(tmp_path):
    out = merge_flags([run_fake(tmp_path, {i: ["cell phone"] for i in range(2, 10)}, 12)])
    text = json.dumps(out)
    assert "data:image" not in text and "base64" not in text
    assert set(out[0]) == {"type", "start_s", "end_s", "confidence", "source", "evidence"}


# ---- CLI end to end ------------------------------------------------------------------------------------

def make_session(tmp_path, seconds=130):
    video = write_video(tmp_path / "masked-t_normal_1.avi", lambda t: textured(seed=int(t * 3)), seconds, fps=4)
    frames = sidecar_frames(seconds, away=[(57, 63, 0.9)], lost=[(100, 104)])
    keys = [58.0, 62.0]
    header = {**HEADER, "recorderStartMs": {"masked": 0.0}}
    lines = [header] + frames + [{"type": "key", "t": k * 1000} for k in keys]
    sidecar = tmp_path / "sidecar-t_normal_1.jsonl"
    sidecar.write_text("\n".join(json.dumps(x) for x in lines), encoding="utf-8")
    return video, sidecar


def test_cli_without_objects_end_to_end(tmp_path, capsys):
    video, sidecar = make_session(tmp_path)
    out = tmp_path / "out"
    rc = cli_main([str(video), str(sidecar), "--out", str(out), "--no-objects", "--chunk-s", "60"])
    assert rc == 0
    doc = json.loads((out / "flags-t_normal_1.json").read_text(encoding="utf-8"))
    assert doc["session_id"] == "t_normal_1" and doc["analyzer_version"] == config.ANALYZER_VERSION
    assert doc["model"] is None and doc["video"]["chunks"] == 3
    assert "thresholds" in doc and doc["thresholds"]["look_away"]["eye_thresholds"] == "fixed"
    got = {f["type"]: f for f in doc["flags"]}
    assert set(got) == {"looking_away", "looking_away_while_typing", "tracking_lost"}
    assert got["looking_away"]["start_s"] == pytest.approx(57.0, abs=0.3)       # crosses the 60 s chunk boundary
    assert got["looking_away"]["end_s"] == pytest.approx(62.9, abs=0.3)
    assert got["tracking_lost"]["start_s"] == pytest.approx(100.0, abs=0.6)
    assert "s per minute of video" in capsys.readouterr().out


def test_cli_missing_files_and_model(tmp_path, capsys):
    assert cli_main([str(tmp_path / "nope.webm"), str(tmp_path / "nope.jsonl")]) == 1
    video, sidecar = make_session(tmp_path, seconds=10)
    assert cli_main([str(video), str(sidecar), "--model", str(tmp_path / "missing.onnx")]) == 1
    assert "Model not found" in capsys.readouterr().err


# ---- with the real model (skipped until scripts/export_model.py was run) --------------------------------

needs_model = pytest.mark.skipif(not MODEL.exists(), reason="run scripts/export_model.py first")
ASSET = Path(__file__).resolve().parent.parent / "out" / "zidane.jpg"


@needs_model
@pytest.mark.skipif(not ASSET.exists(), reason="server/out/zidane.jpg is needed (copied from the ultralytics assets)")
def test_real_model_finds_the_second_person(tmp_path):
    import cv2

    img = cv2.resize(cv2.imread(str(ASSET)), (640, 360))
    p = write_video(tmp_path / "z.avi", lambda t: img, 8, fps=4, size=(640, 360))
    out = merge_flags([analyze_chunk(p, [], 0.0, options=Options(use_objects=True))])
    assert [f["type"] for f in out] == ["second_person"]
    assert out[0]["end_s"] - out[0]["start_s"] >= 7.0


@needs_model
def test_real_model_module_does_not_import_ultralytics_or_torch():
    import analyzer.model  # noqa: F401

    assert "ultralytics" not in sys.modules and "torch" not in sys.modules
