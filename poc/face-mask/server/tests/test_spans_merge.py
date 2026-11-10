import pytest

from analyzer import config
from analyzer.core import chunk_index, merge_flags, slice_frames, slice_keys, split_chunks
from analyzer.spans import join_intervals, spans_from_hits

IV = 0.5  # sample interval at 2 fps


def times(n, start=0.0):
    return [start + i * IV for i in range(n)]


# ---- chunk splitting ---------------------------------------------------------------------

def test_split_chunks():
    assert split_chunks(150) == [(0, 60), (60, 120), (120, 150)]
    assert split_chunks(60) == [(0, 60)]
    assert split_chunks(61) == [(0, 60), (60, 61)]
    assert split_chunks(0) == []
    assert split_chunks(10, chunk_s=4) == [(0, 4), (4, 8), (8, 10)]


def test_chunk_index_and_slicing():
    assert chunk_index(0) == 0 and chunk_index(59.99) == 0 and chunk_index(60) == 1 and chunk_index(-1) == 0
    frames = [{"t": t * 1000.0} for t in range(0, 130)]
    assert [f["t"] for f in slice_frames(frames, 60, 120)][0] == 60000.0
    assert len(slice_frames(frames, 60, 120)) == 60  # [60, 120): no frame is in two chunks
    assert len(slice_frames(frames, 0, 60)) + len(slice_frames(frames, 60, 120)) + len(slice_frames(frames, 120, 180)) == 130
    assert slice_keys([1, 59, 61, 100], 60, 120, margin_s=2) == [59, 61, 100]


# ---- minimum duration and joining ----------------------------------------------------------

def test_short_detection_is_dropped_long_one_kept():
    t = times(20)
    hits = [False] * 20
    hits[3] = True                       # one hit = 0.5 s
    for i in range(8, 12):
        hits[i] = True                   # four hits = 2.0 s
    spans = spans_from_hits(t, hits, IV, join_gap=1.5, min_duration=1.5)
    assert len(spans) == 1
    assert spans[0].start == 4.0 and spans[0].end == 6.0 and spans[0].hits == 4 and spans[0].frames == 4


def test_nearby_hits_are_joined_with_a_gap_but_far_ones_are_not():
    t = times(30)
    hits = [False] * 30
    for i in (2, 3, 6, 7):               # gap of two missed samples (1.0 s <= 1.5 s): one detection
        hits[i] = True
    for i in (20, 21, 22, 23):           # far away: a second detection
        hits[i] = True
    spans = spans_from_hits(t, hits, IV, join_gap=1.5, min_duration=1.5)
    assert [(s.start, s.end) for s in spans] == [(1.0, 4.0), (10.0, 12.0)]
    first = spans[0]
    assert first.hits == 4 and first.frames == 6   # 4 hits in 6 sampled frames


def test_gap_just_over_the_join_limit_splits():
    t = times(20)
    hits = [False] * 20
    for i in (2, 3, 4, 5):
        hits[i] = True
    for i in (9, 10, 11, 12):            # hit times 2.5 and 4.5: gap 2.0 s > 1.5 s
        hits[i] = True
    assert len(spans_from_hits(t, hits, IV, 1.5, 1.5)) == 2


def test_edge_touching_fragment_is_kept_even_if_short():
    t = times(10)
    hits = [False] * 10
    hits[8] = hits[9] = True             # 1.0 s at the end of the chunk: may continue in the next chunk
    spans = spans_from_hits(t, hits, IV, 1.5, min_duration=2.0)
    assert len(spans) == 1 and spans[0].touches_end and not spans[0].touches_start
    hits2 = [True, True] + [False] * 8
    s2 = spans_from_hits(t, hits2, IV, 1.5, 2.0)
    assert s2[0].touches_start and not s2[0].touches_end


def test_no_hits_no_spans():
    assert spans_from_hits(times(5), [False] * 5, IV, 1.5, 1.5) == []
    assert spans_from_hits([], [], IV, 1.5, 1.5) == []


def test_join_intervals():
    assert join_intervals([(0, 1), (1.2, 2), (5, 6)], 0.5) == [(0, 2), (5, 6)]
    assert join_intervals([(5, 6), (0, 1)], 0.5) == [(0, 1), (5, 6)]


