"""Command line: python -m analyzer <masked video> <sidecar> [options]   ->   flags-<id>.json"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import config
from .core import Options
from .rules import common
from .session import analyze_recording, flags_document, write_flags


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="analyzer", description="Integrity flags for one recorded session.")
    ap.add_argument("video", help="masked-<id>.webm (the masked video)")
    ap.add_argument("sidecar", help="sidecar-<id>.jsonl")
    ap.add_argument("--out", help="output folder (default: the sidecar's folder)")
    ap.add_argument("--chunk-s", type=float, default=config.CHUNK_S, help="chunk length in seconds (default 60)")
    ap.add_argument("--model", help="path to the ONNX model (default server/models/yolo11n.onnx)")
    ap.add_argument("--no-objects", action="store_true", help="skip the object model (camera and sidecar checks only)")
    ap.add_argument("--thresholds", choices=["fixed", "calibrated"], default=None,
                    help="eye thresholds for looking away (default: analysis/common.py THRESHOLDS_MODE = fixed)")
    ap.add_argument("--gaze-source", choices=["iris", "blend"], default=None)
    ap.add_argument("--raw", action="store_true", help="use raw instead of smoothed sidecar values")
    ap.add_argument("--threads", type=int, default=0, help="onnxruntime threads (0 = default)")
    args = ap.parse_args(argv)

    video, sidecar = Path(args.video), Path(args.sidecar)
    for p in (video, sidecar):
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            return 1
    sc = common.load_sidecar(sidecar)
    if not sc.frames:
        print(f"No frame lines in {sidecar}", file=sys.stderr)
        return 1
    session_id = sc.header.get("id") or sidecar.stem.replace("sidecar-", "", 1)

    opts = Options(use_objects=not args.no_objects, model_path=args.model, threads=args.threads,
                   gaze_source=args.gaze_source, thresholds_mode=args.thresholds,
                   smoothed=False if args.raw else None)
    try:
        opts.resolve_detector()
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 1

    t0 = time.perf_counter()
    flags, info = analyze_recording(video, sc.header, sc.frames, sc.keys, opts, chunk_s=args.chunk_s, key_events=sc.key_events)
    total = time.perf_counter() - t0

    out_dir = Path(args.out) if args.out else sidecar.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"flags-{session_id}.json"
    write_flags(out, flags_document(session_id, flags, opts, info))

    minutes = (sc.duration_s or info["video_duration_s"]) / 60.0
    print(f"Session {session_id}: {len(flags)} flag(s) -> {out}")
    for f in flags:
        print(f"  {f['type']:<26} {f['start_s']:8.1f} - {f['end_s']:8.1f} s  {f['severity']:<8} [{f['source']}] {f['evidence']}")
    print(f"\nTiming: {info['chunks']} chunk(s), {minutes * 60:.0f} s of recording")
    print(f"  decode + sample + write temp chunks: {info['split_s']:6.1f} s  ({info['split_s'] / max(minutes, 1e-9):5.1f} s per minute of video)")
    print(f"  analyze_chunk (model, camera, rules): {info['analyze_s']:6.1f} s  ({info['analyze_s'] / max(minutes, 1e-9):5.1f} s per minute of video)")
    print(f"  total:                                {total:6.1f} s  ({total / max(minutes, 1e-9):5.1f} s per minute of video)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
