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
    near(look_away_events(frames([(5, 7, GAZE)]), gaze_source="iris"), [(5, 7)])


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
    assert common.GAZE_SOURCE == "blend"
    assert (common.YAW_ENTER_DEG, common.HEAD_MIN_DURATION_S) == (25.0, 1.0)
    assert (common.GAZE_ENTER, common.GAZE_EXIT, common.EYE_MIN_DURATION_S) == (0.5, 0.35, 1.5)
    assert common.MERGE_GAP_S == 0.5


# ---- new rule: baseline, hysteresis, eye duration, gaze source ----------------------

def test_gaze_needs_1_5_seconds():
    assert look_away_events(frames([(5, 6.3, GAZE)]), gaze_source="iris") == []          # 1.3 s: too short for the eyes
    near(look_away_events(frames([(5, 6.8, GAZE)]), gaze_source="iris"), [(5, 6.8)])     # 1.8 s counts


def test_head_needs_only_1_second():
    near(look_away_events(frames([(5, 6.2, YAW)])), [(5, 6.2)])


def test_baseline_is_subtracted_from_yaw():
    f = frames([(5, 8, {"yaw": 30.0})])
    assert look_away_events(f, yaw_base=10.0) == []                   # 30 - 10 = 20 < 25
    near(look_away_events(f, yaw_base=0.0), [(5, 8)])
    assert look_away_events(frames([(5, 8, {"yaw": -30.0})]), yaw_base=-3.0) != []  # |-27| > 25 counts


def test_baseline_is_subtracted_from_gaze():
    f = frames([(5, 8, {"gazeH": 0.6})])
    assert look_away_events(f, gaze_base=0.3, gaze_source="iris") == []                   # 0.3 rel: below enter
    near(look_away_events(f, gaze_base=0.0, gaze_source="iris"), [(5, 8)])


def test_hysteresis_runs_hover_gives_one_run_not_many():
    # alternates 0.52 / 0.42 every frame for 4 s: a plain 0.5 threshold would flicker into ~40 runs
    times = [i * 0.1 for i in range(41)]
    vals = [0.52 if i % 2 == 0 else 0.42 for i in range(41)]
    runs = common.hysteresis_runs(times, vals, 0.5, 0.35)
    assert len(runs) == 1 and runs[0] == pytest.approx([0.0, 4.0])
    naive = common.hysteresis_runs(times, vals, 0.5, 0.5)
    assert len(naive) > 10


def test_hysteresis_value_that_never_reaches_enter_gives_nothing():
    times = [i * 0.1 for i in range(100)]
    assert common.hysteresis_runs(times, [0.49 if i % 2 else 0.4 for i in range(100)], 0.5, 0.35) == []


def test_hysteresis_ends_below_exit():
    times = [i * 0.1 for i in range(30)]
    vals = [0.6] * 10 + [0.3] * 10 + [0.6] * 10
    assert len(common.hysteresis_runs(times, vals, 0.5, 0.35)) == 2


def test_hovering_gaze_in_a_sidecar_is_one_event():
    spec = [(5, 9, {"gazeH": 0.52})] + [(5 + 0.1 * i, 5.05 + 0.1 * i, {"gazeH": 0.42}) for i in range(40) if i % 2]
    near(look_away_events(frames(spec), gaze_source="iris"), [(5, 9)], tol=0.2)


def test_gaze_source_blend_vs_iris():
    f = frames([(5, 8, {"blendH": 0.8})])
    for fr in f:
        fr.setdefault("blendH", 0.0)
    assert look_away_events(f, gaze_source="iris") == []
    assert look_away_events(f) != []                                    # blend is the default source
    near(look_away_events(f, gaze_source="blend"), [(5, 8)])
    with pytest.raises(ValueError):
        look_away_events(f, gaze_source="nope")


def test_raw_vs_smoothed_fields():
    f2 = frames([(5, 8, {"gazeHRaw": 0.8})])
    for fr in f2:
        fr.setdefault("gazeHRaw", 0.0)
    assert look_away_events(f2, smoothed=True, gaze_source="iris") == []                   # smoothed gazeH is 0 everywhere
    near(look_away_events(f2, smoothed=False, gaze_source="iris"), [(5, 8)])


def test_sidecar_events_use_header_baseline(tmp_path):
    p = tmp_path / "sidecar-b_normal_1.jsonl"
    hdr = {"type": "header", "calibration": {"baseline": {"yaw": 12.0, "gazeH": 0.25, "blendH": 0.0}}}
    fr = frames([(5, 8, {"yaw": 34.0, "gazeH": 0.7})])               # yaw rel 22, gaze rel 0.45: neither is away
    p.write_text("\n".join(json.dumps(x) for x in [hdr] + fr))
    sc = load_sidecar(p)
    assert common.baseline_of(sc)["yaw"] == 12.0
    assert common.sidecar_events(sc) == []
    sc.header = {}
    near(common.sidecar_events(sc), [(5, 8)])                           # no baseline -> 0 -> away
