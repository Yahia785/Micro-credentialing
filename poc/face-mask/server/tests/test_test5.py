import sys
from pathlib import Path

ANALYSIS = Path(__file__).resolve().parent.parent.parent / "analysis"
sys.path.insert(0, str(ANALYSIS))

import test5_raw_vs_masked as t5  # noqa: E402


def fl(ftype, s, e):
    return {"type": ftype, "start_s": s, "end_s": e, "confidence": 0.8, "source": "video", "evidence": ""}


def test_same_type_and_overlap_matches():
    assert t5.overlaps(fl("phone_visible", 10, 14), fl("phone_visible", 12, 16))
    assert t5.overlaps(fl("phone_visible", 10, 14), fl("phone_visible", 14.8, 16))      # within the 1 s slack
    assert not t5.overlaps(fl("phone_visible", 10, 14), fl("phone_visible", 16, 18))
    assert not t5.overlaps(fl("phone_visible", 10, 14), fl("book_visible", 10, 14))     # other type


def test_compare_splits_both_only_raw_only_masked():
    raw = [fl("phone_visible", 10, 14), fl("second_person", 30, 40), fl("camera_blocked", 50, 55)]
    masked = [fl("phone_visible", 11, 15), fl("camera_blocked", 90, 95)]
    both, only_raw, only_masked = t5.compare(raw, masked)
    assert [f["type"] for f in both] == ["phone_visible"]
    assert sorted(f["type"] for f in only_raw) == ["camera_blocked", "second_person"]
    assert [f["type"] for f in only_masked] == ["camera_blocked"]


def test_compare_empty():
    assert t5.compare([], []) == ([], [], [])
    both, only_raw, only_masked = t5.compare([], [fl("book_visible", 1, 4)])
    assert both == [] and only_raw == [] and len(only_masked) == 1


def test_pairs_by_id_and_lonely_files(tmp_path):
    for name in ("raw-a_1.webm", "masked-a_1.webm", "raw-b_2gpu.webm", "masked-b_2.webm", "sidecar-a_1.jsonl", "notes.txt"):
        (tmp_path / name).write_bytes(b"")
    pairs, lonely = t5.find_pairs(tmp_path)
    assert [p[0] for p in pairs] == ["a_1"]
    assert sorted(lonely) == ["masked-b_2.webm", "raw-b_2gpu.webm"]
