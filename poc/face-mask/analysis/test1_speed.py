"""Test 1: is it fast enough?  Usage: python test1_speed.py <folder>

Rule (average fps): 15 or more = PASS, 10 to 15 = OK (minimum), below 10 = FAIL.
"""
from __future__ import annotations

import sys

from common import SPEED_MIN_FPS, SPEED_PASS_FPS, fail, find_sidecars, fps_stats, load_sidecar, lost_percent, speed_label


def overall(labels: list[str]) -> str:
    if "FAIL" in labels:
        return "FAIL"
    if "OK (minimum)" in labels or "too few frames" in labels:
        return "OK (minimum)" if "too few frames" not in labels else "FAIL"
    return "PASS"


def main() -> int:
    if len(sys.argv) != 2:
        fail("Usage: python test1_speed.py <folder with sidecar-*.jsonl>")
    rows = []
    for p in find_sidecars(sys.argv[1]):
        sc = load_sidecar(p)
        if len(sc.frames) < 2:
            rows.append((sc.name, None))
            continue
        avg, p10 = fps_stats(sc.frames)
        ms = sum(f["procMs"] for f in sc.frames) / len(sc.frames)
        det = [f["detectMs"] for f in sc.frames if f.get("detectMs") is not None]
        rows.append((sc.name, (avg, p10, lost_percent(sc.frames), ms, sum(det) / len(det) if det else None,
                               sc.header.get("delegate", "?"), sc.header.get("detectLongSide"))))

    w = max(len(n) for n, _ in rows)
    print(f"{'recording':<{w}}  {'avg fps':>8} {'p10 fps':>8} {'lost %':>7} {'ms/frame':>9} {'detect ms':>9} {'delegate':>8} {'size':>5}  result")
    labels = []
    for name, r in rows:
        if r is None:
            print(f"{name:<{w}}  too few frames")
            labels.append("too few frames")
            continue
        avg, p10, lost, ms, det, dele, size = r
        label = speed_label(avg)
        labels.append(label)
        det_s = f"{det:9.1f}" if det is not None else f"{'-':>9}"
        print(f"{name:<{w}}  {avg:8.1f} {p10:8.1f} {lost:7.1f} {ms:9.1f} {det_s} {dele:>8} {str(size or '-'):>5}  {label}")
    res = overall(labels)
    print(f"\nRule: average fps >= {SPEED_PASS_FPS:g} = PASS, {SPEED_MIN_FPS:g} to {SPEED_PASS_FPS:g} = OK (minimum), "
          f"below {SPEED_MIN_FPS:g} = FAIL.  Overall: {res}")
    return 2 if res == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
