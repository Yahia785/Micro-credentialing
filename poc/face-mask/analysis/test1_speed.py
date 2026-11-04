"""Test 1: is it fast enough?  Usage: python test1_speed.py <folder>"""
from __future__ import annotations

import sys

from common import find_sidecars, fail, fps_stats, load_sidecar, lost_percent

PASS_FPS = 15.0


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
        rows.append((sc.name, (avg, p10, lost_percent(sc.frames), ms, sc.header.get("delegate", "?"))))

    w = max(len(n) for n, _ in rows)
    print(f"{'recording':<{w}}  {'avg fps':>8} {'p10 fps':>8} {'lost %':>7} {'ms/frame':>9} {'delegate':>8}  result")
    all_pass = True
    for name, r in rows:
        if r is None:
            print(f"{name:<{w}}  too few frames")
            all_pass = False
            continue
        avg, p10, lost, ms, dele = r
        ok = avg >= PASS_FPS
        all_pass &= ok
        print(f"{name:<{w}}  {avg:8.1f} {p10:8.1f} {lost:7.1f} {ms:9.1f} {dele:>8}  {'PASS' if ok else 'FAIL'}")
    print(f"\nRule: PASS if average fps >= {PASS_FPS:g}.  Overall: {'PASS' if all_pass else 'FAIL'}")
    return 0 if all_pass else 2


if __name__ == "__main__":
    sys.exit(main())
