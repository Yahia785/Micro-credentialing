import json
import subprocess
import sys
from pathlib import Path

import pytest

import common
import speed_report
from common import Thresholds, hysteresis_runs, speed_label, thresholds_for, thresholds_from_edges

ANALYSIS = Path(__file__).resolve().parent.parent


# ---- calibrated thresholds -------------------------------------------------------------

def test_symmetric_person():
    th = thresholds_from_edges(0.2, 0.07, 0.33)          # edges +/-0.13 from the baseline
    assert th.enter_pos == pytest.approx(0.195) and th.enter_neg == pytest.approx(0.195)
    assert th.exit_pos == pytest.approx(0.195 * 0.7)
    assert th.exit_neg == pytest.approx(0.195 * 0.7)


def test_left_and_right_sides_are_separate():
    th = thresholds_from_edges(0.2, 0.12, 0.45)          # d = -0.08 (left) and +0.25 (right)
    assert th.enter_pos == pytest.approx(1.5 * 0.25)
    assert th.enter_neg == pytest.approx(0.15)           # 1.5 * 0.08 = 0.12 < minimum 0.15
    assert th.exit_pos == pytest.approx(1.5 * 0.25 * 0.7)
    assert th.exit_neg == pytest.approx(0.15 * 0.7)


def test_which_edge_is_which_does_not_matter_only_the_sign():
    a = thresholds_from_edges(0.0, -0.1, 0.4)
    b = thresholds_from_edges(0.0, 0.4, -0.1)            # edges swapped (image-mirrored calibration)
    assert a == b
    assert a.enter_pos == pytest.approx(0.6) and a.enter_neg == pytest.approx(0.15)


def test_minimum_enter_distance_stops_jitter_from_triggering():
    th = thresholds_from_edges(0.0, -0.02, 0.02)
    assert th.enter_pos == 0.15 and th.enter_neg == 0.15
    assert th.exit_pos == pytest.approx(0.105)


def test_one_usable_side_is_mirrored_and_nothing_usable_is_none():
    th = thresholds_from_edges(0.0, 0.2, 0.3)            # both edges on the positive side
    assert th.enter_pos == pytest.approx(0.45) and th.enter_neg == pytest.approx(0.45)
    assert thresholds_from_edges(0.0, None, None) is None
    assert thresholds_from_edges(None, 0.1, 0.2) is None
    assert thresholds_from_edges(0.0, 0.0, 0.0) is None


def test_constants():
    assert (common.EDGE_FACTOR, common.MIN_ENTER, common.EXIT_RATIO) == (1.5, 0.15, 0.7)
    assert common.THRESHOLDS_MODE == "fixed"


def test_asymmetric_thresholds_in_runs():
    th = Thresholds(enter_pos=0.375, exit_pos=0.26, enter_neg=0.15, exit_neg=0.10)
    times = [i * 0.1 for i in range(30)]
    # +0.2 for 3 s: below the positive enter threshold -> nothing.  -0.2 for 3 s: above the negative one -> one run.
    assert hysteresis_runs(times, [0.2] * 30, th) == []
    assert hysteresis_runs(times, [-0.2] * 30, th) == [[0.0, pytest.approx(2.9)]]


def test_exit_ratio_keeps_the_run_alive():
    th = Thresholds(0.375, 0.26, 0.375, 0.26)
    times = [i * 0.1 for i in range(20)]
    vals = [0.4] * 3 + [0.3] * 12 + [0.2] * 5            # enters at 0.4, stays above exit 0.26, ends at 0.2
    runs = hysteresis_runs(times, vals, th)
    assert len(runs) == 1 and runs[0][1] == pytest.approx(1.4)


def test_flip_between_sides_is_a_new_run():
    th = Thresholds.symmetric(0.5, 0.35)
    runs = hysteresis_runs([0, 1, 2, 3], [0.6, 0.6, -0.6, -0.6], th)
    assert runs == [[0, 1], [2, 3]]


def _frames(vals, fps=10):
    return [{"type": "frame", "t": i * 1000 / fps, "lost": False, "yaw": 0.0, "gazeH": v} for i, v in enumerate(vals)]


def _sidecar(tmp_path, left, right, base=0.0):
    p = tmp_path / "sidecar-x_normal_1.jsonl"
    hdr = {"type": "header", "scenario": "normal",
           "calibration": {"baseline": {"yaw": 0.0, "gazeH": base},
                           "edges": {"left": {"gazeH": left}, "right": {"gazeH": right}}}}
    p.write_text("\n".join(json.dumps(x) for x in [hdr] + _frames([0.0] * 10 + [0.25] * 30)))
    return common.load_sidecar(p)


