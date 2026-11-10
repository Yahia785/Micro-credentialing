import json

import pytest

import common
from common import (Box, build_zones, copy_patterns, find_cycles, gaze_series, load_labels_ex, load_sidecar,
                    offscreen_direction, offscreen_events, typing_features)


def point(h, v, yaw, pitch):
    return {"yaw": yaw, "pitch": pitch, "gazeH": h, "gazeV": v, "blendH": h, "blendV": v}


def header(left_positive=True, top=True, keyboard=True):
    """A calibration. left_positive: the LEFT dot gives the larger horizontal reading (the usual case: image-right = student's left)."""
    s = 1 if left_positive else -1
    edges = {
        "left": point(0.5 * s + 0.05 * (1 - s) / 2, 0.1, 12 * s, 10),
        "right": point(-0.35 * s + 0.05 * (1 - s) / 2, 0.1, -12 * s, 10),
    }
    if top:
        edges["top"] = point(0.05, -0.3, 0, 3)
        edges["bottom"] = point(0.05, 0.5, 0, 17)
    if keyboard:
        edges["keyboard"] = point(0.05, 0.8, 0, 28)
    return {"calibration": {"baseline": point(0.05, 0.1, 0, 10), "edges": edges}}


Z = build_zones(header())


# ---- zones ----------------------------------------------------------------------------------------

def test_screen_zone_is_the_box_over_the_readings_plus_margin():
    assert Z.note == "calibrated"
    assert (Z.gaze.lo_a, Z.gaze.hi_a) == pytest.approx((-0.35 - 0.15, 0.5 + 0.15))
    assert (Z.gaze.lo_b, Z.gaze.hi_b) == pytest.approx((-0.3 - 0.15, 0.5 + 0.15))
    assert (Z.head.lo_a, Z.head.hi_a) == pytest.approx((-12 - 8, 12 + 8))
    assert (Z.head.lo_b, Z.head.hi_b) == pytest.approx((3 - 8, 17 + 8))


def test_keyboard_zone_is_around_the_keyboard_reading():
    assert (Z.kb_gaze.lo_a, Z.kb_gaze.hi_a) == pytest.approx((0.05 - 0.25, 0.05 + 0.25))
    assert (Z.kb_gaze.lo_b, Z.kb_gaze.hi_b) == pytest.approx((0.8 - 0.25, 0.8 + 0.25))
    assert (Z.kb_head.lo_b, Z.kb_head.hi_b) == pytest.approx((28 - 10, 28 + 10))


def test_no_calibration_no_zones():
    assert build_zones({}) is None
    assert build_zones({"calibration": {}}) is None


def test_missing_top_bottom_and_keyboard_falls_back_and_says_so():
    z = build_zones(header(top=False, keyboard=False))
    assert "vertical gaze" in z.note and "no keyboard zone" in z.note and z.kb_gaze is None
    assert z.gaze.lo_b == pytest.approx(0.1 - common.FALLBACK_GAZE_V_HALF - common.ZONE_GAZE_MARGIN)
    assert z.gaze.hi_a == pytest.approx(0.5 + common.ZONE_GAZE_MARGIN)    # horizontal came from the real readings


def test_box_worst_axis_and_side():
    b = Box(0, 10, 0, 10)
    assert b.contains(5, 5) and not b.contains(11, 5)
    assert b.worst(5, 5) == ("a", 0, 0.0)
    axis, side, ex = b.worst(15, 5)
    assert (axis, side) == ("a", 1) and ex == pytest.approx(0.5)
    axis, side, ex = b.worst(5, -4)
    assert (axis, side) == ("b", -1) and ex == pytest.approx(0.4)
    assert b.worst(13, -2)[0:2] == ("a", 1)                       # the larger excess wins


# ---- direction ------------------------------------------------------------------------------------------

def d(h, v, yaw=0.0, pitch=10.0, z=Z):
    return offscreen_direction(h, v, yaw, pitch, z)


def test_on_screen_is_not_off_screen():
    assert d(0.05, 0.1) is None
    assert d(0.5, 0.1) is None                                    # the left dot itself
    assert d(0.05, -0.3) is None                                  # the top dot


