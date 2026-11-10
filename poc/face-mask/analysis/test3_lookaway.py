"""Test 3: do the sidecar's look-away and off-screen events match hand labels?

Usage: python test3_lookaway.py <folder> [--gaze-source blend|iris] [--thresholds fixed|calibrated] [--raw]

Events = look-away events (head yaw / horizontal gaze rule) plus off-screen looks (gaze or head outside the screen and
keyboard zones, with a direction). Labels: sidecar-<id>.labels.csv with columns start_s,end_s,label and, optionally,
direction (left, right, up, down; empty = any). The direction is as seen by the student looking at the screen.
"""
from __future__ import annotations

import argparse
import sys

import common
from common import (
    EYE_MIN_DURATION_S, GAZE_ENTER, GAZE_EXIT, HEAD_MIN_DURATION_S, KEY_WINDOW_S, MATCH_TOLERANCE_S, MERGE_GAP_S,
    OFFSCREEN_MIN_DURATION_S, YAW_ENTER_DEG, all_look_events, fail, find_sidecars, labels_path, load_labels_ex,
    load_sidecar, lost_segments,
)

PASS_FRACTION = 0.90


def overlaps(a_start: float, a_end: float, b_start: float, b_end: float, slack: float) -> bool:
    return a_start <= b_end + slack and b_start <= a_end + slack


