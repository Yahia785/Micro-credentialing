import numpy as np
import pytest

from analyzer import camera, config
from analyzer.core import Options, analyze_chunk, merge_flags
from analyzer.sidecar_flags import sidecar_flags
from helpers import HEADER, blurred, dark, sidecar_frames, textured, write_video

OPTS_NO_MODEL = Options(use_objects=False)


# ---- camera blocked: frame statistics ---------------------------------------------------------

def test_frame_stats_dark_blurred_and_normal():
    nm, ns = camera.frame_stats(textured())
    dm, ds = camera.frame_stats(dark())
    bm, bs = camera.frame_stats(blurred())
    assert camera.classify(nm, ns) == (False, False)
    assert camera.classify(dm, ds)[0] is True                  # too dark
    assert camera.classify(bm, bs) == (False, True)            # bright enough but blurred
    assert ns > 100 and bs < config.CAMERA_MIN_SHARPNESS and dm < config.CAMERA_MIN_BRIGHTNESS


def test_stats_do_not_depend_on_resolution():
    small = camera.frame_stats(textured(160, 90, seed=3))
    big = camera.frame_stats(textured(1280, 720, seed=3))
    assert big[0] == pytest.approx(small[0], rel=0.15)
    assert camera.classify(*big) == (False, False)


# ---- camera blocked: whole chunk ----------------------------------------------------------------

def run_video(tmp_path, frame_for_time, seconds, name="v.avi"):
    p = write_video(tmp_path / name, frame_for_time, seconds)
    return merge_flags([analyze_chunk(p, [], 0.0, options=OPTS_NO_MODEL)])


def test_dark_period_of_3_seconds_is_flagged(tmp_path):
    flags = run_video(tmp_path, lambda t: dark() if 4 <= t < 7 else textured(), 12)
    assert [f["type"] for f in flags] == ["camera_blocked"]
    f = flags[0]
    assert 3.5 <= f["start_s"] <= 4.5 and 6.5 <= f["end_s"] <= 7.5
    assert "brightness" in f["evidence"] and f["source"] == "video"


def test_blurred_period_is_flagged_with_sharpness_evidence(tmp_path):
    flags = run_video(tmp_path, lambda t: blurred() if 3 <= t < 6 else textured(), 12)
    assert len(flags) == 1 and "sharpness" in flags[0]["evidence"] and "brightness" not in flags[0]["evidence"]


def test_a_1_second_cover_is_not_flagged(tmp_path):
    assert run_video(tmp_path, lambda t: dark() if 4 <= t < 5 else textured(), 12) == []


def test_normal_video_has_no_flags(tmp_path):
    assert run_video(tmp_path, lambda t: textured(seed=int(t * 5)), 10) == []


def test_two_covers_close_together_are_joined(tmp_path):
    # dark 3-5 s, normal for 0.5 s, dark 5.5-8 s -> one flag
    flags = run_video(tmp_path, lambda t: dark() if (3 <= t < 5 or 5.5 <= t < 8) else textured(), 12)
    assert len(flags) == 1 and flags[0]["end_s"] - flags[0]["start_s"] >= 4.5


def test_camera_check_still_works_when_the_video_continues_in_the_next_chunk(tmp_path):
    # dark for the last 1.0 s of chunk 0 and the first 1.5 s of chunk 1: only 2.5 s together
    c0 = write_video(tmp_path / "c0.avi", lambda t: dark() if t >= 9 else textured(), 10)
    c1 = write_video(tmp_path / "c1.avi", lambda t: dark() if t < 1.5 else textured(), 10)
    f0 = analyze_chunk(c0, [], 0.0, options=OPTS_NO_MODEL)
    f1 = analyze_chunk(c1, [], 10.0, options=OPTS_NO_MODEL)
    assert merge_flags([f0]) == [] and merge_flags([f1]) == []        # alone: too short
    both = merge_flags([f0, f1])
    assert len(both) == 1 and both[0]["start_s"] == pytest.approx(9.0, abs=0.6) and both[0]["end_s"] == pytest.approx(11.5, abs=0.6)


# ---- sidecar: looking away, typing rule, tracking lost --------------------------------------------

def flags_of(frames, keys=(), **kw):
    return merge_flags([sidecar_flags(frames, list(keys), HEADER, **kw)])


def types(flags):
    return [f["type"] for f in flags]


def test_looking_away_uses_the_rule_in_common(tmp_path):
    fr = sidecar_frames(30, away=[(10, 13, 0.8)])           # blend gaze 0.8 for 3 s: above 0.5
    out = flags_of(fr)
    assert types(out) == ["looking_away"]
    assert out[0]["start_s"] == pytest.approx(10.0, abs=0.2) and out[0]["end_s"] == pytest.approx(12.9, abs=0.2)
    assert out[0]["source"] == "sidecar"