def test_directions_from_gaze():
    assert d(0.95, 0.1) == ("left", "gaze")                       # left dot has the larger reading, so larger = left
    assert d(-0.8, 0.1) == ("right", "gaze")
    assert d(0.05, -0.9) == ("up", "gaze")
    assert d(0.05, 1.5) == ("down", "gaze")


def test_directions_from_head():
    assert d(0.05, 0.1, yaw=-35) == ("right", "head")
    assert d(0.05, 0.1, yaw=35) == ("left", "head")
    assert d(0.05, 0.1, pitch=-20) == ("up", "head")
    assert d(0.05, 0.1, pitch=45) == ("down", "head")


def test_keyboard_zone_is_not_off_screen_but_next_to_it_is():
    assert d(0.05, 0.85, pitch=28) is None                        # looking at the keyboard
    assert d(0.05, 0.85, pitch=10) is None                        # gaze at the keyboard, head still up
    assert d(0.6, 0.9, pitch=28) == ("down", "gaze")              # low, but too far right for the keyboard and below the screen
    assert d(0.05, 1.6, pitch=28) == ("down", "gaze")             # below even the keyboard
    assert d(0.05, 0.1, pitch=28) is None                         # head down at the keyboard, gaze on screen


def test_without_a_keyboard_zone_the_keyboard_is_off_screen():
    z = build_zones(header(keyboard=False))
    assert offscreen_direction(0.05, 0.85, 0, 28, z) == ("down", "gaze")


def test_the_further_outside_modality_names_the_direction():
    out = d(0.75, 0.1, yaw=-45)                                   # gaze slightly left of the box, head far right
    assert out == ("right", "head")


def test_direction_comes_from_the_calibration_not_from_a_sign_convention():
    z = build_zones(header(left_positive=False))                  # a person whose LEFT dot gives the SMALLER reading
    assert z.h_left_positive is False and z.yaw_left_positive is False
    lo = z.gaze.lo_a - 0.5
    hi = z.gaze.hi_a + 0.5
    assert offscreen_direction(lo, 0.1, 0, 10, z) == ("left", "gaze")
    assert offscreen_direction(hi, 0.1, 0, 10, z) == ("right", "gaze")


def test_vertical_direction_follows_the_top_and_bottom_dots():
    h = header()
    h["calibration"]["edges"]["top"], h["calibration"]["edges"]["bottom"] = (h["calibration"]["edges"]["bottom"], h["calibration"]["edges"]["top"])
    z = build_zones(h)                                            # top and bottom readings swapped: up is now the larger value
    assert z.v_up_positive is True
    assert offscreen_direction(0.05, z.gaze.hi_b + 0.5, 0, 10, z)[0] == "up"


# ---- off-screen events -----------------------------------------------------------------------------------

def frames(seconds, fps=20, bursts=(), lost=()):
    """bursts: (start, end, h, v). On-screen otherwise. yaw and pitch stay at the centre."""
    out = []
    for i in range(int(seconds * fps)):
        t = i / fps
        h, v = 0.05, 0.1
        for a, b, hh, vv in bursts:
            if a <= t < b:
                h, v = hh, vv
        is_lost = any(a <= t < b for a, b in lost)
        out.append({"type": "frame", "t": t * 1000, "lost": is_lost, "yaw": None if is_lost else 0.0, "pitch": None if is_lost else 10.0,
                    "blendH": None if is_lost else h, "blendV": None if is_lost else v})
    return out


def test_off_screen_look_needs_1_5_seconds():
    assert offscreen_events(frames(30, bursts=[(10, 11.2, 0.05, 1.6)]), Z) == []
    ev = offscreen_events(frames(30, bursts=[(10, 12, 0.05, 1.6)]), Z)
    assert len(ev) == 1 and ev[0]["direction"] == "down"
    assert ev[0]["start"] == pytest.approx(10.0) and ev[0]["end"] == pytest.approx(11.95)


def test_off_screen_gaps_under_half_a_second_are_merged_and_lost_frames_do_not_count():
    f = frames(30, bursts=[(10, 11, 0.05, 1.6), (11.3, 12.5, 0.05, 1.6)])
    assert len(offscreen_events(f, Z)) == 1
    assert offscreen_events(frames(30, lost=[(10, 14)]), Z) == []


