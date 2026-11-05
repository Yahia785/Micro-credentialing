"""Test 5: does the mask hide things from the object and camera checks?

Usage (in the SERVER venv, because it uses the analyzer, onnxruntime and the YOLO model):
    server\\.venv\\Scripts\\python.exe analysis\\test5_raw_vs_masked.py <folder>

For every session that has BOTH raw-<id> and masked-<id> videos, the object and camera checks run on both videos
and the flags are compared (same type, overlapping in time). PASS if 90% or more of the flags found in the RAW
video are also found in the MASKED video.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "server"))

from common import fail, load_sidecar  # noqa: E402

try:
    from analyzer import config as acfg  # noqa: E402
    from analyzer.core import Options  # noqa: E402
    from analyzer.session import analyze_recording  # noqa: E402
except ImportError as e:  # pragma: no cover
    fail(f"Cannot import the analyzer ({e}).\nRun this script with the server venv: "
         "server\\.venv\\Scripts\\python.exe analysis\\test5_raw_vs_masked.py <folder> (see README, 'Server analysis').")

PASS_FRACTION = 0.90
MATCH_TOLERANCE_S = 1.0     # two flags match if the same type and they overlap within this slack
EXTS = (".webm", ".mp4", ".avi", ".mkv")


def overlaps(a: dict, b: dict, slack: float = MATCH_TOLERANCE_S) -> bool:
    return a["type"] == b["type"] and a["start_s"] <= b["end_s"] + slack and b["start_s"] <= a["end_s"] + slack


def compare(raw_flags: list[dict], masked_flags: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """(found in both, only in raw, only in masked); matching is by type and time overlap."""
    both = [r for r in raw_flags if any(overlaps(r, m) for m in masked_flags)]
    only_raw = [r for r in raw_flags if r not in both]
    only_masked = [m for m in masked_flags if not any(overlaps(r, m) for r in raw_flags)]
    return both, only_raw, only_masked


def find_pairs(folder: Path):
    """[(id, raw video, masked video)] plus a list of videos without a partner."""
    raws = {p.stem[len("raw-"):]: p for p in folder.iterdir() if p.stem.startswith("raw-") and p.suffix in EXTS}
    masks = {p.stem[len("masked-"):]: p for p in folder.iterdir() if p.stem.startswith("masked-") and p.suffix in EXTS}
    pairs = [(i, raws[i], masks[i]) for i in sorted(raws.keys() & masks.keys())]
    lonely = [str(p.name) for i, p in {**{f"r{k}": v for k, v in raws.items()}, **{f"m{k}": v for k, v in masks.items()}}.items()
              if (i[0] == "r" and i[1:] not in masks) or (i[0] == "m" and i[1:] not in raws)]
    return pairs, lonely


def run_video(video: Path, header: dict, which: str, opts: Options) -> list[dict]:
    flags, _ = analyze_recording(video, header, [], [], opts, which=which)
    return [f for f in flags if f["type"] in acfg.VIDEO_FLAG_TYPES]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--no-objects", action="store_true", help="camera check only")
    args = ap.parse_args()
    folder = Path(args.folder)
    if not folder.is_dir():
        fail(f"Folder not found: {folder}")
    pairs, lonely = find_pairs(folder)
    if not pairs:
        fail(f"No session with both raw-<id> and masked-<id> videos in {folder}. Record with 'Also save raw video' ticked.")
    for name in lonely:
        print(f"note: {name} has no partner with the same id, skipped")

    opts = Options(use_objects=not args.no_objects, sidecar_checks=False)
    tot_raw = tot_both = tot_only_raw = tot_only_masked = 0
    print(f"{'session':<36} {'raw':>4} {'masked':>6} {'both':>5} {'only raw':>9} {'only masked':>12}")
    for sid, raw, masked in pairs:
        sp = folder / f"sidecar-{sid}.jsonl"
        header = load_sidecar(sp).header if sp.exists() else {}
        rf = run_video(raw, header, "raw", opts)
        mf = run_video(masked, header, "masked", opts)
        both, only_raw, only_masked = compare(rf, mf)
        tot_raw += len(rf)
        tot_both += len(both)
        tot_only_raw += len(only_raw)
        tot_only_masked += len(only_masked)
        print(f"{sid:<36} {len(rf):>4} {len(mf):>6} {len(both):>5} {len(only_raw):>9} {len(only_masked):>12}")
        for f in only_raw:
            print(f"    only in RAW:    {f['type']} {f['start_s']:.1f}-{f['end_s']:.1f} s  ({f['evidence']})")
        for f in only_masked:
            print(f"    only in MASKED: {f['type']} {f['start_s']:.1f}-{f['end_s']:.1f} s  ({f['evidence']})")

    print(f"\nOverall: {tot_raw} raw flag(s); {tot_both} also found in the masked video, {tot_only_raw} only in raw, "
          f"{tot_only_masked} only in masked.")
    if tot_raw == 0:
        print("NO DATA: the raw videos produced no flags, so there is nothing to compare. Record scenarios with a phone, a second person, "
              "a covered camera (see README) and run again. This is NOT a pass.")
        return 0
    frac = tot_both / tot_raw
    ok = frac >= PASS_FRACTION
    print(f"{100 * frac:.0f}% of raw flags are also in the masked video. Rule: PASS if >= {100 * PASS_FRACTION:.0f}%.  Result: {'PASS' if ok else 'FAIL'}")
    print("Flags 'only in masked' are not counted against the rule, but check them: the mask or the pixelation may create false flags.")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