# ---- merge across a chunk boundary ------------------------------------------------------------

def vflag(ftype, start, end, ts=False, te=False, hits=2, frames=2, conf=0.8, minimum=None):
    return {"type": ftype, "start_s": start, "end_s": end, "confidence": conf, "source": "video", "evidence": "",
            "touches_start": ts, "touches_end": te,
            "_meta": {"kind": "count", "label": "cell phone box", "hits": hits, "frames": frames},
            "_min": minimum or config.MIN_DURATION_S[ftype]}


def test_flag_crossing_a_chunk_boundary_is_joined_and_evidence_summed():
    a = vflag("phone_visible", 57.0, 60.0, te=True, hits=5, frames=6, conf=0.9)   # chunk 0: last 3 s
    b = vflag("phone_visible", 60.0, 62.0, ts=True, hits=4, frames=4, conf=0.6)   # chunk 1: first 2 s
    out = merge_flags([[a], [b]])
    assert len(out) == 1
    f = out[0]
    assert (f["start_s"], f["end_s"]) == (57.0, 62.0)
    assert f["evidence"] == "cell phone box in 9 of 10 sampled frames"
    assert f["confidence"] == pytest.approx((0.9 * 3 + 0.6 * 2) / 5, abs=1e-3)
    assert set(f) == {"type", "severity", "start_s", "end_s", "confidence", "source", "evidence"}


def test_fragments_too_short_alone_but_long_together_survive():
    a = vflag("second_person", 58.5, 60.0, te=True)   # 1.5 s < 2.0 s minimum
    b = vflag("second_person", 60.0, 61.0, ts=True)   # 1.0 s
    out = merge_flags([[a], [b]])
    assert len(out) == 1 and out[0]["end_s"] - out[0]["start_s"] == 2.5


def test_lone_short_edge_fragment_is_dropped():
    a = vflag("second_person", 58.5, 60.0, te=True)
    assert merge_flags([[a], []]) == []


def test_different_types_are_not_joined():
    a = vflag("phone_visible", 57.0, 60.0, te=True)
    b = vflag("book_visible", 60.0, 63.0, ts=True)
    assert len(merge_flags([[a], [b]])) == 2


def test_far_apart_flags_stay_separate():
    a = vflag("phone_visible", 10.0, 14.0)
    b = vflag("phone_visible", 30.0, 34.0)
    assert len(merge_flags([[a, b]])) == 2


def sflag(ftype, start, end, minimum=1.0, ts=False, te=False, text="x"):
    return {"type": ftype, "start_s": start, "end_s": end, "confidence": 1.0, "source": "sidecar", "evidence": text,
            "touches_start": ts, "touches_end": te, "_meta": {"kind": "text", "text": text}, "_min": minimum}


def test_typing_flag_is_stretched_to_the_whole_merged_look_away():
    # one 20 s look-away split at 60 s; only the second half had a key press nearby
    la0 = sflag("looking_away", 50.0, 60.0, te=True)
    la1 = sflag("looking_away", 60.0, 70.0, ts=True)
    ty1 = sflag("looking_away_while_typing", 60.0, 70.0, ts=True, text="key press")
    out = merge_flags([[la0], [la1, ty1]])
    by = {f["type"]: f for f in out}
    assert (by["looking_away"]["start_s"], by["looking_away"]["end_s"]) == (50.0, 70.0)
    assert (by["looking_away_while_typing"]["start_s"], by["looking_away_while_typing"]["end_s"]) == (50.0, 70.0)


def test_overlapping_duplicates_from_both_chunks_are_merged():
    a = sflag("looking_away", 10.0, 13.0)
    b = sflag("looking_away", 12.5, 15.0)
    out = merge_flags([[a], [b]])
    assert len(out) == 1 and (out[0]["start_s"], out[0]["end_s"]) == (10.0, 15.0)


def test_source_specific_minimum_is_respected_after_merge():
    short_eye = sflag("looking_away", 10.0, 11.2, minimum=1.5, ts=True)   # 1.2 s eye fragment, needs 1.5 s
    assert merge_flags([[short_eye]]) == []
    ok_head = sflag("looking_away", 10.0, 11.2, minimum=1.0)
    assert len(merge_flags([[ok_head]])) == 1
