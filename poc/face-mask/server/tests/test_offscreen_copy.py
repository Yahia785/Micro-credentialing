import pytest

from analyzer import config
from analyzer.core import Options, analyze_chunk, merge_flags, slice_frames, slice_keys
from analyzer.sidecar_flags import sidecar_flags
from helpers import ZONE_HEADER, typing_after, zone_frames

NO_MODEL = Options(use_objects=False)
DOWN = (0.05, 1.6)       # gaze below the screen AND the keyboard zone
RIGHT = (-0.9, 0.1)      # gaze far to the student's right


def flags_for(frames, key_events=()):
    keys_s = [t for t, _ in key_events]
    return merge_flags([sidecar_flags(frames, keys_s, ZONE_HEADER, key_events=list(key_events))])


def by_type(flags, t):
    return [f for f in flags if f["type"] == t]


def test_off_screen_look_has_direction_in_the_evidence():
    fr = zone_frames(30, looks=[(10, 13, *DOWN)])
    out = by_type(flags_for(fr), "off_screen_look")
    assert len(out) == 1
    f = out[0]
    assert "looked down for" in f["evidence"] and f["details"]["direction"] == "down" and f["details"]["typing_after"] is False
    assert f["severity"] == "moderate" and f["source"] == "sidecar"


def test_off_screen_direction_right_and_a_short_glance_is_not_a_flag():
    assert by_type(flags_for(zone_frames(30, looks=[(10, 12, *RIGHT)])), "off_screen_look")[0]["details"]["direction"] == "right"
    assert by_type(flags_for(zone_frames(30, looks=[(10, 11.2, *DOWN)])), "off_screen_look") == []


def test_glancing_at_the_keyboard_is_not_off_screen():
    assert flags_for(zone_frames(30, looks=[(10, 14, 0.05, 0.8)])) == []


def test_a_look_followed_by_typing_carries_the_typing_features():
    fr = zone_frames(30, looks=[(10, 13, *DOWN)])
    ke = typing_after(13.0, n=10) + [(14.9, "backspace")]
    f = by_type(flags_for(fr, ke), "off_screen_look")[0]
    assert f["details"]["typing_after"] is True
    feats = f["details"]["typing_features_10s"]
    assert feats["keys"] == 11 and feats["backspace_ratio"] == pytest.approx(1 / 11, abs=0.01)


def three_cycles():
    looks = [(20, 23, *DOWN), (45, 48, *RIGHT), (58, 62, *DOWN)]            # the last one crosses the 60 s chunk boundary
    keys = []
    for end in (23, 48, 62):
        keys += typing_after(end, n=10)
    return zone_frames(130, looks=looks + [(110, 113, *DOWN)]), sorted(keys)          # a 4th look at 110 s with no typing


def test_copy_pattern_from_three_cycles_in_60_seconds():
    fr, ke = three_cycles()
    out = flags_for(fr, ke)
    cp = by_type(out, "copy_pattern")
    assert len(cp) == 1 and cp[0]["severity"] == "major"
    assert cp[0]["evidence"].startswith("3 cycles in ") and "down x2" in cp[0]["evidence"] and "right x1" in cp[0]["evidence"]
    assert "keys/s" in cp[0]["evidence"] and "pauses" in cp[0]["evidence"] and "backspace" in cp[0]["evidence"]
    d = cp[0]["details"]
    assert len(d["cycles"]) == 3 and d["directions"] == {"down": 2, "right": 1}
    assert d["cycles"][0]["typing_features_10s"]["keys"] == 10
    assert len(by_type(out, "off_screen_look")) == 4                 # the look at 110 s is a look but not a cycle


def test_two_cycles_are_not_a_copy_pattern():
    fr = zone_frames(100, looks=[(20, 23, *DOWN), (50, 53, *DOWN)])
    assert by_type(flags_for(fr, typing_after(23) + typing_after(53)), "copy_pattern") == []


def test_copy_pattern_works_across_chunk_boundaries_and_equals_the_one_chunk_result():
    fr, ke = three_cycles()
    keys_s = [t for t, _ in ke]
    chunks = []
    for start, end in ((0, 60), (60, 120), (120, 180)):
        chunks.append(analyze_chunk(
            None, slice_frames(fr, start, end), float(start), keys_s=slice_keys(keys_s, start, end, config.KEY_MARGIN_S),
            header=ZONE_HEADER, options=NO_MODEL, key_events=[e for e in ke if start - config.KEY_MARGIN_S <= e[0] < end + config.KEY_MARGIN_S]))
    split = merge_flags(chunks)
    whole = flags_for(fr, ke)
    pick = lambda fl: [(f["type"], round(f["start_s"]), round(f["end_s"])) for f in fl if f["type"] in ("off_screen_look", "copy_pattern")]
    assert pick(split) == pick(whole)
    crossing = [f for f in by_type(split, "off_screen_look") if f["start_s"] < 60 < f["end_s"]]
    assert len(crossing) == 1 and crossing[0]["details"]["typing_after"] is True       # the look that crosses 60 s is ONE look


def test_phone_visible_is_minor_and_other_severities_follow_the_config():
    assert config.SEVERITY["phone_visible"] == "minor"
    assert config.SEVERITY["copy_pattern"] == "major"
    fr = zone_frames(30, looks=[(10, 13, *RIGHT)])
    assert by_type(flags_for(fr, typing_after(13)), "off_screen_look")[0]["severity"] == "moderate"


def test_without_calibration_there_are_no_off_screen_flags():
    fr = zone_frames(30, looks=[(10, 13, *DOWN)])
    assert merge_flags([sidecar_flags(fr, [], {"id": "x"})]) == []


def test_key_events_never_contain_keys_only_categories():
    fr, ke = three_cycles()
    cats = {c for _, c in ke}
    assert cats <= {"char", "backspace", "delete", "enter", "space", "other", "unknown"}
