"""Test 6: jitter on "normal" clips (the person sat still and never looked away on purpose).

Usage: python test6_jitter.py <folder> [--scenario normal]

For each clip it compares four variants: iris gaze raw, iris gaze smoothed, blendshape gaze raw,
blendshape gaze smoothed. It prints the standard deviation of yaw and gaze, and the number of
look-away events per minute. On these clips EVERY event is a false flag.

PASS: 0 false look-aways per minute on every normal clip with smoothing on, using the default gaze
source (GAZE_SOURCE in common.py). The other variants are shown for comparison only.
"""
from __future__ import annotations

import argparse
import statistics
import sys

import common
from common import fail, find_sidecars, load_sidecar, reading, sidecar_events

VARIANTS = [("iris raw", "iris", False), ("iris smoothed", "iris", True),
            ("blend raw", "blend", False), ("blend smoothed", "blend", True)]


def column(frames: list[dict], name: str, smoothed: bool) -> list[float]:
    out = []
    for f in frames:
        if f.get("lost"):
            continue
        v = reading(f, name, smoothed)
        if v is not None:
            out.append(v)
    return out


def sd(xs: list[float]) -> float:
    return statistics.stdev(xs) if len(xs) > 1 else float("nan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--scenario", default="normal", help="scenario to analyse (default: normal)")
    args = ap.parse_args()

    sidecars = [load_sidecar(p) for p in find_sidecars(args.folder)]
    chosen = [sc for sc in sidecars if sc.header.get("scenario") == args.scenario and sc.frames]
    if not chosen:
        seen = sorted({sc.header.get("scenario", "?") for sc in sidecars})
        fail(f"No '{args.scenario}' recordings in {args.folder} (scenarios found: {', '.join(seen)}). "
             "Record a 'normal' clip first (see README).")

    all_ok = True
    for sc in chosen:
        has_raw = "gazeHRaw" in sc.frames[0]
        minutes = sc.duration_s / 60.0 or float("nan")
        print(f"\n{sc.name}  ({sc.duration_s:.0f} s, {len(sc.frames)} frames, delegate {sc.header.get('delegate', '?')})")
        if not has_raw:
            print("  note: no *Raw fields (older client): raw and smoothed rows are identical")
        if not common.baseline_of(sc):
            print("  note: no calibration baseline in the header, using 0")
        print(f"  {'variant':<15} {'std yaw':>8} {'std gaze':>9} {'events':>7} {'per min':>8}")
        for label, source, smoothed in VARIANTS:
            gname = "gazeH" if source == "iris" else "blendH"
            n = len(sidecar_events(sc, source, smoothed))
            per_min = n / minutes
            is_main = source == common.GAZE_SOURCE and smoothed
            mark = "  <- pass rule" if is_main else ""
            print(f"  {label:<15} {sd(column(sc.frames, 'yaw', smoothed)):8.2f} "
                  f"{sd(column(sc.frames, gname, smoothed)):9.3f} {n:7d} {per_min:8.2f}{mark}")
            if is_main and n > 0:
                all_ok = False
    print(f"\nPASS rule: 0 false look-aways per minute on every '{args.scenario}' clip "
          f"({common.GAZE_SOURCE} gaze, smoothed).  Result: {'PASS' if all_ok else 'FAIL'}")
    print("If it fails: check the setup screen was green, recalibrate, then tune ONE_EURO_* in config.ts "
          "or GAZE_ENTER/GAZE_EXIT in common.py.")
    return 0 if all_ok else 2


if __name__ == "__main__":
    sys.exit(main())