def test_glance_shorter_than_the_minimum_is_not_a_flag():
    assert flags_of(sidecar_frames(30, away=[(10, 10.8, 0.9)])) == []        # 0.8 s of eye gaze: needs 1.5 s


def test_key_press_during_look_away_gives_the_typing_flag():
    out = flags_of(sidecar_frames(30, away=[(10, 13, 0.8)]), keys=[11.0])
    assert types(out) == ["looking_away", "looking_away_while_typing"]
    typing = out[1]
    assert (typing["start_s"], typing["end_s"]) == (out[0]["start_s"], out[0]["end_s"])


def test_key_press_within_2_seconds_after_counts_but_3_seconds_does_not():
    away = [(10, 13, 0.8)]
    assert "looking_away_while_typing" in types(flags_of(sidecar_frames(30, away=away), keys=[14.5]))   # 1.6 s after the end
    assert "looking_away_while_typing" in types(flags_of(sidecar_frames(30, away=away), keys=[8.5]))    # 1.5 s before the start
    assert "looking_away_while_typing" not in types(flags_of(sidecar_frames(30, away=away), keys=[16.5]))
    assert "looking_away_while_typing" not in types(flags_of(sidecar_frames(30, away=away), keys=[5.0]))


def test_typing_without_looking_away_is_nothing():
    assert flags_of(sidecar_frames(30), keys=[5, 6, 7]) == []


def test_head_turn_counts_for_the_typing_rule_too():
    fr = sidecar_frames(30)
    for f in fr:
        if 10 <= f["t"] / 1000 < 12:
            f["yaw"] = f["yawRaw"] = 40.0
    out = flags_of(fr, keys=[11.0])
    assert types(out) == ["looking_away", "looking_away_while_typing"] and "head" in out[0]["evidence"]


def test_baseline_is_subtracted_so_a_naturally_off_centre_person_is_not_flagged():
    header = {"calibration": {"baseline": {"yaw": 0.0, "gazeH": 0.0, "blendH": 0.4}}}
    fr = sidecar_frames(30, away=[(10, 14, 0.8)])             # 0.8 - 0.4 = 0.4: below the 0.5 threshold
    assert merge_flags([sidecar_flags(fr, [], header)]) == []
    fr2 = sidecar_frames(30, away=[(10, 14, 1.0)])            # 0.6 above the baseline: counts
    assert types(merge_flags([sidecar_flags(fr2, [], header)])) == ["looking_away"]


def test_tracking_lost_needs_2_seconds():
    assert flags_of(sidecar_frames(30, lost=[(10, 11.5)])) == []
    out = flags_of(sidecar_frames(30, lost=[(10, 13)]))
    assert types(out) == ["tracking_lost"] and out[0]["end_s"] - out[0]["start_s"] >= 2.9


def test_tracking_lost_flicker_is_joined():
    out = flags_of(sidecar_frames(30, lost=[(10, 11.2), (11.5, 12.8)]))        # 0.3 s gap
    assert types(out) == ["tracking_lost"] and out[0]["end_s"] - out[0]["start_s"] >= 2.5


def test_lost_frames_are_not_looking_away():
    out = flags_of(sidecar_frames(30, lost=[(10, 14)]))
    assert "looking_away" not in types(out)


def test_look_away_crossing_a_chunk_boundary_is_found_by_merging():
    whole = sidecar_frames(120, away=[(57, 63, 0.9)])
    c0 = [f for f in whole if f["t"] < 60000]
    c1 = [f for f in whole if f["t"] >= 60000]
    out = merge_flags([sidecar_flags(c0, [58.0], HEADER), sidecar_flags(c1, [62.0], HEADER)])
    by = {f["type"]: f for f in out}
    assert by["looking_away"]["start_s"] == pytest.approx(57.0, abs=0.2)
    assert by["looking_away"]["end_s"] == pytest.approx(62.9, abs=0.2)
    assert (by["looking_away_while_typing"]["start_s"], by["looking_away_while_typing"]["end_s"]) == \
           (by["looking_away"]["start_s"], by["looking_away"]["end_s"])


def test_a_3_second_look_away_cut_into_1_5_and_1_5_across_chunks_still_counts():
    whole = sidecar_frames(120, away=[(58.5, 61.5, 0.9)])
    c0 = [f for f in whole if f["t"] < 60000]
    c1 = [f for f in whole if f["t"] >= 60000]
    out = merge_flags([sidecar_flags(c0, [], HEADER), sidecar_flags(c1, [], HEADER)])
    assert types(out) == ["looking_away"]


def test_no_frames_no_flags():
    assert sidecar_flags([], [], HEADER) == []
