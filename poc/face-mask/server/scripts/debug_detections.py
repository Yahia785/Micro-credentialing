"""Debug the object and camera checks on ONE video.

    server\\.venv\\Scripts\\python.exe scripts\\debug_detections.py <video> [--conf 0.10] [--samples 10] [--quiet]

For every sampled frame (2 per second, exactly like the analyzer) it prints the time, the mean brightness and
sharpness, and ALL YOLO boxes (every COCO class, not only the four reported ones) above --conf.
It saves --samples evenly spaced frames with the boxes drawn to server/out/debug/<video name>/ and prints a summary.
This file is for debugging only; the images it writes stay on this machine (server/out is git-ignored).
"""
from __future__ import annotations

import argparse
import ast
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

SERVER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER))

from analyzer import camera, config  # noqa: E402
from analyzer.core import iter_samples  # noqa: E402
from analyzer.model import decode, load_detector, letterbox  # noqa: E402

OUT = SERVER / "out" / "debug"


def coco_names(det) -> dict[int, str]:
    raw = det.session.get_modelmeta().custom_metadata_map.get("names", "{}")
    return {int(k): v for k, v in ast.literal_eval(raw).items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--conf", type=float, default=0.10)
    ap.add_argument("--samples", type=int, default=10)
    ap.add_argument("--quiet", action="store_true", help="only the summary")
    ap.add_argument("--model", default=str(config.DEFAULT_MODEL_PATH))
    args = ap.parse_args()

    video = Path(args.video)
    if not video.exists():
        print(f"File not found: {video}", file=sys.stderr)
        return 1
    det = load_detector(args.model)
    names = coco_names(det)

    rows = []  # (t, brightness, sharpness, [(label, score, box)], frame)
    for t, frame in iter_samples(video):
        blob, ratio, pad = letterbox(frame, det.size)
        out = det.session.run(None, {det.input_name: blob})[0]
        boxes = decode(out, ratio, pad, frame.shape[:2], conf=args.conf, classes=names)
        mean, sharp = camera.frame_stats(frame)
        rows.append((t, mean, sharp, [(b.label, b.score, b.box) for b in boxes], frame))
        if not args.quiet:
            txt = ", ".join(f"{lab} {sc:.2f}" for lab, sc, _ in sorted(rows[-1][3], key=lambda x: -x[1])) or "-"
            print(f"t={t:7.2f}s  bright={mean:6.1f}  sharp={sharp:8.1f}  boxes: {txt}")

    if not rows:
        print("No frames could be read from the video.", file=sys.stderr)
        return 1

    # sample frames with the boxes drawn
    out_dir = OUT / video.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    idx = np.linspace(0, len(rows) - 1, min(args.samples, len(rows))).round().astype(int)
    for i in sorted(set(idx.tolist())):
        t, mean, sharp, boxes, frame = rows[i]
        img = frame.copy()
        for lab, sc, (x, y, w, h) in boxes:
            cv2.rectangle(img, (int(x), int(y)), (int(x + w), int(y + h)), (0, 255, 0), 2)
            cv2.putText(img, f"{lab} {sc:.2f}", (int(x), max(int(y) - 6, 14)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        cv2.putText(img, f"t={t:.1f}s bright={mean:.0f} sharp={sharp:.0f}", (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        cv2.imwrite(str(out_dir / f"frame_{i:04d}_t{t:06.1f}.jpg"), img)

    # summary
    print(f"\n=== SUMMARY for {video.name}")
    ts = [r[0] for r in rows]
    h, w = rows[0][4].shape[:2]
    print(f"sampled frames: {len(rows)} ({ts[0]:.1f}s to {ts[-1]:.1f}s), frame size {w}x{h}")
    br = [r[1] for r in rows]
    sh = [r[2] for r in rows]
    print(f"brightness min/median/max: {min(br):.0f} / {np.median(br):.0f} / {max(br):.0f}   "
          f"(camera_blocked below {config.CAMERA_MIN_BRIGHTNESS:g})")
    print(f"sharpness  min/median/max: {min(sh):.0f} / {np.median(sh):.0f} / {max(sh):.0f}   "
          f"(camera_blocked below {config.CAMERA_MIN_SHARPNESS:g})")
    low_b = sum(1 for r in rows if r[1] < config.CAMERA_MIN_BRIGHTNESS)
    low_s = sum(1 for r in rows if r[2] < config.CAMERA_MIN_SHARPNESS)
    print(f"frames below the camera thresholds: dark {low_b}, blurred {low_s}")

    per = defaultdict(list)
    for _, _, _, boxes, _ in rows:
        best = {}
        for lab, sc, _ in boxes:
            best[lab] = max(best.get(lab, 0.0), sc)
        for lab, sc in best.items():
            per[lab].append(sc)
    reported = set(config.CLASSES.values())
    print(f"\nclasses seen at >= {args.conf:g} (frames, best score, frames >= {config.OBJECT_CONF:g}); * = reported class")
    for lab, scs in sorted(per.items(), key=lambda kv: -max(kv[1])):
        print(f"  {'*' if lab in reported else ' '} {lab:<16} frames {len(scs):4d}   best {max(scs):.2f}   "
              f">= {config.OBJECT_CONF:g}: {sum(1 for s in scs if s >= config.OBJECT_CONF)}")
    for lab in reported:
        if lab not in per:
            print(f"  * {lab:<16} never above {args.conf:g}")
    print(f"\nSample frames with boxes: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