def analyse(sc, labels, gaze_source, smoothed, mode):
    """Match events to labels. Returns a dict with the events, found/direction counts and the extra events."""
    events = all_look_events(sc, gaze_source, smoothed, mode)
    found = dir_total = dir_ok = 0
    for lab in labels:
        hits = [e for e in events if overlaps(e["start"], e["end"], lab["start"], lab["end"], MATCH_TOLERANCE_S)]
        if hits:
            found += 1
        if lab["direction"]:
            dir_total += 1
            if any(e["direction"] == lab["direction"] for e in hits):
                dir_ok += 1
    extra = [e for e in events if not any(overlaps(e["start"], e["end"], lab["start"], lab["end"], MATCH_TOLERANCE_S) for lab in labels)]
    typing = [e for e in events if any(e["start"] - KEY_WINDOW_S <= k <= e["end"] + KEY_WINDOW_S for k in sc.keys)]
    off, zones = common.off_screen_events_of(sc, gaze_source, smoothed)
    cycles = common.find_cycles(off, sc.key_events)
    return {"events": events, "found": found, "dir_total": dir_total, "dir_ok": dir_ok, "extra": extra, "typing": typing,
            "cycles": cycles, "patterns": common.copy_patterns(cycles), "zones": zones}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="folder with sidecar-*.jsonl and sidecar-*.labels.csv")
    ap.add_argument("--gaze-source", choices=["iris", "blend"], default=common.GAZE_SOURCE)
    ap.add_argument("--thresholds", choices=["fixed", "calibrated"], default=common.THRESHOLDS_MODE,
                    help="eye thresholds of the look-away rule: fixed (0.5/0.35) or from each person's calibration")
    ap.add_argument("--raw", action="store_true", help="use raw instead of smoothed values")
    args = ap.parse_args()
    smoothed = not args.raw
    sidecars = find_sidecars(args.folder)
    eye_rule = (f"|gaze| > {GAZE_ENTER:g} (until below {GAZE_EXIT:g})" if args.thresholds == "fixed"
                else f"|gaze| beyond the per-person calibrated thresholds (enter = {common.EDGE_FACTOR:g} x edge reading, at least {common.MIN_ENTER:g}; exit = {common.EXIT_RATIO:g} x enter)")
    print(f"Look-away rule (values minus the calibration baseline): head |yaw| > {YAW_ENTER_DEG:g} deg for >= {HEAD_MIN_DURATION_S:g} s, "
          f"OR eyes {eye_rule} for >= {EYE_MIN_DURATION_S:g} s; gaps < {MERGE_GAP_S:g} s merged.")
    print(f"Off-screen rule: gaze (h, v) or head (yaw, pitch) outside the screen zone AND the keyboard zone for >= {OFFSCREEN_MIN_DURATION_S:g} s; "
          "zones from the calibration (left/right/top/bottom/keyboard readings) plus margins.")
    print(f"Gaze source: {args.gaze_source}, values: {'smoothed' if smoothed else 'raw'}, eye thresholds: {args.thresholds}. "
          "Tracking-lost frames never count.\n")
    if args.thresholds == "fixed":
        print(f"Eye thresholds used: {common.thresholds_for(load_sidecar(sidecars[0]), mode='fixed')[1]}\n")

    tot_labels = tot_found = tot_dir = tot_dir_ok = 0
    print(f"{'recording':<48} {'labels':>6} {'found':>6} {'dir ok':>7} {'extra':>6} {'typing':>6} {'cycles':>6} {'copy':>5} {'lost s':>7}")
    for p in sidecars:
        sc = load_sidecar(p)
        labels = load_labels_ex(p)
        if labels is None:
            print(f"{sc.name:<48} no labels file ({labels_path(p).name}), skipped")
            continue
        if not (sc.header.get("calibration") or {}).get("baseline"):
            print(f"{sc.name:<48} note: no calibration baseline in header, using 0")
        r = analyse(sc, labels, args.gaze_source, smoothed, args.thresholds)
        lost_s = sum(b - a for a, b in lost_segments(sc.frames))
        tot_labels += len(labels)
        tot_found += r["found"]
        tot_dir += r["dir_total"]
        tot_dir_ok += r["dir_ok"]
        d = f"{r['dir_ok']}/{r['dir_total']}" if r["dir_total"] else "-"
        print(f"{sc.name:<48} {len(labels):>6} {r['found']:>6} {d:>7} {len(r['extra']):>6} {len(r['typing']):>6} "
              f"{len(r['cycles']):>6} {len(r['patterns']):>5} {lost_s:7.1f}")
        if args.thresholds == "calibrated":
            print(f"    thresholds: {common.thresholds_for(sc, args.gaze_source, smoothed, 'calibrated')[1]}")
        if r["zones"] is not None and r["zones"].note != "calibrated":
            print(f"    zones: {r['zones'].note}")
        if r["zones"] is None:
            print("    zones: no calibration in the header, off-screen looks not checked")
        for e in r["extra"]:
            print(f"    extra event (no label): {e['start']:.1f}-{e['end']:.1f} s  {e['kind']}{' ' + e['direction'] if e['direction'] else ''}")
    if tot_labels == 0:
        fail("\nNo labels found in any recording. Create sidecar-<id>.labels.csv files (columns start_s,end_s,label,direction; see README).")
    frac = tot_found / tot_labels
    ok = frac >= PASS_FRACTION
    print(f"\nFound {tot_found} of {tot_labels} labels = {100 * frac:.0f}%. Rule: PASS if >= {100 * PASS_FRACTION:.0f}%.  Result: {'PASS' if ok else 'FAIL'}")
    if tot_dir:
        dfrac = tot_dir_ok / tot_dir
        dok = dfrac >= PASS_FRACTION
        ok = ok and dok
        print(f"Direction right for {tot_dir_ok} of {tot_dir} labelled directions = {100 * dfrac:.0f}%. Rule: PASS if >= {100 * PASS_FRACTION:.0f}%.  "
              f"Result: {'PASS' if dok else 'FAIL'}")
    else:
        print("No direction labels: direction not checked.")
    print(f"Overall: {'PASS' if ok else 'FAIL'}")
    print("'extra' = events with no label (false alarms or missed labels). 'typing' = events with a key press within "
          f"{KEY_WINDOW_S:g} s. 'cycles' = off-screen looks followed by typing within {common.COPY_TYPING_WINDOW_S:g} s; "
          f"'copy' = copy_pattern events ({common.COPY_MIN_CYCLES}+ cycles within {common.COPY_WINDOW_S:g} s).")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