def test_direction_of_an_event_is_the_most_frequent_one():
    f = frames(30, bursts=[(10, 12.5, 0.95, 0.1), (12.5, 13, 0.05, 1.6)])
    ev = offscreen_events(f, Z)
    assert len(ev) == 1 and ev[0]["direction"] == "left" and set(ev[0]["dirs"]) == {"left", "down"}


# ---- vertical gaze for sidecars made before blendV existed -------------------------------------------------------

def test_blend_v_is_derived_from_the_eyelook_scores_when_missing():
    fr = []
    for i in range(60):
        down = 0.8 if i >= 20 else 0.0
        fr.append({"t": i * 50, "lost": False, "blendH": 0.0, "eyeLookDownLeft": down, "eyeLookDownRight": down,
                   "eyeLookUpLeft": 0.0, "eyeLookUpRight": 0.0})
    hs, vs, derived = gaze_series(fr, "blend", True)
    assert derived is True and vs[0] == pytest.approx(0.0)
    assert 0 < vs[21] < 0.8 and vs[-1] == pytest.approx(0.8, abs=0.02)      # smoothed, converges
    _, raw, _ = gaze_series(fr, "blend", False)
    assert raw[21] == pytest.approx(0.8)


def test_existing_blend_v_is_used_as_is():
    fr = [{"t": 0, "lost": False, "blendH": 0.0, "blendV": 0.3, "blendVRaw": 0.5}]
    assert gaze_series(fr, "blend", True)[1] == [0.3] and gaze_series(fr, "blend", False)[1] == [0.5]


# ---- typing features ----------------------------------------------------------------------------------------------

def keys(times, cat="char"):
    return [(t, cat) for t in times]


def test_typing_features_continuous_typing():
    ev = keys([100 + i * 0.25 for i in range(40)])            # 4 keys per second for 10 s
    f = typing_features(ev, 100)
    assert f["keys"] == 40 and f["keys_per_s"] == 4.0 and f["pauses"] == 0 and f["backspace_ratio"] == 0.0


def test_typing_features_pauses_and_backspace_ratio():
    ev = keys([100.2, 100.4, 100.6]) + [(100.8, "backspace")] + keys([103.0, 103.2]) + [(107.5, "backspace")]
    f = typing_features(ev, 100)
    assert f["keys"] == 7 and f["keys_per_s"] == 0.7
    # silences: 100.8 -> 103.0 (2.2 s), 103.2 -> 107.5 (4.3 s), 107.5 -> 110 (2.5 s)
    assert f["pauses"] == 3
    assert f["backspace_ratio"] == pytest.approx(2 / 7, abs=1e-3)


def test_typing_features_empty_window_is_one_long_pause():
    f = typing_features(keys([50.0]), 100)
    assert f == {"t0": 100.0, "keys": 0, "keys_per_s": 0.0, "pauses": 1, "backspace_ratio": None}


def test_typing_features_only_count_the_window():
    f = typing_features(keys([99.9, 100.0, 109.9, 110.0]), 100)
    assert f["keys"] == 2


# ---- cycles and the copy pattern ----------------------------------------------------------------------------------------

def ev(start, end, direction="down"):
    return {"start": start, "end": end, "direction": direction}


def test_a_cycle_is_a_look_followed_by_typing_within_3_seconds():
    k = keys([12.5, 12.6])
    assert len(find_cycles([ev(10, 12)], k)) == 1
    assert find_cycles([ev(10, 12)], keys([15.5])) == []        # typing 3.5 s after the look: not a cycle
    assert find_cycles([ev(10, 12)], keys([9.0, 11.0])) == []   # keys before or during the look: not a cycle
    assert len(find_cycles([ev(10, 12)], keys([15.0]))) == 1    # exactly 3 s after still counts


def test_a_cycle_carries_the_typing_features_of_the_window_after_the_look():
    c = find_cycles([ev(10, 12, "right")], keys([12.5, 13.0, 13.5]) + [(14.0, "backspace")])[0]
    assert c["direction"] == "right" and c["typing_start"] == 12.5
    assert c["features"]["keys"] == 4 and c["features"]["backspace_ratio"] == 0.25


