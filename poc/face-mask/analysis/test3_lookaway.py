"""Test 3: do sidecar look-away events match hand labels?  Usage: python test3_lookaway.py <folder>"""
from __future__ import annotations

import sys

from common import (
    GAZE_H_LIMIT, KEY_WINDOW_S, MATCH_TOLERANCE_S, MERGE_GAP_S, MIN_DURATION_S, YAW_LIMIT_DEG,
    fail, find_sidecars, labels_path, load_labels, load_sidecar, look_away_events, lost_segments,
)

PASS_FRACTION = 0.90


def overlaps(a: tuple[float, float], b: tuple[float, float], slack: float) -> bool:
    return a[0] <= b[1] + slack and b[0] <= a[1] + slack


def analyse(sc, labels):
    events = look_away_events(sc.frames)
    found = sum(1 for (s, e, _) in labels if any(overlaps(ev, (s, e), MATCH_TOLERANCE_S) for ev in events))
    extra = [ev for ev in events if not any(overlaps(ev, (s, e), MATCH_TOLERANCE_S) for (s, e, _) in labels)]
    typing = [ev for ev in events if any(ev[0] - KEY_WINDOW_S <= k <= ev[1] + KEY_WINDOW_S for k in sc.keys)]
    return events, found, extra, typing


def main() -> int:
    if len(sys.argv) != 2:
        fail("Usage: python test3_lookaway.py <folder with sidecar-*.jsonl and *.labels.csv>")
    sidecars = find_sidecars(sys.argv[1])
    print(f"Rule: |yaw| > {YAW_LIMIT_DEG:g} deg or |gazeH| > {GAZE_H_LIMIT:g}, for >= {MIN_DURATION_S:g} s, "
          f"merging gaps < {MERGE_GAP_S:g} s. Tracking-lost frames never count as looking away.\n")
    tot_labels = tot_found = 0
    print(f"{'recording':<48} {'labels':>6} {'found':>6} {'extra':>6} {'typing':>6} {'lost s':>7}")
    for p in sidecars:
        sc = load_sidecar(p)
        labels = load_labels(p)
        if labels is None:
            print(f"{sc.name:<48} no labels file ({labels_path(p).name}), skipped")
            continue
        events, found, extra, typing = analyse(sc, labels)
        lost_s = sum(b - a for a, b in lost_segments(sc.frames))
        tot_labels += len(labels)
        tot_found += found
        print(f"{sc.name:<48} {len(labels):>6} {found:>6} {len(extra):>6} {len(typing):>6} {lost_s:7.1f}")
        for a, b in extra:
            print(f"    extra event (no label): {a:.1f}-{b:.1f} s")
    if tot_labels == 0:
        fail("\nNo labels found in any recording. Create <sidecar name>.labels.csv files (see README).")
    frac = tot_found / tot_labels
    ok = frac >= PASS_FRACTION
    print(f"\nFound {tot_found} of {tot_labels} labels = {100 * frac:.0f}%. "
          f"Rule: PASS if >= {100 * PASS_FRACTION:.0f}%.  Result: {'PASS' if ok else 'FAIL'}")
    print("'extra' = events with no label (false alarms or missed labels). "
          f"'typing' = events with a key press within {KEY_WINDOW_S:g} s (looking away while typing).")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
