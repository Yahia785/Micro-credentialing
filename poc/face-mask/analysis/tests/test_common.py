import json

import pytest

import common
from common import fps_stats, load_labels, load_sidecar, look_away_events, lost_percent, lost_segments


def frames(spec, fps=20):
    """spec: list of (start_s, end_s, dict of fields) painted over a neutral 0..30 s timeline."""
    out = []
    for i in range(int(30 * fps)):
        t = i / fps
        f = {"type": "frame", "t": t * 1000, "faces": 1, "lost": False, "yaw": 0.0, "gazeH": 0.0}
        for a, b, fields in spec:
            if a <= t < b:
                f.update(fields)
        out.append(f)
    return out


YAW = {"yaw": 40.0}
GAZE = {"gazeH": -0.8}
LOST = {"lost": True, "faces": 0, "yaw": None, "gazeH": None}


def near(events, expected, tol=0.1):
    assert len(events) == len(expected), events
    for (a, b), (ea, eb) in zip(events, expected):
        assert a == pytest.approx(ea, abs=tol) and b == pytest.approx(eb, abs=tol)


def test_long_turn_counts():
    near(look_away_events(frames([(5, 8, YAW)])), [(5, 8)])


def test_gaze_only_counts():
    near(look_away_events(frames([(5, 7, GAZE)])), [(5, 7)])


def test_glance_shorter_than_1s_does_not_count():
    assert look_away_events(frames([(5, 5.8, YAW)])) == []


def test_thresholds_are_strict():
    assert look_away_events(frames([(5, 9, {"yaw": 25.0, "gazeH": 0.5}) ])) == []


def test_gap_under_half_second_is_merged():
    # two 0.8 s runs separated by 0.3 s: alone neither counts, merged they do
    near(look_away_events(frames([(5, 5.8, YAW), (6.1, 6.9, YAW)])), [(5, 6.9)])


def test_gap_of_half_second_or_more_splits():
    assert look_away_events(frames([(5, 6.5, YAW), (7.1, 8.6, YAW)])) != []
    near(look_away_events(frames([(5, 6.5, YAW), (7.1, 8.6, YAW)])), [(5, 6.45), (7.1, 8.55)])


def test_tracking_lost_gap_is_bridged_but_not_counted_as_away():
    f = frames([(5, 8, YAW), (6.0, 6.3, LOST)])
    near(look_away_events(f), [(5, 8)])  # short lost gap merges the two halves
    assert lost_segments(f) == [pytest.approx((6.0, 6.25), abs=0.1)]


def test_long_lost_period_alone_is_not_a_look_away():
    f = frames([(5, 9, LOST)])
    assert look_away_events(f) == []
    assert lost_percent(f) == pytest.approx(100 * 4 / 30, abs=0.5)


def test_long_lost_gap_splits_events():
    f = frames([(5, 7, YAW), (7, 8, LOST), (8, 10, YAW)])
    near(look_away_events(f), [(5, 6.95), (8, 9.95)])


def test_sidecar_and_labels_roundtrip(tmp_path):
    p = tmp_path / "sidecar-x_normal_1.jsonl"
    lines = [{"type": "header", "id": "x"}, {"type": "frame", "t": 0, "lost": False, "yaw": 1, "gazeH": 0, "procMs": 5},
             {"type": "key", "t": 500}, {"type": "frame", "t": 50, "lost": False, "yaw": 1, "gazeH": 0, "procMs": 5},
             {"type": "summary", "frames": 2, "lostFrames": 0, "durationS": 0.05, "avgFps": 40, "p10Fps": 20}]
    p.write_text("\n".join(json.dumps(x) for x in lines))
    sc = load_sidecar(p)
    assert len(sc.frames) == 2 and sc.keys == [0.5] and sc.header["id"] == "x"
    assert load_labels(p) is None
    (tmp_path / "sidecar-x_normal_1.labels.csv").write_text("start_s,end_s,label\n3,5,look-away\n")
    assert load_labels(p) == [(3.0, 5.0, "look-away")]


def test_fps_stats():
    avg, p10 = fps_stats([{"t": i * 50} for i in range(101)])
    assert avg == pytest.approx(20) and p10 == pytest.approx(20)


def test_rule_constants():
    assert (common.YAW_LIMIT_DEG, common.GAZE_H_LIMIT, common.MIN_DURATION_S, common.MERGE_GAP_S) == (25.0, 0.5, 1.0, 0.5)