def cyc(starts, directions=None):
    directions = directions or ["down"] * len(starts)
    return [{"start": s, "end": s + 2, "direction": dr, "typing_start": s + 3,
             "features": {"t0": s + 2, "keys": 10, "keys_per_s": 1.0, "pauses": 2, "backspace_ratio": 0.1}} for s, dr in zip(starts, directions)]


def test_three_cycles_within_60_seconds_is_a_copy_pattern():
    out = copy_patterns(cyc([10, 30, 62], ["down", "down", "right"]))
    assert len(out) == 1
    cp = out[0]
    assert cp["n_cycles"] == 3 and cp["directions"] == {"down": 2, "right": 1}
    assert cp["start"] == 10 and cp["end"] == 64
    assert cp["features"] == {"keys_per_s": 1.0, "pauses": 2.0, "backspace_ratio": 0.1}


def test_two_cycles_are_not_enough():
    assert copy_patterns(cyc([10, 30])) == []


def test_three_cycles_spread_over_more_than_60_seconds_are_not_a_pattern():
    assert copy_patterns(cyc([0, 40, 80])) == []                # any window of 60 s holds only two
    assert len(copy_patterns(cyc([0, 40, 59.9]))) == 1          # the first and the third are 59.9 s apart


def test_a_far_away_extra_cycle_is_not_part_of_the_pattern():
    out = copy_patterns(cyc([10, 25, 40, 400]))
    assert len(out) == 1 and out[0]["n_cycles"] == 3


def test_two_separate_patterns():
    out = copy_patterns(cyc([10, 25, 40, 300, 320, 340]))
    assert [c["n_cycles"] for c in out] == [3, 3]


def test_a_longer_chain_of_cycles_is_one_pattern_with_all_cycles():
    out = copy_patterns(cyc([0, 20, 40, 60, 80]))
    assert len(out) == 1 and out[0]["n_cycles"] == 5


def test_constants():
    assert (common.COPY_MIN_CYCLES, common.COPY_WINDOW_S, common.COPY_TYPING_WINDOW_S) == (3, 60.0, 3.0)
    assert common.OFFSCREEN_MIN_DURATION_S == 1.5 and common.TYPING_FEATURE_WINDOW_S == 10.0 and common.TYPING_PAUSE_S == 1.0


# ---- sidecar files and labels --------------------------------------------------------------------------------------------------

def test_key_categories_are_loaded_and_old_files_get_unknown(tmp_path):
    p = tmp_path / "sidecar-x_normal_1.jsonl"
    p.write_text("\n".join(json.dumps(x) for x in [
        {"type": "header"}, {"type": "key", "t": 1500.0, "cat": "backspace"}, {"type": "key", "t": 2000.0},
        {"type": "frame", "t": 0, "lost": False}]))
    sc = load_sidecar(p)
    assert sc.key_events == [(1.5, "backspace"), (2.0, "unknown")] and sc.keys == [1.5, 2.0]


def test_labels_with_a_direction_column(tmp_path):
    p = tmp_path / "sidecar-x_normal_1.jsonl"
    p.write_text("")
    (tmp_path / "sidecar-x_normal_1.labels.csv").write_text("start_s,end_s,label,direction\n10,13,look-away,Down\n20,22,look-away,\n")
    lab = load_labels_ex(p)
    assert lab[0] == {"start": 10.0, "end": 13.0, "label": "look-away", "direction": "down"}
    assert lab[1]["direction"] == ""
    (tmp_path / "sidecar-x_normal_1.labels.csv").write_text("start_s,end_s,label\n10,13,look-away\n")
    assert load_labels_ex(p)[0]["direction"] == ""                # old files without the column still load
    assert common.load_labels(p) == [(10.0, 13.0, "look-away")]


def test_backspace_ratio_is_unknown_when_categories_are_missing():
    f = typing_features([(100.5, "unknown"), (101.0, "unknown")], 100)
    assert f["keys"] == 2 and f["backspace_ratio"] is None
    f2 = typing_features([(100.5, "unknown"), (101.0, "backspace"), (101.5, "char")], 100)
    assert f2["backspace_ratio"] == 0.5                      # only keys with a known category count