def test_calibrated_catches_a_small_edge_look_that_fixed_misses(tmp_path):
    sc = _sidecar(tmp_path, left=-0.13, right=0.13)      # +/-0.13 at the screen edges, as on the real Dell G3
    assert common.sidecar_events(sc, thresholds_mode="fixed") == []
    ev = common.sidecar_events(sc, thresholds_mode="calibrated")   # enter 0.195 < 0.25
    assert len(ev) == 1 and ev[0][0] == pytest.approx(1.0)


def test_calibrated_uses_each_side_separately(tmp_path):
    # person who looks far to the right (+0.4) but only a little to the left (-0.1): +0.25 is NOT a look-away
    sc = _sidecar(tmp_path, left=-0.1, right=0.4)
    assert common.sidecar_events(sc, thresholds_mode="calibrated") == []   # enter_pos = 0.6


def test_thresholds_for_text_and_fallback(tmp_path):
    sc = _sidecar(tmp_path, left=-0.13, right=0.13)
    th, text = thresholds_for(sc, mode="calibrated")
    assert text.startswith("calibrated") and th.enter_pos == pytest.approx(0.195)
    assert thresholds_for(sc, mode="fixed")[1].startswith("fixed")
    sc.header["calibration"].pop("edges")
    th2, text2 = thresholds_for(sc, mode="calibrated")
    assert th2 == common.FIXED_THRESHOLDS and "unavailable" in text2
    with pytest.raises(ValueError):
        thresholds_for(sc, mode="nope")


# ---- test 1 labels and speed report ------------------------------------------------------

@pytest.mark.parametrize("fps,label", [(25, "PASS"), (15.0, "PASS"), (14.99, "OK (minimum)"), (12, "OK (minimum)"),
                                       (10.0, "OK (minimum)"), (9.99, "FAIL"), (3, "FAIL")])
def test_speed_label(fps, label):
    assert speed_label(fps) == label


def _write_recording(folder: Path, name: str, fps: float):
    lines = [{"type": "header", "scenario": "normal", "delegate": "CPU", "detectLongSide": 640}]
    for i in range(int(fps * 20)):
        lines.append({"type": "frame", "t": i * 1000 / fps, "lost": False, "procMs": 50, "detectMs": 30})
    (folder / f"sidecar-{name}.jsonl").write_text("\n".join(json.dumps(x) for x in lines))


def _run(script, *args):
    return subprocess.run([sys.executable, str(ANALYSIS / script), *map(str, args)], capture_output=True, text=True)


def test_test1_script_labels_and_exit_codes(tmp_path):
    _write_recording(tmp_path, "a_normal_1", 20)
    r = _run("test1_speed.py", tmp_path)
    assert r.returncode == 0 and "PASS" in r.stdout and "Overall: PASS" in r.stdout

    _write_recording(tmp_path, "b_normal_2", 12)
    r = _run("test1_speed.py", tmp_path)
    assert r.returncode == 0 and "OK (minimum)" in r.stdout and "Overall: OK (minimum)" in r.stdout

    _write_recording(tmp_path, "c_normal_3", 6)
    r = _run("test1_speed.py", tmp_path)
    assert r.returncode == 2 and "FAIL" in r.stdout and "Overall: FAIL" in r.stdout


def test_speed_report_table_and_errors(tmp_path):
    data = {"laptop": "dell", "time": "t", "measuredSeconds": 15, "results": [
        {"delegate": "GPU", "detect": 640, "available": True, "frames": 240, "lostFrames": 0, "avgFps": 16.2, "p10Fps": 13.1,
         "meanDetectMs": 49.0, "std": {"yawRaw": 1.2, "yaw": 0.5, "gazeHRaw": 0.09, "gazeH": 0.03, "blendHRaw": None, "blendH": None}},
        {"delegate": "CPU", "detect": 640, "available": True, "frames": 100, "lostFrames": 3, "avgFps": 8.0, "p10Fps": 6.0,
         "meanDetectMs": 120.0, "std": {}},
        {"delegate": "GPU", "detect": 320, "available": False, "note": "GPU not available", "std": {}},
    ]}
    text = speed_report.format_table(data)
    assert "PASS" in text and "FAIL" in text and "GPU not available" in text
    assert "1.20 / 0.50" in text and "-" in text
    assert "Largest tracking size reaching 15 fps on GPU: 640 px" in text
    assert "on CPU: none" in text

    f = tmp_path / "speedtest-dell-1.json"
    f.write_text(json.dumps(data))
    r = _run("speed_report.py", f)
    assert r.returncode == 0 and "dell" in r.stdout
    empty = tmp_path / "empty"
    empty.mkdir()
    r = _run("speed_report.py", empty)
    assert r.returncode == 1 and "No speedtest" in r.stderr
