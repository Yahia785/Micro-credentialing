import pytest

from test2_leaks import classify, covered_fraction, lost_change_times, near_any, nearest_frame

MASK = [[100, 100, 100, 100]]


def test_hit_fully_inside_mask():
    assert covered_fraction((120, 120, 50, 50), MASK) == 1.0
    assert classify((120, 120, 50, 50), MASK) == "INSIDE"


def test_hit_with_no_overlap_is_outside():
    assert covered_fraction((300, 300, 50, 50), MASK) == 0.0
    assert classify((300, 300, 50, 50), MASK) == "OUTSIDE"


def test_hit_mostly_outside_is_outside_even_if_touching():
    # 10x10 px of a 100x100 hit overlap the mask: 1% covered
    assert classify((190, 190, 100, 100), MASK) == "OUTSIDE"


def test_half_covered_hit_is_inside_at_the_threshold():
    assert covered_fraction((150, 100, 100, 100), MASK) == pytest.approx(0.5)
    assert classify((150, 100, 100, 100), MASK) == "INSIDE"


def test_no_mask_boxes_means_outside():
    assert classify((10, 10, 50, 50), []) == "OUTSIDE"


def test_largest_single_box_is_used():
    two = [[0, 0, 40, 100], [40, 0, 40, 100]]  # each covers half of a 80-wide hit
    assert covered_fraction((0, 0, 80, 100), two) == pytest.approx(0.5)


def test_nearest_frame():
    times = [0.0, 0.04, 0.08, 0.12]
    assert nearest_frame(times, -1) == 0
    assert nearest_frame(times, 0.05) == 1
    assert nearest_frame(times, 0.07) == 2
    assert nearest_frame(times, 5) == 3


def test_lost_change_times_and_window():
    fr = [{"t": i * 100, "lost": 10 <= i < 15} for i in range(30)]
    assert lost_change_times(fr) == [1.0, 1.5]
    assert near_any(1.3, [1.0, 1.5], 0.5) and not near_any(2.2, [1.0, 1.5], 0.5)
